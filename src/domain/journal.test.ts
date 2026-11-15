import { describe, expect, it } from "vitest";
import { blobKey } from "../storage/types.js";
import { MAX_GROUPS } from "./journal.js";
import { createTestEnv } from "./testkit.js";

const count = (env: ReturnType<typeof createTestEnv>, table: string) =>
  (env.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("undo/redo journal", () => {
  it("undoes and redoes a mutation as one group", () => {
    const env = createTestEnv();
    const d = env.domain;
    const t = d.createTask({ name: "before" });
    d.updateTask(t.id, { name: "after", flagged: true });
    expect(d.history()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: "Edit Action", redoLabel: null });
    d.undo();
    expect(d.getTask(t.id)).toMatchObject({ name: "before", flagged: false });
    expect(d.history()).toMatchObject({ canUndo: true, canRedo: true, undoLabel: "Add Action", redoLabel: "Edit Action" });
    d.redo();
    expect(d.getTask(t.id)).toMatchObject({ name: "after", flagged: true });
    d.undo();
    d.undo();
    expect(() => d.getTask(t.id)).toThrow(/not found/);
    expect(() => d.undo()).toThrow(/Nothing to undo/);
    d.redo();
    expect(d.getTask(t.id).name).toBe("before");
  });

  it("restores multi-row operations (delete with descendants and tags; repeat clones)", async () => {
    const env = createTestEnv();
    const d = env.domain;
    const p = d.createProject({ name: "P" });
    const tag = d.createTag({ name: "x" });
    const t = d.createTask({ name: "t", projectId: p.id, tagIds: [tag.id] });
    d.createTask({ name: "c", parentId: t.id });
    await d.deleteProject(p.id);
    expect(count(env, "tasks")).toBe(0);
    d.undo();
    expect(count(env, "tasks")).toBe(3);
    expect(d.getTask(t.id).tagIds).toEqual([tag.id]);
    expect(d.getProject(p.id).task.name).toBe("P");

    const r = d.createTask({
      name: "r",
      dueDate: "2026-11-01T09:00:00.000",
      repeat: { rule: "FREQ=DAILY", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: false },
    });
    d.completeTask(r.id, true);
    expect(d.getTask(`${r.id}.0`).completed).not.toBeNull();
    d.undo();
    expect(() => d.getTask(`${r.id}.0`)).toThrow();
    expect(d.getTask(r.id)).toMatchObject({ dueDate: "2026-11-01T09:00:00.000", completed: null });
  });

  it("a new mutation clears the redo stack", () => {
    const env = createTestEnv();
    const d = env.domain;
    d.createTask({ name: "a" });
    d.undo();
    expect(d.history().canRedo).toBe(true);
    d.createTask({ name: "b" });
    expect(d.history().canRedo).toBe(false);
    expect(() => d.redo()).toThrow(/Nothing to redo/);
  });

  it("view options are not journaled; settings are", () => {
    const env = createTestEnv();
    const d = env.domain;
    d.setViewOptions("inbox", { filter: "all" });
    expect(d.history().canUndo).toBe(false);
    d.updateSettings({ use24HourTime: true });
    expect(d.history().undoLabel).toBe("Change Settings");
    d.undo();
    expect(d.getSettings().use24HourTime).toBe(false);
    // Undoing a perspective edit keeps view options changed since.
    d.updatePerspective("flagged", { favorite: false });
    d.setViewOptions("flagged", { filter: "remaining" });
    d.undo();
    expect(d.getPerspective("flagged")).toMatchObject({ favorite: true, viewOptions: { filter: "remaining" } });
  });

  it("discard erases a task whose creation is the latest change, leaving history as before", async () => {
    const env = createTestEnv();
    const d = env.domain;
    const keep = d.createTask({ name: "keep" });
    const historyBefore = d.history();
    const groupsBefore = count(env, "change_groups");
    const fresh = d.createTask({ name: "" });
    await d.discardTask(fresh.id);
    expect(() => d.getTask(fresh.id)).toThrow(/not found/);
    expect(d.history()).toEqual(historyBefore);
    expect(count(env, "change_groups")).toBe(groupsBefore);
    expect(env.sqlite.prepare("SELECT COUNT(*) AS n FROM change_rows WHERE row_key_json LIKE ?").get(`%${fresh.id}%`)).toEqual({ n: 0 });

    // Titled tasks with tags, placed among siblings, are discarded the same way (the client decides).
    const tag = d.createTag({ name: "t" });
    const named = d.createTask({ name: "has a title", tagIds: [tag.id], position: { before: keep.id } });
    await d.discardTask(named.id);
    expect(() => d.getTask(named.id)).toThrow();
    expect(d.history().undoLabel).toBe("New Tag");
    expect(count(env, "task_tags")).toBe(0);
  });

  it("discard after an intervening mutation is a normal journaled delete", async () => {
    const env = createTestEnv();
    const d = env.domain;
    const fresh = d.createTask({ name: "" });
    const other = d.createTask({ name: "other" });
    await d.discardTask(fresh.id);
    expect(() => d.getTask(fresh.id)).toThrow();
    expect(d.history().undoLabel).toBe("Delete Action");
    d.undo();
    expect(d.getTask(fresh.id).name).toBe("");
    expect(d.getTask(other.id).name).toBe("other");
    // Editing the new task itself is also a later change: discard deletes normally.
    d.updateTask(fresh.id, { flagged: true });
    await d.discardTask(fresh.id);
    expect(d.history().undoLabel).toBe("Delete Action");
  });

  it("client-supplied ids survive undo/redo and discard; duplicates conflict", async () => {
    const env = createTestEnv();
    const d = env.domain;
    const t = d.createTask({ id: "client-task-1", name: "t" });
    expect(t.id).toBe("client-task-1");
    const p = d.createProject({ id: "client-proj-1", name: "p" });
    const f = d.createFolder({ id: "client-fold-1", name: "f" });
    const g = d.createTag({ id: "client-tag-01", name: "g" });
    const v = d.createPerspective({ id: "client-view-1", name: "v" });
    expect([p.id, f.id, g.id, v.id]).toEqual(["client-proj-1", "client-fold-1", "client-tag-01", "client-view-1"]);
    for (let i = 0; i < 5; i++) d.undo();
    expect(() => d.getTask(t.id)).toThrow(/not found/);
    expect(count(env, "folders")).toBe(0);
    for (let i = 0; i < 5; i++) d.redo();
    expect(d.getTask(t.id).name).toBe("t");
    expect(d.getProject(p.id).id).toBe(p.id);
    expect(count(env, "folders")).toBe(1);
    expect(() => d.createTask({ id: t.id, name: "again" })).toThrow(expect.objectContaining({ code: "conflict", status: 409 }));
    expect(() => d.createProject({ id: t.id, name: "again" })).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(() => d.createFolder({ id: f.id, name: "again" })).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(() => d.createTag({ id: g.id, name: "again" })).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(() => d.createPerspective({ id: "inbox", name: "again" })).toThrow(expect.objectContaining({ code: "conflict" }));
    const fresh = d.createTask({ id: "client-task-2", name: "" });
    await d.discardTask(fresh.id);
    expect(() => d.getTask(fresh.id)).toThrow(/not found/);
    expect(d.createTask({ id: "client-task-2", name: "reused" }).name).toBe("reused");
  });

  it("keeps the newest 200 groups", () => {
    const env = createTestEnv();
    const d = env.domain;
    const t = d.createTask({ name: "n0" });
    for (let i = 1; i <= MAX_GROUPS + 20; i++) d.updateTask(t.id, { name: `n${i}` });
    expect(count(env, "change_groups")).toBe(MAX_GROUPS);
    for (let i = 0; i < MAX_GROUPS; i++) d.undo();
    expect(d.getTask(t.id).name).toBe(`n${20}`);
    expect(d.history().canUndo).toBe(false);
  });

  it("does not journal writes made outside domain mutations (importer)", () => {
    const env = createTestEnv();
    env.sqlite
      .prepare("INSERT INTO tasks (id, rank, name, added, modified) VALUES ('imp', 0, 'imported', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
      .run();
    expect(count(env, "change_rows")).toBe(0);
    env.domain.invalidate();
    expect(env.domain.getTask("imp").name).toBe("imported");
  });

  it("garbage-collects blobs only when no attachment or journal row references them", async () => {
    const env = createTestEnv();
    const d = env.domain;
    const t = d.createTask({ name: "t" });
    const bytes = new TextEncoder().encode("hello");
    const a1 = await d.uploadAttachment(t.id, { name: "a.txt", bytes });
    const a2 = await d.uploadAttachment(t.id, { name: "b.txt", bytes });
    expect(a1.sha256).toBe(a2.sha256);
    expect(a1.contentType).toBe("text/plain");
    expect(count(env, "blobs")).toBe(1);
    await d.deleteAttachment(a1.id);
    await d.deleteAttachment(a2.id);
    // Still referenced by the journal: undo must find the bytes.
    expect(count(env, "blobs")).toBe(1);
    d.undo();
    expect(new TextDecoder().decode((await d.attachmentBytes(a2.id)).bytes)).toBe("hello");
    // Once the journal no longer references it (cleared, e.g. by import), GC removes it.
    await d.deleteAttachment(a2.id);
    env.sqlite.exec("DELETE FROM change_rows; DELETE FROM change_groups;");
    await d.gcBlobs();
    expect(count(env, "blobs")).toBe(0);
    await expect(env.blobStore.get(blobKey(a1.sha256))).rejects.toThrow();
  });

  it("rejects oversized attachments", async () => {
    const env = createTestEnv();
    const t = env.domain.createTask({ name: "t" });
    const big = new Uint8Array(100 * 1024 * 1024 + 1);
    await expect(env.domain.uploadAttachment(t.id, { name: "big.bin", bytes: big })).rejects.toMatchObject({ status: 413 });
  });
});
