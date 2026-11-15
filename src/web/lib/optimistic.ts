// Optimistic previews: the changes a queued write makes, shown on top of server data from the moment the write is
// queued until the refresh that follows it lands (a failure reverts them). The server stays authoritative; derived
// fields recomputed here (effective dates, overdue, deferred, status) are a best-effort preview, and knock-on effects
// (counts, siblings becoming available, perspective membership) wait for the refresh.
import type { Attachment, Folder, OutlineGroup, OutlineRow, Perspective, Project, SearchResults, Settings, Tag, Task, TaskDetail, TaskPatch } from "../../shared/schemas";
import { addDaysToKey, dateValueToInstant, dayStartInstant, normaliseIsoDate } from "../../shared/datetime";
import { todayKey } from "./dates";
import { previewDate } from "./nl";
import { applyRowChanges, findRow } from "./outlineModel";

export type TaskChanges = Partial<Task> | ((task: Task) => Partial<Task>);
export type ProjectRecord = Omit<Project, "task">;
export type ProjectChanges = Partial<ProjectRecord>;

/** Where a row sits in an outline: under `parentId` (a displayed row, or null for a group root), after sibling `after`. */
export interface RowPlace {
  parentId: string | null;
  /** Previous sibling; null places the row first under its parent. */
  after: string | null;
  /** Places the row after the parent's last child instead (`after` is ignored). */
  last?: boolean;
  /** Group that takes a root row (`parentId` null) when no anchor is shown, e.g. "inbox". */
  groupKey?: string;
  /** Shows the `groupKey` group (holding just this row) when the outline has no such group yet (a first new item). */
  ensureGroup?: boolean;
}

/** A row (with its subtree) placed somewhere, or removed when `at` is null. */
export interface RowChange {
  kind: "row";
  id: string;
  at: RowPlace | null;
  /** The row and its subtree, for showing it where it is not displayed yet (created or restored rows). */
  rows?: readonly OutlineRow[];
  /** Limits the change to one group (e.g. a row leaving its old project's group). */
  inGroup?: string;
}

export interface Lists {
  folders: Folder;
  tags: Tag;
  perspectives: Perspective;
  projects: Project;
}
export type ListName = keyof Lists;

/** A list item replaced or added (`value`), removed (`value: null`) or merged with `patch`. */
export type ItemChange = {
  [L in ListName]: { kind: "item"; list: L; id: string; value?: Lists[L] | null; patch?: Partial<Lists[L]> };
}[ListName];

export interface PreviewAttachment extends Attachment {
  /** Still being uploaded. */
  uploading?: boolean;
}

export type Change =
  | { kind: "task"; ids: readonly string[]; task?: TaskChanges; project?: ProjectChanges }
  | RowChange
  | ItemChange
  | { kind: "settings"; changes: Partial<Settings> }
  | { kind: "attachment"; taskId: string; id: string; value: PreviewAttachment | null };

const DATE_FIELDS = [
  ["deferDate", "defer"],
  ["plannedDate", "planned"],
  ["dueDate", "due"],
] as const;

/** Resolves a date input (ISO or natural language) the way the server will, or undefined when unparseable. */
export function resolveDateInput(input: string | null, field: "defer" | "planned" | "due", settings: Settings): string | null | undefined {
  if (input === null) return null;
  return normaliseIsoDate(input) ?? previewDate(input, field, settings) ?? undefined;
}

/** Task changes implied by a PATCH body; unparseable dates are left to the server. */
export function changesFromPatch(patch: TaskPatch, settings: Settings): Partial<Task> {
  const { deferDate, plannedDate, dueDate, ...rest } = patch;
  const changes: Partial<Task> = { ...rest };
  const inputs = { deferDate, plannedDate, dueDate };
  for (const [key, field] of DATE_FIELDS) {
    const input = inputs[key];
    if (input === undefined) continue;
    const value = resolveDateInput(input, field, settings);
    if (value !== undefined) changes[key] = value;
  }
  return changes;
}

const ms = (value: string | null, settings: Settings) => (value === null ? null : dateValueToInstant(value, settings.timeZone));

/** The value inherited from ancestors, when the current effective value visibly comes from them. */
function inherited(own: string | null, effective: string | null): string | null {
  return effective !== null && effective !== own ? effective : null;
}

