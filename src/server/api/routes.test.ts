import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createTestEnv } from "../../domain/testkit.js";
import type { ImportRun } from "../../shared/schemas.js";
import { createApiRoutes, type ImportSource } from "./routes.js";

function setup() {
  const env = createTestEnv();
  const imports: ImportSource[] = [];
  const run: ImportRun = { id: 1, importedAt: "2026-10-31T04:20:00.000Z", source: "x", appId: null, appVersion: null, counts: { tasks: 0 }, warnings: [] };
  const api = new OpenAPIHono();
  api.route("/", createApiRoutes({ domain: env.domain, blobStore: env.blobStore, runImport: async (s) => (imports.push(s), run) }));
  api.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "t", version: "1" } });
  const app = new OpenAPIHono();
  app.route("/api/v1", api);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { env, app, call, imports };
}

describe("REST API", () => {
  it("task lifecycle with natural-language dates, derived state and the error envelope", async () => {
    const { call } = setup();
    const created = await call("POST", "/tasks", { name: "Buy milk", dueDate: "tomorrow", deferDate: "today" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Buy milk", inInbox: true, dueDate: "2026-11-01T17:00:00.000", deferDate: "2026-10-31T00:00:00.000", status: "dueSoon" });
    const id = created.body.id as string;

    const patched = await call("PATCH", `/tasks/${id}`, { dueDate: "2026-11-05T09:00:00+10:00", flagged: true });
    expect(patched.body).toMatchObject({ dueDate: "2026-11-04T23:00:00.000Z", effectiveFlagged: true });

    const bad = await call("PATCH", `/tasks/${id}`, { dueDate: "someday maybe" });
    expect(bad.status).toBe(422);
    expect(bad.body).toEqual({ error: { code: "parse_error", message: "Unable to parse date: someday maybe", details: { field: "due", text: "someday maybe" } } });

    const invalid = await call("POST", "/tasks", { note: "no name" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("validation_error");

    const missing = await call("GET", "/tasks/nope");
    expect(missing).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });

    const done = await call("POST", `/tasks/${id}/complete`, { completed: true });
    expect(done.body.changed[0]).toMatchObject({ id, status: "completed" });
    expect((await call("GET", "/history")).body).toMatchObject({ canUndo: true, undoLabel: "Complete" });
    expect((await call("POST", "/undo")).body.canRedo).toBe(true);
    expect((await call("GET", `/tasks/${id}`)).body.completed).toBeNull();
    expect((await call("POST", "/redo")).status).toBe(200);
    expect((await call("POST", "/redo")).status).toBe(409);

    expect((await call("DELETE", `/tasks/${id}`)).status).toBe(204);
    expect((await call("GET", `/tasks/${id}`)).status).toBe(404);
  });

  it("projects, folders, tags, moves, outline, batch and cleanup", async () => {
    const { call } = setup();
    const folder = (await call("POST", "/folders", { name: "Work" })).body;
    const project = (await call("POST", "/projects", { name: "Launch", type: "sequential", folderId: folder.id })).body;
    expect(project).toMatchObject({ type: "sequential", folderId: folder.id, reviewInterval: { steps: 1, unit: "week" } });
    const a = (await call("POST", "/tasks", { name: "a", projectId: project.id })).body;
    const b = (await call("POST", "/tasks", { name: "b", position: { after: a.id } })).body;
    expect(b.projectId).toBe(project.id);
    expect(b.status).toBe("blocked");

    const outline = await call("POST", "/tasks/outline", { op: "indent", ids: [b.id] });
    expect(outline.body.changed.map((t: { id: string }) => t.id)).toContain(b.id);
    expect((await call("GET", `/tasks/${a.id}`)).body.children.map((t: { name: string }) => t.name)).toEqual(["b"]);

    const tag = (await call("POST", "/tags", { name: "Home" })).body;
    expect((await call("POST", `/tasks/${a.id}/tags`, { tagId: tag.id })).body.tagIds).toEqual([tag.id]);
    expect((await call("GET", "/tags")).body.items[0]).toMatchObject({ name: "Home", remainingCount: 1 });
    expect((await call("DELETE", `/tasks/${a.id}/tags/${tag.id}`)).body.tagIds).toEqual([]);

    const batch = await call("POST", "/tasks/batch", { ids: [a.id, b.id], patch: { flagged: true } });
    expect(batch.body.changed.every((t: { flagged: boolean }) => t.flagged)).toBe(true);

    const inbox = (await call("POST", "/tasks", { name: "file me" })).body;
    await call("PATCH", `/tasks/${inbox.id}`, { assignedProjectId: project.id });
    const cleaned = await call("POST", "/cleanup");
    expect(cleaned.body.changed[0]).toMatchObject({ id: inbox.id, projectId: project.id, inInbox: false });

    const moved = await call("POST", `/tasks/${inbox.id}/move`, { inbox: true, position: "start" });
    expect(moved.body.changed[0]).toMatchObject({ inInbox: true });

    expect((await call("PATCH", `/projects/${project.id}`, { status: "onHold" })).body).toMatchObject({ status: "onHold" });
    const both = await call("POST", "/projects/batch", { ids: [project.id], patch: { status: "active", type: "parallel" } });
    expect(both.body.items[0]).toMatchObject({ status: "active", type: "parallel" });
    expect((await call("POST", `/projects/${project.id}/review`)).body.lastReview).toBe("2026-10-31T04:20:00.000Z");
    const other = (await call("POST", "/folders", { name: "Other" })).body;
    expect((await call("POST", `/projects/${project.id}/move`, { parentId: other.id, position: "end" })).body.folderId).toBe(other.id);
    expect((await call("GET", `/projects?folderId=${other.id}`)).body.items).toHaveLength(1);
    expect((await call("POST", `/folders/${folder.id}/move`, { parentId: other.id })).body.parentId).toBe(other.id);
    expect((await call("POST", `/folders/${other.id}/move`, { parentId: folder.id })).status).toBe(422);
    expect((await call("DELETE", `/folders/${other.id}`)).status).toBe(204);
    expect((await call("GET", "/projects")).body.items).toEqual([]);
  });

  it("lists tasks with filters and cursor pagination", async () => {
    const { call } = setup();
    for (let i = 0; i < 5; i++) await call("POST", "/tasks", { name: `t${i}`, flagged: i % 2 === 0, dueDate: i < 2 ? "tomorrow" : null });
    const page1 = await call("GET", "/tasks?limit=2");
    expect(page1.body.items.map((t: { name: string }) => t.name)).toEqual(["t0", "t1"]);
    const page2 = await call("GET", `/tasks?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((t: { name: string }) => t.name)).toEqual(["t2", "t3"]);
    expect((await call("GET", "/tasks?flagged=true")).body.items).toHaveLength(3);
    expect((await call("GET", "/tasks?dueBefore=next%20week")).body.items).toHaveLength(2);
    expect((await call("GET", "/tasks?q=T4")).body.items).toHaveLength(1);
    expect((await call("GET", "/tasks?perspective=flagged")).body.items).toHaveLength(3);
    expect((await call("GET", "/tasks?limit=0")).status).toBe(400);
  });

  it("perspectives, contents, view options, forecast, review, search and quick open", async () => {
    const { call } = setup();
    await call("POST", "/tasks", { name: "due", dueDate: "today 6pm" });
    const list = (await call("GET", "/perspectives")).body.items;
    expect(list.map((p: { id: string }) => p.id)).toEqual(["inbox", "projects", "tags", "forecast", "flagged", "review", "completed", "changed", "search"]);
    const inbox = (await call("GET", "/perspectives/inbox/contents")).body;
    expect(inbox.groups[0].rows[0].task.name).toBe("due");
    const vo = await call("PUT", "/perspectives/inbox/view-options", { filter: "all" });
    expect(vo.body.viewOptions.filter).toBe("all");
    expect((await call("PATCH", "/perspectives/inbox", { name: "Renamed" })).status).toBe(422);
    expect((await call("PATCH", "/perspectives/inbox", { favorite: false })).body.favorite).toBe(false);
    expect((await call("DELETE", "/perspectives/inbox")).status).toBe(422);

    const custom = (await call("POST", "/perspectives", { name: "Due", rules: [{ actionStatus: "due" }], presentation: { layout: "flat" } })).body;
    expect((await call("GET", `/perspectives/${custom.id}/contents`)).body.groups[0].rows).toHaveLength(1);

    const forecast = (await call("GET", "/forecast")).body;
    expect(forecast.days.find((d: { key: string }) => d.key === "TODAY").count).toBe(1);
    expect((await call("GET", "/forecast?from=2026-11-01&days=2")).body.days).toHaveLength(4);
    expect((await call("GET", "/forecast?from=nope")).status).toBe(400);
    expect((await call("GET", "/perspectives/forecast/contents?day=TODAY")).body.groups.map((g: { key: string }) => g.key)).toEqual(["TODAY"]);

    expect((await call("GET", "/review")).body.items).toEqual([]);
    expect((await call("GET", "/search?q=DU")).body.tasks).toHaveLength(1);
    expect((await call("GET", "/quick-open?q=inb")).body.items[0]).toMatchObject({ type: "perspective", id: "inbox" });
    expect(await call("GET", "/quick-open")).toMatchObject({ status: 200, body: { items: [] } });
  });

  it("multi-select complete/drop are single undo steps; repeating projects complete via either endpoint", async () => {
    const { call } = setup();
    const a = (await call("POST", "/tasks", { name: "a" })).body;
    const b = (await call("POST", "/tasks", { name: "b" })).body;
    const done = await call("POST", "/tasks/complete", { ids: [a.id, b.id], completed: true });
    expect(done.body.changed.map((t: { status: string }) => t.status)).toEqual(["completed", "completed"]);
    await call("POST", "/undo");
    expect((await call("GET", "/tasks?inbox=true")).body.items).toHaveLength(2);
    const dropped = await call("POST", "/tasks/drop", { ids: [a.id, b.id], dropped: true });
    expect(dropped.body.changed).toHaveLength(2);
    expect((await call("GET", "/history")).body.undoLabel).toBe("Drop");
    expect((await call("POST", "/tasks/complete", { ids: [], completed: true })).status).toBe(400);

    const tag = (await call("POST", "/tags", { name: "T" })).body;
    const tagged = await call("POST", "/tasks/tags", { ids: [a.id, b.id], add: [tag.id] });
    expect(tagged.body.changed.map((t: { tagIds: string[] }) => t.tagIds)).toEqual([[tag.id], [tag.id]]);
    const proj = (await call("POST", "/projects", { name: "Dest" })).body;
    const moved = await call("POST", "/tasks/move", { ids: [b.id, a.id], projectId: proj.id, position: "end" });
    expect(moved.status).toBe(200);
    expect((await call("GET", `/tasks/${proj.id}`)).body.children.map((t: { name: string }) => t.name)).toEqual(["a", "b"]);

    const blank = (await call("POST", "/tasks", { name: "" })).body;
    const historyBefore = (await call("POST", "/undo")).body; // undo the creation to read the prior labels…
    await call("POST", "/redo"); // …and bring the task back
    expect((await call("POST", `/tasks/${blank.id}/discard`)).status).toBe(204);
    expect((await call("GET", `/tasks/${blank.id}`)).status).toBe(404);
    expect((await call("GET", "/history")).body).toEqual({ ...historyBefore, canRedo: false, redoLabel: null, redoId: null });
    expect((await call("POST", "/tasks/nope/discard")).status).toBe(404);

    const status = await call("POST", "/tasks/status", { ids: [a.id, b.id, a.id], status: "completed" });
    expect(status.body.changed.map((t: { status: string }) => t.status)).toEqual(["completed", "completed"]);
    expect((await call("POST", "/tasks/status", { ids: [a.id], status: "paused" })).status).toBe(400);
    expect((await call("POST", "/delete", { taskIds: [a.id], tagIds: ["missing"] })).status).toBe(404);
    expect((await call("POST", "/delete", { taskIds: [a.id, b.id], projectIds: [proj.id], tagIds: [tag.id] })).status).toBe(204);
    expect((await call("GET", `/projects/${proj.id}`)).status).toBe(404);
    expect((await call("GET", "/history")).body.undoLabel).toBe("Delete Items");

    const repeat = { rule: "FREQ=WEEKLY", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: false };
    const p = (await call("POST", "/projects", { name: "Weekly", dueDate: "2026-11-02T09:00:00.000", repeat })).body;
    const res = await call("POST", `/tasks/${p.id}/complete`, { completed: true });
    expect(res.status).toBe(200);
    expect((await call("GET", `/projects/${p.id}.0`)).body.status).toBe("completed");
    const patched = await call("PATCH", `/projects/${p.id}`, { status: "completed" });
    expect(patched.body).toMatchObject({ status: "active", task: { dueDate: "2026-11-16T09:00:00.000" } });
    expect((await call("GET", `/projects/${p.id}.1`)).body.status).toBe("completed");
  });

  it("settings and parse", async () => {
    const { call } = setup();
    expect((await call("GET", "/settings")).body).toMatchObject({ timeZone: "Australia/Brisbane", defaultDueTime: "17:00", dueSoonSeconds: 172800 });
    expect((await call("PATCH", "/settings", { defaultDueTime: "09:00" })).body.defaultDueTime).toBe("09:00");
    expect((await call("PATCH", "/settings", { timeZone: "Mars/Olympus" })).status).toBe(400);
    expect((await call("POST", "/parse", { kind: "date", text: "tom", field: "due" })).body).toEqual({ value: "2026-11-01T09:00:00.000" });
    expect((await call("POST", "/parse", { kind: "duration", text: "1h30m" })).body).toEqual({ value: 90 });
    expect((await call("POST", "/parse", { kind: "date", text: "gibberish" })).status).toBe(422);
    expect((await call("POST", "/settings/reset")).body.defaultDueTime).toBe("17:00");
  });

  it("attachments: multipart upload, metadata, streamed download, delete", async () => {
    const { call, app } = setup();
    const task = (await call("POST", "/tasks", { name: "with file" })).body;
    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("hello world")], "hello.txt", { type: "text/plain" }));
    const up = await app.request(`/api/v1/tasks/${task.id}/attachments`, { method: "POST", body: form });
    expect(up.status).toBe(201);
    const att = await up.json();
    expect(att).toMatchObject({ name: "hello.txt", size: 11, contentType: "text/plain" });
    expect((await call("GET", `/tasks/${task.id}/attachments`)).body.items).toHaveLength(1);
    expect((await call("GET", `/attachments/${att.id}`)).body.sha256).toBe(att.sha256);
    const dl = await app.request(`/api/v1/attachments/${att.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain('filename="hello.txt"');
    expect(await dl.text()).toBe("hello world");
    expect((await call("GET", `/tasks/${task.id}`)).body.attachments).toHaveLength(1);
    expect((await call("DELETE", `/attachments/${att.id}`)).status).toBe(204);
    expect((await call("GET", `/attachments/${att.id}`)).status).toBe(404);
  });

  it("rejects attachments over 100 MB with 413", async () => {
    const { call, app } = setup();
    const task = (await call("POST", "/tasks", { name: "big" })).body;
    const res = await app.request(`/api/v1/tasks/${task.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(101 * 1024 * 1024) },
      body: "--x--",
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
  });

  it("redirects downloads when the blob store offers a URL", async () => {
    const { env, call, app } = setup();
    const task = (await call("POST", "/tasks", { name: "t" })).body;
    const att = await env.domain.uploadAttachment(task.id, { name: "a.pdf", bytes: new TextEncoder().encode("%PDF-1.4") });
    expect(att.contentType).toBe("application/pdf");
    env.blobStore.downloadUrl = async () => "https://example.test/signed";
    const res = await app.request(`/api/v1/attachments/${att.id}/download`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.test/signed");
  });

  it("import accepts multipart or {url} and reports the last run", async () => {
    const { call, app, imports } = setup();
    expect((await call("GET", "/import/last")).body).toEqual({ run: null });
    expect((await call("POST", "/import", { url: "https://example.test/OmniFocus.zip" })).body.counts).toEqual({ tasks: 0 });
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x50, 0x4b, 3, 4])], "OmniFocus.zip"));
    expect((await app.request("/api/v1/import", { method: "POST", body: form })).status).toBe(200);
    expect(imports[0]).toEqual({ url: "https://example.test/OmniFocus.zip" });
    expect(imports[1]).toMatchObject({ name: "OmniFocus.zip" });
    expect((await call("POST", "/import", { nope: 1 })).status).toBe(400);
  });

  it("publishes an OpenAPI document covering the resources", async () => {
    const { call } = setup();
    const doc = (await call("GET", "/openapi.json")).body;
    for (const path of ["/tasks", "/tasks/{id}/complete", "/perspectives/{id}/contents", "/forecast", "/undo", "/parse", "/import", "/attachments/{id}/download"]) {
      expect(doc.paths[path], path).toBeDefined();
    }
  });

  it.each([
    ["/tasks", { name: "t" }],
    ["/projects", { name: "p" }],
    ["/folders", { name: "f" }],
    ["/tags", { name: "g" }],
    ["/perspectives", { name: "v" }],
  ])("POST %s accepts a client-supplied id, rejects duplicates (409) and malformed ids (400)", async (path, input) => {
    const { call } = setup();
    const id = `client_${path.slice(1)}-0001`;
    const created = await call("POST", path, { ...input, id });
    expect(created.status).toBe(201);
    expect(created.body.id).toBe(id);
    expect((await call("GET", `${path}/${id}`)).body.id).toBe(id);
    const dup = await call("POST", path, { ...input, id });
    expect(dup).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
    for (const bad of ["short", "has/slash12", "has space12", "x".repeat(65), ""]) {
      expect((await call("POST", path, { ...input, id: bad })).status, bad).toBe(400);
    }
  });

  it("client task ids collide with project ids and built-in perspective ids", async () => {
    const { call } = setup();
    const p = (await call("POST", "/projects", { name: "p" })).body;
    expect((await call("POST", "/tasks", { name: "t", id: p.id })).status).toBe(409);
    const t = (await call("POST", "/tasks", { name: "t" })).body;
    expect((await call("POST", "/projects", { name: "p", id: t.id })).status).toBe(409);
    expect((await call("POST", "/perspectives", { name: "v", id: "forecast" })).status).toBe(409);
    const doc = (await call("GET", "/openapi.json")).body;
    for (const path of ["/tasks", "/projects", "/folders", "/tags", "/perspectives"]) expect(doc.paths[path].post.responses["409"], path).toBeDefined();
    expect(doc.paths["/tasks"].post.requestBody.content["application/json"].schema.properties.id).toMatchObject({ pattern: "^[A-Za-z0-9_-]{8,64}$", description: expect.stringContaining("409") });
  });

  it("outline group uses a client-supplied groupId", async () => {
    const { call } = setup();
    const a = (await call("POST", "/tasks", { name: "a" })).body;
    const b = (await call("POST", "/tasks", { name: "b" })).body;
    const grouped = await call("POST", "/tasks/outline", { op: "group", ids: [a.id, b.id], groupId: "group-0001" });
    expect(grouped.status).toBe(200);
    expect((await call("GET", "/tasks/group-0001")).body.children.map((t: { id: string }) => t.id)).toEqual([a.id, b.id]);
    expect((await call("POST", "/tasks/outline", { op: "group", ids: [a.id], groupId: "group-0001" })).status).toBe(409);
    expect((await call("POST", "/tasks/outline", { op: "group", ids: [a.id], groupId: "x/y" })).status).toBe(400);
  });
});
