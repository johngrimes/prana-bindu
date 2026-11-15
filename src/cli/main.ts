#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Command } from "commander";
import { z } from "zod";
import { backupDatabase } from "../backup/index.js";
import { ConfigError, loadConfig, type Config } from "../config.js";
import { openDatabase, type DbHandle } from "../db/connection.js";
import { createDomain } from "../domain/index.js";
import { ImportError } from "../importer/errors.js";
import { importOfocus } from "../importer/index.js";
import { MailDrop } from "../maildrop/index.js";
import { runMcpStdio } from "../mcp/stdio.js";
import { createApp } from "../server/app.js";
import { AuthError, AuthService } from "../server/auth/index.js";
import { OAuthService } from "../server/oauth/service.js";
import type { ImportRun } from "../shared/schemas.js";
import { createBlobStore } from "../storage/index.js";
import type { BlobStore } from "../storage/types.js";

interface Runtime extends DbHandle {
  config: Config;
  blobStore: BlobStore;
}

function openRuntime(): Runtime {
  const config = loadConfig();
  return { config, ...openDatabase(config.dbFile), blobStore: createBlobStore(config) };
}

const importSource = (arg: string) => (/^https?:\/\//i.test(arg) ? { url: arg } : { path: resolve(arg) });

function printImportRun(run: ImportRun): void {
  console.log(`Imported ${run.source} at ${run.importedAt}${run.appVersion ? ` (OmniFocus ${run.appVersion})` : ""}`);
  const width = Math.max(...Object.keys(run.counts).map((k) => k.length));
  for (const [kind, count] of Object.entries(run.counts)) console.log(`  ${kind.padEnd(width)}  ${count}`);
  if (run.warnings.length > 0) {
    console.log(`Warnings (${run.warnings.length}):`);
    for (const w of run.warnings) console.log(`  - ${w}`);
  }
}

/** package.json version, from `src/cli` (tsx) or `dist/server/cli` (built). */
function version(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgFile = resolve(here, here.split(sep).includes("dist") ? "../../../package.json" : "../../package.json");
  return z.object({ version: z.string() }).parse(JSON.parse(readFileSync(pkgFile, "utf8"))).version;
}

const program = new Command()
  .name("prana-bindu")
  .description("Mobile-first task manager with a REST API and an MCP server. Configured via PRANA_* environment variables.")
  .version(version());

program
  .command("serve")
  .description("Serve the web app, REST API (/api/v1) and MCP endpoint (/mcp)")
  .action(() => {
    const rt = openRuntime();
    const domain = createDomain({ db: rt.db, sqlite: rt.sqlite, blobStore: rt.blobStore, defaultTimeZone: rt.config.timeZone });
    const deps = { db: rt.db, sqlite: rt.sqlite, blobStore: rt.blobStore };
    const app = createApp({
      config: rt.config,
      db: rt.db,
      domain,
      blobStore: rt.blobStore,
      runImport: async (source) => {
        const run = await importOfocus(source, deps);
        domain.invalidate();
        return run;
      },
    });
    const mailDrop = rt.config.mailDrop ? new MailDrop({ domain, config: rt.config.mailDrop }) : null;
    // Deletes expired OAuth codes and tokens, dead grants and unused clients: now and hourly.
    const oauth = new OAuthService(rt.db, rt.config.origin);
    oauth.sweep();
    const oauthSweep = setInterval(() => oauth.sweep(), 60 * 60 * 1000);
    oauthSweep.unref();
    const server = serve({ fetch: app.fetch, port: rt.config.port }, (info) => {
      console.log(`prana-bindu listening on port ${info.port} (${rt.config.origin})`);
      console.log(`  data: ${rt.config.dataDir}  blobs: ${rt.config.blob.driver}`);
      mailDrop?.start();
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      console.error(err.code === "EADDRINUSE" ? `Port ${rt.config.port} is already in use` : `Server error: ${err.message}`);
      process.exit(1);
    });
    let stopping = false;
    const shutdown = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal} received, shutting down`);
      clearInterval(oauthSweep);
      const force = setTimeout(() => {
        console.error("Forced shutdown after 10s");
        process.exit(1);
      }, 10_000);
      force.unref();
      // Stop Mail Drop first so that no check is writing when the database closes.
      void (mailDrop?.stop() ?? Promise.resolve()).then(() =>
        server.close(() => {
          rt.sqlite.close();
          process.exit(0);
        }),
      );
      // Idle keep-alive sockets would otherwise hold the server open until they time out.
      if ("closeIdleConnections" in server) server.closeIdleConnections();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });

program
  .command("import")
  .description("Replace all data with a .ofocus backup (zip file, .ofocus directory, or http(s) URL of a zip)")
  .argument("<source>", "path or URL")
  .action(async (source: string) => {
    const rt = openRuntime();
    try {
      printImportRun(await importOfocus(importSource(source), rt));
    } catch (err) {
      if (!(err instanceof ImportError)) throw err;
      console.error(`Import failed (${err.code}): ${err.message}`);
      process.exitCode = 1;
    } finally {
      rt.sqlite.close();
    }
  });

program
  .command("backup")
  .description("Upload a gzipped snapshot of the database to the PRANA_BACKUP_S3_* bucket and delete expired backups")
  .action(async () => {
    // Reads the database file directly: no migrations, so it never writes to the live database.
    const config = loadConfig();
    if (!config.backup) {
      throw new ConfigError(
        "Backups need PRANA_BACKUP_S3_ENDPOINT, PRANA_BACKUP_S3_REGION, PRANA_BACKUP_S3_BUCKET, PRANA_BACKUP_S3_ACCESS_KEY_ID and PRANA_BACKUP_S3_SECRET_ACCESS_KEY",
      );
    }
    const result = await backupDatabase(config.dbFile, config.backup);
    console.log(
      `Backed up ${config.dbFile} (${result.databaseBytes} bytes) to s3://${config.backup.s3.bucket}/${result.key} (${result.uploadedBytes} bytes gzipped)`,
    );
    for (const key of result.deleted) console.log(`Deleted expired backup ${key}`);
  });

