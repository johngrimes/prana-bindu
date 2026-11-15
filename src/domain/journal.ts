// Undo/redo journal (docs/plan.md §Undo journal). AFTER triggers on every journaled domain table copy
// OLD/NEW rows (as JSON keyed by SQL column name) into change_rows while journal_state holds a group id.
import type Database from "better-sqlite3";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../db/schema.js";

export const MAX_GROUPS = 200;

interface TableMeta {
  name: string;
  columns: string[];
  keys: string[];
}

/** Every domain table except `blobs` (blob rows are content-addressed and garbage-collected instead). */
const JOURNALED: SQLiteTable[] = (Object.values(schema) as unknown[])
  .filter((v): v is SQLiteTable => is(v, SQLiteTable))
  .filter((t) => {
    const name = getTableConfig(t).name;
    return name !== "blobs" && (schema.DOMAIN_TABLES as readonly string[]).includes(name);
  });

function tableMeta(table: SQLiteTable): TableMeta {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => c.name);
  const keys = cfg.columns.filter((c) => c.primary).map((c) => c.name);
  for (const pk of cfg.primaryKeys) keys.push(...pk.columns.map((c) => c.name));
  return { name: cfg.name, columns, keys };
}

export const TABLES: Map<string, TableMeta> = new Map(JOURNALED.map((t) => {
  const m = tableMeta(t);
  return [m.name, m];
}));

const q = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;

function jsonObject(prefix: "NEW" | "OLD", columns: string[]): string {
  return `json_object(${columns.map((c) => `'${c}', ${prefix}.${q(c)}`).join(", ")})`;
}

/** Creates the journal triggers (idempotent). */
export function installJournalTriggers(sqlite: Database.Database): void {
  const statements: string[] = [];
  for (const t of TABLES.values()) {
    const keyNew = jsonObject("NEW", t.keys);
    const keyOld = jsonObject("OLD", t.keys);
    const insert = (when: string, key: string, before: string, after: string): string =>
      `CREATE TRIGGER IF NOT EXISTS ${q(`journal_${t.name}_${when}`)} AFTER ${when.toUpperCase()} ON ${q(t.name)} ` +
      `WHEN EXISTS (SELECT 1 FROM journal_state) BEGIN ` +
      `INSERT INTO change_rows (group_id, table_name, row_key_json, before_json, after_json) ` +
      `SELECT group_id, '${t.name}', ${key}, ${before}, ${after} FROM journal_state LIMIT 1; END`;
    statements.push(insert("insert", keyNew, "NULL", jsonObject("NEW", t.columns)));
    statements.push(insert("update", keyNew, jsonObject("OLD", t.columns), jsonObject("NEW", t.columns)));
    statements.push(insert("delete", keyOld, jsonObject("OLD", t.columns), "NULL"));
  }
  sqlite.exec(statements.join(";\n") + ";");
}

interface ChangeRow {
  id: number;
  table_name: string;
  row_key_json: string;
  before_json: string | null;
  after_json: string | null;
}

function deleteRow(sqlite: Database.Database, meta: TableMeta, keyJson: string): void {
  const key = JSON.parse(keyJson) as Record<string, unknown>;
  const where = meta.keys.map((k) => `${q(k)} = ?`).join(" AND ");
  sqlite.prepare(`DELETE FROM ${q(meta.name)} WHERE ${where}`).run(...meta.keys.map((k) => key[k] as never));
}