/** Applies `changes` to `task` and recomputes the derived fields that depend only on the task itself. */
export function projectTask<T extends Task>(task: T, changes: Partial<Task>, settings: Settings, now = Date.now()): T {
  const next: T = { ...task, ...changes };
  if ("flagged" in changes) next.effectiveFlagged = next.flagged || (task.effectiveFlagged && !task.flagged);

  if ("dueDate" in changes) {
    const parent = inherited(task.dueDate, task.effectiveDueDate);
    const own = next.dueDate;
    next.effectiveDueDate = own === null ? parent : parent !== null && (ms(parent, settings) ?? 0) < (ms(own, settings) ?? 0) ? parent : own;
  }
  if ("deferDate" in changes) {
    const parent = inherited(task.deferDate, task.effectiveDeferDate);
    const own = next.deferDate;
    next.effectiveDeferDate = own === null ? parent : parent !== null && (ms(parent, settings) ?? 0) > (ms(own, settings) ?? 0) ? parent : own;
  }
  if ("plannedDate" in changes) next.effectivePlannedDate = next.plannedDate ?? inherited(task.plannedDate, task.effectivePlannedDate);

  if ("completed" in changes || "dropped" in changes) {
    next.effectiveCompleted = next.completed !== null;
    next.effectiveDropped = next.dropped !== null;
  }
  next.remaining = !next.effectiveCompleted && !next.effectiveDropped;

  const deferMs = ms(next.effectiveDeferDate, settings);
  next.deferred = deferMs !== null && deferMs > now;
  if (next.deferred !== task.deferred) next.blocked = next.deferred || next.remainingChildCount > 0;
  next.blocked = next.remaining && next.blocked;
  next.available = next.remaining && !next.blocked;

  const dueMs = ms(next.effectiveDueDate, settings);
  const tomorrowStart = dayStartInstant(addDaysToKey(todayKey(settings.timeZone, new Date(now)), 1), settings.timeZone);
  const dueSoonLimit = settings.dueSoonSeconds === 0 ? tomorrowStart : now + settings.dueSoonSeconds * 1000;
  next.overdue = next.remaining && dueMs !== null && dueMs < now;
  next.dueSoon = next.remaining && !next.overdue && dueMs !== null && dueMs <= dueSoonLimit;
  next.status = next.effectiveCompleted
    ? "completed"
    : next.effectiveDropped
      ? "dropped"
      : next.overdue
        ? "overdue"
        : next.dueSoon
          ? "dueSoon"
          : next.blocked
            ? "blocked"
            : next.firstAvailable
              ? "next"
              : "available";
  return next;
}

// ---------------------------------------------------------------------------------------------
// Applying changes to server data
// ---------------------------------------------------------------------------------------------

/** `task` with every task change for it applied, in order. */
export function previewTask<T extends Task>(task: T, changes: readonly Change[], settings: Settings): T {
  let out = task;
  for (const c of changes) {
    if (c.kind !== "task" || !c.task || !c.ids.includes(task.id)) continue;
    out = projectTask(out, typeof c.task === "function" ? c.task(out) : c.task, settings);
  }
  return out;
}

/** A project record with its project changes applied. */
export function previewProjectRecord<P extends ProjectRecord>(id: string, record: P, changes: readonly Change[]): P {
  let out = record;
  for (const c of changes) if (c.kind === "task" && c.project && c.ids.includes(id)) out = { ...out, ...c.project };
  return out;
}

function previewProject(project: Project, changes: readonly Change[], settings: Settings): Project {
  if (!changes.some((c) => c.kind === "task" && c.ids.includes(project.id))) return project;
  return { ...previewProjectRecord(project.id, project, changes), task: previewTask(project.task, changes, settings) };
}

/** A cached list (folders, tags, perspectives, projects) with its item changes (and, for projects, task changes) applied. */
export function previewList<L extends ListName>(list: L, items: Lists[L][], changes: readonly Change[], settings: Settings): Lists[L][] {
  let out = items;
  for (const c of changes) {
    if (c.kind !== "item" || c.list !== list) continue;
    const idx = out.findIndex((i) => i.id === c.id);
    if (c.value === null) {
      if (idx >= 0) out = out.filter((_, i) => i !== idx);
      continue;
    }
    const value = c.value as Lists[L] | undefined;
    const patch = c.patch as Partial<Lists[L]> | undefined;
    if (value) out = idx >= 0 ? out.map((item, i) => (i === idx ? value : item)) : [...out, value];
    else if (patch && idx >= 0) out = out.map((item, i) => (i === idx ? { ...item, ...patch } : item));
    if (value && patch) out = out.map((item) => (item.id === c.id ? { ...item, ...patch } : item));
  }
  if (list === "projects") out = (out as Project[]).map((p) => previewProject(p, changes, settings)) as Lists[L][];
  return out;
}

export function previewSettings(settings: Settings, changes: readonly Change[]): Settings {
  let out = settings;
  for (const c of changes) if (c.kind === "settings") out = { ...out, ...c.changes };
  return out;
}

function previewRow(row: OutlineRow, changes: readonly Change[], settings: Settings): OutlineRow {
  if (!changes.some((c) => c.kind === "task" && c.ids.includes(row.id))) return row;
  if (row.kind === "task" && row.task) return { ...row, task: previewTask(row.task, changes, settings) };
  if (row.kind === "project" && row.project) return { ...row, project: previewProject(row.project, changes, settings) };
  return row;
}

/** Outline groups with row moves, additions and removals, then field changes, applied. */
export function previewGroups(groups: OutlineGroup[], changes: readonly Change[], settings: Settings): OutlineGroup[] {
  if (changes.length === 0) return groups;
  const moved = applyRowChanges(groups, changes.filter((c): c is RowChange => c.kind === "row"));
  return moved.map((g) => ({ ...g, rows: g.rows.map((r) => previewRow(r, changes, settings)) }));
}

