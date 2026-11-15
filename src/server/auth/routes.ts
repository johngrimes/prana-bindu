import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import {
  ApiError,
  ApiTokenCreate,
  ApiTokenCreated,
  ApiTokenInfo,
  AuthPasskey,
  AuthSession,
  EnrollOptionsRequest,
  EnrollVerifyRequest,
  PasskeyRename,
  WebAuthnCredentialResponse,
} from "../../shared/schemas.js";
import { validationHook } from "../errors.js";
import { assertCsrf, clearSessionCookie, requireAuth, resolveAuth, setSessionCookie, type AuthEnv } from "./middleware.js";
import { AuthError, SESSION_COOKIE, type AuthService } from "./service.js";

const tags = ["Auth"];
const PUBLIC: [] = [];
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const jsonBody = <T extends z.ZodType>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const errors = {
  400: json(ApiError, "Invalid request or failed verification"),
  401: json(ApiError, "Not authenticated"),
  403: json(ApiError, "Missing X-Requested-With: prana-bindu header"),
};
const IdParam = z.object({ id: z.string().min(1) });

const CreationOptions = z
  .looseObject({ challenge: z.string(), rp: z.looseObject({ id: z.string().optional(), name: z.string() }) })
  .describe("PublicKeyCredentialCreationOptionsJSON");
const RequestOptions = z.looseObject({ challenge: z.string() }).describe("PublicKeyCredentialRequestOptionsJSON");

const routes = {
  session: createRoute({
    method: "get",
    path: "/session",
    tags,
    summary: "Current authentication state",
    security: PUBLIC,
    responses: { 200: json(AuthSession, "Authenticated"), 401: errors[401] },
  }),
  loginOptions: createRoute({
    method: "post",
    path: "/login/options",
    tags,
    summary: "Start passkey sign-in (discoverable credential)",
    security: PUBLIC,
    responses: { 200: json(RequestOptions, "WebAuthn request options"), 403: errors[403] },
  }),
  loginVerify: createRoute({
    method: "post",
    path: "/login/verify",
    tags,
    summary: "Finish passkey sign-in; sets the pb_session cookie",
    security: PUBLIC,
    request: { body: jsonBody(WebAuthnCredentialResponse) },
    responses: { 200: json(AuthSession, "Signed in"), ...errors },
  }),
  logout: createRoute({
    method: "post",
    path: "/logout",
    tags,
    summary: "Destroy the current session",
    security: PUBLIC,
    responses: { 204: { description: "Signed out" }, 403: errors[403] },
  }),
  enrollOptions: createRoute({
    method: "post",
    path: "/enroll/options",
    tags,
    summary: "Start passkey registration (enrollment token or active session)",
    security: PUBLIC,
    request: { body: jsonBody(EnrollOptionsRequest) },
    responses: { 200: json(CreationOptions, "WebAuthn creation options"), ...errors },
  }),
  enrollVerify: createRoute({
    method: "post",
    path: "/enroll/verify",
    tags,
    summary: "Finish passkey registration; with a token it also signs in",
    security: PUBLIC,
    request: { body: jsonBody(EnrollVerifyRequest) },
    responses: { 201: json(AuthPasskey, "Passkey registered"), ...errors },
  }),
  listPasskeys: createRoute({
    method: "get",
    path: "/passkeys",
    tags,
    summary: "List passkeys",
    responses: { 200: json(z.object({ items: z.array(AuthPasskey) }), "Passkeys"), 401: errors[401] },
  }),
  renamePasskey: createRoute({
    method: "patch",
    path: "/passkeys/{id}",
    tags,
    summary: "Rename a passkey",
    request: { params: IdParam, body: jsonBody(PasskeyRename) },
    responses: { 200: json(AuthPasskey, "Renamed"), ...errors, 404: json(ApiError, "Not found") },
  }),
  deletePasskey: createRoute({
    method: "delete",
    path: "/passkeys/{id}",
    tags,
    summary: "Delete a passkey",
    request: { params: IdParam },
    responses: { 204: { description: "Deleted" }, ...errors, 404: json(ApiError, "Not found") },
  }),
  listTokens: createRoute({
    method: "get",
    path: "/tokens",
    tags,
    summary: "List active API tokens",
    responses: { 200: json(z.object({ items: z.array(ApiTokenInfo) }), "Tokens"), 401: errors[401] },
  }),
  createToken: createRoute({
    method: "post",
    path: "/tokens",
    tags,
    summary: "Create an API token (plaintext returned once)",
    request: { body: jsonBody(ApiTokenCreate) },
    responses: { 201: json(ApiTokenCreated, "Created"), ...errors },
  }),
  revokeToken: createRoute({
    method: "delete",
    path: "/tokens/{id}",
    tags,
    summary: "Revoke an API token",
    request: { params: IdParam },
    responses: { 204: { description: "Revoked" }, ...errors, 404: json(ApiError, "Not found") },
  }),
};