function upsertRow(sqlite: Database.Database, meta: TableMeta, rowJson: string): void {
  const row = JSON.parse(rowJson) as Record<string, unknown>;
  if (meta.name === "perspectives") {
    // View options are unjournaled UI state: undoing a perspective edit must not roll them back.
    const current = sqlite.prepare("SELECT view_options_json AS v FROM perspectives WHERE id = ?").get(row.id as string) as
      | { v: string }
      | undefined;
    if (current) row.view_options_json = current.v;
  }
  const cols = meta.columns.filter((c) => c in row);
  sqlite
    .prepare(`INSERT OR REPLACE INTO ${q(meta.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...cols.map((c) => row[c] as never));
}

/** Journal operations on the raw connection. All methods must run inside a transaction. */
export class Journal {
  constructor(private readonly sqlite: Database.Database) {}

  /** Opens a group: clears redo, records the group, and arms the triggers. */
  begin(label: string, createdAt: string): number {
    this.sqlite.prepare("DELETE FROM change_rows WHERE group_id IN (SELECT id FROM change_groups WHERE state = 'undone')").run();
    this.sqlite.prepare("DELETE FROM change_groups WHERE state = 'undone'").run();
    const info = this.sqlite
      .prepare("INSERT INTO change_groups (label, created_at, state) VALUES (?, ?, 'applied')")
      .run(label, createdAt);
    const id = Number(info.lastInsertRowid);
    this.sqlite.prepare("DELETE FROM journal_state").run();
    this.sqlite.prepare("INSERT INTO journal_state (group_id) VALUES (?)").run(id);
    return id;
  }

  /** Disarms the triggers, drops the group when it recorded nothing, and prunes old groups. Returns whether it was kept. */
  end(groupId: number): boolean {
    this.sqlite.prepare("DELETE FROM journal_state").run();
    const n = this.sqlite.prepare("SELECT COUNT(*) AS n FROM change_rows WHERE group_id = ?").get(groupId) as { n: number };
    if (n.n === 0) this.sqlite.prepare("DELETE FROM change_groups WHERE id = ?").run(groupId);
    this.prune();
    return n.n > 0;
  }

  /** Disarms the triggers without committing anything (used on rollback paths). */
  disarm(): void {
    this.sqlite.prepare("DELETE FROM journal_state").run();
  }

  prune(): void {
    const cutoff = this.sqlite
      .prepare("SELECT id FROM change_groups ORDER BY id DESC LIMIT 1 OFFSET ?")
      .get(MAX_GROUPS - 1) as { id: number } | undefined;
    if (!cutoff) return;
    this.sqlite.prepare("DELETE FROM change_rows WHERE group_id < ?").run(cutoff.id);
    this.sqlite.prepare("DELETE FROM change_groups WHERE id < ?").run(cutoff.id);
  }

  rows(groupId: number): ChangeRow[] {
    return this.sqlite
      .prepare("SELECT id, table_name, row_key_json, before_json, after_json FROM change_rows WHERE group_id = ? ORDER BY id")
      .all(groupId) as ChangeRow[];
  }

  newestApplied(): { id: number; label: string } | undefined {
    return this.sqlite
      .prepare("SELECT id, label FROM change_groups WHERE state = 'applied' ORDER BY id DESC LIMIT 1")
      .get() as { id: number; label: string } | undefined;
  }

  oldestUndone(): { id: number; label: string } | undefined {
    const applied = this.newestApplied();
    return this.sqlite
      .prepare("SELECT id, label FROM change_groups WHERE state = 'undone' AND id > ? ORDER BY id ASC LIMIT 1")
      .get(applied?.id ?? 0) as { id: number; label: string } | undefined;
  }

  /** Restores before-images of a group (newest row first) and marks it undone. Returns the group or undefined. */
  undo(): { id: number; label: string } | undefined {
    const group = this.newestApplied();
    if (!group) return undefined;
    this.disarm();
    for (const r of this.rows(group.id).reverse()) {
      const meta = TABLES.get(r.table_name);
      if (!meta) continue;
      if (r.before_json === null) deleteRow(this.sqlite, meta, r.row_key_json);
      else upsertRow(this.sqlite, meta, r.before_json);
    }
    this.sqlite.prepare("UPDATE change_groups SET state = 'undone' WHERE id = ?").run(group.id);
    return group;
  }

  /**
   * If the newest applied group is exactly the creation of `taskId` (its insert, its tag links, its own
   * follow-up updates, and rank-only renumbering of siblings), reverts that group and erases it from history.
   * Returns false (changing nothing) otherwise.
   */
  discardCreation(taskId: string): boolean {
    const group = this.newestApplied();
    if (!group) return false;
    const rows = this.rows(group.id);
    const parse = (json: string | null): Record<string, unknown> | null =>
      json === null ? null : (JSON.parse(json) as Record<string, unknown>);
    let created = false;
    for (const r of rows) {
      const key = parse(r.row_key_json)!;
      const before = parse(r.before_json);
      const after = parse(r.after_json);
      if (r.table_name === "tasks" && key.id === taskId) {
        if (before === null) created = true;
        continue;
      }
      if (r.table_name === "task_tags" && key.task_id === taskId) continue;
      const rankOnly =
        r.table_name === "tasks" &&
        before !== null &&
        after !== null &&
        Object.keys(after).every((k) => k === "rank" || after[k] === before[k]);
      if (!rankOnly) return false;
    }
    if (!created) return false;
    this.disarm();
    for (const r of [...rows].reverse()) {
      const meta = TABLES.get(r.table_name);
      if (!meta) continue;
      if (r.before_json === null) deleteRow(this.sqlite, meta, r.row_key_json);
      else upsertRow(this.sqlite, meta, r.before_json);
    }
    this.sqlite.prepare("DELETE FROM change_rows WHERE group_id = ?").run(group.id);
    this.sqlite.prepare("DELETE FROM change_groups WHERE id = ?").run(group.id);
    return true;
  }

  /** Re-applies after-images of the oldest undone group and marks it applied. */
  redo(): { id: number; label: string } | undefined {
    const group = this.oldestUndone();
    if (!group) return undefined;
    this.disarm();
    for (const r of this.rows(group.id)) {
      const meta = TABLES.get(r.table_name);
      if (!meta) continue;
      if (r.after_json === null) deleteRow(this.sqlite, meta, r.row_key_json);
      else upsertRow(this.sqlite, meta, r.after_json);
    }
    this.sqlite.prepare("UPDATE change_groups SET state = 'applied' WHERE id = ?").run(group.id);
    return group;
  }
}
