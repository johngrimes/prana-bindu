// Opt-in: imports the real OmniFocus sample backup (never committed). Run with
//   PRANA_SAMPLE_OFOCUS=/tmp/pb-import/OmniFocus.zip npx vitest run src/importer/sample.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection.js";
import { FsBlobStore } from "../storage/fs.js";
import { importOfocus } from "./index.js";

const samplePath = process.env.PRANA_SAMPLE_OFOCUS;

describe.skipIf(!samplePath)("real sample import", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-sample-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("imports with the counts from docs/spec.md §11 in under 60 s", async () => {
    const { db, sqlite } = openDatabase(":memory:");
    const blobStore = new FsBlobStore(join(dir, "blobs"));
    const started = performance.now();
    const run = await importOfocus({ path: samplePath! }, { db, sqlite, blobStore });
    const seconds = (performance.now() - started) / 1000;
    console.log(`sample import: ${seconds.toFixed(1)} s`, run.counts, `${run.warnings.length} warning(s)`);
    expect(seconds).toBeLessThan(60);
    expect(run.counts).toMatchObject({
      tasks: 2561,
      projects: 44,
      folders: 4,
      tags: 12,
      taskTags: 79,
      alarms: 110,
      attachments: 500,
      blobs: 330,
      customPerspectives: 3,
      builtinPerspectives: 8,
      settings: 11,
    });
    const count = (table: string) => Number(sqlite.prepare(`select count(*) from ${table}`).pluck().get());
    expect(count("tasks")).toBe(2561);
    expect(count("attachments")).toBe(500);
    expect(count("blobs")).toBe(330);
    expect(count("perspectives")).toBe(3 + 9);

    // Re-importing reuses stored blobs and leaves no orphans behind.
    const again = await importOfocus({ path: samplePath! }, { db, sqlite, blobStore });
    expect(again.counts).toEqual(run.counts);
  }, 180_000);
});
