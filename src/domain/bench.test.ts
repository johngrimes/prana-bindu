import { describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { BUILTIN_PERSPECTIVES } from "../shared/schemas.js";
import { createTestEnv } from "./testkit.js";

/** Generates a dataset shaped like the sample backup: ~2.5k tasks over 44 projects, nested groups, tags, dates. */
function seed(env: ReturnType<typeof createTestEnv>): void {
  const now = "2026-10-01T00:00:00.000Z";
  const { db } = env;
  let n = 0;
  const id = (p: string) => `${p}${(n++).toString().padStart(8, "0")}`;
  const folders = Array.from({ length: 4 }, (_, i) => ({ id: id("f"), name: `Folder ${i}`, rank: i * 1000, added: now, modified: now }));
  db.insert(schema.folders).values(folders).run();
  const tags = Array.from({ length: 12 }, (_, i) => ({
    id: id("g"),
    name: `Tag ${i}`,
    rank: i,
    status: (i === 11 ? "onHold" : "active") as "onHold" | "active",
    added: now,
    modified: now,
  }));
  db.insert(schema.tags).values(tags).run();
  const tasks: (typeof schema.tasks.$inferInsert)[] = [];
  const projects: (typeof schema.projects.$inferInsert)[] = [];
  const links: (typeof schema.taskTags.$inferInsert)[] = [];
  const day = (k: number) => `2026-${String(10 + Math.floor(k / 28)).padStart(2, "0")}-${String((k % 28) + 1).padStart(2, "0")}T09:00:00.000`;
  for (let p = 0; p < 44; p++) {
    const pid = id("p");
    tasks.push({ id: pid, rank: p, name: `Project ${p}`, added: now, modified: now, completed: p % 4 === 0 ? now : null });
    projects.push({
      taskId: pid,
      folderId: folders[p % 4]!.id,
      type: (["parallel", "sequential", "singleActions"] as const)[p % 3],
      status: p % 4 === 0 ? "completed" : "active",
      lastReview: now,
    });
    for (let g = 0; g < 8; g++) {
      const gid = id("t");
      tasks.push({ id: gid, parentId: pid, rank: g, name: `Group ${p}.${g}`, added: now, modified: now, sequential: g % 2 === 0 });
      for (let t = 0; t < 6; t++) {
        const tid = id("t");
        const k = p * 48 + g * 6 + t;
        tasks.push({
          id: tid,
          parentId: gid,
          rank: t,
          name: `Task ${k} with some words`,
          note: k % 5 === 0 ? "a note about things" : "",
          added: now,
          modified: now,
          flagged: k % 7 === 0,
          dueDate: k % 3 === 0 ? day(k % 90) : null,
          deferDate: k % 11 === 0 ? day((k + 5) % 90) : null,
          completed: k % 2 === 0 ? now : null,
          repeatRule: k % 13 === 0 ? "FREQ=WEEKLY" : null,
          repeatScheduleType: k % 13 === 0 ? "regularly" : null,
          repeatAnchor: k % 13 === 0 ? "due" : null,
        });
        if (k % 4 === 0) links.push({ taskId: tid, tagId: tags[k % 12]!.id, rankInTask: 0, rankInTag: k, added: now });
      }
    }
  }
  for (let i = 0; i < 400; i++) tasks.push({ id: id("i"), rank: i, name: `Inbox ${i}`, inInbox: true, added: now, modified: now });
  for (let i = 0; i < tasks.length; i += 500) db.insert(schema.tasks).values(tasks.slice(i, i + 500)).run();
  db.insert(schema.projects).values(projects).run();
  db.insert(schema.taskTags).values(links).run();
  env.domain.invalidate();
}

describe("performance", () => {
  it("computes every perspective for a 2.5k-task dataset well under 300 ms", () => {
    const env = createTestEnv();
    seed(env);
    const d = env.domain;
    expect(d.listTasks({ availability: "all", limit: 5000 }).items.length).toBeGreaterThan(2500);
    const custom = d.createPerspective({
      name: "Due or flagged",
      aggregation: "any",
      rules: [{ actionStatus: "due" }, { actionStatus: "flagged" }, { actionMatchingSearch: ["words"] }],
      presentation: { layout: "flat", grouping: "tag", sorting: "due" },
    });
    for (const id of [...BUILTIN_PERSPECTIVES, custom.id]) {
      env.clock.advance(5000); // force derived state to be recomputed
      const start = performance.now();
      d.perspectiveContents(id, { q: "task" });
      const ms = performance.now() - start;
      expect(ms, `${id} took ${ms.toFixed(1)} ms`).toBeLessThan(150);
    }
  });
});
