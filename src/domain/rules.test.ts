import { beforeEach, describe, expect, it } from "vitest";
import type { Domain } from "./index.js";
import { createTestEnv, type TestEnv } from "./testkit.js";

type Rule = Record<string, unknown>;

let env: TestEnv;
let d: Domain;
let ids: Record<string, string>;

/** Names of tasks matched by a custom perspective with the given rules (flat, manual order). */
function match(rules: Rule[], aggregation: "all" | "any" | "none" = "all"): string[] {
  const p = d.createPerspective({ name: "test", rules, aggregation, presentation: { layout: "flat" } });
  const contents = d.perspectiveContents(p.id);
  return contents.groups.flatMap((g) => g.rows.map((r) => (r.task ?? r.project!.task).name));
}

beforeEach(() => {
  env = createTestEnv();
  d = env.domain;
  const folder = d.createFolder({ name: "Work" });
  const work = d.createProject({ name: "Work project", folderId: folder.id, type: "sequential" });
  const sal = d.createProject({ name: "Errands", type: "singleActions" });
  const hold = d.createProject({ name: "Someday", status: "onHold" });
  const home = d.createTag({ name: "Home" });
  const waiting = d.createTag({ name: "Waiting", status: "onHold" });
  ids = { folder: folder.id, work: work.id, sal: sal.id, hold: hold.id, home: home.id, waiting: waiting.id };
  ids.a = d.createTask({ name: "a", projectId: work.id, dueDate: "2026-10-31T17:00:00.000", tagIds: [home.id], estimatedMinutes: 15 }).id;
  ids.b = d.createTask({ name: "b", projectId: work.id, deferDate: "2026-11-02T00:00:00.000", note: "call Bob about invoice" }).id;
  ids.g = d.createTask({ name: "g", projectId: sal.id }).id;
  ids.g1 = d.createTask({ name: "g1", parentId: ids.g, flagged: true, estimatedMinutes: 60 }).id;
  ids.c = d.createTask({ name: "c", projectId: sal.id, tagIds: [home.id, waiting.id], plannedDate: "2026-11-01T09:00:00.000" }).id;
  ids.h = d.createTask({ name: "h", projectId: hold.id }).id;
  ids.i = d.createTask({
    name: "i",
    repeat: { rule: "FREQ=DAILY", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: false },
  }).id;
  ids.done = d.createTask({ name: "done", projectId: sal.id }).id;
  d.completeTask(ids.done, true);
});