/** `/api/v1/auth` routes (docs/spec.md §9 Auth row). Login and enrollment are public; the rest require auth. */
export function createAuthRoutes({ auth }: { auth: AuthService }): OpenAPIHono<AuthEnv> {
  const app = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });
  const authed = requireAuth(auth);
  for (const path of ["/passkeys", "/passkeys/*", "/tokens", "/tokens/*"]) app.use(path, authed);

  app.openapi(routes.session, (c) => {
    const info = resolveAuth(c, auth);
    if (!info) throw new AuthError("unauthorized", "Not signed in", 401);
    return c.json({ authenticated: true as const, via: info.kind }, 200);
  });

  app.openapi(routes.loginOptions, async (c) => {
    assertCsrf(c);
    return c.json(await auth.authenticationOptions(), 200);
  });

  app.openapi(routes.loginVerify, async (c) => {
    assertCsrf(c);
    const response = c.req.valid("json") as unknown as AuthenticationResponseJSON;
    setSessionCookie(c, auth, await auth.login(response));
    return c.json({ authenticated: true as const, via: "session" as const }, 200);
  });

  app.openapi(routes.logout, (c) => {
    assertCsrf(c);
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) auth.destroySession(sessionId);
    clearSessionCookie(c, auth);
    return c.body(null, 204);
  });

  app.openapi(routes.enrollOptions, async (c) => {
    assertCsrf(c);
    const { token } = c.req.valid("json");
    if (token !== undefined) auth.assertEnrollmentToken(token);
    else if (resolveAuth(c, auth)?.kind !== "session") {
      throw new AuthError("unauthorized", "An enrollment token or an active session is required", 401);
    }
    return c.json(await auth.registrationOptions(), 200);
  });

  app.openapi(routes.enrollVerify, async (c) => {
    assertCsrf(c);
    const { token, name, response } = c.req.valid("json");
    const registration = response as unknown as RegistrationResponseJSON;
    if (token === undefined) {
      if (resolveAuth(c, auth)?.kind !== "session") {
        throw new AuthError("unauthorized", "An enrollment token or an active session is required", 401);
      }
      return c.json(await auth.registerPasskey(registration, name), 201);
    }
    const passkey = await auth.registerPasskey(registration, name, token);
    setSessionCookie(c, auth, auth.createSession());
    return c.json(passkey, 201);
  });

  app.openapi(routes.listPasskeys, (c) => c.json({ items: auth.listPasskeys() }, 200));

  app.openapi(routes.renamePasskey, (c) => c.json(auth.renamePasskey(c.req.valid("param").id, c.req.valid("json").name), 200));

  app.openapi(routes.deletePasskey, (c) => {
    auth.deletePasskey(c.req.valid("param").id);
    return c.body(null, 204);
  });

  app.openapi(routes.listTokens, (c) => c.json({ items: auth.listApiTokens() }, 200));

  app.openapi(routes.createToken, (c) => c.json(auth.createApiToken(c.req.valid("json").name), 201));

  app.openapi(routes.revokeToken, (c) => {
    auth.revokeApiToken(c.req.valid("param").id);
    return c.body(null, 204);
  });

  return app;
}
