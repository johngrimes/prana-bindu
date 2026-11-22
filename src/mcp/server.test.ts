import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createTestEnv } from "../domain/testkit.js";
import { handleMcpRequest } from "./http.js";
import { createMcpServer } from "./server.js";

async function connect() {
  const env = createTestEnv();
  const server = createMcpServer({ domain: env.domain, blobStore: env.blobStore });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return r as { structuredContent?: Record<string, unknown>; content: { type: string; text: string }[]; isError?: boolean };
  };
  return { env, client, call };
}

describe("MCP server", () => {
  it("exposes every tool from the spec", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "list_tasks", "get_task", "create_task", "update_task", "complete_task", "drop_task", "delete_task", "move_task",
        "add_tag_to_task", "remove_tag_from_task", "list_projects", "get_project", "create_project", "update_project",
        "delete_project", "mark_project_reviewed", "list_folders", "create_folder", "update_folder", "delete_folder",
        "list_tags", "create_tag", "update_tag", "delete_tag", "list_perspectives", "get_perspective_contents",
        "get_forecast", "get_review_queue", "search", "list_attachments", "get_attachment", "undo", "redo", "parse_date",
      ].sort(),
    );
    expect(client.getServerVersion()?.name).toBe("prana-bindu");
  });

  it("creates, tags, completes and queries tasks with structured results", async () => {
    const { call } = await connect();
    const project = await call("create_project", { name: "Garden", type: "sequential" });
    const projectId = project.structuredContent!.id as string;
    const task = await call("create_task", { name: "Water", projectId, dueDate: "tomorrow 8am" });
    expect(task.content[0]!.text).toMatch(/^Created task "Water"/);
    expect(task.structuredContent).toMatchObject({ dueDate: "2026-11-01T08:00:00.000", status: "dueSoon", projectId });
    const taskId = task.structuredContent!.id as string;

    const tag = await call("create_tag", { name: "Outside" });
    const tagged = await call("add_tag_to_task", { taskId, tagId: tag.structuredContent!.id });
    expect(tagged.structuredContent!.tagIds).toEqual([tag.structuredContent!.id]);

    const listed = await call("list_tasks", { projectId });
    expect((listed.structuredContent!.items as unknown[]).length).toBe(1);

    const contents = await call("get_perspective_contents", { perspective: "projects" });
    expect(contents.content[0]!.text).toBe("1 group, 2 rows");

    const forecast = await call("get_forecast", {});
    const days = forecast.structuredContent!.days as { key: string; count: number }[];
    expect(days.find((d) => d.key === "2026-11-01")!.count).toBe(1);

    const done = await call("complete_task", { id: taskId });
    expect(done.structuredContent!.changed).toHaveLength(1);
    const undone = await call("undo");
    expect(undone.structuredContent).toMatchObject({ canRedo: true, redoLabel: "Complete" });
    expect((await call("get_task", { id: taskId })).structuredContent!.completed).toBeNull();

    const found = await call("search", { q: "wat" });
    expect((found.structuredContent!.tasks as unknown[]).length).toBe(1);
    expect((await call("parse_date", { text: "next week", field: "defer" })).structuredContent).toEqual({ value: "2026-11-07T00:00:00.000" });
  });

  it("update_folder renames and moves as one undo step", async () => {
    const { env, call } = await connect();
    const parent = env.domain.createFolder({ name: "Parent" });
    const f = env.domain.createFolder({ name: "Child" });
    const r = await call("update_folder", { id: f.id, name: "Renamed", parentId: parent.id });
    expect(r.structuredContent).toMatchObject({ name: "Renamed", parentId: parent.id });
    await call("undo");
    expect(env.domain.getFolder(f.id)).toMatchObject({ name: "Child", parentId: null });
    const t = await call("update_tag", { id: env.domain.createTag({ name: "x" }).id, status: "onHold", parentId: null });
    expect(t.structuredContent).toMatchObject({ status: "onHold", parentId: null });
  });

  it("reports domain errors as tool errors and validates input", async () => {
    const { call } = await connect();
    const missing = await call("get_task", { id: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toBe("not_found: Task not found: nope");
    const badDate = await call("create_task", { name: "x", dueDate: "whenever" });
    expect(badDate.isError).toBe(true);
    expect(badDate.content[0]!.text).toMatch(/^parse_error/);
    const invalid = await call("complete_task", {});
    expect(invalid.isError).toBe(true);
  });

  it("returns text content for small text attachments only", async () => {
    const { env, call } = await connect();
    const t = env.domain.createTask({ name: "t" });
    const text = await env.domain.uploadAttachment(t.id, { name: "notes.md", bytes: new TextEncoder().encode("# Hi") });
    const bin = await env.domain.uploadAttachment(t.id, { name: "img.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]) });
    expect((await call("get_attachment", { id: text.id })).structuredContent).toMatchObject({ content: "# Hi", attachment: { contentType: "text/markdown" } });
    expect((await call("get_attachment", { id: bin.id })).structuredContent).toMatchObject({ content: null, attachment: { contentType: "image/png" } });
    expect(((await call("list_attachments", { taskId: t.id })).structuredContent!.items as unknown[]).length).toBe(2);
  });

  it("serves stateless streamable HTTP in JSON mode", async () => {
    const env = createTestEnv();
    const app = new Hono();
    app.all("/mcp", (c) => handleMcpRequest(c, { domain: env.domain, blobStore: env.blobStore }));
    const post = (body: unknown) =>
      app.request("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify(body),
      });
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    expect((await init.json()).result.serverInfo.name).toBe("prana-bindu");
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_task", arguments: { name: "via http" } } });
    const body = await res.json();
    expect(body.result.structuredContent.name).toBe("via http");
    expect(env.domain.listTasks({ inbox: true }).items.map((t) => t.name)).toEqual(["via http"]);
  });

  it("rejects GET and DELETE with 405 since stateless mode offers no SSE stream or session", async () => {
    const env = createTestEnv();
    const app = new Hono();
    app.all("/mcp", (c) => handleMcpRequest(c, { domain: env.domain, blobStore: env.blobStore }));
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request("/mcp", { method, headers: { accept: "text/event-stream", "mcp-protocol-version": "2025-06-18" } });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(await res.json()).toEqual({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    }
  });
});
