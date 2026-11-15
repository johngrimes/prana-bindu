import { describe, expect, it } from "vitest";
import { createTestEnv } from "./testkit.js";

const status = (env: ReturnType<typeof createTestEnv>, id: string) => env.domain.getTask(id).status;

describe("derived state: availability", () => {
  it("sequential project: only the first remaining action is available (next)", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P", type: "sequential" });
    const a = env.domain.createTask({ name: "a", projectId: p.id });
    const b = env.domain.createTask({ name: "b", projectId: p.id });
    const c = env.domain.createTask({ name: "c", projectId: p.id });
    expect([status(env, a.id), status(env, b.id), status(env, c.id)]).toEqual(["next", "blocked", "blocked"]);
    env.domain.completeTask(a.id, true);
    expect([status(env, a.id), status(env, b.id), status(env, c.id)]).toEqual(["completed", "next", "blocked"]);
    env.domain.dropTask(b.id, true);
    expect(status(env, c.id)).toBe("next");
  });

  it("parallel project: every remaining action available, first one is next", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P", type: "parallel" });
    const a = env.domain.createTask({ name: "a", projectId: p.id });
    const b = env.domain.createTask({ name: "b", projectId: p.id });
    expect([status(env, a.id), status(env, b.id)]).toEqual(["next", "available"]);
    expect(env.domain.getTask(b.id).available).toBe(true);
  });

  it("single-actions list: every available action is first available, never sequential-blocked", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "SAL", type: "singleActions" });
    const a = env.domain.createTask({ name: "a", projectId: p.id });
    const b = env.domain.createTask({ name: "b", projectId: p.id });
    expect([status(env, a.id), status(env, b.id)]).toEqual(["next", "next"]);
  });

  it("action groups are blocked while they have remaining children; sequential groups block later children", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P" });
    const g = env.domain.createTask({ name: "group", projectId: p.id, sequential: true });
    const g1 = env.domain.createTask({ name: "g1", parentId: g.id });
    const g2 = env.domain.createTask({ name: "g2", parentId: g.id });
    const other = env.domain.createTask({ name: "other", projectId: p.id });
    expect(status(env, g.id)).toBe("blocked");
    expect(env.domain.getTask(g.id).remainingChildCount).toBe(2);
    expect([status(env, g1.id), status(env, g2.id), status(env, other.id)]).toEqual(["next", "blocked", "available"]);
    env.domain.completeTask(g1.id, true);
    env.domain.completeTask(g2.id, true);
    // Group without remaining children is itself available.
    expect(env.domain.getTask(g.id).available).toBe(true);
  });

  it("a blocked parent (other than by children) blocks its children; sequential siblings block nested groups", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P", type: "sequential" });
    const first = env.domain.createTask({ name: "first", projectId: p.id });
    const g = env.domain.createTask({ name: "group", projectId: p.id });
    const child = env.domain.createTask({ name: "child", parentId: g.id });
    expect(status(env, first.id)).toBe("next");
    expect(status(env, child.id)).toBe("blocked");
    env.domain.completeTask(first.id, true);
    expect(status(env, child.id)).toBe("next");
  });

  it("deferred items are blocked and children inherit the latest defer date", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P", deferDate: "2026-11-05T00:00:00.000" });
    const t = env.domain.createTask({ name: "t", projectId: p.id, deferDate: "2026-11-02T00:00:00.000" });
    const u = env.domain.createTask({ name: "u", projectId: p.id, deferDate: "2026-11-09T00:00:00.000" });
    const tt = env.domain.getTask(t.id);
    expect(tt.effectiveDeferDate).toBe("2026-11-05T00:00:00.000");
    expect(tt.deferred).toBe(true);
    expect(tt.status).toBe("blocked");
    expect(env.domain.getTask(u.id).effectiveDeferDate).toBe("2026-11-09T00:00:00.000");
    expect(env.domain.getProject(p.id).pending).toBe(true);
    env.clock.set("2026-11-06T00:00:00.000Z");
    expect(env.domain.getTask(t.id).status).toBe("next");
    expect(env.domain.getTask(u.id).status).toBe("blocked");
  });

  it("on-hold and dropped projects/folders/tags", () => {
    const env = createTestEnv();
    const folder = env.domain.createFolder({ name: "F" });
    const p = env.domain.createProject({ name: "P", folderId: folder.id });
    const t = env.domain.createTask({ name: "t", projectId: p.id });
    env.domain.updateProject(p.id, { status: "onHold" });
    expect(env.domain.getTask(t.id)).toMatchObject({ remaining: true, blocked: true, status: "blocked" });
    env.domain.updateProject(p.id, { status: "active" });
    expect(status(env, t.id)).toBe("next");

    const parentTag = env.domain.createTag({ name: "Parent" });
    const tag = env.domain.createTag({ name: "Waiting", parentId: parentTag.id });
    env.domain.addTag(t.id, tag.id);
    env.domain.updateTag(parentTag.id, { status: "onHold" });
    expect(env.domain.getTag(tag.id).effectiveStatus).toBe("onHold");
    expect(status(env, t.id)).toBe("blocked");
    env.domain.updateTag(parentTag.id, { status: "dropped" });
    expect(env.domain.getTag(tag.id).effectiveStatus).toBe("dropped");
    env.domain.updateTag(parentTag.id, { status: "active" });
    expect(status(env, t.id)).toBe("next");

    env.domain.updateFolder(folder.id, { status: "dropped" });
    expect(env.domain.getProject(p.id).effectiveStatus).toBe("dropped");
    expect(env.domain.getTask(t.id)).toMatchObject({ remaining: false, status: "dropped" });
    expect(env.domain.listFolders()[0]!.effectiveActive).toBe(false);
  });

  it("inherits flags and dates (earliest due, latest defer, nearest planned)", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P", flagged: true, dueDate: "2026-11-10T17:00:00.000", plannedDate: "2026-11-03T09:00:00.000" });
    const g = env.domain.createTask({ name: "g", projectId: p.id, dueDate: "2026-11-20T17:00:00.000", plannedDate: "2026-11-04T09:00:00.000" });
    const c = env.domain.createTask({ name: "c", parentId: g.id, dueDate: "2026-11-08T17:00:00.000" });
    const d = env.domain.createTask({ name: "d", parentId: g.id });
    expect(env.domain.getTask(c.id)).toMatchObject({
      flagged: false,
      effectiveFlagged: true,
      effectiveDueDate: "2026-11-08T17:00:00.000",
      effectivePlannedDate: "2026-11-04T09:00:00.000",
    });
    expect(env.domain.getTask(d.id).effectiveDueDate).toBe("2026-11-10T17:00:00.000");
    expect(env.domain.getTask(g.id).effectiveDueDate).toBe("2026-11-10T17:00:00.000");
  });

  it("an incomplete child of a completed parent is effectively completed", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P" });
    const g = env.domain.createTask({ name: "g", projectId: p.id });
    const c = env.domain.createTask({ name: "c", parentId: g.id });
    env.domain.completeTask(g.id, true);
    expect(env.domain.getTask(c.id)).toMatchObject({ completed: null, effectiveCompleted: true, remaining: false, status: "completed" });
    env.domain.completeTask(g.id, false);
    expect(env.domain.getTask(c.id).remaining).toBe(true);
  });

  it("overdue and due soon honour the due-soon setting", () => {
    const env = createTestEnv();
    const overdue = env.domain.createTask({ name: "o", dueDate: "2026-10-31T09:00:00.000" });
    const soon = env.domain.createTask({ name: "s", dueDate: "2026-11-02T09:00:00.000" });
    const later = env.domain.createTask({ name: "l", dueDate: "2026-11-05T09:00:00.000" });
    const tonight = env.domain.createTask({ name: "t", dueDate: "2026-10-31T23:00:00.000" });
    expect([status(env, overdue.id), status(env, soon.id), status(env, later.id), status(env, tonight.id)]).toEqual([
      "overdue",
      "dueSoon",
      "available",
      "dueSoon",
    ]);
    env.domain.updateSettings({ dueSoonSeconds: 0 }); // "today"
    expect([status(env, soon.id), status(env, tonight.id)]).toEqual(["available", "dueSoon"]);
  });

  it("fixed dates resolve as instants; floating dates in the user's time zone", () => {
    const env = createTestEnv({ timeZone: "UTC" });
    // 14:20 Brisbane = 04:20 UTC. Floating 05:00 in UTC is in the future; in Brisbane it would be past.
    const t = env.domain.createTask({ name: "t", dueDate: "2026-10-31T05:00:00.000" });
    expect(status(env, t.id)).toBe("dueSoon");
    env.domain.updateSettings({ timeZone: "Australia/Brisbane" });
    expect(status(env, t.id)).toBe("overdue");
    const fixed = env.domain.createTask({ name: "f", dueDate: "2026-10-31T05:00:00.000Z" });
    expect(status(env, fixed.id)).toBe("dueSoon");
  });

  it("project stalled: active with remaining but no available actions", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P" });
    const t = env.domain.createTask({ name: "t", projectId: p.id, deferDate: "2026-12-01T00:00:00.000" });
    expect(env.domain.getProject(p.id)).toMatchObject({ stalled: true, remainingCount: 1, availableCount: 0 });
    env.domain.updateTask(t.id, { deferDate: null });
    expect(env.domain.getProject(p.id)).toMatchObject({ stalled: false, availableCount: 1 });
  });

  it("inbox items are never next", () => {
    const env = createTestEnv();
    const t = env.domain.createTask({ name: "inbox" });
    expect(env.domain.getTask(t.id)).toMatchObject({ inInbox: true, available: true, firstAvailable: false, status: "available" });
  });
});

