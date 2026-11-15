import { describe, expect, it } from "vitest";
import type { Project } from "../../shared/schemas";
import { mergeDue, nextUnreviewed, reviewItems, type ReviewEntry } from "./reviewModel";

const project = (id: string, lastReview = "2026-10-01T00:00:00.000Z") => ({ id, lastReview }) as Project;
const byId = (...projects: Project[]) => new Map(projects.map((p) => [p.id, p]));

describe("mergeDue", () => {
  it("keeps listed projects in place when they stop being due and appends newly due ones", () => {
    const entries = mergeDue([], [project("a"), project("b")]);
    const later = mergeDue(entries, [project("c"), project("b", "2026-10-31T00:00:00.000Z")]);
    expect(later).toEqual([
      { id: "a", joinedLastReview: "2026-10-01T00:00:00.000Z" },
      { id: "b", joinedLastReview: "2026-10-01T00:00:00.000Z" },
      { id: "c", joinedLastReview: "2026-10-01T00:00:00.000Z" },
    ]);
  });
});

describe("reviewItems", () => {
  const entries: ReviewEntry[] = [
    { id: "a", joinedLastReview: "2026-10-01T00:00:00.000Z" },
    { id: "gone", joinedLastReview: "2026-10-01T00:00:00.000Z" },
    { id: "b", joinedLastReview: "2026-10-01T00:00:00.000Z" },
  ];

  it("marks projects whose last review changed since joining as reviewed and skips deleted ones", () => {
    const items = reviewItems(entries, byId(project("a", "2026-10-31T04:20:00.000Z"), project("b")));
    expect(items.map((i) => [i.project.id, i.reviewed])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("un-marks a project once its last review is restored (undo)", () => {
    expect(reviewItems(entries, byId(project("a"))).map((i) => i.reviewed)).toEqual([false]);
  });
});

describe("nextUnreviewed", () => {
  const items = (...states: Array<[string, boolean]>) => states.map(([id, reviewed]) => ({ project: project(id), reviewed }));

  it("moves to the next unreviewed project below, skipping reviewed ones", () => {
    expect(nextUnreviewed(items(["a", true], ["b", true], ["c", false]), "a")).toBe("c");
  });

  it("wraps round to projects skipped earlier", () => {
    expect(nextUnreviewed(items(["a", false], ["b", true], ["c", true]), "c")).toBe("a");
  });

  it("starts from the top without a current project", () => {
    expect(nextUnreviewed(items(["a", true], ["b", false]), null)).toBe("b");
  });

  it("never returns the current project and is null when nothing is left", () => {
    expect(nextUnreviewed(items(["a", false]), "a")).toBeNull();
    expect(nextUnreviewed(items(["a", true], ["b", true]), "b")).toBeNull();
    expect(nextUnreviewed([], null)).toBeNull();
  });

  it("treats a current project that is no longer listed like no current project", () => {
    expect(nextUnreviewed(items(["a", false], ["b", false]), "deleted")).toBe("a");
  });
});
