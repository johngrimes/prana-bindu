import { describe, expect, it } from "vitest";
import { advanceRepeat, type RepeatSpec } from "./repeat.js";
import { createTestEnv } from "./testkit.js";

const BNE = "Australia/Brisbane";
const at = (iso: string) => Date.parse(iso);
const spec = (rule: string, extra: Partial<RepeatSpec> = {}): RepeatSpec => ({
  rule,
  scheduleType: "regularly",
  anchorDate: "due",
  catchUpAutomatically: false,
  ...extra,
});
const none = { deferDate: null, plannedDate: null, dueDate: null };

describe("advanceRepeat", () => {
  const now = at("2026-10-31T04:20:00.000Z");
  const opts = { completedAt: now, now, timeZone: BNE };

  it("regularly: next occurrence strictly after the anchor, other dates keep offsets", () => {
    const r = advanceRepeat(
      spec("FREQ=DAILY;INTERVAL=1"),
      { ...none, dueDate: "2026-10-25T09:00:00.000", deferDate: "2026-10-24T08:00:00.000" },
      opts,
    );
    expect(r?.dates).toEqual({ dueDate: "2026-10-26T09:00:00.000", deferDate: "2026-10-25T08:00:00.000", plannedDate: null });
  });

  it("regularly with catch-up skips to the first occurrence after now", () => {
    const r = advanceRepeat(
      spec("FREQ=DAILY", { catchUpAutomatically: true }),
      { ...none, dueDate: "2026-10-25T09:00:00.000" },
      opts,
    );
    expect(r?.dates.dueDate).toBe("2026-11-01T09:00:00.000");
  });

  it("weekly BYDAY anchored on defer", () => {
    const r = advanceRepeat(
      spec("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", { anchorDate: "defer" }),
      { ...none, deferDate: "2026-10-26T00:00:00.000", dueDate: "2026-10-27T17:00:00.000" },
      opts,
    );
    expect(r?.dates).toMatchObject({ deferDate: "2026-11-09T00:00:00.000", dueDate: "2026-11-10T17:00:00.000" });
  });

  it("monthly by month day and yearly", () => {
    expect(
      advanceRepeat(spec("FREQ=MONTHLY;BYMONTHDAY=1"), { ...none, dueDate: "2026-10-01T09:00:00.000" }, opts)?.dates.dueDate,
    ).toBe("2026-11-01T09:00:00.000");
    expect(advanceRepeat(spec("FREQ=YEARLY"), { ...none, dueDate: "2026-03-15T09:00:00.000" }, opts)?.dates.dueDate).toBe(
      "2027-03-15T09:00:00.000",
    );
  });

  it("fromCompletion: computed from the completion day, keeping the anchor's time of day", () => {
    const r = advanceRepeat(
      spec("FREQ=DAILY;INTERVAL=3", { scheduleType: "fromCompletion" }),
      { ...none, dueDate: "2026-10-20T17:00:00.000", deferDate: "2026-10-20T08:00:00.000" },
      opts,
    );
    // Completed Oct 31 (Brisbane) → due Nov 3 17:00; defer keeps its −9h offset.
    expect(r?.dates).toMatchObject({ dueDate: "2026-11-03T17:00:00.000", deferDate: "2026-11-03T08:00:00.000" });
  });

  it("fromCompletion weekly with BYDAY picks the next matching weekday after completion", () => {
    const r = advanceRepeat(
      spec("FREQ=WEEKLY;BYDAY=SA", { scheduleType: "fromCompletion", anchorDate: "defer" }),
      { ...none, deferDate: "2026-10-03T06:00:00.000" },
      opts,
    );
    expect(r?.dates.deferDate).toBe("2026-11-07T06:00:00.000");
  });

  it("COUNT decrements and ends the series", () => {
    const r = advanceRepeat(spec("FREQ=DAILY;COUNT=3"), { ...none, dueDate: "2026-10-31T09:00:00.000" }, opts);
    expect(r?.rule).toBe("FREQ=DAILY;COUNT=2");
    expect(advanceRepeat(spec("FREQ=DAILY;COUNT=1"), { ...none, dueDate: "2026-10-31T09:00:00.000" }, opts)).toBeNull();
  });

  it("UNTIL in the past ends the series", () => {
    expect(
      advanceRepeat(spec("FREQ=DAILY;UNTIL=20261031T000000Z"), { ...none, dueDate: "2026-10-31T09:00:00.000" }, opts),
    ).toBeNull();
    expect(
      advanceRepeat(spec("FREQ=DAILY;UNTIL=20261231T000000Z"), { ...none, dueDate: "2026-10-31T09:00:00.000" }, opts)?.dates.dueDate,
    ).toBe("2026-11-01T09:00:00.000");
  });

  it("keeps wall-clock time across DST for fixed and floating dates", () => {
    const syd = { completedAt: now, now, timeZone: "Australia/Sydney" };
    // Sydney DST starts 2026-10-04: 09:00 AEST = 23:00Z; 09:00 AEDT = 22:00Z.
    const fixed = advanceRepeat(spec("FREQ=DAILY"), { ...none, dueDate: "2026-10-01T23:00:00.000Z" }, syd);
    expect(fixed?.dates.dueDate).toBe("2026-10-02T23:00:00.000Z");
    const fixed2 = advanceRepeat(spec("FREQ=DAILY"), { ...none, dueDate: "2026-10-02T23:00:00.000Z" }, syd);
    expect(fixed2?.dates.dueDate).toBe("2026-10-03T22:00:00.000Z");
    const floating = advanceRepeat(spec("FREQ=DAILY"), { ...none, dueDate: "2026-10-03T09:00:00.000" }, syd);
    expect(floating?.dates.dueDate).toBe("2026-10-04T09:00:00.000");
  });

  it("falls back to another date when the anchor field is empty", () => {
    const r = advanceRepeat(spec("FREQ=WEEKLY"), { ...none, deferDate: "2026-10-30T00:00:00.000" }, opts);
    expect(r?.dates.deferDate).toBe("2026-11-06T00:00:00.000");
  });

  it("rejects invalid rules", () => {
    expect(() => advanceRepeat(spec("NOPE"), none, opts)).toThrow(/repeat rule/i);
  });
});