describe("rule evaluator", () => {
  it("no rules → all remaining actions", () => {
    expect(match([])).toEqual(["i", "a", "b", "g", "g1", "c", "h"]);
  });

  it("availability", () => {
    expect(match([{ actionAvailability: "firstAvailable" }])).toEqual(["a", "g1"]);
    expect(match([{ actionAvailability: "available" }])).toEqual(["i", "a", "g1"]);
    expect(match([{ actionAvailability: "completed" }])).toEqual(["done"]);
    expect(match([{ actionAvailability: "remaining" }, { actionIsLeaf: true }, { actionIsProject: false }])).toEqual([
      "i",
      "a",
      "b",
      "g1",
      "c",
      "h",
    ]);
  });

  it("status, dates and durations", () => {
    expect(match([{ actionStatus: "due" }])).toEqual(["a"]);
    expect(match([{ actionStatus: "flagged" }])).toEqual(["g1"]);
    expect(match([{ actionHasDueDate: true }])).toEqual(["a"]);
    expect(match([{ actionHasDeferDate: true }])).toEqual(["b"]);
    expect(match([{ actionHasPlannedDate: true }])).toEqual(["c"]);
    expect(match([{ actionHasDuration: true }])).toEqual(["a", "g1"]);
    expect(match([{ actionWithinDuration: 30 }])).toEqual(["a"]);
  });

  it("structure rules", () => {
    expect(match([{ actionIsProject: true }])).toEqual(["Work project", "Errands", "Someday"]);
    expect(match([{ actionIsGroup: true }])).toEqual(["g"]);
    expect(match([{ actionIsProjectOrGroup: true }, { actionAvailability: "remaining" }])).toEqual(["Work project", "Errands", "g", "Someday"]);
    expect(match([{ actionRepeats: true }])).toEqual(["i"]);
    expect(match([{ actionHasNoProject: true }])).toEqual(["i"]);
    expect(match([{ actionIsInSingleActionsList: true }, { actionAvailability: "remaining" }])).toEqual(["g", "g1", "c"]);
    expect(match([{ actionIsUntagged: true }, { actionAvailability: "available" }])).toEqual(["i", "g1"]);
  });

  it("date field predicates", () => {
    expect(match([{ actionDateField: "due", actionDateIsToday: true }])).toEqual(["a"]);
    expect(match([{ actionDateField: "planned", actionDateIsTomorrow: true }])).toEqual(["c"]);
    expect(match([{ actionDateField: "defer", actionDateIsInTheNext: { relativeAfterAmount: 3, relativeComponent: "day" } }])).toEqual(["b"]);
    expect(match([{ actionDateField: "defer", actionDateIsInTheNext: { amount: 1, component: "hour" } }])).toEqual([]);
    expect(match([{ actionDateField: "completed", actionDateIsInThePast: { relativeBeforeAmount: 1, relativeComponent: "week" } }])).toEqual(["done"]);
    expect(match([{ actionDateField: "added", actionDateIsYesterday: true }])).toEqual([]);
    expect(match([{ actionDateField: "planned", actionDateIsOnDateSpec: { dynamic: "tomorrow" } }])).toEqual(["c"]);
    expect(match([{ actionDateField: "planned", actionDateIsOnDateSpec: { dynamic: "2026-11-01" } }])).toEqual(["c"]);
    expect(
      match([{ actionDateField: "defer", actionDateIsAfterDateSpec: { dynamic: "2026-11-01" }, actionDateIsBeforeDateSpec: { dynamic: "2026-11-02" } }]),
    ).toEqual(["b"]);
    expect(match([{ actionDateField: "defer", actionDateIsAfterDateSpec: { dynamic: "2026-11-03" } }])).toEqual([]);
  });

  it("tags and projects", () => {
    expect(match([{ actionHasAnyOfTags: [ids.home, ids.waiting] }])).toEqual(["a", "c"]);
    expect(match([{ actionHasAllOfTags: [ids.home, ids.waiting] }])).toEqual(["c"]);
    expect(match([{ actionHasTagWithStatus: "onHold" }])).toEqual(["c"]);
    expect(match([{ actionHasTagWithStatus: "stalled" }])).toEqual(["c"]); // Waiting has remaining but no available
    expect(match([{ actionHasProjectWithStatus: "onHold" }])).toEqual(["Someday", "h"]);
    expect(match([{ actionHasProjectWithStatus: "stalled" }, { actionIsProject: false }])).toEqual([]);
    d.updateTask(ids.a!, { deferDate: "2026-12-01T00:00:00.000" }); // Work project: nothing available now
    expect(match([{ actionHasProjectWithStatus: "stalled" }, { actionIsProject: false }])).toEqual(["a", "b"]);
    expect(match([{ actionHasProjectWithStatus: "active" }, { actionIsLeaf: true }])).toEqual(["a", "b", "g1", "c", "done"]);
    expect(match([{ actionWithinFocus: [ids.folder] }, { actionAvailability: "remaining" }])).toEqual(["Work project", "a", "b"]);
    expect(match([{ actionWithinFocus: [ids.sal] }, { actionIsLeaf: true }, { actionAvailability: "remaining" }])).toEqual(["g1", "c"]);
  });

  it("search terms must all match name or note", () => {
    expect(match([{ actionMatchingSearch: ["bob", "INVOICE"] }])).toEqual(["b"]);
    expect(match([{ actionMatchingSearch: ["bob", "nothing"] }])).toEqual([]);
  });

  it("aggregation, nested groups, disabled and unknown rules", () => {
    expect(match([{ actionHasDueDate: true }, { actionHasDeferDate: true }], "any")).toEqual(["a", "b"]);
    expect(match([{ actionAvailability: "remaining" }, { actionIsProject: true }], "none")).toEqual(["done"]);
    expect(
      match([
        { actionAvailability: "remaining" },
        { aggregateType: "any", aggregateRules: [{ actionHasDueDate: true }, { aggregateType: "all", aggregateRules: [{ actionStatus: "flagged" }, { actionIsLeaf: true }] }] },
      ]),
    ).toEqual(["a", "g1"]);
    // A disabled rule is ignored entirely.
    expect(match([{ disabledRule: { actionHasDueDate: true } }, { actionRepeats: true }])).toEqual(["i"]);
    // Unknown rules evaluate to true and are preserved.
    const unknown = { actionSomethingNew: { x: 1 } };
    expect(match([unknown, { actionRepeats: true }])).toEqual(["i"]);
    const kept = d.listPerspectives().find((p) => p.rules.some((r) => "actionSomethingNew" in r));
    expect(kept?.rules[0]).toEqual(unknown);
  });
});

describe("perspective presentation", () => {
  it("projects layout groups matches under their projects with ancestors as context", () => {
    const p = d.createPerspective({ name: "flagged", rules: [{ actionStatus: "flagged" }] });
    const c = d.perspectiveContents(p.id);
    expect(c.groups.map((g) => [g.key, g.title, g.rows.map((r) => `${r.kind}:${r.depth}`)])).toEqual([
      [ids.sal, "Errands", ["project:0", "task:1", "task:2"]],
    ]);
  });

  it("flat layout honours grouping and sorting", () => {
    const p = d.createPerspective({
      name: "by tag",
      rules: [{ actionAvailability: "remaining" }, { actionIsLeaf: true }, { actionIsProject: false }],
      presentation: { layout: "flat", grouping: "tag", sorting: "name" },
    });
    const c = d.perspectiveContents(p.id);
    expect(c.groups.map((g) => [g.title, g.rows.map((r) => r.task!.name)])).toEqual([
      ["Home", ["a", "c"]],
      ["Waiting", ["c"]],
      ["Untagged", ["b", "g1", "h", "i"]],
    ]);
    const byDue = d.createPerspective({
      name: "by due",
      rules: [{ actionAvailability: "remaining" }, { actionIsLeaf: true }],
      presentation: { layout: "flat", grouping: "due", sorting: "manual" },
    });
    expect(d.perspectiveContents(byDue.id).groups.map((g) => g.key)).toEqual(["bucket:today", "bucket:none"]);
  });
});