const passkey = program.command("passkey").description("Manage passkeys");
passkey
  .command("enroll")
  .description("Print a one-time enrollment link (valid for 15 minutes) for registering a passkey")
  .action(() => {
    const rt = openRuntime();
    const token = new AuthService(rt.db, rt.config).createEnrollmentToken();
    rt.sqlite.close();
    console.log(`${rt.config.origin}/enroll#${token}`);
  });

const token = program.command("token").description("Manage API tokens (for the REST API and /mcp)");
token
  .command("create")
  .description("Create an API token; the plaintext is printed once")
  .argument("<name>", "label shown in Settings")
  .action((name: string) => {
    const rt = openRuntime();
    const { plaintext } = new AuthService(rt.db, rt.config).createApiToken(name.trim() || name);
    rt.sqlite.close();
    console.log(plaintext);
  });
token
  .command("list")
  .description("List active API tokens")
  .action(() => {
    const rt = openRuntime();
    const tokens = new AuthService(rt.db, rt.config).listApiTokens();
    rt.sqlite.close();
    if (tokens.length === 0) {
      console.log("No API tokens.");
      return;
    }
    for (const t of tokens) {
      console.log(`${t.id}  ${t.prefix}…  ${t.name}  created ${t.createdAt}  last used ${t.lastUsedAt ?? "never"}`);
    }
  });
token
  .command("revoke")
  .description("Revoke an API token by id")
  .argument("<id>", "token id (see `token list`)")
  .action((id: string) => {
    const rt = openRuntime();
    try {
      new AuthService(rt.db, rt.config).revokeApiToken(id);
      console.log(`Revoked ${id}`);
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      console.error(err.message);
      process.exitCode = 1;
    } finally {
      rt.sqlite.close();
    }
  });

program
  .command("mcp")
  .description("Run the MCP server over stdio against the local database (no token; local trust)")
  .action(async () => {
    const rt = openRuntime();
    const domain = createDomain({ db: rt.db, sqlite: rt.sqlite, blobStore: rt.blobStore, defaultTimeZone: rt.config.timeZone });
    await runMcpStdio({ domain, blobStore: rt.blobStore });
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
