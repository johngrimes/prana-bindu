import { describe, expect, it } from "vitest";
import type { OutlineGroup, OutlineRow, Task } from "../../shared/schemas";
import { leavingRows, mergeContents, placementOf, visibleRows, type StickyRow } from "./outlineModel";

const task = (id: string, extra: Partial<Task> = {}) => ({ id, name: id, completed: null, ...extra }) as Task;
const row = (id: string, depth = 0, extra: Partial<Task> = {}): OutlineRow => ({ kind: "task", id, depth, task: task(id, extra) });
const group = (rows: OutlineRow[], key = "g"): OutlineGroup => ({ key, title: "", kind: "none", rows });
const ids = (groups: OutlineGroup[]) => groups.flatMap((g) => g.rows.map((r) => r.id));

describe("mergeContents", () => {
  it("keeps a completed row at its old position after the server stops returning it", () => {
    const before = [row("a"), row("b"), row("c")];
    const after = [group([row("a"), row("c")])];
    const sticky = [{ row: row("b", 0, { completed: "2026-10-31T00:00:00.000Z" }), groupKey: "g", placement: placementOf(before, "b") }];
    const merged = mergeContents(after, sticky, new Set());
    expect(ids(merged)).toEqual(["a", "b", "c"]);
    expect(merged[0]?.rows[1]?.task?.completed).toBe("2026-10-31T00:00:00.000Z");
  });

  it("inserts a new sibling after the anchor's subtree", () => {
    const groups = [group([row("a"), row("a1", 1), row("a2", 1), row("b")])];
    const merged = mergeContents(groups, [{ row: row("new"), groupKey: "g", placement: { type: "after", id: "a", skipSubtree: true } }], new Set());
    expect(ids(merged)).toEqual(["a", "a1", "a2", "new", "b"]);
  });

  it("does not duplicate rows the server already returns and hides deleted rows", () => {
    const groups = [group([row("a"), row("b")])];
    const merged = mergeContents(groups, [{ row: row("a"), groupKey: "g", placement: { type: "start" } }], new Set(["b"]));
    expect(ids(merged)).toEqual(["a"]);
  });
});

describe("visibleRows", () => {
  it("hides descendants of collapsed rows and marks rows with children", () => {
    const groups = [group([row("a"), row("a1", 1), row("a1x", 2), row("b")])];
    const shown = visibleRows(groups, { "g/a": true });
    expect(shown[0]?.rows.map((r) => [r.row.id, r.hasChildren])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(visibleRows(groups, {})[0]?.rows.map((r) => r.row.id)).toEqual(["a", "a1", "a1x", "b"]);
  });
});

describe("leavingRows", () => {
  const inboxRow = (id: string, depth = 0, extra: Partial<Task> = {}) =>
    row(id, depth, { inInbox: true, parentId: depth === 0 ? null : "parent", assignedProjectId: null, tagIds: [], ...extra });

  it("marks kept rows that newer server contents no longer include", () => {
    const before = [group([row("a"), row("b")])];
    const after = [group([row("a")])];
    const sticky: StickyRow[] = [{ row: row("b"), groupKey: "g", placement: placementOf(before[0]!.rows, "b"), since: before }];
    const merged = mergeContents(after, sticky, new Set());
    expect([...leavingRows(merged, after, sticky, new Set())]).toEqual(["g/b"]);
  });

  it("does not mark a kept row before contents newer than its change arrive", () => {
    const current = [group([row("a")])];
    const sticky: StickyRow[] = [{ row: row("new"), groupKey: "g", placement: { type: "end" }, since: current }];
    const merged = mergeContents(current, sticky, new Set());
    expect(leavingRows(merged, current, sticky, new Set()).size).toBe(0);
  });

  it("marks rows per group, so a task leaving one tag group stays normal in another", () => {
    const server = [group([row("t")], "tag1"), group([], "tag2")];
    const merged = [group([row("t")], "tag1"), group([row("t")], "tag2")];
    expect([...leavingRows(merged, server, [], new Set())]).toEqual(["tag2/t"]);
  });

  it("marks inbox items Clean Up will file away, with their subtrees", () => {
    const rows = [
      inboxRow("project", 0, { assignedProjectId: "p1" }),
      inboxRow("project-child", 1),
      inboxRow("tagged", 0, { tagIds: ["t1"] }),
      inboxRow("missing-project", 0, { assignedProjectId: "deleted" }),
      inboxRow("plain"),
    ];
    const groups = [group(rows, "inbox")];
    expect([...leavingRows(groups, groups, [], new Set(["p1"]))]).toEqual(["inbox/project", "inbox/project-child", "inbox/tagged"]);
  });

  it("leaves tagged inbox items alone outside the inbox group", () => {
    const groups = [group([inboxRow("tagged", 0, { tagIds: ["t1"] })], "TODAY")];
    expect(leavingRows(groups, groups, [], new Set()).size).toBe(0);
  });
});