describe("repeating tasks in the domain", () => {
  it("completing creates a completed clone subtree with dotted ids and advances the original", () => {
    const env = createTestEnv();
    const p = env.domain.createProject({ name: "P" });
    const t = env.domain.createTask({
      name: "weekly review",
      projectId: p.id,
      dueDate: "2026-10-30T09:00:00.000",
      note: "notes",
      repeat: { rule: "FREQ=WEEKLY", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: false },
    });
    const tag = env.domain.createTag({ name: "x" });
    env.domain.addTag(t.id, tag.id);
    const sub = env.domain.createTask({ name: "sub", parentId: t.id });
    env.domain.completeTask(sub.id, true);
    env.domain.completeTask(t.id, true);

    const clone = env.domain.getTask(`${t.id}.0`);
    expect(clone).toMatchObject({ name: "weekly review", note: "notes", dueDate: "2026-10-30T09:00:00.000", tagIds: [tag.id] });
    expect(clone.completed).toBe("2026-10-31T04:20:00.000Z");
    expect(env.domain.getTask(`${t.id}.0.0`)).toMatchObject({ name: "sub", parentId: `${t.id}.0` });

    const orig = env.domain.getTask(t.id);
    expect(orig).toMatchObject({ completed: null, dueDate: "2026-11-06T09:00:00.000" });
    expect(env.domain.getTask(sub.id).completed).toBeNull();
    const order = env.domain.getTaskDetail(p.id).children.map((c) => c.id);
    expect(order).toEqual([`${t.id}.0`, t.id]);

    env.domain.completeTask(t.id, true);
    expect(env.domain.getTask(`${t.id}.1`).dueDate).toBe("2026-11-06T09:00:00.000");
  });

  it("drop occurrence skips; drop series drops", () => {
    const env = createTestEnv();
    const repeat = { rule: "FREQ=DAILY", scheduleType: "regularly" as const, anchorDate: "due" as const, catchUpAutomatically: false };
    const t = env.domain.createTask({ name: "daily", dueDate: "2026-10-31T09:00:00.000", repeat });
    env.domain.dropTask(t.id, true, "occurrence");
    expect(env.domain.getTask(`${t.id}.0`).dropped).not.toBeNull();
    expect(env.domain.getTask(t.id)).toMatchObject({ dropped: null, dueDate: "2026-11-01T09:00:00.000" });
    env.domain.dropTask(t.id, true, "series");
    expect(env.domain.getTask(t.id).dropped).not.toBeNull();
    expect(() => env.domain.getTask(`${t.id}.1`)).toThrow();
  });

  it("an exhausted series simply completes", () => {
    const env = createTestEnv();
    const t = env.domain.createTask({
      name: "last",
      dueDate: "2026-10-31T09:00:00.000",
      repeat: { rule: "FREQ=DAILY;COUNT=1", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: false },
    });
    env.domain.completeTask(t.id, true);
    expect(env.domain.getTask(t.id).completed).not.toBeNull();
    expect(() => env.domain.getTask(`${t.id}.0`)).toThrow();
  });

  it("repeating projects clone into their folder (complete, skip occurrence, status patch)", () => {
    const env = createTestEnv();
    const d = env.domain;
    const folder = d.createFolder({ name: "F" });
    const before = d.createProject({ name: "Before", folderId: folder.id });
    const p = d.createProject({
      name: "Monthly",
      folderId: folder.id,
      dueDate: "2026-11-01T17:00:00.000",
      repeat: { rule: "FREQ=MONTHLY", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: false },
    });
    const action = d.createTask({ name: "pay", projectId: p.id });
    d.completeTask(action.id, true);
    d.completeTask(p.id, true);
    expect(d.getProject(`${p.id}.0`)).toMatchObject({ status: "completed", folderId: folder.id });
    expect(d.getTask(`${p.id}.0.0`).name).toBe("pay");
    expect(d.getProject(p.id)).toMatchObject({ status: "active", task: { dueDate: "2026-12-01T17:00:00.000", completed: null } });
    expect(d.getTask(action.id).completed).toBeNull();
    expect(d.listProjects({ folderId: folder.id }).map((x) => x.id)).toEqual([before.id, `${p.id}.0`, p.id]);

    d.dropTask(p.id, true, "occurrence");
    expect(d.getProject(`${p.id}.1`)).toMatchObject({ status: "dropped" });
    expect(d.getProject(p.id).task.dueDate).toBe("2027-01-01T17:00:00.000");

    d.updateProject(p.id, { status: "completed" });
    expect(d.getProject(`${p.id}.2`).status).toBe("completed");
    expect(d.getProject(p.id)).toMatchObject({ status: "active", task: { dueDate: "2027-02-01T17:00:00.000" } });

    d.updateProject(p.id, { status: "dropped" });
    expect(d.getProject(p.id)).toMatchObject({ status: "dropped" });
    expect(d.getProject(p.id).task.dropped).not.toBeNull();
  });
});

