import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AppDb } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { builtinPerspectiveRows } from "../domain/builtins.js";
import type { ImportRun } from "../shared/schemas.js";
import { blobKey, type BlobStore } from "../storage/types.js";
import { extractBlob, sniffContentType } from "./blobs.js";
import { mapPackage, referencedBlobs, type BlobInfo, type MappedData } from "./mapping.js";
import { openSource, type ImportSource, type PackageReader } from "./source.js";
import { readPackage } from "./transactions.js";

export { ImportError, type ImportErrorCode } from "./errors.js";
export type { ImportSource } from "./source.js";

export interface ImportDeps {
  db: AppDb;
  sqlite: Database.Database;
  blobStore: BlobStore;
}

const UPLOAD_CONCURRENCY = 8;
/** Rows per multi-row INSERT; keeps bound parameters well under SQLite's limit for the widest table. */
const INSERT_CHUNK = 400;

/**
 * Extracts, verifies and uploads every distinct referenced blob before any database change.
 * Blobs the database already knows are not re-uploaded. Returns per-blob info and the keys uploaded now.
 */
async function uploadBlobs(
  reader: PackageReader,
  wanted: Map<string, string>,
  known: Set<string>,
  store: BlobStore,
  warnings: string[],
): Promise<{ info: Map<string, BlobInfo>; uploaded: string[] }> {
  const info = new Map<string, BlobInfo>();
  const uploaded: string[] = [];
  const files = new Set(reader.files);
  // Upload promises never reject; the first failure is recorded and acted on once every upload has finished.
  const uploads: Promise<void>[] = [];
  const inFlight = new Set<Promise<void>>();
  const failure: { failed: boolean; reason?: unknown } = { failed: false };
  const fail = (reason: unknown) => {
    if (!failure.failed) Object.assign(failure, { failed: true, reason });
  };
  try {
    for (const [sha, path] of wanted) {
      if (failure.failed) break;
      if (!files.has(path)) {
        warnings.push(`Attachment file ${path} is missing from the backup.`);
        continue;
      }
      const result = extractBlob(reader.read(path), sha);
      if ("error" in result) {
        warnings.push(`Attachment file ${path} ${result.error}; its attachments were skipped.`);
        continue;
      }
      const sniffed = sniffContentType(result.bytes);
      info.set(sha, { size: result.bytes.length, sniffed });
      if (known.has(sha)) continue;
      const p = store
        .put(blobKey(sha), result.bytes, sniffed ?? "application/octet-stream")
        .then(() => void uploaded.push(sha), fail);
      uploads.push(p);
      inFlight.add(p);
      void p.then(() => inFlight.delete(p));
      if (inFlight.size >= UPLOAD_CONCURRENCY) await Promise.race(inFlight);
    }
  } catch (err) {
    fail(err);
  }
  await Promise.all(uploads);
  if (failure.failed) {
    await deleteBlobs(store, uploaded);
    throw failure.reason;
  }
  return { info, uploaded };
}

async function deleteBlobs(store: BlobStore, shas: Iterable<string>): Promise<number> {
  let failures = 0;
  for (const sha of shas) {
    try {
      await store.delete(blobKey(sha));
    } catch {
      failures++;
    }
  }
  return failures;
}

function insertAll(db: AppDb, table: SQLiteTable, rows: object[]): void {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    db.insert(table)
      .values(rows.slice(i, i + INSERT_CHUNK) as never)
      .run();
  }
}

/** Replace-all write in one SQLite transaction (spec §11). Auth tables are untouched. */
function writeAll(db: AppDb, data: MappedData, run: typeof schema.importRuns.$inferInsert, now: string): number {
  return db.transaction(
    (tx) => {
      tx.delete(schema.journalState).run();
      tx.delete(schema.changeRows).run();
      tx.delete(schema.changeGroups).run();
      for (const table of [
        schema.folders,
        schema.tags,
        schema.tasks,
        schema.projects,
        schema.taskTags,
        schema.alarms,
        schema.blobs,
        schema.attachments,
        schema.settings,
      ]) {
        tx.delete(table).run();
      }
      tx.delete(schema.perspectives).where(eq(schema.perspectives.builtin, false)).run();

      insertAll(tx, schema.folders, data.folders);
      insertAll(tx, schema.tags, data.tags);
      insertAll(tx, schema.tasks, data.tasks);
      insertAll(tx, schema.projects, data.projects);
      insertAll(tx, schema.taskTags, data.taskTags);
      insertAll(tx, schema.alarms, data.alarms);
      insertAll(tx, schema.blobs, data.blobs);
      insertAll(tx, schema.attachments, data.attachments);
      insertAll(tx, schema.settings, data.settings);
      insertAll(tx, schema.perspectives, data.customPerspectives);

      // Built-in rows always exist after an import; their favourite/rank follow the backup's sidebar order.
      tx.insert(schema.perspectives).values(builtinPerspectiveRows(now)).onConflictDoNothing().run();
      for (const [id, placement] of data.builtinPlacement ?? []) {
        tx.update(schema.perspectives)
          .set({ favorite: placement.favorite, rank: placement.rank, modified: now })
          .where(eq(schema.perspectives.id, id))
          .run();
      }

      const inserted = tx.insert(schema.importRuns).values(run).returning({ id: schema.importRuns.id }).get();
      return inserted.id;
    },
    { behavior: "immediate" },
  );
}

/**
 * Imports an OmniFocus `.ofocus` backup, replacing all domain data (docs/spec.md §11, docs/research/ofocus-format.md §6).
 * The package is parsed and validated and its blobs uploaded before the database is touched; throws `ImportError`
 * (with nothing written) for unusable input.
 */
export async function importOfocus(source: ImportSource, deps: ImportDeps): Promise<ImportRun> {
  const { db, blobStore } = deps;
  const reader = await openSource(source);
  const pkg = readPackage(reader);

  const previous = new Set(db.select({ sha: schema.blobs.sha256 }).from(schema.blobs).all().map((r) => r.sha));
  const blobWarnings: string[] = [];
  const { info, uploaded } = await uploadBlobs(reader, referencedBlobs(pkg), previous, blobStore, blobWarnings);

  const importedAt = new Date().toISOString();
  let data: MappedData;
  let id: number;
  try {
    data = mapPackage(pkg, info, importedAt);
    data.warnings.push(...blobWarnings);
    id = writeAll(
      db,
      data,
      {
        importedAt,
        source: reader.label,
        appId: pkg.appId,
        appVersion: pkg.appVersion,
        capabilitiesJson: JSON.stringify(pkg.capabilities),
        countsJson: JSON.stringify(data.counts),
        warningsJson: JSON.stringify(data.warnings),
      },
      importedAt,
    );
  } catch (err) {
    await deleteBlobs(blobStore, uploaded);
    throw err;
  }

  // GC: the journal is empty after import, so only attachments keep blobs alive (docs/plan.md §Blob storage).
  const live = new Set(data.blobs.map((b) => b.sha256));
  const gcFailures = await deleteBlobs(
    blobStore,
    [...previous].filter((sha) => !live.has(sha)),
  );
  if (gcFailures > 0) {
    data.warnings.push(`${gcFailures} unreferenced attachment file(s) could not be deleted from storage.`);
    db.update(schema.importRuns)
      .set({ warningsJson: JSON.stringify(data.warnings) })
      .where(eq(schema.importRuns.id, id))
      .run();
  }
  return {
    id,
    importedAt,
    source: reader.label,
    appId: pkg.appId,
    appVersion: pkg.appVersion,
    counts: data.counts,
    warnings: data.warnings,
  };
}
