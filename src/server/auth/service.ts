import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { and, asc, eq, gt, isNull, lt, lte } from "drizzle-orm";
import type { AppDb } from "../../db/connection.js";
import { apiTokens, enrollmentTokens, passkeys, sessions, webauthnChallenges } from "../../db/schema.js";
import type { ApiTokenCreated, ApiTokenInfo, AuthPasskey } from "../../shared/schemas.js";

export const SESSION_COOKIE = "pb_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding sessions are re-extended at most this often (avoids a write per request). */
export const SESSION_REFRESH_MS = 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
export const API_TOKEN_PREFIX = "pb_";
const TOKEN_DISPLAY_LENGTH = 10;

export interface AuthConfig {
  origin: string;
  rpId: string;
  rpName: string;
}

/** Failure the HTTP layer reports as `{error: {code, message}}` with `status`. */
export class AuthError extends Error {
  override name = "AuthError";
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 404,
  ) {
    super(message);
  }
}

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
export const randomSecret = (): string => randomBytes(32).toString("base64url");

type PasskeyRow = typeof passkeys.$inferSelect;
type TokenRow = typeof apiTokens.$inferSelect;

const toPasskey = (r: PasskeyRow): AuthPasskey => ({
  id: r.id,
  name: r.name,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
  deviceType: r.deviceType,
  backedUp: r.backedUp,
});

const toTokenInfo = (r: TokenRow): ApiTokenInfo => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
});

export interface SessionCheck {
  /** Set when the session's expiry was extended and the cookie should be re-issued. */
  refreshed: boolean;
}

