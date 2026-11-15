import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { errorResponse } from "./errors.js";

/** Built SPA directory: `dist/web` from `src/server` (tsx/vitest) or `dist/server/server` (built). */
export function defaultWebDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.split(sep).includes("dist") ? resolve(here, "../../web") : resolve(here, "../../dist/web");
}

/** Paths owned by the API, MCP and OAuth; never answered with the SPA shell. */
const isServerPath = (path: string): boolean => /^\/(api|mcp|oauth)(\/|$)|^\/\.well-known\/oauth-/.test(path);

/**
 * Serves files from `webDir` and falls back to `index.html` for other GET/HEAD navigations
 * (client-side routes). Hashed `/assets/*` are cached immutably; the shell is never cached.
 */
export function mountSpa(app: Hono, webDir: string): void {
  const indexFile = join(webDir, "index.html");
  let indexHtml: string | undefined;

  const serveFiles = serveStatic({ root: webDir });
  app.use("*", async (c, next) => {
    if (isServerPath(c.req.path)) return next();
    const res = await serveFiles(c, next);
    if (res instanceof Response && res.ok) {
      res.headers.set("Cache-Control", c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    }
    return res;
  });

  app.on(["GET", "HEAD"], "*", (c) => {
    if (isServerPath(c.req.path)) return errorResponse(c, 404, "not_found", `No route for ${c.req.method} ${c.req.path}`);
    // Missing static assets (e.g. `/assets/old-hash.js`, `/favicon.png`) are real 404s, not the SPA shell.
    if (/\.[a-z0-9]+$/i.test(c.req.path) && !c.req.header("Accept")?.includes("text/html")) {
      return c.text("Not found", 404);
    }
    if (indexHtml === undefined) {
      if (!existsSync(indexFile)) return c.text("Web client not built (run `npm run build`).", 404);
      indexHtml = readFileSync(indexFile, "utf8");
    }
    c.header("Cache-Control", "no-cache");
    return c.html(indexHtml);
  });
}
