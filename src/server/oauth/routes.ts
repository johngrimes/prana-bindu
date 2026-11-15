import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CODE_CHALLENGE, MAX_STATE_LENGTH, OAUTH_SCOPE, OAuthError, appendQuery, type OAuthService } from "./service.js";

/**
 * Bounds the anonymous POST endpoints; a maximal registration (10 redirect URIs of 2048 characters plus a
 * 100-character name) is about 21 KiB of JSON.
 */
const MAX_BODY_BYTES = 32 * 1024;

const oauthError = (c: Context, error: string, description: string, status: 400 | 413 = 400) =>
  c.json({ error, error_description: description }, status);

/** String-valued parameters of a form-encoded (or JSON) body; anything unparseable yields none. */
async function readParams(c: Context): Promise<Record<string, string>> {
  let body: unknown;
  try {
    body = (c.req.header("content-type") ?? "").includes("application/json") ? await c.req.json() : await c.req.parseBody();
  } catch {
    return {};
  }
  const params: Record<string, string> = {};
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body)) if (typeof value === "string") params[key] = value;
  }
  return params;
}

/**
 * OAuth 2.1 authorization server for remote MCP clients, mounted at the app root: `/.well-known/*` metadata
 * (RFC 9728, RFC 8414) and `/oauth/*` (RFC 7591 registration, PKCE S256 authorization, token endpoint with
 * refresh rotation, RFC 7009 revocation). Errors use the RFC 6749 `{error, error_description}` shape. Consent
 * happens in the SPA (`/authorize?request=<id>`) through `/api/v1/auth/oauth`.
 */
export function createOAuthRoutes(oauth: OAuthService): Hono {
  const app = new Hono();

  const protectedResource = (c: Context) => c.json(oauth.protectedResourceMetadata());
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(oauth.authorizationServerMetadata()));

  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => oauthError(c, "invalid_request", `Request body exceeds ${MAX_BODY_BYTES} bytes`, 413),
  });

  app.post("/oauth/register", limitBody, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return oauthError(c, "invalid_client_metadata", "Body must be JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return oauthError(c, "invalid_client_metadata", "Body must be an object");
    let client;
    try {
      client = oauth.registerClient(body as Record<string, unknown>);
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(c, err.error, err.description);
      throw err;
    }
    return c.json(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  // Until the client and redirect URI are verified nothing may redirect (an open redirector otherwise).
  app.get("/oauth/authorize", (c) => {
    const q = c.req.query();
    const client = q.client_id ? oauth.getClient(q.client_id) : null;
    if (!client) return c.text("Authorization failed: unknown client_id.", 400);
    const redirectUri = q.redirect_uri;
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return c.text("Authorization failed: redirect_uri is not registered for this client.", 400);
    }
    // An oversized state is the invalid parameter, so it is not echoed.
    const stateOk = q.state === undefined || q.state.length <= MAX_STATE_LENGTH;
    const fail = (error: string, description: string) =>
      c.redirect(appendQuery(redirectUri, { error, error_description: description, state: stateOk ? q.state : undefined, iss: oauth.issuer }), 302);
    if (!stateOk) return fail("invalid_request", `state must be at most ${MAX_STATE_LENGTH} characters`);
    if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
    if (!q.code_challenge || !CODE_CHALLENGE.test(q.code_challenge) || q.code_challenge_method !== "S256") {
      return fail("invalid_request", "A PKCE code_challenge with code_challenge_method S256 is required");
    }
    if (q.resource !== undefined && q.resource !== oauth.resource) return fail("invalid_target", `resource must be ${oauth.resource}`);
    if (q.scope !== undefined && q.scope !== "" && q.scope !== OAUTH_SCOPE) return fail("invalid_scope", `The only scope is ${OAUTH_SCOPE}`);
    const id = oauth.createAuthorizationRequest({
      clientId: client.id,
      redirectUri,
      state: q.state ?? null,
      codeChallenge: q.code_challenge,
    });
    return c.redirect(`/authorize?request=${encodeURIComponent(id)}`, 302);
  });

  app.post("/oauth/token", limitBody, async (c) => {
    c.header("Cache-Control", "no-store");
    const params = await readParams(c);
    if (params.resource !== undefined && params.resource !== oauth.resource) {
      return oauthError(c, "invalid_target", `resource must be ${oauth.resource}`);
    }
    try {
      if (params.grant_type === "authorization_code") return c.json(oauth.exchangeCode(params));
      if (params.grant_type === "refresh_token") return c.json(oauth.refresh(params));
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(c, err.error, err.description);
      throw err;
    }
    if (!params.grant_type) return oauthError(c, "invalid_request", "grant_type is required");
    return oauthError(c, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  });

  // RFC 7009: always 200.
  app.post("/oauth/revoke", limitBody, async (c) => {
    const { token, client_id } = await readParams(c);
    oauth.revoke(token, client_id);
    return c.body(null, 200);
  });

  return app;
}
