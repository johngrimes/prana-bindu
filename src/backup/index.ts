import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import Database from "better-sqlite3";
import type { BackupConfig } from "../config.js";
import { createS3Client } from "../storage/s3.js";

/** Backup object names below the prefix: `prana-<UTC timestamp>.db.gz`. */
const BACKUP_NAME = /^prana-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db\.gz$/;

const DAY_MS = 86_400_000;

export interface BackupResult {
  key: string;
  databaseBytes: number;
  uploadedBytes: number;
  /** Keys of expired backups deleted after the upload. */
  deleted: string[];
}

/** `<prefix>prana-20261031T030000Z.db.gz` for `now` in UTC. */
export function backupKey(prefix: string, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  return `${prefix}prana-${stamp}.db.gz`;
}

/**
 * Consistent copy of a database that another process may be writing, including changes still in its WAL.
 * Opens the file read-only and never runs migrations, so it is safe against the live database.
 */
export function snapshotDatabase(dbFile: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "prana-backup-"));
  try {
    const target = join(dir, "prana.db");
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      db.pragma("busy_timeout = 5000");
      // VACUUM INTO reads within one transaction, so the copy is a point-in-time snapshot.
      db.prepare("VACUUM INTO ?").run(target);
    } finally {
      db.close();
    }
    return readFileSync(target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Keys under `prefix` named like backups whose timestamp is more than `retentionDays` before `now`. */
export function expiredBackupKeys(keys: string[], prefix: string, now: Date, retentionDays: number): string[] {
  if (retentionDays === 0) return [];
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  return keys.filter((key) => {
    if (!key.startsWith(prefix)) return false;
    const m = BACKUP_NAME.exec(key.slice(prefix.length));
    if (!m) return false;
    const [, y, mo, d, h, mi, s] = m.map(Number);
    return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) < cutoff;
  });
}

/** Uploads a gzipped snapshot of `dbFile` to the backup bucket, then deletes backups past the retention period. */
export async function backupDatabase(dbFile: string, config: BackupConfig, now: Date = new Date()): Promise<BackupResult> {
  const snapshot = snapshotDatabase(dbFile);
  const body = gzipSync(snapshot);
  const key = backupKey(config.prefix, now);
  const client = createS3Client(config.s3);
  const bucket = config.s3.bucket;
  try {
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/gzip", ContentLength: body.byteLength }),
    );

    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: config.prefix, ContinuationToken: continuationToken }),
      );
      for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    const deleted = expiredBackupKeys(keys, config.prefix, now, config.retentionDays).filter((k) => k !== key);
    for (const expired of deleted) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: expired }));

    return { key, databaseBytes: snapshot.byteLength, uploadedBytes: body.byteLength, deleted };
  } finally {
    client.destroy();
  }
}
