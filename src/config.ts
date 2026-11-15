import { resolve } from "node:path";
import { z } from "zod";

/** Typed runtime configuration (docs/plan.md §Configuration). */
export interface Config {
  dataDir: string;
  /** SQLite database file inside `dataDir`. */
  dbFile: string;
  port: number;
  /** Public origin without trailing slash, e.g. `https://tasks.example.com`. */
  origin: string;
  /** WebAuthn RP ID = hostname of `origin`. */
  rpId: string;
  rpName: string;
  /** Default IANA time zone for settings.timeZone. */
  timeZone: string;
  /** fs: blobs are stored as files at `<dir>/<key>` (keys are `blobs/<sha256>`). */
  blob: { driver: "fs"; dir: string } | { driver: "s3"; s3: S3Config };
  /** Database backup target for `prana-bindu backup`; undefined when no `PRANA_BACKUP_S3_*` variable is set. */
  backup?: BackupConfig;
  /** Mail Drop (email to inbox) watched by `serve`; undefined when no `PRANA_MAIL_DROP_*` variable is set. */
  mailDrop?: MailDropConfig;
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface BackupConfig {
  s3: S3Config;
  /** Key prefix for backup objects, e.g. `backups/`. */
  prefix: string;
  /** Backups older than this many days are deleted after a successful backup; 0 keeps every backup. */
  retentionDays: number;
}

export interface MailDropConfig {
  /** Fastmail API token with the Mail scope. */
  token: string;
  /** Name of the mailbox whose messages become inbox items. */
  mailbox: string;
  /** JMAP session resource URL. */
  sessionUrl: string;
}

export const FASTMAIL_SESSION_URL = "https://api.fastmail.com/jmap/session";

export class ConfigError extends Error {
  override name = "ConfigError";
}

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const booleanString = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .optional()
  .transform((v) => (v === undefined ? undefined : ["true", "1", "yes"].includes(v)));

const isTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const EnvSchema = z.object({
  PRANA_DATA_DIR: optionalString,
  PRANA_PORT: optionalString.pipe(z.coerce.number<string | undefined>().int().min(1).max(65535).optional()),
  PRANA_ORIGIN: optionalString.pipe(
    z
      .url({ protocol: /^https?$/, error: "must be an http(s) URL" })
      .refine((u) => {
        const p = new URL(u);
        return (p.pathname === "/" || p.pathname === "") && !p.search && !p.hash;
      }, "must be an origin without path, query or fragment")
      .optional(),
  ),
  PRANA_RP_NAME: optionalString,
  PRANA_TIMEZONE: optionalString.pipe(z.string().refine(isTimeZone, "must be an IANA time zone").optional()),
  PRANA_BLOB_DRIVER: optionalString.pipe(z.enum(["fs", "s3"]).optional()),
  PRANA_S3_ENDPOINT: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),
  PRANA_S3_REGION: optionalString,
  PRANA_S3_BUCKET: optionalString,
  PRANA_S3_ACCESS_KEY_ID: optionalString,
  PRANA_S3_SECRET_ACCESS_KEY: optionalString,
  PRANA_S3_FORCE_PATH_STYLE: booleanString,
  PRANA_BACKUP_S3_ENDPOINT: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),
  PRANA_BACKUP_S3_REGION: optionalString,
  PRANA_BACKUP_S3_BUCKET: optionalString,
  PRANA_BACKUP_S3_ACCESS_KEY_ID: optionalString,
  PRANA_BACKUP_S3_SECRET_ACCESS_KEY: optionalString,
  PRANA_BACKUP_S3_FORCE_PATH_STYLE: booleanString,
  PRANA_BACKUP_PREFIX: optionalString,
  PRANA_BACKUP_RETENTION_DAYS: optionalString.pipe(z.coerce.number<string | undefined>().int().min(0).optional()),
  // Printable ASCII only: the token goes into an Authorization header, and fetch's error for an invalid header value
  // would include it.
  PRANA_MAIL_DROP_FASTMAIL_TOKEN: optionalString.pipe(
    z.string().regex(/^[\x21-\x7e]+$/, "must not contain spaces or control characters").optional(),
  ),
  PRANA_MAIL_DROP_MAILBOX: optionalString,
  PRANA_MAIL_DROP_SESSION_URL: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),
});

