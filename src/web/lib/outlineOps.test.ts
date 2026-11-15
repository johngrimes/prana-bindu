import { describe, expect, it } from "vitest";
import type { OutlineGroup, OutlineRow, Task } from "../../shared/schemas";
import { invertChanges, type RowChange, type StateReader } from "./optimistic";
import { applyRowChanges } from "./outlineModel";
import { moveChanges, outlineOpChanges } from "./outlineOps";

const row = (id: string, depth: number, parentId: string | null = null): OutlineRow => ({ kind: "task", id, depth, task: { id, parentId, name: id } as Task });

/** Inbox: a, b (children b1, b2), c, d. */
const inbox = (): OutlineGroup[] => [
  { key: "inbox", title: "Inbox", kind: "none", rows: [row("a", 0), row("b", 0), row("b1", 1, "b"), row("b2", 1, "b"), row("c", 0), row("d", 0)] },
];

/** "id@depth" per row, and each task row's parentId where it differs from null. */
const shape = (groups: OutlineGroup[]) => groups.map((g) => g.rows.map((r) => `${r.id}@${r.depth}${r.task?.parentId ? `<${r.task.parentId}` : ""}`).join(" "));

const run = (changes: RowChange[], groups = inbox()) => shape(applyRowChanges(groups, changes));

describe("outline operation previews", () => {
  it("indents under the previous sibling, after its children", () => {
    expect(run(outlineOpChanges("indent", ["c"], inbox()))).toEqual(["a@0 b@0 b1@1<b b2@1<b c@1<b d@0"]);
  });

  it("indents adjacent selected siblings together under the first unselected one", () => {
    expect(run(outlineOpChanges("indent", ["c", "d"], inbox()))).toEqual(["a@0 b@0 b1@1<b b2@1<b c@1<b d@1<b"]);
  });

  it("does not indent the first sibling", () => {
    expect(outlineOpChanges("indent", ["a"], inbox())).toEqual([]);
  });

  it("outdents after the parent, keeping the order of several children", () => {
    expect(run(outlineOpChanges("outdent", ["b1", "b2"], inbox()))).toEqual(["a@0 b@0 b1@0 b2@0 c@0 d@0"]);
  });

  it("moves up and down among siblings with subtrees", () => {
    expect(run(outlineOpChanges("moveUp", ["c"], inbox()))).toEqual(["a@0 c@0 b@0 b1@1<b b2@1<b d@0"]);
    expect(run(outlineOpChanges("moveDown", ["a"], inbox()))).toEqual(["b@0 b1@1<b b2@1<b a@0 c@0 d@0"]);
    expect(run(outlineOpChanges("moveUp", ["b"], inbox()))).toEqual(["b@0 b1@1<b b2@1<b a@0 c@0 d@0"]);
  });

  it("groups the selection into a new group where the first item was", () => {
    const changes = outlineOpChanges("group", ["c", "d"], inbox(), row("g", 0));
    expect(run(changes)).toEqual(["a@0 b@0 b1@1<b b2@1<b g@0 c@1<g d@1<g"]);
  });

  it("ungroups: children take the group's place and the group goes", () => {
    expect(run(outlineOpChanges("ungroup", ["b"], inbox()))).toEqual(["a@0 b1@0 b2@0 c@0 d@0"]);
  });

  it("is idempotent: applying a preview to data that already has it changes nothing", () => {
    const changes = outlineOpChanges("indent", ["c"], inbox());
    const once = applyRowChanges(inbox(), changes);
    expect(shape(applyRowChanges(once, changes))).toEqual(shape(once));
  });

  it("works under a project header row", () => {
    const groups: OutlineGroup[] = [{ key: "p", title: "P", kind: "project", rows: [{ kind: "project", id: "p", depth: 0 }, row("x", 1, "p"), row("y", 1, "p")] }];
    expect(run(outlineOpChanges("moveUp", ["y"], groups), groups)).toEqual(["p@0 y@1<p x@1<p"]);
    expect(outlineOpChanges("outdent", ["x"], groups)).toEqual([]);
  });
});