/** Task detail with field, project, child and attachment changes applied. */
export function previewDetail(detail: TaskDetail, changes: readonly Change[], settings: Settings): TaskDetail {
  if (changes.length === 0) return detail;
  const task = previewTask(detail, changes, settings);
  const project = task.project ? previewProjectRecord(task.id, task.project, changes) : null;
  const removed = new Set(changes.filter((c) => c.kind === "row" && c.at === null && !c.inGroup).map((c) => (c as RowChange).id));
  const children = task.children.filter((t) => !removed.has(t.id)).map((t) => previewTask(t, changes, settings));
  let attachments: PreviewAttachment[] = task.attachments;
  for (const c of changes) {
    if (c.kind !== "attachment" || c.taskId !== task.id) continue;
    const rest = attachments.filter((a) => a.id !== c.id);
    attachments = c.value ? [...rest, c.value] : rest;
  }
  return { ...task, project, children, attachments };
}

/** Search results with field changes applied and removed items gone. */
export function previewSearch(results: SearchResults, changes: readonly Change[], settings: Settings): SearchResults {
  if (changes.length === 0) return results;
  const removed = new Set(changes.filter((c) => c.kind === "row" && c.at === null && !c.inGroup).map((c) => (c as RowChange).id));
  return {
    ...results,
    tasks: results.tasks.filter((t) => !removed.has(t.id)).map((t) => previewTask(t, changes, settings)),
    projects: previewList("projects", results.projects, changes, settings).filter((p) => !removed.has(p.id)),
    folders: previewList("folders", results.folders, changes, settings).filter((f) => results.folders.some((x) => x.id === f.id)),
    tags: previewList("tags", results.tags, changes, settings).filter((t) => results.tags.some((x) => x.id === t.id)),
  };
}

// ---------------------------------------------------------------------------------------------
// Undo snapshots: the changes that restore what was shown before a write
// ---------------------------------------------------------------------------------------------

/** Current (previewed) state, as shown, used to capture what a write overwrites. `undefined` means unknown. */
export interface StateReader {
  task(id: string): Task | undefined;
  projectRecord(id: string): ProjectRecord | undefined;
  /** The displayed outline groups (null when no outline is shown). */
  outline(): OutlineGroup[] | null;
  item<L extends ListName>(list: L, id: string): Lists[L] | null | undefined;
  settings(): Settings | undefined;
  attachment(taskId: string, id: string): PreviewAttachment | null | undefined;
}

function pick<T extends object>(source: T, keys: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (source as Record<string, unknown>)[k];
  return out as Partial<T>;
}

/**
 * The changes that restore what `changes` overwrite, read before they apply. Field changes on items that are
 * not loaded are skipped.
 */
export function invertChanges(changes: readonly Change[], read: StateReader): Change[] {
  const fields: Change[] = [];
  const places: Array<{ index: number; change: RowChange }> = [];
  const removals: RowChange[] = [];
  const groups = read.outline() ?? [];
  for (const c of changes) {
    switch (c.kind) {
      case "task":
        for (const id of c.ids) {
          const task = read.task(id);
          if (task && c.task) fields.push({ kind: "task", ids: [id], task: pick(task, Object.keys(typeof c.task === "function" ? c.task(task) : c.task)) });
          const record = c.project ? read.projectRecord(id) : undefined;
          if (record && c.project) fields.push({ kind: "task", ids: [id], project: pick(record, Object.keys(c.project)) });
        }
        break;
      case "row": {
        const found = findRow(groups, c.id);
        if (found) {
          // A removed row's subtree goes with it: restore every row of the block where it was.
          places.push({ index: found.index, change: { kind: "row", id: c.id, at: found.at, rows: found.block } });
        } else if (c.at !== null) removals.push({ kind: "row", id: c.id, at: null });
        break;
      }
      case "item": {
        const current = read.item(c.list, c.id);
        if (current === undefined) break;
        if (c.value !== undefined) fields.push({ kind: "item", list: c.list, id: c.id, value: current } as ItemChange);
        else if (c.patch && current) fields.push({ kind: "item", list: c.list, id: c.id, patch: pick(current, Object.keys(c.patch)) } as ItemChange);
        break;
      }
      case "settings": {
        const current = read.settings();
        if (current) fields.push({ kind: "settings", changes: pick(current, Object.keys(c.changes)) });
        break;
      }
      case "attachment": {
        const current = read.attachment(c.taskId, c.id);
        if (current !== undefined) fields.push({ kind: "attachment", taskId: c.taskId, id: c.id, value: current });
        break;
      }
    }
  }
  // Rows go back top to bottom (so each anchor is in place first), and rows the write added leave last.
  places.sort((a, b) => a.index - b.index);
  return [...fields.reverse(), ...places.map((p) => p.change), ...removals];
}
