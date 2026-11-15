import { describe, expect, it } from "vitest";
import type { Folder, Project, Settings, Task } from "../../shared/schemas";
import { changesFromPatch, invertChanges, previewList, previewSettings, previewTask, projectTask, type Change, type StateReader } from "./optimistic";

const settings: Settings = {
  dateFormat: "dd/MM/yyyy",
  firstWeekday: 1,
  use24HourTime: false,
  defaultDeferTime: "00:00",
  defaultDueTime: "17:00",
  defaultPlannedTime: "09:00",
  dueSoonSeconds: 172800,
  theme: "system",
  forecastTagId: null,
  timeZone: "UTC",
};
const now = Date.parse("2026-10-31T12:00:00.000Z");

const task = (extra: Partial<Task> = {}): Task =>
  ({
    id: "t",
    name: "t",
    flagged: false,
    effectiveFlagged: false,
    deferDate: null,
    plannedDate: null,
    dueDate: null,
    effectiveDeferDate: null,
    effectivePlannedDate: null,
    effectiveDueDate: null,
    completed: null,
    dropped: null,
    effectiveCompleted: false,
    effectiveDropped: false,
    remaining: true,
    deferred: false,
    blocked: false,
    available: true,
    firstAvailable: false,
    overdue: false,
    dueSoon: false,
    status: "available",
    remainingChildCount: 0,
    tagIds: [],
    ...extra,
  }) as Task;

describe("changesFromPatch", () => {
  it("resolves natural-language and ISO dates and leaves unparseable ones to the server", () => {
    const changes = changesFromPatch({ dueDate: "2026-11-02", deferDate: "2026-11-01T08:30", plannedDate: "gibberish", name: "x" }, settings);
    expect(changes).toEqual({ name: "x", dueDate: "2026-11-02T17:00:00.000", deferDate: "2026-11-01T08:30:00.000" });
  });

  it("passes clears through", () => {
    expect(changesFromPatch({ dueDate: null }, settings)).toEqual({ dueDate: null });
  });
});

describe("projectTask", () => {
  it("marks a task due within the due-soon window", () => {
    const t = projectTask(task(), { dueDate: "2026-11-01T17:00:00.000" }, settings, now);
    expect([t.effectiveDueDate, t.dueSoon, t.overdue, t.status]).toEqual(["2026-11-01T17:00:00.000", true, false, "dueSoon"]);
  });

  it("marks a past due date overdue", () => {
    expect(projectTask(task(), { dueDate: "2026-10-30T17:00:00.000" }, settings, now).status).toBe("overdue");
  });

  it("keeps an earlier inherited due date when the own one is later", () => {
    const inherited = task({ effectiveDueDate: "2026-10-30T17:00:00.000" });
    expect(projectTask(inherited, { dueDate: "2026-12-01T17:00:00.000" }, settings, now).effectiveDueDate).toBe("2026-10-30T17:00:00.000");
    expect(projectTask(inherited, { dueDate: null }, settings, now).effectiveDueDate).toBe("2026-10-30T17:00:00.000");
  });

  it("drops the own due date from the effective value when cleared", () => {
    const own = task({ dueDate: "2026-11-01T17:00:00.000", effectiveDueDate: "2026-11-01T17:00:00.000", dueSoon: true, status: "dueSoon" });
    const t = projectTask(own, { dueDate: null }, settings, now);
    expect([t.effectiveDueDate, t.dueSoon, t.status]).toEqual([null, false, "available"]);
  });

  it("blocks a task deferred into the future and unblocks it when the deferral is cleared", () => {
    const deferred = projectTask(task(), { deferDate: "2026-11-05T00:00:00.000" }, settings, now);
    expect([deferred.deferred, deferred.blocked, deferred.available, deferred.status]).toEqual([true, true, false, "blocked"]);
    const cleared = projectTask(deferred, { deferDate: null }, settings, now);
    expect([cleared.deferred, cleared.blocked, cleared.status]).toEqual([false, false, "available"]);
  });

  it("completing a task makes it no longer remaining", () => {
    const t = projectTask(task({ dueDate: "2026-10-30T17:00:00.000", effectiveDueDate: "2026-10-30T17:00:00.000" }), { completed: "2026-10-31T12:00:00.000Z" }, settings, now);
    expect([t.remaining, t.overdue, t.status]).toEqual([false, false, "completed"]);
  });

  it("keeps an inherited flag when the own flag is cleared", () => {
    expect(projectTask(task({ effectiveFlagged: true }), { flagged: false }, settings, now).effectiveFlagged).toBe(true);
    expect(projectTask(task({ flagged: true, effectiveFlagged: true }), { flagged: false }, settings, now).effectiveFlagged).toBe(false);
  });
});

describe("previews", () => {
  it("apply task changes in order on the changed tasks only", () => {
    const changes: Change[] = [
      { kind: "task", ids: ["t"], task: { name: "first" } },
      { kind: "task", ids: ["t"], task: (t) => ({ name: `${t.name} then second` }) },
    ];
    expect(previewTask(task(), changes, settings).name).toBe("first then second");
    expect(previewTask(task({ id: "other" }), changes, settings).name).toBe("t");
  });

  it("add, patch and remove list items, and apply task changes to project rows", () => {
    const folder = (id: string, name: string) => ({ id, name }) as Folder;
    const folders = [folder("a", "A"), folder("b", "B")];
    const changes: Change[] = [
      { kind: "item", list: "folders", id: "c", value: folder("c", "C") },
      { kind: "item", list: "folders", id: "a", patch: { name: "A2" } },
      { kind: "item", list: "folders", id: "b", value: null },
    ];
    expect(previewList("folders", folders, changes, settings).map((f) => f.name)).toEqual(["A2", "C"]);
    const project = { id: "t", task: task(), status: "active" } as Project;
    const [p] = previewList("projects", [project], [{ kind: "task", ids: ["t"], task: { name: "renamed" }, project: { status: "onHold" } }], settings);
    expect([p?.task.name, p?.status]).toEqual(["renamed", "onHold"]);
  });
});

describe("undo snapshots", () => {
  const reader: StateReader = {
    task: (id) => (id === "t" ? task({ flagged: false, name: "old" }) : undefined),
    projectRecord: () => undefined,
    outline: () => null,
    item: (list, id) => (list === "folders" && id === "f" ? ({ id: "f", name: "Old folder" } as never) : list === "folders" ? null : undefined),
    settings: () => settings,
    attachment: () => undefined,
  };

  it("captures the overwritten values, which restore the shown state", () => {
    const changes: Change[] = [
      { kind: "task", ids: ["t", "unloaded"], task: { flagged: true } },
      { kind: "item", list: "folders", id: "f", patch: { name: "New folder" } },
      { kind: "item", list: "folders", id: "n", value: { id: "n", name: "Created" } as Folder },
      { kind: "settings", changes: { theme: "dark" } },
    ];
    const before = invertChanges(changes, reader);
    const folders = previewList("folders", previewList("folders", [{ id: "f", name: "Old folder" } as Folder], changes, settings), before, settings);
    expect(folders.map((f) => f.name)).toEqual(["Old folder"]);
    expect(previewTask(previewTask(task(), changes, settings), before, settings).flagged).toBe(false);
    expect(previewSettings(previewSettings(settings, changes), before).theme).toBe("system");
  });
});