describe("behaviour: completion cascade, tags, delete", () => {
  it("completes the parent with its last child when completedByChildren is set", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P", completedByChildren: true });
    const g = env.domain.createTask({ name: "g", projectId: p.id, completedByChildren: true });
    const a = env.domain.createTask({ name: "a", parentId: g.id });
    const b = env.domain.createTask({ name: "b", parentId: g.id });
    env.domain.completeTask(a.id, true);
    expect(env.domain.getTask(g.id).completed).toBeNull();
    env.clock.advance(5000);
    const res = env.domain.completeTask(b.id, true);
    const ts = env.domain.getTask(b.id).completed;
    expect(env.domain.getTask(g.id).completed).toBe(ts);
    expect(env.domain.getProject(p.id)).toMatchObject({ status: "completed" });
    expect(env.domain.getTask(p.id).completed).toBe(ts);
    expect(res.changed.map((t) => t.id).sort()).toEqual([b.id, g.id, p.id].sort());
  });

  it("mutually exclusive tags replace siblings", () => {
    const env = createTestEnv();
    const energy = env.domain.createTag({ name: "Energy", childrenMutuallyExclusive: true });
    const high = env.domain.createTag({ name: "High", parentId: energy.id });
    const low = env.domain.createTag({ name: "Low", parentId: energy.id });
    const home = env.domain.createTag({ name: "Home" });
    const t = env.domain.createTask({ name: "t", tagIds: [home.id, high.id] });
    expect(env.domain.addTag(t.id, low.id).tagIds).toEqual([home.id, low.id]);
    expect(env.domain.updateTask(t.id, { tagIds: [high.id, low.id] }).tagIds).toEqual([low.id]);
  });

  it("delete removes descendants, links, alarms and attachments", async () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P" });
    const g = env.domain.createTask({ name: "g", projectId: p.id });
    const c = env.domain.createTask({ name: "c", parentId: g.id });
    const tag = env.domain.createTag({ name: "x" });
    env.domain.addTag(c.id, tag.id);
    await env.domain.uploadAttachment(c.id, { name: "a.txt", bytes: new TextEncoder().encode("hi") });
    await env.domain.deleteProject(p.id);
    expect(() => env.domain.getTask(c.id)).toThrow(/not found/);
    expect(env.domain.getTag(tag.id).remainingCount).toBe(0);
    expect(env.sqlite.prepare("SELECT COUNT(*) AS n FROM task_tags").get()).toEqual({ n: 0 });
    expect(env.sqlite.prepare("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
  });

  it("clean up moves assigned inbox items to the end of their project and tagged ones out of the inbox", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P" });
    const existing = env.domain.createTask({ name: "existing", projectId: p.id });
    const assigned = env.domain.createTask({ name: "assigned" });
    const tag = env.domain.createTag({ name: "t" });
    const tagged = env.domain.createTask({ name: "tagged", tagIds: [tag.id] });
    const plain = env.domain.createTask({ name: "plain" });
    env.domain.updateTask(assigned.id, { assignedProjectId: p.id });
    expect(env.domain.getTask(assigned.id).projectName).toBe("P");
    env.domain.cleanup();
    expect(env.domain.getTask(assigned.id)).toMatchObject({ inInbox: false, parentId: p.id, projectId: p.id, assignedProjectId: null });
    expect(env.domain.getTaskDetail(p.id).children.map((c) => c.id)).toEqual([existing.id, assigned.id]);
    expect(env.domain.getTask(tagged.id)).toMatchObject({ inInbox: false, parentId: null });
    expect(env.domain.getTask(plain.id).inInbox).toBe(true);
  });

  it("review: mark reviewed and interval changes", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P" });
    expect(p.nextReview).toBe("2026-11-07T00:00:00.000");
    expect(env.domain.reviewQueue()).toEqual([]);
    env.clock.set("2026-11-08T01:00:00.000Z");
    expect(env.domain.reviewQueue().map((x) => x.id)).toEqual([p.id]);
    const reviewed = env.domain.markReviewed(p.id);
    expect(reviewed.lastReview).toBe("2026-11-08T01:00:00.000Z");
    expect(reviewed.nextReview).toBe("2026-11-15T00:00:00.000");
    const changed = env.domain.updateProject(p.id, { reviewInterval: { steps: 2, unit: "month" } });
    expect(changed.nextReview).toBe("2027-01-08T00:00:00.000");
  });

  it("outline operations: indent, outdent, move, group, ungroup", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P" });
    const [a, b, c] = ["a", "b", "c"].map((name) => env.domain.createTask({ name, projectId: p.id }));
    const kids = () => env.domain.getTaskDetail(p.id).children.map((t) => t.name);
    env.domain.outline("indent", [b!.id, c!.id]);
    expect(kids()).toEqual(["a"]);
    expect(env.domain.getTaskDetail(a!.id).children.map((t) => t.name)).toEqual(["b", "c"]);
    env.domain.outline("outdent", [b!.id, c!.id]);
    expect(kids()).toEqual(["a", "b", "c"]);
    env.domain.outline("moveUp", [c!.id]);
    expect(kids()).toEqual(["a", "c", "b"]);
    env.domain.outline("moveDown", [a!.id]);
    expect(kids()).toEqual(["c", "a", "b"]);
    env.domain.outline("group", [a!.id, b!.id]);
    expect(kids()).toEqual(["c", ""]);
    const group = env.domain.getTaskDetail(p.id).children[1]!;
    expect(env.domain.getTaskDetail(group.id).children.map((t) => t.name)).toEqual(["a", "b"]);
    env.domain.outline("ungroup", [group.id]);
    expect(kids()).toEqual(["c", "a", "b"]);
  });

  it("moves between inbox, projects and tasks; refuses cycles", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P" });
    const t = env.domain.createTask({ name: "t" });
    const u = env.domain.createTask({ name: "u", parentId: t.id });
    env.domain.moveTask(t.id, { projectId: p.id, position: "start" });
    expect(env.domain.getTask(u.id).projectId).toBe(p.id);
    expect(() => env.domain.moveTask(t.id, { parentId: u.id, position: "end" })).toThrow(/itself/);
    env.domain.moveTask(u.id, { inbox: true, position: "end" });
    expect(env.domain.getTask(u.id)).toMatchObject({ inInbox: true, parentId: null, projectId: null });
  });

  it("moves a selection as one undo step, keeping outline order; descendants travel with ancestors", () => {
    const env = createTestEnv();
    const d = env.domain;
    const p = d.createProject({ name: "P" });
    const existing = d.createTask({ name: "existing", projectId: p.id });
    const a = d.createTask({ name: "a" });
    const a1 = d.createTask({ name: "a1", parentId: a.id });
    const b = d.createTask({ name: "b" });
    const c = d.createTask({ name: "c" });
    const res = d.moveTasks([c.id, a.id, a1.id], { projectId: p.id, position: "start" });
    expect(res.changed.map((t) => t.id).sort()).toEqual([a.id, c.id].sort());
    expect(d.getTaskDetail(p.id).children.map((t) => t.name)).toEqual(["a", "c", "existing"]);
    expect(d.getTask(a1.id).parentId).toBe(a.id);
    expect(d.history().undoLabel).toBe("Move");
    d.undo();
    expect(d.listTasks({ inbox: true }).items.map((t) => t.name)).toEqual(["a", "a1", "b", "c"]);
    d.moveTasks([a.id, c.id], { position: { after: existing.id } });
    expect(d.getTaskDetail(p.id).children.map((t) => t.name)).toEqual(["existing", "a", "c"]);
    expect(() => d.moveTasks([b.id, c.id], { position: { after: c.id } })).toThrow(/anchor/);
    expect(() => d.moveTasks([a.id], { parentId: a1.id })).toThrow(/itself/);
    expect(d.getTask(a.id).projectId).toBe(p.id);
  });

  it("adds and removes tags on a selection as one undo step, honouring exclusive groups", () => {
    const env = createTestEnv();
    const d = env.domain;
    const energy = d.createTag({ name: "Energy", childrenMutuallyExclusive: true });
    const high = d.createTag({ name: "High", parentId: energy.id });
    const low = d.createTag({ name: "Low", parentId: energy.id });
    const home = d.createTag({ name: "Home" });
    const x = d.createTask({ name: "x", tagIds: [high.id, home.id] });
    const y = d.createTask({ name: "y" });
    d.tagTasks([x.id, y.id], { add: [low.id], remove: [home.id] });
    expect([d.getTask(x.id).tagIds, d.getTask(y.id).tagIds]).toEqual([[low.id], [low.id]]);
    d.undo();
    expect([d.getTask(x.id).tagIds, d.getTask(y.id).tagIds]).toEqual([[high.id, home.id], []]);
    expect(() => d.tagTasks([x.id], { add: ["missing"] })).toThrow(/not found/);
  });

  it("renumbers ranks when there is no gap", () => {
    const env = createTestEnv();
    const first = env.domain.createTask({ name: "first" });
    env.sqlite.prepare("UPDATE tasks SET rank = 5 WHERE id = ?").run(first.id);
    const second = env.domain.createTask({ name: "second" });
    env.sqlite.prepare("UPDATE tasks SET rank = 6 WHERE id = ?").run(second.id);
    env.domain.invalidate();
    const mid = env.domain.createTask({ name: "mid", position: { after: first.id } });
    const order = env.domain.listTasks({ inbox: true }).items.map((t) => t.name);
    expect(order).toEqual(["first", "mid", "second"]);
    expect(env.domain.getTask(mid.id).rank).not.toBe(5);
  });
});