type Env = z.infer<typeof EnvSchema>;

/** Builds an S3Config from `<prefix>ENDPOINT`, `<prefix>REGION`, … or throws naming every missing variable. */
function s3Config(e: Env, prefix: "PRANA_S3_" | "PRANA_BACKUP_S3_", reason: string): S3Config {
  const required = {
    [`${prefix}ENDPOINT`]: e[`${prefix}ENDPOINT`],
    [`${prefix}REGION`]: e[`${prefix}REGION`],
    [`${prefix}BUCKET`]: e[`${prefix}BUCKET`],
    [`${prefix}ACCESS_KEY_ID`]: e[`${prefix}ACCESS_KEY_ID`],
    [`${prefix}SECRET_ACCESS_KEY`]: e[`${prefix}SECRET_ACCESS_KEY`],
  };
  const missing = Object.entries(required)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  ${reason} requires ${missing.join(", ")}`);
  }
  return {
    endpoint: e[`${prefix}ENDPOINT`]!,
    region: e[`${prefix}REGION`]!,
    bucket: e[`${prefix}BUCKET`]!,
    accessKeyId: e[`${prefix}ACCESS_KEY_ID`]!,
    secretAccessKey: e[`${prefix}SECRET_ACCESS_KEY`]!,
    forcePathStyle: e[`${prefix}FORCE_PATH_STYLE`] ?? true,
  };
}

/** Parses and validates `PRANA_*` environment variables; throws `ConfigError` listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  const e = parsed.data;
  const dataDir = resolve(e.PRANA_DATA_DIR ?? "./data");
  const port = e.PRANA_PORT ?? 3000;
  const origin = new URL(e.PRANA_ORIGIN ?? `http://localhost:${port}`).origin;
  const driver = e.PRANA_BLOB_DRIVER ?? "fs";

  const blob: Config["blob"] =
    driver === "s3" ? { driver: "s3", s3: s3Config(e, "PRANA_S3_", "PRANA_BLOB_DRIVER=s3") } : { driver: "fs", dir: dataDir };

  const backupS3Set = [
    e.PRANA_BACKUP_S3_ENDPOINT,
    e.PRANA_BACKUP_S3_REGION,
    e.PRANA_BACKUP_S3_BUCKET,
    e.PRANA_BACKUP_S3_ACCESS_KEY_ID,
    e.PRANA_BACKUP_S3_SECRET_ACCESS_KEY,
  ].some((v) => v !== undefined);
  const backup: BackupConfig | undefined = backupS3Set
    ? {
        s3: s3Config(e, "PRANA_BACKUP_S3_", "Database backup"),
        prefix: e.PRANA_BACKUP_PREFIX ?? "backups/",
        retentionDays: e.PRANA_BACKUP_RETENTION_DAYS ?? 30,
      }
    : undefined;

  const mailDropSet = [e.PRANA_MAIL_DROP_FASTMAIL_TOKEN, e.PRANA_MAIL_DROP_MAILBOX, e.PRANA_MAIL_DROP_SESSION_URL].some(
    (v) => v !== undefined,
  );
  let mailDrop: MailDropConfig | undefined;
  if (mailDropSet) {
    const missing = Object.entries({
      PRANA_MAIL_DROP_FASTMAIL_TOKEN: e.PRANA_MAIL_DROP_FASTMAIL_TOKEN,
      PRANA_MAIL_DROP_MAILBOX: e.PRANA_MAIL_DROP_MAILBOX,
    })
      .filter(([, v]) => v === undefined)
      .map(([k]) => k);
    if (missing.length > 0) throw new ConfigError(`Invalid configuration:\n  Mail Drop requires ${missing.join(", ")}`);
    mailDrop = {
      token: e.PRANA_MAIL_DROP_FASTMAIL_TOKEN!,
      mailbox: e.PRANA_MAIL_DROP_MAILBOX!,
      sessionUrl: e.PRANA_MAIL_DROP_SESSION_URL ?? FASTMAIL_SESSION_URL,
    };
  }

  return {
    dataDir,
    dbFile: resolve(dataDir, "prana.db"),
    port,
    origin,
    rpId: new URL(origin).hostname,
    rpName: e.PRANA_RP_NAME ?? "prana-bindu",
    timeZone: e.PRANA_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    blob,
    backup,
    mailDrop,
  };
}
