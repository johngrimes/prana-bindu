import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { BackupConfig } from "../config.js";
import { createS3Client } from "../storage/s3.js";
import { backupDatabase, backupKey, expiredBackupKeys, snapshotDatabase } from "./index.js";

const countRows = (image: Buffer): number => {
  const db = new Database(image);
  try {
    return z.number().parse(db.prepare("SELECT count(*) FROM t").pluck().get());
  } finally {
    db.close();
  }
};

/** A WAL database with `rows` committed rows that stay in the WAL (no checkpoint). */
function openWriter(file: string, rows: number): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec("CREATE TABLE t (v TEXT)");
  const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
  for (let i = 0; i < rows; i++) insert.run(`row ${i}`);
  return db;
}

describe("snapshotDatabase", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-backup-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("captures committed WAL content of a database another connection holds open, but not its open transaction", () => {
    const file = join(dir, "prana.db");
    const writer = openWriter(file, 3);
    try {
      writer.exec("BEGIN; INSERT INTO t (v) VALUES ('uncommitted')");
      expect(countRows(snapshotDatabase(file))).toBe(3);
      writer.exec("COMMIT");
      expect(countRows(snapshotDatabase(file))).toBe(4);
    } finally {
      writer.close();
    }
  });

  it("reads a closed WAL database without -wal/-shm files", () => {
    const file = join(dir, "prana.db");
    openWriter(file, 2).close();
    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(countRows(snapshotDatabase(file))).toBe(2);
  });

  it("fails instead of backing up an empty database when the file is missing", () => {
    const file = join(dir, "missing.db");
    expect(() => snapshotDatabase(file)).toThrow();
    expect(existsSync(file)).toBe(false);
  });
});

describe("backupKey", () => {
  it("names the object after the UTC time to the second", () => {
    expect(backupKey("backups/", new Date("2026-10-31T03:00:05.123Z"))).toBe("backups/prana-20261031T030005Z.db.gz");
  });
});

describe("expiredBackupKeys", () => {
  const now = new Date("2026-10-31T03:00:00Z");
  const keys = [
    "backups/prana-20261001T030000Z.db.gz", // exactly 30 days old
    "backups/prana-20261001T025959Z.db.gz", // 30 days and 1 second old
    "backups/prana-20250101T000000Z.db.gz",
    "backups/prana-20261030T030000Z.db.gz",
    "backups/notes.txt",
    "backups/old/prana-20250101T000000Z.db.gz",
    "other/prana-20250101T000000Z.db.gz",
  ];

  it("selects only backup-named objects directly under the prefix older than the retention period", () => {
    expect(expiredBackupKeys(keys, "backups/", now, 30)).toEqual([
      "backups/prana-20261001T025959Z.db.gz",
      "backups/prana-20250101T000000Z.db.gz",
    ]);
  });

  it("keeps everything when retention is 0", () => {
    expect(expiredBackupKeys(keys, "backups/", now, 0)).toEqual([]);
  });
});

// Opt-in integration test against a real S3-compatible bucket. Set PRANA_BACKUP_S3_ENDPOINT, PRANA_BACKUP_S3_REGION,
// PRANA_BACKUP_S3_BUCKET, PRANA_BACKUP_S3_ACCESS_KEY_ID and PRANA_BACKUP_S3_SECRET_ACCESS_KEY to run it.
const env = process.env;
const configured = Boolean(
  env.PRANA_BACKUP_S3_ENDPOINT &&
    env.PRANA_BACKUP_S3_REGION &&
    env.PRANA_BACKUP_S3_BUCKET &&
    env.PRANA_BACKUP_S3_ACCESS_KEY_ID &&
    env.PRANA_BACKUP_S3_SECRET_ACCESS_KEY,
);

describe.skipIf(!configured)("backupDatabase (live bucket)", () => {
  it("uploads a restorable snapshot and deletes only expired backups", { timeout: 60_000 }, async () => {
    const config: BackupConfig = {
      s3: {
        endpoint: env.PRANA_BACKUP_S3_ENDPOINT!,
        region: env.PRANA_BACKUP_S3_REGION!,
        bucket: env.PRANA_BACKUP_S3_BUCKET!,
        accessKeyId: env.PRANA_BACKUP_S3_ACCESS_KEY_ID!,
        secretAccessKey: env.PRANA_BACKUP_S3_SECRET_ACCESS_KEY!,
        forcePathStyle: env.PRANA_BACKUP_S3_FORCE_PATH_STYLE !== "false",
      },
      prefix: `test/prana-bindu-backup-${randomBytes(8).toString("hex")}/`,
      retentionDays: 7,
    };
    const bucket = config.s3.bucket;
    const client = createS3Client(config.s3);
    const dir = await mkdtemp(join(tmpdir(), "pb-backup-live-"));
    const now = new Date("2026-10-31T03:00:00Z");
    const expired = `${config.prefix}prana-20261023T030000Z.db.gz`;
    const kept = [`${config.prefix}prana-20261025T030000Z.db.gz`, `${config.prefix}notes.txt`];
    const writer = openWriter(join(dir, "prana.db"), 5);
    try {
      for (const key of [expired, ...kept]) await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "x" }));

      const result = await backupDatabase(join(dir, "prana.db"), config, now);

      expect(result.key).toBe(`${config.prefix}prana-20261031T030000Z.db.gz`);
      expect(result.deleted).toEqual([expired]);
      const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: config.prefix }));
      expect((listed.Contents ?? []).map((o) => o.Key).sort()).toEqual([...kept, result.key].sort());
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: result.key }));
      const uploaded = Buffer.from(await object.Body!.transformToByteArray());
      expect(uploaded.byteLength).toBe(result.uploadedBytes);
      expect(countRows(gunzipSync(uploaded))).toBe(5);
    } finally {
      writer.close();
      const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: config.prefix }));
      for (const o of listed.Contents ?? []) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }));
      client.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
