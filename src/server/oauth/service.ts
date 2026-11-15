import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, exists, gt, isNull, lte, notExists, or, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../../db/connection.js";
import {
  oauthAccessTokens,
  oauthAuthorizationRequests,
  oauthClients,
  oauthCodes,
  oauthGrants,
  oauthRefreshTokens,
} from "../../db/schema.js";
import type { ConnectedApp, OAuthAuthorizationRequestInfo } from "../../shared/schemas.js";
import { randomSecret, sha256Hex } from "../auth/service.js";

/** The single scope: the whole task database. Optional in requests. */
export const OAUTH_SCOPE = "prana";
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Renewed on every rotation. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
/** A client that never obtained a grant is swept after this (bounds anonymous registration). */
export const NEVER_GRANTED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
/** A client without grants is swept this long after its last grant (clients reconnect with a cached client_id). */
export const UNUSED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 2048;
export const MAX_CLIENT_NAME_LENGTH = 100;
export const MAX_STATE_LENGTH = 1024;
const DEFAULT_CLIENT_NAME = "Unnamed client";
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** base64url SHA-256: 43 characters. */
export const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

/** An RFC 6749 error (`{error, error_description}`), reported with status 400. */
export class OAuthError extends Error {
  override name = "OAuthError";
  constructor(
    readonly error: string,
    readonly description: string,
  ) {
    super(description);
  }
}

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** https, or http on a loopback host; no fragment; at most 2048 characters. */
export function isAllowedRedirectUri(uri: string): boolean {
  if (uri.length > MAX_REDIRECT_URI_LENGTH || uri.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return url.hostname !== "";
  return url.protocol === "http:" && LOOPBACK_HOSTS[url.hostname] === true;
}

/** Constant-time PKCE S256 check (RFC 7636 §4.6); malformed verifiers never match. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER.test(verifier)) return false;
  const expected = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const actual = Buffer.from(challenge);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Appends query parameters (skipping null/undefined) to an absolute URI, keeping its query. */
export function appendQuery(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.append(key, value);
  return url.toString();
}

/**
 * Minimal OAuth 2.1 authorization server state for remote MCP clients (docs/spec.md §10.1): dynamic
 * registration, consent-backed grants, PKCE codes, access tokens and rotating refresh tokens.
 * Single user: a grant is one client's approved access to the whole database.
 */
export class OAuthService {
  /** Issuer and authorization server: the app origin. */
  readonly issuer: string;
  /** The protected resource: the MCP endpoint. */
  readonly resource: string;

  constructor(
    private readonly db: AppDb,
    origin: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.issuer = origin;
    this.resource = `${origin}/mcp`;
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  /** RFC 9728 protected resource metadata. */
  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: [OAUTH_SCOPE],
      resource_name: "prana-bindu",
    };
  }

  /** RFC 8414 authorization server metadata. */
  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [OAUTH_SCOPE],
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** `WWW-Authenticate` for a 401 from `/mcp` (RFC 9728 §5.1). */
  bearerChallenge(invalidToken: boolean): string {
    const base = `Bearer realm="prana-bindu", resource_metadata="${this.issuer}/.well-known/oauth-protected-resource/mcp"`;
    return invalidToken ? `${base}, error="invalid_token"` : base;
  }

  // -- Clients --------------------------------------------------------------

  /** RFC 7591 registration of a public client. */
  registerClient(metadata: Record<string, unknown>): OAuthClient {
    const uris = metadata.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length < 1 ||
      uris.length > MAX_REDIRECT_URIS ||
      !uris.every((u): u is string => typeof u === "string" && isAllowedRedirectUri(u))
    ) {
      throw new OAuthError(
        "invalid_redirect_uri",
        `redirect_uris must list 1-${MAX_REDIRECT_URIS} https (or loopback http) URLs without fragments`,
      );
    }
    const rawName = metadata.client_name;
    if (rawName !== undefined && typeof rawName !== "string") {
      throw new OAuthError("invalid_client_metadata", "client_name must be a string");
    }
    const name = (rawName ?? "").trim();
    if (name.length > MAX_CLIENT_NAME_LENGTH) {
      throw new OAuthError("invalid_client_metadata", `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`);
    }
    const client: OAuthClient = { id: randomUUID(), name: name || DEFAULT_CLIENT_NAME, redirectUris: uris, createdAt: this.iso() };
    this.db
      .insert(oauthClients)
      .values({ id: client.id, name: client.name, redirectUrisJson: JSON.stringify(uris), createdAt: client.createdAt })
      .run();
    return client;
  }

  getClient(id: string): OAuthClient | null {
    const row = this.db.select().from(oauthClients).where(eq(oauthClients.id, id)).get();
    if (!row) return null;
    return { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirectUrisJson) as string[], createdAt: row.createdAt };
  }

  // -- Authorization requests and consent ------------------------------------

  /** Stores a validated pending request; returns its id (the consent page's `request` parameter). */
  createAuthorizationRequest(input: { clientId: string; redirectUri: string; state: string | null; codeChallenge: string }): string {
    const id = randomSecret();
    this.db
      .insert(oauthAuthorizationRequests)
      .values({ id, ...input, createdAt: this.iso(), expiresAt: this.iso(AUTHORIZATION_REQUEST_TTL_MS) })
      .run();
    return id;
  }

  private activeRequest(id: string) {
    const row = this.db.select().from(oauthAuthorizationRequests).where(eq(oauthAuthorizationRequests.id, id)).get();
    return row && row.expiresAt > this.iso() ? row : null;
  }

  /** What the consent page shows; null when unknown, expired or already decided. */
  describeRequest(id: string): OAuthAuthorizationRequestInfo | null {
    const request = this.activeRequest(id);
    const client = request ? this.getClient(request.clientId) : null;
    if (!request || !client) return null;
    return { id, clientName: client.name, redirectHost: new URL(request.redirectUri).host, expiresAt: request.expiresAt };
  }

  /** Deletes and returns an active request, so it is decided at most once. */
  private consumeRequest(id: string) {
    const request = this.activeRequest(id);
    if (!request) return null;
    const deleted = this.db.delete(oauthAuthorizationRequests).where(eq(oauthAuthorizationRequests.id, id)).returning().get();
    return deleted ? request : null;
  }

  /** Approves a request: creates the grant and a single-use code; returns the client redirect, or null when gone. */
  approve(id: string): string | null {
    const code = randomSecret();
    const request = this.db.transaction(() => {
      const taken = this.consumeRequest(id);
      if (!taken || !this.getClient(taken.clientId)) return null;
      const grantId = randomUUID();
      const at = this.iso();
      this.db.insert(oauthGrants).values({ id: grantId, clientId: taken.clientId, createdAt: at }).run();
      this.db.update(oauthClients).set({ lastGrantedAt: at }).where(eq(oauthClients.id, taken.clientId)).run();
      this.db
        .insert(oauthCodes)
        .values({
          codeHash: sha256Hex(code),
          grantId,
          redirectUri: taken.redirectUri,
          codeChallenge: taken.codeChallenge,
          expiresAt: this.iso(AUTHORIZATION_CODE_TTL_MS),
        })
        .run();
      return taken;
    });
    if (!request) return null;
    return appendQuery(request.redirectUri, { code, state: request.state, iss: this.issuer });
  }

  /** Denies a request; returns the client redirect carrying `access_denied`, or null when gone. */
  deny(id: string): string | null {
    const request = this.consumeRequest(id);
    if (!request) return null;
    return appendQuery(request.redirectUri, {
      error: "access_denied",
      error_description: "The user denied access",
      state: request.state,
      iss: this.issuer,
    });
  }

  // -- Token endpoint ---------------------------------------------------------

  private grant(id: string) {
    return this.db.select().from(oauthGrants).where(eq(oauthGrants.id, id)).get() ?? null;
  }

  /** Revokes a grant and every code and token it issued; false when unknown. */
  deleteGrant(id: string): boolean {
    return this.db.transaction(() => {
      this.db.delete(oauthCodes).where(eq(oauthCodes.grantId, id)).run();
      this.db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.grantId, id)).run();
      this.db.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.grantId, id)).run();
      return this.db.delete(oauthGrants).where(eq(oauthGrants.id, id)).run().changes > 0;
    });
  }

  private issueTokens(grantId: string): TokenResponse {
    const accessToken = randomSecret();
    const refreshToken = randomSecret();
    this.db
      .insert(oauthAccessTokens)
      .values({ tokenHash: sha256Hex(accessToken), grantId, expiresAt: this.iso(ACCESS_TOKEN_TTL_MS) })
      .run();
    this.db
      .insert(oauthRefreshTokens)
      .values({ tokenHash: sha256Hex(refreshToken), grantId, expiresAt: this.iso(REFRESH_TOKEN_TTL_MS) })
      .run();
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refreshToken,
      scope: OAUTH_SCOPE,
    };
  }

  /** `grant_type=authorization_code`. A replayed code revokes the grant it issued (OAuth 2.1 §4.1.3). */
  exchangeCode(params: Record<string, string>): TokenResponse {
    const { code, redirect_uri, client_id, code_verifier } = params;
    if (!code || !redirect_uri || !client_id || !code_verifier) {
      throw new OAuthError("invalid_request", "code, redirect_uri, client_id and code_verifier are required");
    }
    const codeHash = sha256Hex(code);
    const stored = this.db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, codeHash)).get();
    if (stored?.usedAt) {
      this.deleteGrant(stored.grantId);
      throw new OAuthError("invalid_grant", "Authorization code already used");
    }
    const grant = stored && stored.expiresAt > this.iso() ? this.grant(stored.grantId) : null;
    if (
      !stored ||
      !grant ||
      grant.clientId !== client_id ||
      stored.redirectUri !== redirect_uri ||
      !verifyPkceS256(code_verifier, stored.codeChallenge)
    ) {
      throw new OAuthError("invalid_grant", "Invalid authorization code");
    }
    const tokens = this.db.transaction(() => {
      const marked = this.db
        .update(oauthCodes)
        .set({ usedAt: this.iso() })
        .where(and(eq(oauthCodes.codeHash, codeHash), isNull(oauthCodes.usedAt)))
        .run();
      return marked.changes === 1 ? this.issueTokens(grant.id) : null;
    });
    if (!tokens) throw new OAuthError("invalid_grant", "Authorization code already used");
    return tokens;
  }

  /** `grant_type=refresh_token` with rotation; reuse of a rotated token revokes the grant. */
  refresh(params: Record<string, string>): TokenResponse {
    const { refresh_token, client_id, scope } = params;
    if (!refresh_token || !client_id) throw new OAuthError("invalid_request", "refresh_token and client_id are required");
    if (scope !== undefined && scope !== "" && scope !== OAUTH_SCOPE) {
      throw new OAuthError("invalid_scope", `The only scope is ${OAUTH_SCOPE}`);
    }
    const tokenHash = sha256Hex(refresh_token);
    const stored = this.db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, tokenHash)).get();
    if (stored?.usedAt) {
      this.deleteGrant(stored.grantId);
      throw new OAuthError("invalid_grant", "Refresh token already used");
    }
    const grant = stored && stored.expiresAt > this.iso() ? this.grant(stored.grantId) : null;
    if (!grant || grant.clientId !== client_id) throw new OAuthError("invalid_grant", "Invalid refresh token");
    const tokens = this.db.transaction(() => {
      const marked = this.db
        .update(oauthRefreshTokens)
        .set({ usedAt: this.iso() })
        .where(and(eq(oauthRefreshTokens.tokenHash, tokenHash), isNull(oauthRefreshTokens.usedAt)))
        .run();
      return marked.changes === 1 ? this.issueTokens(grant.id) : null;
    });
    if (!tokens) throw new OAuthError("invalid_grant", "Refresh token already used");
    return tokens;
  }

  /** RFC 7009: a token presented by the client that owns it revokes its whole grant; anything else is ignored. */
  revoke(token: string | undefined, clientId: string | undefined): void {
    if (!token || !clientId) return;
    const tokenHash = sha256Hex(token);
    const grantId =
      this.db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, tokenHash)).get()?.grantId ??
      this.db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, tokenHash)).get()?.grantId;
    const grant = grantId ? this.grant(grantId) : null;
    if (grant && grant.clientId === clientId) this.deleteGrant(grant.id);
  }

  // -- Resource server --------------------------------------------------------

  /** Validates an access token and records the grant's use; returns the grant id or null. */
  checkAccessToken(token: string): string | null {
    const row = this.db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, sha256Hex(token))).get();
    if (!row || row.expiresAt <= this.iso()) return null;
    const touched = this.db.update(oauthGrants).set({ lastUsedAt: this.iso() }).where(eq(oauthGrants.id, row.grantId)).run();
    return touched.changes === 1 ? row.grantId : null;
  }

  // -- Connected apps -----------------------------------------------------------

  /** Holds while a grant can still be used: an unexpired access token, unused refresh token or unused code. */
  private grantAlive(nowIso: string): SQL {
    return or(
      exists(
        this.db
          .select({ one: sql`1` })
          .from(oauthAccessTokens)
          .where(and(eq(oauthAccessTokens.grantId, oauthGrants.id), gt(oauthAccessTokens.expiresAt, nowIso))),
      ),
      exists(
        this.db
          .select({ one: sql`1` })
          .from(oauthRefreshTokens)
          .where(
            and(eq(oauthRefreshTokens.grantId, oauthGrants.id), isNull(oauthRefreshTokens.usedAt), gt(oauthRefreshTokens.expiresAt, nowIso)),
          ),
      ),
      exists(
        this.db
          .select({ one: sql`1` })
          .from(oauthCodes)
          .where(and(eq(oauthCodes.grantId, oauthGrants.id), isNull(oauthCodes.usedAt), gt(oauthCodes.expiresAt, nowIso))),
      ),
    )!;
  }

  /** Usable grants with their client names, newest first. */
  listConnectedApps(): ConnectedApp[] {
    return this.db
      .select({ id: oauthGrants.id, clientName: oauthClients.name, createdAt: oauthGrants.createdAt, lastUsedAt: oauthGrants.lastUsedAt })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
      .where(this.grantAlive(this.iso()))
      .orderBy(desc(oauthGrants.createdAt))
      .all();
  }

  /**
   * Deletes dead rows: unusable grants (with their codes and tokens), expired requests, codes and tokens (used
   * refresh tokens stay until expiry so a replay still revokes), and clients without grants that never got one
   * within a day or whose last grant is 30 days old.
   */
  sweep(): void {
    const nowIso = this.iso();
    this.db.transaction(() => {
      const dead = this.db.select({ id: oauthGrants.id }).from(oauthGrants).where(sql`not ${this.grantAlive(nowIso)}`).all();
      for (const { id } of dead) this.deleteGrant(id);
      this.db.delete(oauthAuthorizationRequests).where(lte(oauthAuthorizationRequests.expiresAt, nowIso)).run();
      this.db.delete(oauthCodes).where(lte(oauthCodes.expiresAt, nowIso)).run();
      this.db.delete(oauthAccessTokens).where(lte(oauthAccessTokens.expiresAt, nowIso)).run();
      this.db.delete(oauthRefreshTokens).where(lte(oauthRefreshTokens.expiresAt, nowIso)).run();
      const stale = this.db
        .select({ id: oauthClients.id })
        .from(oauthClients)
        .where(
          and(
            notExists(this.db.select({ one: sql`1` }).from(oauthGrants).where(eq(oauthGrants.clientId, oauthClients.id))),
            or(
              and(isNull(oauthClients.lastGrantedAt), lte(oauthClients.createdAt, this.iso(-NEVER_GRANTED_CLIENT_TTL_MS))),
              lte(oauthClients.lastGrantedAt, this.iso(-UNUSED_CLIENT_TTL_MS)),
            ),
          ),
        )
        .all();
      for (const { id } of stale) {
        this.db.delete(oauthAuthorizationRequests).where(eq(oauthAuthorizationRequests.clientId, id)).run();
        this.db.delete(oauthClients).where(eq(oauthClients.id, id)).run();
      }
    });
  }
}
