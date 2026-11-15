import { describe, expect, it } from "vitest";
import type { OutlineGroup } from "../shared/schemas.js";
import { fuzzyMatch } from "./views.js";
import { createTestEnv } from "./testkit.js";

const names = (groups: OutlineGroup[]) =>
  groups.map((g) => [g.title, g.rows.map((r) => `${r.depth}:${r.task?.name ?? r.project?.task.name ?? r.folder?.name ?? r.tag?.name}`)]);

describe("built-in perspectives", () => {
  it("inbox: remaining by default, hierarchical, available filter", () => {
    const env = createTestEnv();
    const d = env.domain;
    const a = d.createTask({ name: "a" });
    d.createTask({ name: "a1", parentId: a.id });
    const b = d.createTask({ name: "b", deferDate: "2026-12-01T00:00:00.000" });
    const done = d.createTask({ name: "done" });
    d.completeTask(done.id, true);
    expect(names(d.perspectiveContents("inbox").groups)).toEqual([["Inbox", ["0:a", "1:a1", "0:b"]]]);
    d.setViewOptions("inbox", { filter: "available" });
    expect(names(d.perspectiveContents("inbox").groups)).toEqual([["Inbox", ["0:a", "1:a1"]]]);
    d.setViewOptions("inbox", { filter: "all" });
    expect(names(d.perspectiveContents("inbox").groups)[0]![1]).toContain("0:done");
    void b;
  });

  it("projects: sections per project, folder titles, show folders/inbox, selection and empty text", () => {
    const env = createTestEnv();
    const d = env.domain;
    const f = d.createFolder({ name: "Work" });
    const p1 = d.createProject({ name: "Alpha", folderId: f.id });
    d.createTask({ name: "a1", projectId: p1.id });
    const p2 = d.createProject({ name: "Beta" });
    const done = d.createProject({ name: "Done", status: "completed" });
    d.createTask({ name: "inbox item" });
    expect(names(d.perspectiveContents("projects").groups)).toEqual([
      ["Work : Alpha", ["0:Alpha", "1:a1"]],
      ["Beta", ["0:Beta"]],
    ]);
    d.setViewOptions("projects", { filter: "remaining", showFolders: true, showInbox: true });
    expect(names(d.perspectiveContents("projects").groups)).toEqual([
      ["Inbox", ["0:inbox item"]],
      ["", ["0:Work", "1:Alpha", "2:a1", "0:Beta"]],
    ]);
    d.setViewOptions("projects", { filter: "remaining", showInbox: true });
    expect(d.perspectiveContents("projects", { project: p2.id }).groups.map((g) => g.key)).toEqual([p2.id]);
    expect(d.perspectiveContents("projects", { folder: f.id }).groups.map((g) => g.key)).toEqual([p1.id]);
    d.setViewOptions("projects", { filter: "all" });
    expect(d.perspectiveContents("projects").groups.map((g) => g.key)).toEqual([p1.id, p2.id, done.id]);
    expect(d.perspectiveContents("projects", { folder: f.id }).groups.map((g) => g.key)).toEqual([p1.id]);
    expect(d.perspectiveContents("projects", { project: p2.id }).groups.map((g) => g.key)).toEqual([p2.id]);
    d.updateProject(p1.id, { status: "dropped" });
    d.updateProject(p2.id, { status: "dropped" });
    d.setViewOptions("projects", { filter: "available" });
    expect(d.perspectiveContents("projects")).toMatchObject({ groups: [], emptyText: "No available projects" });
  });

  it("tags: grouped by tag (repeated), untagged group, sort by due and flagged, tag selection", () => {
    const env = createTestEnv();
    const d = env.domain;
    const home = d.createTag({ name: "Home" });
    const office = d.createTag({ name: "Office" });
    d.createTag({ name: "Empty" });
    d.createTask({ name: "x", tagIds: [home.id, office.id] });
    d.createTask({ name: "y", tagIds: [home.id], dueDate: "2026-11-02T09:00:00.000" });
    d.createTask({ name: "z", tagIds: [home.id], flagged: true });
    d.createTask({ name: "plain" });
    expect(names(d.perspectiveContents("tags").groups)).toEqual([
      ["Home", ["0:x", "0:y", "0:z"]],
      ["Office", ["0:x"]],
      ["Untagged", ["0:plain"]],
    ]);
    d.setViewOptions("tags", { filter: "available", sortByDueAndFlagged: true });
    expect(names(d.perspectiveContents("tags", { tag: home.id }).groups)).toEqual([["Home", ["0:y", "0:z", "0:x"]]]);
    expect(names(d.perspectiveContents("tags", { tag: "untagged" }).groups)).toEqual([["Untagged", ["0:plain"]]]);
  });

  it("flagged: effective flags with groupings", () => {
    const env = createTestEnv();
    const d = env.domain;
    const p = d.createProject({ name: "P", flagged: true });
    d.createTask({ name: "inherits", projectId: p.id });
    const tag = d.createTag({ name: "T" });
    d.createTask({ name: "own", flagged: true, tagIds: [tag.id], dueDate: "2026-11-01T09:00:00.000" });
    d.createTask({ name: "unflagged" });
    expect(names(d.perspectiveContents("flagged").groups)).toEqual([["", ["0:own", "0:inherits"]]]);
    d.setViewOptions("flagged", { grouping: "project" });
    expect(names(d.perspectiveContents("flagged").groups)).toEqual([
      ["Inbox", ["0:own"]],
      ["P", ["0:inherits"]],
    ]);
    d.setViewOptions("flagged", { grouping: "due" });
    expect(d.perspectiveContents("flagged").groups.map((g) => g.title)).toEqual(["Tomorrow", "No Due Date"]);
    d.setViewOptions("flagged", { grouping: "tagsCombined" });
    expect(d.perspectiveContents("flagged").groups.map((g) => g.title)).toEqual(["T", "Untagged"]);
  });

  it("completed and changed: date buckets, newest first, empty buckets omitted", () => {
    const env = createTestEnv();
    const d = env.domain;
    const old = d.createTask({ name: "old" });
    const recent = d.createTask({ name: "recent" });
    env.clock.set("2025-06-01T00:00:00.000Z");
    d.completeTask(old.id, true);
    env.clock.set("2026-10-27T02:00:00.000Z");
    d.completeTask(recent.id, true);
    env.clock.set("2026-10-31T04:20:00.000Z");
    const today = d.createTask({ name: "today" });
    d.completeTask(today.id, true);
    expect(names(d.perspectiveContents("completed").groups)).toEqual([
      ["Today", ["0:today"]],
      ["Within the last week", ["0:recent"]],
      ["More than a year ago", ["0:old"]],
    ]);
    expect(d.perspectiveContents("changed").groups[0]!.title).toBe("Today");
  });

  it("review: projects due for review grouped by date", () => {
    const env = createTestEnv();
    const d = env.domain;
    env.clock.set("2026-10-01T00:00:00.000Z");
    const p = d.createProject({ name: "Old" });
    d.createProject({ name: "Paused", status: "onHold" });
    d.createProject({ name: "Done", status: "completed" });
    env.clock.set("2026-10-31T04:20:00.000Z");
    const fresh = d.createProject({ name: "Fresh" });
    const groups = d.perspectiveContents("review").groups;
    expect(groups.map((g) => [g.key, g.kind, g.rows.map((r) => r.project!.task.name)])).toEqual([
      ["2026-10-08", "date", ["Old", "Paused"]],
    ]);
    void p;
    void fresh;
  });

  it("review: a selected project shows its remaining actions, even once it is no longer due", () => {
    const env = createTestEnv();
    const d = env.domain;
    env.clock.set("2026-10-01T00:00:00.000Z");
    const p = d.createProject({ name: "Old" });
    d.createProject({ name: "Other" });
    const open = d.createTask({ name: "open", projectId: p.id });
    const done = d.createTask({ name: "done", projectId: p.id });
    d.createTask({ name: "sub", parentId: open.id });
    env.clock.set("2026-10-31T04:20:00.000Z");
    d.completeTask(done.id, true);
    const shown = (): string[][] =>
      d.perspectiveContents("review", { project: p.id }).groups.map((g) => g.rows.map((r) => `${r.depth}:${r.kind}:${r.project?.task.name ?? r.task!.name}`));
    expect(shown()).toEqual([["0:project:Old", "1:task:open", "2:task:sub"]]);
    d.markReviewed(p.id);
    d.updateProject(p.id, { status: "completed" });
    expect(shown()).toEqual([["0:project:Old"]]);
    expect(d.perspectiveContents("review").groups.flatMap((g) => g.rows.map((r) => r.project!.task.name))).toEqual(["Other"]);
  });

  it("search: names and notes, plus projects, folders and tags", () => {
    const env = createTestEnv();
    const d = env.domain;
    d.createFolder({ name: "Garden folder" });
    d.createProject({ name: "Garden project" });
    d.createTag({ name: "garden" });
    d.createTask({ name: "Water plants", note: "the GARDEN beds" });
    const done = d.createTask({ name: "garden done" });
    d.completeTask(done.id, true);
    const r = d.search("garden");
    expect([r.tasks.length, r.projects.length, r.folders.length, r.tags.length]).toEqual([1, 1, 1, 1]);
    expect(d.search("garden", "all").tasks.map((t) => t.name)).toEqual(["Water plants", "garden done"]);
    expect(d.perspectiveContents("search", { q: "garden" }).groups.map((g) => g.key)).toEqual(["tasks", "projects", "folders", "tags"]);
  });

  it("quick open ranks prefix matches first", () => {
    const env = createTestEnv();
    const d = env.domain;
    d.createTag({ name: "Shopping" });
    d.createTag({ name: "Errands list" });
    d.createProject({ name: "House stuff" });
    const r = d.quickOpen("s");
    expect(r[0]!.name).toBe("Search");
    expect(r.map((x) => x.name).slice(0, 2).sort()).toEqual(["Search", "Shopping"]);
    expect(d.quickOpen("hs")[0]).toMatchObject({ name: "House stuff", type: "project", matches: [[0, 1], [3, 4]] });
    expect(fuzzyMatch("Errands list", "list")).toMatchObject({ matches: [[8, 12]] });
    expect(fuzzyMatch("abc", "x")).toBeNull();
  });
});

