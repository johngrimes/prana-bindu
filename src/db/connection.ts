import { mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type AppDb = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  sqlite: Database.Database;
  db: AppDb;
}

/** Repository-root `drizzle/` folder, from `src/db` (tsx/vitest) or `dist/server/db` (built). */
function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.split(sep).includes("dist") ? resolve(here, "../../../drizzle") : resolve(here, "../../drizzle");
}

/** Opens (creating if needed) the SQLite database and applies pending migrations. */
export function openDatabase(file: string): DbHandle {
  if (file !== ":memory:") mkdirSync(dirname(resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  return { sqlite, db };
}
