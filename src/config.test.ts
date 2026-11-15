import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const s3Env = {
  PRANA_BLOB_DRIVER: "s3",
  PRANA_S3_ENDPOINT: "https://s3.example.com",
  PRANA_S3_REGION: "us-east-1",
  PRANA_S3_BUCKET: "prana-attachments",
  PRANA_S3_ACCESS_KEY_ID: "id",
  PRANA_S3_SECRET_ACCESS_KEY: "secret",
};

describe("loadConfig", () => {
  it("applies documented defaults", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      dataDir: resolve("data"),
      dbFile: resolve("data/prana.db"),
      port: 3000,
      origin: "http://localhost:3000",
      rpId: "localhost",
      rpName: "prana-bindu",
      blob: { driver: "fs", dir: resolve("data") },
    });
    expect(c.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("derives origin default from the port, RP ID from the origin hostname, and strips a trailing slash", () => {
    expect(loadConfig({ PRANA_PORT: "8080" }).origin).toBe("http://localhost:8080");
    const c = loadConfig({ PRANA_ORIGIN: "https://tasks.example.com:8443/", PRANA_TIMEZONE: "Australia/Brisbane" });
    expect(c.origin).toBe("https://tasks.example.com:8443");
    expect(c.rpId).toBe("tasks.example.com");
    expect(c.timeZone).toBe("Australia/Brisbane");
  });

  it("treats empty variables as unset", () => {
    expect(loadConfig({ PRANA_PORT: "", PRANA_ORIGIN: " " }).port).toBe(3000);
  });

  it("builds S3 config with path-style addressing by default", () => {
    expect(loadConfig(s3Env).blob).toEqual({
      driver: "s3",
      s3: {
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        bucket: "prana-attachments",
        accessKeyId: "id",
        secretAccessKey: "secret",
        forcePathStyle: true,
      },
    });
    const vhost = loadConfig({ ...s3Env, PRANA_S3_FORCE_PATH_STYLE: "false" }).blob;
    expect(vhost.driver === "s3" && vhost.s3.forcePathStyle).toBe(false);
  });

  it("names every missing S3 variable", () => {
    expect(() => loadConfig({ PRANA_BLOB_DRIVER: "s3", PRANA_S3_REGION: "us-east-1" })).toThrow(
      /PRANA_S3_ENDPOINT, PRANA_S3_BUCKET, PRANA_S3_ACCESS_KEY_ID, PRANA_S3_SECRET_ACCESS_KEY/,
    );
  });

  it("has no backup target unless a PRANA_BACKUP_S3_* variable is set, independent of the blob driver", () => {
    expect(loadConfig(s3Env).backup).toBeUndefined();
    expect(loadConfig({ PRANA_BACKUP_PREFIX: "db/", PRANA_BACKUP_RETENTION_DAYS: "7" }).backup).toBeUndefined();
  });

  it("builds the backup target with a backups/ prefix and 30-day retention by default", () => {
    const backupEnv = Object.fromEntries(
      Object.entries(s3Env)
        .filter(([k]) => k.startsWith("PRANA_S3_"))
        .map(([k, v]) => [k.replace("PRANA_S3_", "PRANA_BACKUP_S3_"), v]),
    );
    expect(loadConfig(backupEnv).backup).toEqual({
      s3: {
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        bucket: "prana-attachments",
        accessKeyId: "id",
        secretAccessKey: "secret",
        forcePathStyle: true,
      },
      prefix: "backups/",
      retentionDays: 30,
    });
    expect(loadConfig({ ...backupEnv, PRANA_BACKUP_PREFIX: "db/", PRANA_BACKUP_RETENTION_DAYS: "0" }).backup).toMatchObject({
      prefix: "db/",
      retentionDays: 0,
    });
  });

  it("names every missing backup S3 variable once any is set", () => {
    expect(() => loadConfig({ PRANA_BACKUP_S3_BUCKET: "prana-backups" })).toThrow(
      /PRANA_BACKUP_S3_ENDPOINT, PRANA_BACKUP_S3_REGION, PRANA_BACKUP_S3_ACCESS_KEY_ID, PRANA_BACKUP_S3_SECRET_ACCESS_KEY/,
    );
  });

  it("enables Mail Drop only when its variables are set, defaulting to Fastmail's JMAP session URL", () => {
    expect(loadConfig({}).mailDrop).toBeUndefined();
    expect(loadConfig({ PRANA_MAIL_DROP_FASTMAIL_TOKEN: "fmu1-x", PRANA_MAIL_DROP_MAILBOX: "Mail Drop" }).mailDrop).toEqual({
      token: "fmu1-x",
      mailbox: "Mail Drop",
      sessionUrl: "https://api.fastmail.com/jmap/session",
    });
    expect(
      loadConfig({
        PRANA_MAIL_DROP_FASTMAIL_TOKEN: "t",
        PRANA_MAIL_DROP_MAILBOX: "Tasks",
        PRANA_MAIL_DROP_SESSION_URL: "http://localhost:8080/jmap/session",
      }).mailDrop?.sessionUrl,
    ).toBe("http://localhost:8080/jmap/session");
  });

  it.each([
    [{ PRANA_MAIL_DROP_FASTMAIL_TOKEN: "t" }, /PRANA_MAIL_DROP_MAILBOX/],
    [{ PRANA_MAIL_DROP_MAILBOX: "Tasks" }, /PRANA_MAIL_DROP_FASTMAIL_TOKEN/],
    [{ PRANA_MAIL_DROP_SESSION_URL: "https://jmap.example.com/session" }, /PRANA_MAIL_DROP_FASTMAIL_TOKEN, PRANA_MAIL_DROP_MAILBOX/],
  ])("requires the Mail Drop token and mailbox once any Mail Drop variable is set (%o)", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  it.each([
    ["PRANA_PORT", "abc"],
    ["PRANA_PORT", "70000"],
    ["PRANA_ORIGIN", "ftp://example.com"],
    ["PRANA_ORIGIN", "https://example.com/app"],
    ["PRANA_TIMEZONE", "Mars/Olympus"],
    ["PRANA_BLOB_DRIVER", "gcs"],
    ["PRANA_S3_FORCE_PATH_STYLE", "maybe"],
    ["PRANA_BACKUP_RETENTION_DAYS", "-1"],
    ["PRANA_BACKUP_RETENTION_DAYS", "7.5"],
    ["PRANA_BACKUP_S3_ENDPOINT", "s3.example.com"],
    ["PRANA_MAIL_DROP_SESSION_URL", "api.fastmail.com/jmap/session"],
    ["PRANA_MAIL_DROP_FASTMAIL_TOKEN", "fmu1-abc\ndef"],
  ])("rejects %s=%s", (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
    expect(() => loadConfig({ [key]: value })).toThrow(key);
  });
});