describe("completion and drop are mutually exclusive", () => {
  it("keeps completed/dropped and project status consistent", () => {
    const env = createTestEnv();
    const d = env.domain;
    const t = d.createTask({ name: "t" });
    d.dropTask(t.id, true);
    d.completeTask(t.id, true);
    expect(d.getTask(t.id)).toMatchObject({ dropped: null, status: "completed" });
    d.dropTask(t.id, true);
    expect(d.getTask(t.id)).toMatchObject({ completed: null, status: "dropped" });

    const p = d.createProject({ name: "P" });
    d.completeTask(p.id, true);
    d.dropTask(p.id, true);
    expect(d.getProject(p.id)).toMatchObject({ status: "dropped", task: { completed: null } });
    d.updateProject(p.id, { status: "completed" });
    expect(d.getProject(p.id)).toMatchObject({ status: "completed", task: { dropped: null } });
    d.updateProject(p.id, { status: "onHold" });
    expect(d.getProject(p.id)).toMatchObject({ status: "onHold", task: { dropped: null, completed: null } });
  });

  it("multi-item complete/drop and project patches are one undo group", () => {
    const env = createTestEnv();
    const d = env.domain;
    const a = d.createTask({ name: "a" });
    const b = d.createTask({ name: "b" });
    expect(d.completeTasks([a.id, b.id], true).changed).toHaveLength(2);
    d.undo();
    expect([d.getTask(a.id).completed, d.getTask(b.id).completed]).toEqual([null, null]);
    d.dropTasks([a.id, b.id], true);
    d.undo();
    expect([d.getTask(a.id).dropped, d.getTask(b.id).dropped]).toEqual([null, null]);
    const p1 = d.createProject({ name: "1" });
    const p2 = d.createProject({ name: "2" });
    expect(d.updateProjects([p1.id, p2.id], { status: "onHold" }).map((p) => p.status)).toEqual(["onHold", "onHold"]);
    expect(d.history().undoLabel).toBe("Edit Projects");
    d.undo();
    expect([d.getProject(p1.id).status, d.getProject(p2.id).status]).toEqual(["active", "active"]);
    // A failing item rolls back the whole group.
    expect(() => d.completeTasks([a.id, "missing"], true)).toThrow(/not found/);
    expect(d.getTask(a.id).completed).toBeNull();
  });

  it("duplicate ids are applied once (a repeating task advances once)", () => {
    const env = createTestEnv();
    const d = env.domain;
    const t = d.createTask({
      name: "r",
      dueDate: "2026-11-01T09:00:00.000",
      repeat: { rule: "FREQ=DAILY", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: false },
    });
    d.completeTasks([t.id, t.id], true);
    expect(d.getTask(t.id).dueDate).toBe("2026-11-02T09:00:00.000");
    expect(() => d.getTask(`${t.id}.1`)).toThrow();
    const p = d.createProject({
      name: "P",
      dueDate: "2026-11-01T09:00:00.000",
      repeat: { rule: "FREQ=DAILY", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: false },
    });
    expect(d.updateProjects([p.id, p.id], { status: "completed" })).toHaveLength(1);
    expect(d.getProject(p.id).task.dueDate).toBe("2026-11-02T09:00:00.000");
  });

  it("setTasksStatus moves a mixed selection to one state", () => {
    const env = createTestEnv();
    const d = env.domain;
    const a = d.createTask({ name: "a" });
    const b = d.createTask({ name: "b" });
    const p = d.createProject({ name: "P", status: "onHold" });
    d.dropTask(a.id, true);
    d.completeTask(b.id, true);
    d.setTasksStatus([a.id, b.id, p.id], "active");
    expect([d.getTask(a.id).status, d.getTask(b.id).status]).toEqual(["available", "available"]);
    expect(d.getProject(p.id).status).toBe("onHold");
    d.setTasksStatus([a.id, b.id], "dropped");
    d.setTasksStatus([a.id, b.id, p.id], "completed");
    expect([d.getTask(a.id).dropped, d.getTask(b.id).dropped]).toEqual([null, null]);
    expect(d.getProject(p.id).status).toBe("completed");
    expect(d.history().undoLabel).toBe("Complete");
    // Reopening a dropped task via "mark incomplete" also clears the drop.
    d.dropTask(a.id, true);
    d.completeTasks([a.id], false);
    expect(d.getTask(a.id)).toMatchObject({ dropped: null, completed: null });
  });

  it("deleteMany removes a mixed selection in one undo step, skipping items inside selected containers", async () => {
    const env = createTestEnv();
    const d = env.domain;
    const folder = d.createFolder({ name: "F" });
    const sub = d.createFolder({ name: "Sub", parentId: folder.id });
    const inFolder = d.createProject({ name: "In folder", folderId: sub.id });
    const loose = d.createProject({ name: "Loose" });
    const child = d.createTask({ name: "child", projectId: loose.id });
    const inbox = d.createTask({ name: "inbox" });
    const parentTag = d.createTag({ name: "Parent" });
    const childTag = d.createTag({ name: "Child", parentId: parentTag.id });
    d.addTag(inbox.id, childTag.id);
    await expect(d.deleteMany({ taskIds: [inbox.id, "missing"] })).rejects.toMatchObject({ status: 404 });
    expect(d.getTask(inbox.id).name).toBe("inbox");
    await d.deleteMany({
      folderIds: [folder.id, sub.id],
      projectIds: [inFolder.id, loose.id, loose.id],
      taskIds: [child.id, inbox.id],
      tagIds: [childTag.id, parentTag.id],
    });
    expect(d.listProjects()).toEqual([]);
    expect(d.listFolders()).toEqual([]);
    expect(d.listTags()).toEqual([]);
    expect(d.listTasks({ availability: "all" }).items).toEqual([]);
    expect(d.history().undoLabel).toBe("Delete Items");
    d.undo();
    expect(d.listProjects().map((p) => p.task.name)).toEqual(["In folder", "Loose"]);
    expect(d.getTask(inbox.id).tagIds).toEqual([childTag.id]);
  });
});
