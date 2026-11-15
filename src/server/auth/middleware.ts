import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { OAuthService } from "../oauth/service.js";
import { AuthError, SESSION_COOKIE, SESSION_TTL_MS, type AuthService } from "./service.js";

export interface AuthInfo {
  /** `oauth` only on `/mcp`: OAuth access tokens are not valid for the REST API. */
  kind: "session" | "token" | "oauth";
  /** API token id for `token` requests. */
  tokenId?: string;
  /** OAuth grant id for `oauth` requests. */
  grantId?: string;
}

const BEARER = /^Bearer\s+(\S+)$/i;

export type AuthEnv = { Variables: { auth: AuthInfo } };

export const CSRF_HEADER = "X-Requested-With";
export const CSRF_VALUE = "prana-bindu";
const SAFE_METHODS: Record<string, true> = { GET: true, HEAD: true, OPTIONS: true };

export function setSessionCookie(c: Context, auth: AuthService, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: auth.config.origin.startsWith("https:"),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context, auth: AuthService): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: auth.config.origin.startsWith("https:") });
}

/** Unsafe requests that may carry the session cookie must send `X-Requested-With: prana-bindu`. */
export function assertCsrf(c: Context): void {
  if (!SAFE_METHODS[c.req.method] && c.req.header(CSRF_HEADER) !== CSRF_VALUE) {
    throw new AuthError("csrf", `Unsafe requests authenticated by cookie require the header ${CSRF_HEADER}: ${CSRF_VALUE}`, 403);
  }
}

/**
 * Resolves the caller from `Authorization: Bearer pb_…` (which takes precedence and never falls back
 * to the cookie) or the session cookie. Returns null when unauthenticated; throws for a bad bearer
 * token or a cookie request failing the CSRF rule.
 */
export function resolveAuth(c: Context, auth: AuthService): (AuthInfo & { kind: "session" | "token" }) | null {
  const header = c.req.header("Authorization");
  if (header !== undefined) {
    const match = BEARER.exec(header);
    const tokenId = match?.[1] ? auth.checkApiToken(match[1]) : null;
    if (!tokenId) throw new AuthError("invalid_token", "The bearer token is invalid or revoked", 401);
    return { kind: "token", tokenId };
  }
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return null;
  const check = auth.checkSession(sessionId);
  if (!check) {
    clearSessionCookie(c, auth);
    return null;
  }
  assertCsrf(c);
  if (check.refreshed) setSessionCookie(c, auth, sessionId);
  return { kind: "session" };
}

/** Session cookie (with CSRF rule) or bearer token; sets `c.var.auth`. */
export function requireAuth(auth: AuthService): MiddlewareHandler<AuthEnv> {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const info = resolveAuth(c, auth);
    if (!info) throw new AuthError("unauthorized", "Authentication required", 401);
    c.set("auth", info);
    await next();
  });
}

/**
 * `/mcp`: an API token (`pb_…`) or an OAuth access token; never the session cookie. A 401 carries the RFC 9728
 * challenge pointing MCP clients at the protected resource metadata, with `error="invalid_token"` when a token
 * was presented but rejected.
 */
export function requireBearer(auth: AuthService, oauth: OAuthService): MiddlewareHandler<AuthEnv> {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const header = c.req.header("Authorization");
    if (header === undefined) {
      c.header("WWW-Authenticate", oauth.bearerChallenge(false));
      throw new AuthError("unauthorized", "A bearer token is required (an OAuth access token or Authorization: Bearer pb_…)", 401);
    }
    const token = BEARER.exec(header)?.[1];
    const tokenId = token ? auth.checkApiToken(token) : null;
    const grantId = token && !tokenId ? oauth.checkAccessToken(token) : null;
    if (tokenId) c.set("auth", { kind: "token", tokenId });
    else if (grantId) c.set("auth", { kind: "oauth", grantId });
    else {
      c.header("WWW-Authenticate", oauth.bearerChallenge(true));
      throw new AuthError("invalid_token", "The bearer token is invalid, expired or revoked", 401);
    }
    await next();
  });
}