describe("move previews", () => {
  it("moves tasks before an anchor, keeping their order", () => {
    expect(run(moveChanges(["d", "a"], { position: { before: "c" } }, inbox()))).toEqual(["b@0 b1@1<b b2@1<b a@0 d@0 c@0"]);
  });

  it("moves into a row at the end of its children", () => {
    expect(run(moveChanges(["a"], { parentId: "b", position: "end" }, inbox()))).toEqual(["b@0 b1@1<b b2@1<b a@1<b c@0 d@0"]);
  });

  it("moves a selected parent with its subtree, skipping selected descendants", () => {
    expect(run(moveChanges(["b", "b1"], { position: { after: "d" } }, inbox()))).toEqual(["a@0 c@0 d@0 b@0 b1@1<b b2@1<b"]);
  });
});

describe("row changes", () => {
  it("adds an absent row by group key, at the end or start", () => {
    const added = row("n", 0);
    expect(run([{ kind: "row", id: "n", at: { parentId: null, after: null, last: true, groupKey: "inbox" }, rows: [added] }])).toEqual(["a@0 b@0 b1@1<b b2@1<b c@0 d@0 n@0"]);
    expect(run([{ kind: "row", id: "n", at: { parentId: null, after: null, groupKey: "inbox" }, rows: [added] }])).toEqual(["n@0 a@0 b@0 b1@1<b b2@1<b c@0 d@0"]);
    expect(run([{ kind: "row", id: "n", at: { parentId: null, after: null, groupKey: "elsewhere" }, rows: [added] }])).toEqual(["a@0 b@0 b1@1<b b2@1<b c@0 d@0"]);
  });

  it("shows a first row in a new group only when asked to", () => {
    const at = { parentId: null, after: null, last: true, groupKey: "inbox" };
    const added = { kind: "row" as const, id: "n", rows: [row("n", 0)] };
    expect(shape(applyRowChanges([], [{ ...added, at }]))).toEqual([]);
    expect(shape(applyRowChanges([], [{ ...added, at: { ...at, ensureGroup: true } }]))).toEqual(["n@0"]);
  });

  it("removes a row with its subtree, only in the named group when scoped", () => {
    expect(run([{ kind: "row", id: "b", at: null }])).toEqual(["a@0 c@0 d@0"]);
    expect(run([{ kind: "row", id: "b", at: null, inGroup: "other" }])).toEqual(["a@0 b@0 b1@1<b b2@1<b c@0 d@0"]);
  });

  it("keeps a row in place when none of its anchors are shown in this group", () => {
    expect(run([{ kind: "row", id: "c", at: { parentId: "elsewhere", after: null, last: true } }])).toEqual(["a@0 b@0 b1@1<b b2@1<b c@0<elsewhere d@0"]);
  });
});

describe("undo snapshots of row changes", () => {
  const reader = (groups: OutlineGroup[]): StateReader => ({
    task: () => undefined,
    projectRecord: () => undefined,
    outline: () => groups,
    item: () => undefined,
    settings: () => undefined,
    attachment: () => undefined,
  });

  for (const [label, changes] of [
    ["group", outlineOpChanges("group", ["c", "d"], inbox(), row("g", 0))],
    ["ungroup", outlineOpChanges("ungroup", ["b"], inbox())],
    ["indent", outlineOpChanges("indent", ["c", "d"], inbox())],
    ["delete", [{ kind: "row", id: "b", at: null }] as RowChange[]],
    ["create", [{ kind: "row", id: "n", at: { parentId: null, after: "a" }, rows: [row("n", 0)] }] as RowChange[]],
  ] as const) {
    it(`restores the outline after ${label}`, () => {
      const before = invertChanges(changes, reader(inbox()));
      const after = applyRowChanges(inbox(), changes);
      expect(shape(applyRowChanges(after, before as RowChange[]))).toEqual(shape(inbox()));
    });
  }
});