describe("forecast", () => {
  it("buckets past, today, days and future, with counts, badges and calendar", () => {
    const env = createTestEnv(); // Sat 31 Oct 2026, Brisbane
    const d = env.domain;
    const tag = d.createTag({ name: "Today tag" });
    d.updateSettings({ forecastTagId: tag.id });
    d.createTask({ name: "overdue", dueDate: "2026-10-29T09:00:00.000" });
    d.createTask({ name: "today", dueDate: "2026-10-31T17:00:00.000" });
    d.createTask({ name: "monday", dueDate: "2026-11-02T09:00:00.000" });
    d.createTask({ name: "planned", plannedDate: "2026-11-03T09:00:00.000" });
    d.createTask({ name: "deferred", deferDate: "2026-11-04T00:00:00.000" });
    d.createTask({ name: "far", dueDate: "2026-12-25T09:00:00.000" });
    d.createTask({ name: "flag", flagged: true });
    d.createTask({ name: "tagged", tagIds: [tag.id] });
    const onHold = d.createProject({ name: "Hold", status: "onHold" });
    d.createTask({ name: "held", projectId: onHold.id, dueDate: "2026-11-01T09:00:00.000" });

    const f = d.forecast();
    expect(f.today).toBe("2026-10-31");
    const byKey = Object.fromEntries(f.days.map((x) => [x.key, x]));
    expect(f.days.map((x) => x.key)).toEqual([
      "PAST",
      "TODAY",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "FUTURE",
    ]);
    const rowNames = (k: string) => byKey[k]!.rows.map((r) => r.task!.name);
    expect(rowNames("PAST")).toEqual(["overdue"]);
    expect(byKey.PAST).toMatchObject({ dueCount: 1, badge: "overdue" });
    expect(rowNames("TODAY")).toEqual(["overdue", "today", "tagged"]);
    expect(byKey.TODAY).toMatchObject({ dueCount: 2, count: 3, badge: "overdue" });
    expect(rowNames("2026-11-01")).toEqual([]); // on-hold excluded by default
    expect(rowNames("2026-11-02")).toEqual(["monday"]);
    expect(byKey["2026-11-02"]).toMatchObject({ badge: "dueSoon", dueCount: 1 });
    expect(rowNames("2026-11-03")).toEqual(["planned"]);
    expect(byKey["2026-11-03"]).toMatchObject({ dueCount: 0, count: 1 });
    expect(rowNames("2026-11-04")).toEqual([]);
    expect(rowNames("FUTURE")).toEqual(["far"]);

    d.setViewOptions("forecast", {
      forecast: { includeDefer: true, includePlanned: false, includeOnHold: true, todayIncludesFlagged: true },
    });
    const g = Object.fromEntries(d.forecast().days.map((x) => [x.key, x.rows.map((r) => r.task!.name)]));
    expect(g["2026-11-04"]).toEqual(["deferred"]);
    expect(g["2026-11-03"]).toEqual([]);
    expect(g["2026-11-01"]).toEqual(["held"]);
    expect(g.TODAY).toEqual(["overdue", "today", "flag", "tagged"]);

    // Calendar: 5 weeks from Sunday 25 Oct (firstWeekday = Sunday).
    expect(f.calendar).toHaveLength(35);
    expect(f.calendar[0]!.date).toBe("2026-10-25");
    expect(f.calendar.find((c) => c.date === "2026-11-02")).toMatchObject({ dueCount: 1, count: 1 });
    d.updateSettings({ firstWeekday: 2 });
    expect(d.forecast().calendar[0]!.date).toBe("2026-10-26");

    // ?day= selects one section in perspective contents.
    expect(d.perspectiveContents("forecast", { day: "2026-11-02" }).groups.map((x) => x.key)).toEqual(["2026-11-02"]);
  });

  it("from/days select the range", () => {
    const env = createTestEnv();
    const f = env.domain.forecast({ from: "2026-11-10", days: 3 });
    expect(f.days.map((x) => x.key)).toEqual(["PAST", "2026-11-10", "2026-11-11", "2026-11-12", "FUTURE"]);
  });
});
