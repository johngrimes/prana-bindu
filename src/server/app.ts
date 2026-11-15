import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono, type MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Config } from "../config.js";
import type { AppDb } from "../db/connection.js";
import type { Domain } from "../domain/index.js";
import { handleMcpRequest } from "../mcp/http.js";
import type { BlobStore } from "../storage/types.js";
import { createApiRoutes } from "./api/routes.js";
import { createAuthRoutes, requireAuth, requireBearer, AuthService, SESSION_COOKIE, type AuthEnv } from "./auth/index.js";
import { errorResponse, handleError, validationHook } from "./errors.js";
import { idempotency } from "./idempotency.js";
import { createOAuthConsentRoutes } from "./oauth/consent.js";
import { createOAuthRoutes } from "./oauth/routes.js";
import { OAuthService } from "./oauth/service.js";
import { defaultWebDir, mountSpa } from "./static.js";

export interface AppDeps {
  config: Pick<Config, "origin" | "rpId" | "rpName">;
  db: AppDb;
  domain: Domain;
  blobStore: BlobStore;
  runImport: Parameters<typeof createApiRoutes>[0]["runImport"];
  /** Built SPA directory; defaults to `dist/web`. */
  webDir?: string;
  now?: () => Date;
}

const API_VERSION = "1.0.0";

/** One process: `/api/v1` (REST + OpenAPI), `/mcp` (bearer or OAuth), OAuth (`/oauth`, `/.well-known`), and the SPA with history fallback. */
export function createApp(deps: AppDeps): Hono {
  const auth = new AuthService(deps.db, deps.config, deps.now);
  const oauth = new OAuthService(deps.db, deps.config.origin, deps.now);
  const app = new Hono();
  app.onError(handleError);
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Attachment thumbnails may redirect to presigned object-storage URLs.
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
      strictTransportSecurity: deps.config.origin.startsWith("https:") ? "max-age=31536000; includeSubDomains" : false,
      crossOriginResourcePolicy: "same-origin",
      referrerPolicy: "same-origin",
    }),
  );

  const api = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });
  api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "API token created in Settings or with `prana-bindu token create <name>` (format `pb_…`).",
  });
  api.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: SESSION_COOKIE,
    description: "Browser session from passkey sign-in. Unsafe methods also require `X-Requested-With: prana-bindu`.",
  });
  api.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "prana-bindu API",
      version: API_VERSION,
      description:
        "Task management REST API. Errors use `{error: {code, message, details?}}`. " +
        "POST, PUT, PATCH and DELETE accept an optional `Idempotency-Key` header (1–200 characters): a repeat of the same method, path and key within 10 minutes replays the first response (unless it was a 5xx) instead of running again. " +
        "Their responses carry `X-Undo-Steps` (undo steps the request added: 1, 0 when nothing changed, -1 when a discard erased a creation) and, when it recorded one, `X-Undo-Step` (that step's id, as in the `undoId`/`redoId` of `GET /history`) and `X-Undo-Previous` (the step Undo reaches after it, 0 for none).",
    },
    servers: [{ url: `${deps.config.origin}/api/v1` }],
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  });

  const authed = requireAuth(auth);
  const protect: MiddlewareHandler<AuthEnv> = (c, next) =>
    /^\/api\/v1\/(auth\/|openapi\.json$)/.test(c.req.path) ? next() : authed(c, next);
  api.use("*", protect);
  // After authentication, so a replay never bypasses it.
  const idempotent = idempotency();
  api.use("*", (c, next) => (c.req.path.startsWith("/api/v1/auth/") ? next() : idempotent(c, next)));
  // Inside the idempotency cache, so a replayed answer carries the header too.
  api.use("*", async (c, next) => {
    if (c.req.method === "GET" || c.req.path.startsWith("/api/v1/auth/")) return next();
    const steps = await deps.domain.countUndoSteps(next);
    c.res.headers.set("X-Undo-Steps", String(steps.net));
    if (steps.last !== null) {
      c.res.headers.set("X-Undo-Step", String(steps.last));
      // 0 when the new step is the oldest one.
      c.res.headers.set("X-Undo-Previous", String(steps.previous ?? 0));
    }
  });
  api.route("/auth/oauth", createOAuthConsentRoutes({ auth, oauth }));
  api.route("/auth", createAuthRoutes({ auth }));
  api.route("/", createApiRoutes({ domain: deps.domain, blobStore: deps.blobStore, runImport: deps.runImport }));
  api.all("*", (c) => errorResponse(c, 404, "not_found", `No route for ${c.req.method} ${c.req.path}`));
  app.route("/api/v1", api);

  const mcpDeps = { domain: deps.domain, blobStore: deps.blobStore };
  app.all(
    "/mcp",
    // DNS-rebinding guard (MCP transport spec): browsers send Origin on cross-origin requests.
    async (c, next) => {
      const origin = c.req.header("Origin");
      if (origin !== undefined && origin !== deps.config.origin) return errorResponse(c, 403, "forbidden", "Origin not allowed");
      await next();
    },
    requireBearer(auth, oauth),
    (c) => handleMcpRequest(c, mcpDeps),
  );
  app.route("/", createOAuthRoutes(oauth));

  mountSpa(app, deps.webDir ?? defaultWebDir());
  app.notFound((c) => errorResponse(c, 404, "not_found", `No route for ${c.req.method} ${c.req.path}`));
  return app;
}