/** Passkeys, enrollment tokens, sessions and API tokens (docs/plan.md §Auth). All secrets are stored as SHA-256 hashes. */
export class AuthService {
  constructor(
    private readonly db: AppDb,
    readonly config: AuthConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  // -- WebAuthn challenges --------------------------------------------------

  private storeChallenge(challenge: string, kind: "registration" | "authentication"): void {
    this.db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, this.iso())).run();
    this.db.insert(webauthnChallenges).values({ challenge, kind, expiresAt: this.iso(CHALLENGE_TTL_MS) }).run();
  }

  /** Deletes the challenge (single use) and reports whether it was valid for `kind`. */
  private consumeChallenge(challenge: string, kind: "registration" | "authentication"): boolean {
    const row = this.db.delete(webauthnChallenges).where(eq(webauthnChallenges.challenge, challenge)).returning().get();
    return row !== undefined && row.kind === kind && row.expiresAt > this.iso();
  }

  // -- Enrollment -----------------------------------------------------------

  /** Creates a one-time enrollment token valid for 15 minutes; returns the plaintext. */
  createEnrollmentToken(): string {
    const token = randomSecret();
    this.db
      .insert(enrollmentTokens)
      .values({ tokenHash: sha256Hex(token), createdAt: this.iso(), expiresAt: this.iso(ENROLLMENT_TTL_MS) })
      .run();
    return token;
  }

  private findUsableEnrollment(token: string) {
    return this.db
      .select()
      .from(enrollmentTokens)
      .where(
        and(
          eq(enrollmentTokens.tokenHash, sha256Hex(token)),
          isNull(enrollmentTokens.usedAt),
          gt(enrollmentTokens.expiresAt, this.iso()),
        ),
      )
      .get();
  }

  assertEnrollmentToken(token: string): void {
    if (!this.findUsableEnrollment(token)) {
      throw new AuthError("invalid_enrollment_token", "The enrollment link is invalid, expired or already used", 401);
    }
  }

  async registrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = this.db.select().from(passkeys).all();
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpId,
      // The single user's stable handle, so re-registering on one authenticator replaces its credential.
      userID: new Uint8Array(createHash("sha256").update(`prana-bindu-user:${this.config.rpId}`).digest().subarray(0, 16)),
      userName: "prana-bindu",
      userDisplayName: "prana-bindu",
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({
        id: p.id,
        transports: JSON.parse(p.transportsJson) as AuthenticatorTransport[],
      })),
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
      timeout: CHALLENGE_TTL_MS,
    });
    this.storeChallenge(options.challenge, "registration");
    return options;
  }

  /**
   * Verifies a registration response and stores the passkey. With `enrollmentToken` the token is
   * re-checked and consumed in the same transaction as the insert.
   */
  async registerPasskey(response: RegistrationResponseJSON, name: string, enrollmentToken?: string): Promise<AuthPasskey> {
    if (enrollmentToken !== undefined) this.assertEnrollmentToken(enrollmentToken);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: (c) => this.consumeChallenge(c, "registration"),
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: false,
      });
    } catch (err) {
      throw new AuthError("passkey_verification_failed", (err as Error).message, 400);
    }
    if (!verification.verified) throw new AuthError("passkey_verification_failed", "Registration could not be verified", 400);
    const info = verification.registrationInfo;
    const row: PasskeyRow = {
      id: info.credential.id,
      name,
      publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
      counter: info.credential.counter,
      transportsJson: JSON.stringify(response.response.transports ?? info.credential.transports ?? []),
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      createdAt: this.iso(),
      lastUsedAt: null,
    };
    this.db.transaction((tx) => {
      if (enrollmentToken !== undefined) {
        const used = tx
          .update(enrollmentTokens)
          .set({ usedAt: this.iso() })
          .where(and(eq(enrollmentTokens.tokenHash, sha256Hex(enrollmentToken)), isNull(enrollmentTokens.usedAt)))
          .returning()
          .get();
        if (!used) throw new AuthError("invalid_enrollment_token", "The enrollment link was already used", 401);
      }
      tx.insert(passkeys)
        .values(row)
        .onConflictDoUpdate({
          target: passkeys.id,
          set: { name: row.name, publicKey: row.publicKey, counter: row.counter, transportsJson: row.transportsJson },
        })
        .run();
    });
    return toPasskey(this.db.select().from(passkeys).where(eq(passkeys.id, row.id)).get()!);
  }

  // -- Login ----------------------------------------------------------------

  async authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      userVerification: "preferred",
      timeout: CHALLENGE_TTL_MS,
    });
    this.storeChallenge(options.challenge, "authentication");
    return options;
  }

  /** Verifies a passkey assertion; returns the new session id (plaintext, for the cookie). */
  async login(response: AuthenticationResponseJSON): Promise<string> {
    const passkey = this.db.select().from(passkeys).where(eq(passkeys.id, response.id)).get();
    if (!passkey) throw new AuthError("unknown_passkey", "This passkey is not registered", 401);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (c) => this.consumeChallenge(c, "authentication"),
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        credential: {
          id: passkey.id,
          publicKey: isoBase64URL.toBuffer(passkey.publicKey),
          counter: passkey.counter,
          transports: JSON.parse(passkey.transportsJson) as AuthenticatorTransport[],
        },
        requireUserVerification: false,
      });
    } catch (err) {
      throw new AuthError("passkey_verification_failed", (err as Error).message, 401);
    }
    if (!verification.verified) throw new AuthError("passkey_verification_failed", "Sign-in could not be verified", 401);
    this.db
      .update(passkeys)
      .set({
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: this.iso(),
        backedUp: verification.authenticationInfo.credentialBackedUp,
      })
      .where(eq(passkeys.id, passkey.id))
      .run();
    return this.createSession();
  }

  // -- Passkey management ---------------------------------------------------

  listPasskeys(): AuthPasskey[] {
    return this.db.select().from(passkeys).orderBy(asc(passkeys.createdAt)).all().map(toPasskey);
  }

  renamePasskey(id: string, name: string): AuthPasskey {
    const row = this.db.update(passkeys).set({ name }).where(eq(passkeys.id, id)).returning().get();
    if (!row) throw new AuthError("not_found", "Passkey not found", 404);
    return toPasskey(row);
  }

  deletePasskey(id: string): void {
    const row = this.db.delete(passkeys).where(eq(passkeys.id, id)).returning().get();
    if (!row) throw new AuthError("not_found", "Passkey not found", 404);
  }

  // -- Sessions -------------------------------------------------------------

  createSession(): string {
    const id = randomSecret();
    this.db
      .insert(sessions)
      .values({ idHash: sha256Hex(id), createdAt: this.iso(), lastSeenAt: this.iso(), expiresAt: this.iso(SESSION_TTL_MS) })
      .run();
    return id;
  }

  /** Validates a session id, sliding its 30-day expiry forward; null when unknown or expired. */
  checkSession(id: string): SessionCheck | null {
    const idHash = sha256Hex(id);
    const row = this.db.select().from(sessions).where(eq(sessions.idHash, idHash)).get();
    if (!row) return null;
    const nowIso = this.iso();
    if (row.expiresAt <= nowIso) {
      this.db.delete(sessions).where(lte(sessions.expiresAt, nowIso)).run();
      return null;
    }
    const sinceSeen = this.now().getTime() - Date.parse(row.lastSeenAt);
    if (sinceSeen < SESSION_REFRESH_MS) return { refreshed: false };
    this.db.update(sessions).set({ lastSeenAt: nowIso, expiresAt: this.iso(SESSION_TTL_MS) }).where(eq(sessions.idHash, idHash)).run();
    this.db.delete(sessions).where(lte(sessions.expiresAt, nowIso)).run();
    return { refreshed: true };
  }

  destroySession(id: string): void {
    this.db.delete(sessions).where(eq(sessions.idHash, sha256Hex(id))).run();
  }

  // -- API tokens -----------------------------------------------------------

  createApiToken(name: string): ApiTokenCreated {
    const plaintext = `${API_TOKEN_PREFIX}${randomSecret()}`;
    const row = this.db
      .insert(apiTokens)
      .values({
        id: randomBytes(9).toString("base64url"), // 12 chars of [A-Za-z0-9_-]
        name,
        tokenHash: sha256Hex(plaintext),
        prefix: plaintext.slice(0, TOKEN_DISPLAY_LENGTH),
        createdAt: this.iso(),
      })
      .returning()
      .get();
    return { token: toTokenInfo(row), plaintext };
  }

  /** Active (non-revoked) tokens, oldest first. */
  listApiTokens(): ApiTokenInfo[] {
    return this.db.select().from(apiTokens).where(isNull(apiTokens.revokedAt)).orderBy(asc(apiTokens.createdAt)).all().map(toTokenInfo);
  }

  revokeApiToken(id: string): void {
    const row = this.db
      .update(apiTokens)
      .set({ revokedAt: this.iso() })
      .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
      .returning()
      .get();
    if (!row) throw new AuthError("not_found", "API token not found", 404);
  }

  /** Validates a bearer token and records its use; returns the token id or null. */
  checkApiToken(plaintext: string): string | null {
    if (!plaintext.startsWith(API_TOKEN_PREFIX)) return null;
    const row = this.db
      .update(apiTokens)
      .set({ lastUsedAt: this.iso() })
      .where(and(eq(apiTokens.tokenHash, sha256Hex(plaintext)), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id })
      .get();
    return row?.id ?? null;
  }
}
