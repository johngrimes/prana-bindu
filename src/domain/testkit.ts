// Test support shared by domain, API and MCP tests: an in-memory database with a controllable clock.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { openDatabase, type DbHandle } from "../db/connection.js";
import { FsBlobStore } from "../storage/fs.js";
import { createDomain, type Domain } from "./index.js";

export interface TestEnv {
  domain: Domain;
  blobStore: FsBlobStore;
  sqlite: DbHandle["sqlite"];
  db: DbHandle["db"];
  clock: { now: Date; set(iso: string): void; advance(ms: number): void };
}

/** Sat 31 Oct 2026 14:20 in Australia/Brisbane (UTC+10, no DST). */
export const TEST_NOW = "2026-10-31T04:20:00.000Z";

export function createTestEnv(opts: { now?: string; timeZone?: string } = {}): TestEnv {
  const { sqlite, db } = openDatabase(":memory:");
  const blobDir = mkdtempSync(join(tmpdir(), "pb-blobs-"));
  onTestFinished(() => rmSync(blobDir, { recursive: true, force: true }));
  const blobStore = new FsBlobStore(blobDir);
  const clock = {
    now: new Date(opts.now ?? TEST_NOW),
    set(iso: string) {
      this.now = new Date(iso);
    },
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const domain = createDomain({
    db,
    sqlite,
    blobStore,
    now: () => clock.now,
    defaultTimeZone: opts.timeZone ?? "Australia/Brisbane",
  });
  return { domain, blobStore, sqlite, db, clock };
}
