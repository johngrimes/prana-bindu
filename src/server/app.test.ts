import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection.js";
import { createDomain } from "../domain/index.js";
import { FsBlobStore } from "../storage/fs.js";
import { createApp } from "./app.js";
import { AuthService } from "./auth/service.js";

const ORIGIN = "http://localhost:3000";
const config = { origin: ORIGIN, rpId: "localhost", rpName: "prana-bindu" };

describe("createApp", () => {
  let dir: string;
  let app: Hono;
  let bearer: Record<string, string>;
  let auth: AuthService;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pb-app-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>prana-bindu</title>");
    writeFileSync(join(webDir, "assets", "app-abc123.js"), "console.log(1)");
    const handle = openDatabase(":memory:");
    const blobStore = new FsBlobStore(join(dir, "data"));
    const domain = createDomain({ ...handle, blobStore });
    app = createApp({
      config,
      db: handle.db,
      domain,
      blobStore,
      runImport: () => Promise.reject(new Error("not used")),
      webDir,
    });
    auth = new AuthService(handle.db, config);
    bearer = { Authorization: `Bearer ${auth.createApiToken("test").plaintext}` };
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  describe("SPA", () => {
    it("serves files, with immutable caching for hashed assets", async () => {
      const res = await app.request("/assets/app-abc123.js");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("console.log(1)");
      expect(res.headers.get("cache-control")).toContain("immutable");
    });

    it("falls back to index.html for client routes, including ids containing dots", async () => {
      for (const path of ["/", "/inbox", "/projects?project=abc", "/perspectives/abc.12/edit"]) {
        const res = await app.request(path, { headers: { Accept: "text/html" } });
        expect(res.status, path).toBe(200);
        expect(await res.text()).toContain("<title>prana-bindu</title>");
        expect(res.headers.get("cache-control")).toBe("no-cache");
      }
    });

    it("returns 404 for missing assets instead of the shell", async () => {
      const res = await app.request("/assets/app-old.js", { headers: { Accept: "*/*" } });
      expect(res.status).toBe(404);
    });

    it("never falls back for /api or /mcp", async () => {
      const api = await app.request("/api/v1/nope", { headers: { ...bearer, Accept: "text/html" } });
      expect(api.status).toBe(404);
      expect((await api.json()).error.code).toBe("not_found");
      const apiRoot = await app.request("/api", { headers: { Accept: "text/html" } });
      expect(apiRoot.status).toBe(404);
      expect(apiRoot.headers.get("content-type")).toContain("application/json");
    });

    it("sends security headers", async () => {
      const res = await app.request("/inbox", { headers: { Accept: "text/html" } });
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
  });

  describe("API", () => {
    it("publishes a public OpenAPI 3.1 document with both security schemes and auth + domain paths", async () => {
      const res = await app.request("/api/v1/openapi.json");
      expect(res.status).toBe(200);
      const doc = await res.json();
      expect(doc.openapi).toBe("3.1.0");
      expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(["bearerAuth", "cookieAuth"]);
      expect(doc.paths["/auth/login/verify"].post.security).toEqual([]);
      expect(doc.paths["/auth/tokens"]).toBeDefined();
      expect(doc.paths["/tasks"]).toBeDefined();
    });

    it("protects domain routes and accepts bearer tokens", async () => {
      const anon = await app.request("/api/v1/settings");
      expect(anon.status).toBe(401);
      expect(await anon.json()).toEqual({ error: { code: "unauthorized", message: "Authentication required" } });
      expect((await app.request("/api/v1/settings", { headers: bearer })).status).toBe(200);
    });

    it("leaves login and session endpoints public", async () => {
      expect((await app.request("/api/v1/auth/session")).status).toBe(401);
      const res = await app.request("/api/v1/auth/login/options", { method: "POST", headers: { "X-Requested-With": "prana-bindu" } });
      expect(res.status).toBe(200);
    });

    it("requires a bearer token for /mcp", async () => {
      const res = await app.request("/mcp", { method: "POST" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    });

    // The "Add to inbox" Shortcut (docs/spec.md §15) sends exactly this request, treats an `id` in
    // the answer as success and speaks `error.message` otherwise. It has no tests of its own.
    it("serves the Siri Shortcut: bearer JSON POST to /tasks without the CSRF header", async () => {
      const siri = auth.createApiToken("Siri");
      const send = (name: string) =>
        app.request("/api/v1/tasks", {
          method: "POST",
          headers: { Authorization: `Bearer ${siri.plaintext}`, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ name }),
        });

      const said = "Call Mum’s office tomorrow 3pm #errands 📞";
      const res = await send(said);
      expect(res.status).toBe(201);
      const task = await res.json();
      expect(task.id).toEqual(expect.any(String));
      expect(task).toMatchObject({ name: said, inInbox: true, parentId: null, dueDate: null, deferDate: null, tagIds: [], flagged: false });
      const inbox = await (await app.request("/api/v1/tasks?inbox=true", { headers: bearer })).json();
      expect(inbox.items.map((t: { id: string }) => t.id)).toContain(task.id);

      auth.revokeApiToken(siri.token.id);
      const revoked = await send("Buy milk");
      expect(revoked.status).toBe(401);
      expect((await revoked.json()).error.message).toBe("The bearer token is invalid or revoked");
    });
  });

  describe("Idempotency-Key", () => {
    const post = (path: string, body: unknown, key?: string, auth = true) =>
      app.request(`/api/v1${path}`, {
        method: "POST",
        headers: { ...(auth ? bearer : {}), "content-type": "application/json", ...(key === undefined ? {} : { "Idempotency-Key": key }) },
        body: JSON.stringify(body),
      });
    const count = async (name: string) => {
      const res = await app.request(`/api/v1/tasks?q=${encodeURIComponent(name)}&availability=all`, { headers: bearer });
      return ((await res.json()).items as { name: string }[]).filter((t) => t.name === name).length;
    };
    const snapshot = async (res: Response) => ({ status: res.status, type: res.headers.get("content-type"), body: await res.text() });

    it("replays the first response for a repeated key without re-running the handler", async () => {
      const first = await snapshot(await post("/tasks", { name: "idem-once" }, "key-once"));
      const second = await snapshot(await post("/tasks", { name: "idem-once" }, "key-once"));
      expect(first.status).toBe(201);
      expect(first.type).toContain("application/json");
      expect(second).toEqual(first);
      expect(await count("idem-once")).toBe(1);
    });

    it("executes requests with different keys, no key, or an out-of-range key separately", async () => {
      expect((await post("/tasks", { name: "idem-diff" }, "key-diff-1")).status).toBe(201);
      expect((await post("/tasks", { name: "idem-diff" }, "key-diff-2")).status).toBe(201);
      expect(await count("idem-diff")).toBe(2);
      await post("/tasks", { name: "idem-none" });
      await post("/tasks", { name: "idem-none" });
      expect(await count("idem-none")).toBe(2);
      const long = "k".repeat(201);
      await post("/tasks", { name: "idem-long" }, long);
      await post("/tasks", { name: "idem-long" }, long);
      expect(await count("idem-long")).toBe(2);
    });

    it("makes a concurrent duplicate wait for and replay the in-flight request", async () => {
      const [a, b] = await Promise.all([post("/tasks", { name: "idem-race" }, "key-race"), post("/tasks", { name: "idem-race" }, "key-race")]);
      expect(await snapshot(b)).toEqual(await snapshot(a));
      expect(await count("idem-race")).toBe(1);
    });

    it("scopes keys to method and path", async () => {
      expect((await post("/tasks", { name: "idem-scope" }, "key-scope")).status).toBe(201);
      const folder = await post("/folders", { name: "idem-scope-folder" }, "key-scope");
      expect(folder.status).toBe(201);
      expect((await folder.json()).name).toBe("idem-scope-folder");
    });

    it("replays client errors", async () => {
      const bad = await snapshot(await post("/tasks", { note: "no name" }, "key-4xx"));
      expect(bad.status).toBe(400);
      expect(await snapshot(await post("/tasks", { name: "idem-4xx" }, "key-4xx"))).toEqual(bad);
      expect(await count("idem-4xx")).toBe(0);
    });

    it("never replays to an unauthenticated request", async () => {
      expect((await post("/tasks", { name: "idem-auth" }, "key-auth")).status).toBe(201);
      const anon = await post("/tasks", { name: "idem-auth" }, "key-auth", false);
      expect(anon.status).toBe(401);
      expect((await anon.json()).error.code).toBe("unauthorized");
    });

    it("passes multipart uploads through and replays them", async () => {
      const task = await (await post("/tasks", { name: "idem-upload" })).json();
      const upload = () => {
        const form = new FormData();
        form.append("file", new File([new TextEncoder().encode("hi")], "hi.txt", { type: "text/plain" }));
        return app.request(`/api/v1/tasks/${task.id}/attachments`, { method: "POST", headers: { ...bearer, "Idempotency-Key": "key-upload" }, body: form });
      };
      const first = await snapshot(await upload());
      expect(first.status).toBe(201);
      expect(await snapshot(await upload())).toEqual(first);
      const list = await app.request(`/api/v1/tasks/${task.id}/attachments`, { headers: bearer });
      expect((await list.json()).items).toHaveLength(1);
    });

    it("is documented in the OpenAPI description", async () => {
      const doc = await (await app.request("/api/v1/openapi.json")).json();
      expect(doc.info.description).toContain("Idempotency-Key");
    });
  });

  describe("X-Undo-Steps", () => {
    const send = (method: string, path: string, body?: unknown, key?: string) =>
      app.request(`/api/v1${path}`, {
        method,
        headers: { ...bearer, "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    it("reports the undo steps each write added, including none and an erased creation", async () => {
      const created = await send("POST", "/tasks", { name: "steps" });
      expect(created.headers.get("x-undo-steps")).toBe("1");
      const { id } = await created.json();
      expect((await send("PATCH", `/tasks/${id}`, { flagged: true })).headers.get("x-undo-steps")).toBe("1");
      // Clean Up with nothing to file away changes nothing, so it records no undo step.
      expect((await send("POST", "/cleanup", {})).headers.get("x-undo-steps")).toBe("0");
      const fresh = await (await send("POST", "/tasks", { name: "" })).json();
      expect((await send("POST", `/tasks/${fresh.id}/discard`, {})).headers.get("x-undo-steps")).toBe("-1");
      expect((await send("POST", "/tasks/missing/complete", { completed: true })).headers.get("x-undo-steps")).toBe("0");
    });

    it("names the step a write added, which history then reports for undo and, once undone, for redo", async () => {
      const created = await send("POST", "/tasks", { name: "step-id" });
      const step = Number(created.headers.get("x-undo-step"));
      expect(step).toBeGreaterThan(0);
      expect((await (await app.request("/api/v1/history", { headers: bearer })).json()).undoId).toBe(step);
      const undone = await (await send("POST", "/undo", {})).json();
      expect(undone.redoId).toBe(step);
      expect(undone.undoId).not.toBe(step);
      expect((await send("POST", "/cleanup", {})).headers.get("x-undo-step")).toBeNull();
    });

    it("names the step each new step follows, so a client can tell whether others came in between", async () => {
      const first = Number((await send("POST", "/tasks", { name: "step-chain" })).headers.get("x-undo-step"));
      const second = await send("POST", "/tasks", { name: "step-chain-2" });
      expect(Number(second.headers.get("x-undo-previous"))).toBe(first);
    });

    it("is replayed with an idempotent answer", async () => {
      const first = await send("POST", "/tasks", { name: "steps-replay" }, "steps-key");
      const again = await send("POST", "/tasks", { name: "steps-replay" }, "steps-key");
      expect([first.headers.get("x-undo-steps"), again.headers.get("x-undo-steps")]).toEqual(["1", "1"]);
    });
  });
});
