import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { ApiError, ConnectedApp, OAuthAuthorizationRequestInfo, OAuthRedirect } from "../../shared/schemas.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { AuthError, type AuthService } from "../auth/service.js";
import { validationHook } from "../errors.js";
import type { OAuthService } from "./service.js";

const tags = ["Auth"];
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const IdParam = z.object({ id: z.string().min(1) });
const errors = {
  401: json(ApiError, "Not authenticated"),
  403: json(ApiError, "Requires a browser session, or the X-Requested-With: prana-bindu header is missing"),
  404: json(ApiError, "Unknown, expired or already decided"),
};
const REQUEST_GONE = "This authorization request has expired or was already used";

const routes = {
  getRequest: createRoute({
    method: "get",
    path: "/requests/{id}",
    tags,
    summary: "Pending OAuth authorization request (consent page; browser session only)",
    request: { params: IdParam },
    responses: { 200: json(OAuthAuthorizationRequestInfo, "Request"), ...errors },
  }),
  approve: createRoute({
    method: "post",
    path: "/requests/{id}/approve",
    tags,
    summary: "Approve an OAuth authorization request; returns the client redirect carrying the code",
    request: { params: IdParam },
    responses: { 200: json(OAuthRedirect, "Approved"), ...errors },
  }),
  deny: createRoute({
    method: "post",
    path: "/requests/{id}/deny",
    tags,
    summary: "Deny an OAuth authorization request; returns the client redirect carrying access_denied",
    request: { params: IdParam },
    responses: { 200: json(OAuthRedirect, "Denied"), ...errors },
  }),
  listApps: createRoute({
    method: "get",
    path: "/grants",
    tags,
    summary: "Connected apps: OAuth clients approved to use the MCP server, newest first",
    responses: { 200: json(z.object({ items: z.array(ConnectedApp) }), "Connected apps"), 401: errors[401] },
  }),
  disconnect: createRoute({
    method: "delete",
    path: "/grants/{id}",
    tags,
    summary: "Disconnect an app: revokes its grant and every token it holds",
    request: { params: IdParam },
    responses: { 204: { description: "Disconnected" }, 401: errors[401], 403: errors[403], 404: json(ApiError, "Not found") },
  }),
};

/**
 * `/api/v1/auth/oauth`: OAuth consent for the SPA page `/authorize?request=<id>` and the Settings "Connected
 * apps" list. Consent is a human decision, so the request routes accept only the browser session.
 */
export function createOAuthConsentRoutes({ auth, oauth }: { auth: AuthService; oauth: OAuthService }): OpenAPIHono<AuthEnv> {
  const app = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });
  app.use("*", requireAuth(auth));
  app.use("/requests/*", async (c, next) => {
    if (c.var.auth.kind !== "session") throw new AuthError("session_required", "Approving apps requires signing in with a passkey", 403);
    await next();
  });

  app.openapi(routes.getRequest, (c) => {
    const info = oauth.describeRequest(c.req.valid("param").id);
    if (!info) throw new AuthError("not_found", REQUEST_GONE, 404);
    return c.json(info, 200);
  });

  app.openapi(routes.approve, (c) => {
    const redirectTo = oauth.approve(c.req.valid("param").id);
    if (!redirectTo) throw new AuthError("not_found", REQUEST_GONE, 404);
    return c.json({ redirectTo }, 200);
  });

  app.openapi(routes.deny, (c) => {
    const redirectTo = oauth.deny(c.req.valid("param").id);
    if (!redirectTo) throw new AuthError("not_found", REQUEST_GONE, 404);
    return c.json({ redirectTo }, 200);
  });

  app.openapi(routes.listApps, (c) => c.json({ items: oauth.listConnectedApps() }, 200));

  app.openapi(routes.disconnect, (c) => {
    if (!oauth.deleteGrant(c.req.valid("param").id)) throw new AuthError("not_found", "Connected app not found", 404);
    return c.body(null, 204);
  });

  return app;
}
