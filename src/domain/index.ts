// Domain services: the only layer that touches domain tables (docs/plan.md §Domain runtime model).
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppDb } from "../db/connection.js";
import * as schema from "../db/schema.js";
import {
  addToNaive,
  dateValueToInstant,
  formatFloating,
  instantToNaive,
  isValidTimeZone,
  normaliseIsoDate,
} from "../shared/datetime.js";
import { parseDate, parseDuration, type DateField } from "../shared/nlparse.js";
import {
  BUILTIN_PERSPECTIVES,
  PerspectivePresentation,
  Settings as SettingsSchema,
  ViewOptions as ViewOptionsSchema,
  type Attachment,
  type Availability,
  type Changed,
  type Folder,
  type Forecast,
  type History,
  type ImportRun,
  type Perspective,
  type PerspectiveContents,
  type Position,
  type Project,
  type QuickOpenResult,
  type RepeatRule,
  type SearchResults,
  type Settings,
  type Tag,
  type Task,
  type TaskDetail,
  type TaskStatus,
  type ViewOptions,
} from "../shared/schemas.js";
import type { z } from "zod";
import type {
  ContainerMove,
  FolderCreate,
  FolderPatch,
  OutlineOp,
  PerspectiveCreate,
  PerspectivePatch,
  ProjectCreate,
  ProjectPatch,
  TagCreate,
  TagPatch,
  TaskCreate,
  TaskMove,
  TaskPatch,
} from "../shared/schemas.js";
import { blobKey, type BlobStore } from "../storage/types.js";
import { sniffContentType } from "./attachments.js";
import { builtinPerspectiveRows } from "./builtins.js";
import { computeDerived, type Derived } from "./derive.js";
import { alarmDto, attachmentDto, folderDto, perspectiveDto, tagDto } from "./dto.js";
import { DomainError, notFound } from "./errors.js";
import { newId } from "./ids.js";
import { installJournalTriggers, Journal } from "./journal.js";
import { insertionIndex, planRank, type Ranked } from "./rank.js";
import { advanceRepeat, parseRule } from "./repeat.js";
import { defaultSettings, settingsFromRows, SETTINGS_KEYS } from "./settings.js";
import { Snapshot, type FolderRow, type ProjectRow, type TagRow, type TaskRow } from "./snapshot.js";
import { contentsFor, View, type ContentsParams } from "./views.js";

export { DomainError } from "./errors.js";
export { builtinPerspectiveRows } from "./builtins.js";

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface DomainDeps {
  db: AppDb;
  sqlite: Database.Database;
  blobStore: BlobStore;
  now?: () => Date;
  /** Used when no `timeZone` setting is stored (default: the process' zone). */
  defaultTimeZone?: string;
}

export interface TaskListFilter {
  perspective?: string;
  inbox?: boolean;
  projectId?: string;
  tagId?: string;
  folderId?: string;
  flagged?: boolean;
  status?: TaskStatus;
  availability?: Availability;
  q?: string;
  dueBefore?: string;
  dueAfter?: string;
  limit?: number;
  cursor?: string;
}

/** Where a task lives: under a parent task, in the inbox, or at the top level without a project. */
interface Container {
  parentId: string | null;
  inbox: boolean;
}

export interface AttachmentFile {
  name: string;
  bytes: Uint8Array;
  /** Declared type; magic bytes and the file extension take precedence (see `sniffContentType`). */
  contentType?: string;
}

interface StoredBlob {
  sha256: string;
  contentType: string;
  key: string;
  size: number;
  name: string;
}

/** Identifies an emailed message: JMAP email ids are unique within an account. */
export interface MailDropSource {
  accountId: string;
  emailId: string;
}

/** Undo steps one request's writes added (`Domain#countUndoSteps`). */
export interface UndoSteps {
  net: number;
  /** Id of the newest step recorded, or null when none was. */
  last: number | null;
  /** The step that was newest before `last` (what Undo reverts after it), or null when there was none. */
  previous: number | null;
}

type TaskCreateInput = z.input<typeof TaskCreate>;
type TaskPatchInput = z.input<typeof TaskPatch>;

export class Domain {
  private readonly db: AppDb;
  private readonly sqlite: Database.Database;
  private readonly blobStore: BlobStore;
  private readonly clock: () => Date;
  private readonly defaultTimeZone: string;
  private readonly journal: Journal;

  private snapshot: Snapshot | null = null;
  private dataVersion = -1;
  private derivedCache: Derived | null = null;
  private derivedKey = "";
  private msCache = new Map<string, number>();
  private msCacheTz = "";
  /** Task ids written during the current mutation. */
  private touched = new Set<string>();
  private mutationNow = "";
  /** Undo steps added by the writes of one request (see `countUndoSteps`). */
  private readonly undoSteps = new AsyncLocalStorage<UndoSteps>();

  constructor(deps: DomainDeps) {
    this.db = deps.db;
    this.sqlite = deps.sqlite;
    this.blobStore = deps.blobStore;
    this.clock = deps.now ?? (() => new Date());
    this.defaultTimeZone = deps.defaultTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    installJournalTriggers(this.sqlite);
    this.journal = new Journal(this.sqlite);
  }

  /** Drops cached state (call after writes by other code, e.g. the importer). */
  invalidate(): void {
    this.snapshot = null;
    this.derivedCache = null;
  }

  // -------------------------------------------------------------------------
  // Snapshot / derived state
  // -------------------------------------------------------------------------

  private snap(): Snapshot {
    const version = this.sqlite.pragma("data_version", { simple: true }) as number;
    if (this.snapshot && version === this.dataVersion) return this.snapshot;
    this.dataVersion = version;
    const missing = BUILTIN_PERSPECTIVES.filter(
      (id) => !this.db.select({ id: schema.perspectives.id }).from(schema.perspectives).where(eq(schema.perspectives.id, id)).get(),
    );
    if (missing.length > 0) {
      const rows = builtinPerspectiveRows(this.clock().toISOString()).filter((r) => missing.includes(r.id as never));
      this.db.insert(schema.perspectives).values(rows).onConflictDoNothing().run();
    }
    this.snapshot = Snapshot.load(this.db);
    this.derivedCache = null;
    return this.snapshot;
  }

  getSettings(): Settings {
    return settingsFromRows(this.snap().settingRows, defaultSettings(this.defaultTimeZone));
  }

  private toMs = (value: string): number => {
    let v = this.msCache.get(value);
    if (v === undefined) {
      if (this.msCache.size > 100_000) this.msCache.clear();
      v = dateValueToInstant(value, this.msCacheTz);
      this.msCache.set(value, v);
    }
    return v;
  };

  private derived(now = this.clock().getTime()): Derived {
    const snap = this.snap();
    const settings = this.getSettings();
    if (settings.timeZone !== this.msCacheTz) {
      this.msCache.clear();
      this.msCacheTz = settings.timeZone;
    }
    const key = `${snap.version}|${settings.timeZone}|${settings.dueSoonSeconds}`;
    if (this.derivedCache && this.derivedKey === key && Math.abs(this.derivedCache.now - now) < 1000) {
      return this.derivedCache;
    }
    this.derivedCache = computeDerived(snap, settings, now, this.toMs);
    this.derivedKey = key;
    return this.derivedCache;
  }

  private view(): View {
    return new View(this.snap(), this.derived(), this.getSettings());
  }

  // -------------------------------------------------------------------------
  // Mutation plumbing
  // -------------------------------------------------------------------------

  private mutate<T>(label: string, fn: () => T): T {
    const { value, kept } = this.transact(() => {
      const previous = this.journal.newestApplied()?.id ?? null;
      const group = this.journal.begin(label, this.mutationNow);
      const value = fn();
      return { value, kept: this.journal.end(group) ? { id: group, previous } : null };
    });
    const steps = this.undoSteps.getStore();
    if (kept && steps) {
      steps.net++;
      steps.last = kept.id;
      steps.previous = kept.previous;
    }
    return value;
  }

  /**
   * Runs `fn` and reports the undo steps its writes added: `net` is 1 for a change, 0 when nothing changed (no step
   * is recorded), -1 when a discard erased the creation step; `last` is the id of the newest step it recorded and
   * `previous` the step before it. Clients use it to keep their own undo history in line with the server's.
   */
  async countUndoSteps(fn: () => Promise<void>): Promise<UndoSteps> {
    const steps: UndoSteps = { net: 0, last: null, previous: null };
    await this.undoSteps.run(steps, fn);
    return steps;
  }

  /**
   * Runs `fn` in one transaction with the mutation bookkeeping (`touched`, `mutationNow`) but no undo group. Only
   * `mutate` and writes the user did not make themselves (Mail Drop) call this.
   */
  private transact<T>(fn: () => T): T {
    this.touched = new Set();
    this.mutationNow = this.clock().toISOString();
    this.snap();
    try {
      return this.sqlite.transaction(fn)();
    } catch (e) {
      this.invalidate();
      throw e;
    }
  }

  private changed(): Changed {
    const v = this.view();
    const snap = this.snap();
    return { changed: [...this.touched].filter((id) => snap.tasks.has(id)).map((id) => v.task(id)) };
  }

  private writeTask(id: string, patch: Partial<TaskRow>, touchModified = true): void {
    const snap = this.snap();
    const row = snap.tasks.get(id);
    if (!row) throw notFound("Task", id);
    const values = touchModified ? { ...patch, modified: this.mutationNow } : patch;
    this.db.update(schema.tasks).set(values).where(eq(schema.tasks.id, id)).run();
    snap.tasks.set(id, { ...row, ...values });
    snap.touch();
    this.touched.add(id);
  }

  private insertTaskRow(row: TaskRow): void {
    this.db.insert(schema.tasks).values(row).run();
    const snap = this.snap();
    snap.tasks.set(row.id, row);
    snap.touch();
    this.touched.add(row.id);
  }

  private writeProject(id: string, patch: Partial<ProjectRow>): void {
    const snap = this.snap();
    const row = snap.projects.get(id);
    if (!row) throw notFound("Project", id);
    this.db.update(schema.projects).set(patch).where(eq(schema.projects.taskId, id)).run();
    snap.projects.set(id, { ...row, ...patch });
    snap.touch();
    this.touched.add(id);
  }

  private writeFolder(id: string, patch: Partial<FolderRow>): void {
    const snap = this.snap();
    const row = snap.folders.get(id);
    if (!row) throw notFound("Folder", id);
    const values = { ...patch, modified: this.mutationNow };
    this.db.update(schema.folders).set(values).where(eq(schema.folders.id, id)).run();
    snap.folders.set(id, { ...row, ...values });
    snap.touch();
  }

  private writeTag(id: string, patch: Partial<TagRow>): void {
    const snap = this.snap();
    const row = snap.tags.get(id);
    if (!row) throw notFound("Tag", id);
    const values = { ...patch, modified: this.mutationNow };
    this.db.update(schema.tags).set(values).where(eq(schema.tags.id, id)).run();
    snap.tags.set(id, { ...row, ...values });
    snap.touch();
  }

  private removeTaskRows(ids: string[]): void {
    if (ids.length === 0) return;
    const snap = this.snap();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      this.db.delete(schema.taskTags).where(inArray(schema.taskTags.taskId, chunk)).run();
      this.db.delete(schema.alarms).where(inArray(schema.alarms.taskId, chunk)).run();
      this.db.delete(schema.attachments).where(inArray(schema.attachments.taskId, chunk)).run();
      this.db.delete(schema.projects).where(inArray(schema.projects.taskId, chunk)).run();
      this.db.delete(schema.tasks).where(inArray(schema.tasks.id, chunk)).run();
    }
    const gone = new Set(ids);
    for (const id of ids) {
      snap.tasks.delete(id);
      snap.projects.delete(id);
      snap.taskTags.delete(id);
      snap.alarms.delete(id);
      this.touched.add(id);
    }
    for (const [aid, a] of snap.attachments) if (gone.has(a.taskId)) snap.attachments.delete(aid);
    snap.touch();
  }

  // -------------------------------------------------------------------------
  // Input normalisation
  // -------------------------------------------------------------------------

  private dateDefaults(settings: Settings) {
    return { defer: settings.defaultDeferTime, due: settings.defaultDueTime, planned: settings.defaultPlannedTime };
  }

  /** Normalises a date input: ISO (fixed/floating/offset) or natural language (→ floating in the user's zone). */
  normaliseDate(input: string | null | undefined, field: DateField): string | null {
    if (input === null || input === undefined) return null;
    const iso = normaliseIsoDate(input);
    if (iso !== null) return iso;
    const settings = this.getSettings();
    const parsed = parseDate(input, {
      field,
      now: this.clock(),
      timeZone: settings.timeZone,
      defaults: this.dateDefaults(settings),
      dateFormat: settings.dateFormat,
    });
    if (parsed === null) throw new DomainError("parse_error", `Unable to parse date: ${input}`, { field, text: input });
    return parsed;
  }

  /** POST /parse. */
  parse(kind: "date" | "duration", text: string, field: DateField = "due"): string | number {
    if (kind === "duration") {
      const v = parseDuration(text);
      if (v === null) throw new DomainError("parse_error", `Unable to parse duration: ${text}`);
      return v;
    }
    return this.normaliseDate(text, field)!;
  }

  private repeatColumns(repeat: RepeatRule | null): Partial<TaskRow> {
    if (repeat === null) {
      return { repeatRule: null, repeatScheduleType: null, repeatAnchor: null, repeatCatchUp: false };
    }
    const rule = repeat.rule.replace(/^RRULE:/i, "").trim();
    parseRule(rule);
    return {
      repeatRule: rule,
      repeatScheduleType: repeat.scheduleType,
      repeatAnchor: repeat.anchorDate,
      repeatCatchUp: repeat.catchUpAutomatically,
    };
  }

  // -------------------------------------------------------------------------
  // Ordering helpers
  // -------------------------------------------------------------------------

  private siblingsIn(c: Container): TaskRow[] {
    const snap = this.snap();
    if (c.parentId !== null) return snap.childrenOf(c.parentId);
    return c.inbox ? snap.inboxRoots() : snap.orphanRoots();
  }

  private containerOf(row: TaskRow): Container {
    return { parentId: row.parentId, inbox: row.parentId === null && row.inInbox };
  }

  /** Rank for placing `movingId` (or a new task) into `c` at `position`, renumbering siblings when needed. */
  private rankIn(c: Container, position: Position, movingId: string | null): number {
    const siblings: Ranked[] = this.siblingsIn(c).filter((s) => s.id !== movingId);
    const plan = planRank(siblings, insertionIndex(siblings, position));
    for (const [id, rank] of plan.renumber) this.writeTask(id, { rank }, false);
    return plan.rank;
  }

  /** Folder/project siblings share one rank space inside a folder. */
  private containerRank(folderId: string | null, position: Position, movingId: string | null): number {
    const snap = this.snap();
    const siblings: Ranked[] = snap
      .containerChildren(folderId)
      .map((i) => (i.kind === "folder" ? { id: i.row.id, rank: i.row.rank } : { id: i.task.id, rank: i.task.rank }))
      .filter((s) => s.id !== movingId);
    const plan = planRank(siblings, insertionIndex(siblings, position));
    for (const [id, rank] of plan.renumber) {
      if (snap.folders.has(id)) this.writeFolder(id, { rank });
      else this.writeTask(id, { rank }, false);
    }
    return plan.rank;
  }

  private tagRank(parentId: string | null, position: Position, movingId: string | null): number {
    const siblings: Ranked[] = this.snap()
      .tagChildren(parentId)
      .filter((t) => t.id !== movingId);
    const plan = planRank(siblings, insertionIndex(siblings, position));
    for (const [id, rank] of plan.renumber) this.writeTag(id, { rank });
    return plan.rank;
  }

  // -------------------------------------------------------------------------
  // Tasks: reads
  // -------------------------------------------------------------------------

  /** The client-supplied id (409 `conflict` if `taken` has it), or a new server id. */
  private claimId(kind: string, id: string | undefined, taken: ReadonlyMap<string, unknown>): string {
    if (id === undefined) return newId();
    if (taken.has(id)) throw new DomainError("conflict", `${kind} id already in use: ${id}`, { kind, id });
    return id;
  }

  private requireTask(id: string): TaskRow {
    const row = this.snap().tasks.get(id);
    if (!row) throw notFound("Task", id);
    return row;
  }

  private requireProject(id: string): ProjectRow {
    const row = this.snap().projects.get(id);
    if (!row) throw notFound("Project", id);
    return row;
  }

  getTask(id: string): Task {
    this.requireTask(id);
    return this.view().task(id);
  }

  getTaskDetail(id: string): TaskDetail {
    this.requireTask(id);
    const v = this.view();
    const snap = this.snap();
    const tz = this.getSettings().timeZone;
    const p = snap.projects.get(id);
    let project: TaskDetail["project"] = null;
    if (p) {
      const { task: _task, ...rest } = v.project(id);
      project = rest;
    }
    return {
      ...v.task(id),
      children: snap.childrenOf(id).map((c) => v.task(c.id)),
      alarms: (snap.alarms.get(id) ?? []).map((a) => alarmDto(v.d, a, tz)),
      attachments: snap.attachmentsOf(id).map(attachmentDto),
      project,
    };
  }

  listTasks(filter: TaskListFilter = {}): { items: Task[]; nextCursor: string | null } {
    const v = this.view();
    const snap = this.snap();
    const d = v.d;
    let ids: string[];
    if (filter.perspective) {
      const contents = this.perspectiveContents(filter.perspective, {});
      const seen = new Set<string>();
      ids = [];
      for (const g of contents.groups) {
        for (const r of g.rows) {
          if ((r.kind === "task" || r.kind === "project") && !seen.has(r.id)) {
            seen.add(r.id);
            ids.push(r.id);
          }
        }
      }
    } else ids = d.taskOrder;

    const availability = filter.availability ?? "remaining";
    const tz = this.getSettings().timeZone;
    const dueBefore = filter.dueBefore ? dateValueToInstant(this.normaliseDate(filter.dueBefore, "due")!, tz) : null;
    const dueAfter = filter.dueAfter ? dateValueToInstant(this.normaliseDate(filter.dueAfter, "due")!, tz) : null;
    const q = filter.q?.trim().toLowerCase();
    const items = ids.filter((id) => {
      const s = d.tasks.get(id);
      const row = snap.tasks.get(id);
      if (!s || !row) return false;
      if (!v.matchesFilter(id, availability)) return false;
      if (filter.inbox !== undefined && s.inInboxTree !== filter.inbox) return false;
      // The project's own root task is not one of its actions.
      if (filter.projectId && (s.projectId !== filter.projectId || id === filter.projectId)) return false;
      if (filter.folderId && !(s.projectId && d.projects.get(s.projectId)?.folderIds.includes(filter.folderId))) return false;
      if (filter.tagId && !snap.tagIdsOf(id).includes(filter.tagId)) return false;
      if (filter.flagged !== undefined && s.effectiveFlagged !== filter.flagged) return false;
      if (filter.status && s.status !== filter.status) return false;
      if (q && !row.name.toLowerCase().includes(q) && !row.note.toLowerCase().includes(q)) return false;
      if (dueBefore !== null && (s.dueMs === null || s.dueMs >= dueBefore)) return false;
      if (dueAfter !== null && (s.dueMs === null || s.dueMs <= dueAfter)) return false;
      return true;
    });
    const limit = Math.min(Math.max(filter.limit ?? 500, 1), 5000);
    let offset = 0;
    if (filter.cursor) {
      offset = Number.parseInt(Buffer.from(filter.cursor, "base64url").toString("utf8"), 10);
      if (!Number.isInteger(offset) || offset < 0) throw new DomainError("validation_error", "Invalid cursor");
    }
    const page = items.slice(offset, offset + limit).map((id) => v.task(id));
    const next = offset + limit < items.length ? Buffer.from(String(offset + limit)).toString("base64url") : null;
    return { items: page, nextCursor: next };
  }

  // -------------------------------------------------------------------------
  // Tasks: writes
  // -------------------------------------------------------------------------

  private resolveContainer(input: { parentId?: string; projectId?: string; inbox?: boolean; position?: Position }): Container {
    const snap = this.snap();
    if (input.parentId) {
      this.requireTask(input.parentId);
      return { parentId: input.parentId, inbox: false };
    }
    if (input.projectId) {
      this.requireProject(input.projectId);
      return { parentId: input.projectId, inbox: false };
    }
    if (input.inbox) return { parentId: null, inbox: true };
    const pos = input.position;
    if (pos && typeof pos === "object") {
      const anchor = snap.tasks.get("before" in pos ? pos.before : pos.after);
      if (!anchor) throw new DomainError("validation_error", "Position anchor not found");
      if (snap.isProject(anchor.id)) throw new DomainError("invalid_operation", "Use the project endpoints to place projects");
      return this.containerOf(anchor);
    }
    return { parentId: null, inbox: true };
  }

  private applyCreate(input: TaskCreateInput, c: Container, id = newId()): TaskRow {
    const now = this.mutationNow;
    const row: TaskRow = {
      id,
      parentId: c.parentId,
      inInbox: c.parentId === null && c.inbox,
      rank: this.rankIn(c, input.position ?? "end", null),
      name: input.name,
      note: input.note ?? "",
      flagged: input.flagged ?? false,
      deferDate: this.normaliseDate(input.deferDate, "defer"),
      plannedDate: this.normaliseDate(input.plannedDate, "planned"),
      dueDate: this.normaliseDate(input.dueDate, "due"),
      estimatedMinutes: input.estimatedMinutes ?? null,
      completed: null,
      dropped: null,
      added: now,
      modified: now,
      sequential: input.sequential ?? false,
      completedByChildren: input.completedByChildren ?? false,
      repeatRule: null,
      repeatScheduleType: null,
      repeatAnchor: null,
      repeatCatchUp: false,
      nextCloneId: 0,
      assignedProjectId: null,
      ...this.repeatColumns(input.repeat ?? null),
    };
    this.insertTaskRow(row);
    if (input.tagIds?.length) this.setTaskTags(id, input.tagIds);
    return row;
  }

  createTask(input: TaskCreateInput): Task {
    const id = this.mutate("Add Action", () => {
      const c = this.resolveContainer(input);
      return this.applyCreate(input, c, this.claimId("Task", input.id, this.snap().tasks)).id;
    });
    return this.getTask(id);
  }

  private applyPatch(id: string, patch: TaskPatchInput): void {
    const row = this.requireTask(id);
    const values: Partial<TaskRow> = {};
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.note !== undefined) values.note = patch.note;
    if (patch.flagged !== undefined) values.flagged = patch.flagged;
    if (patch.deferDate !== undefined) values.deferDate = this.normaliseDate(patch.deferDate, "defer");
    if (patch.plannedDate !== undefined) values.plannedDate = this.normaliseDate(patch.plannedDate, "planned");
    if (patch.dueDate !== undefined) values.dueDate = this.normaliseDate(patch.dueDate, "due");
    if (patch.estimatedMinutes !== undefined) values.estimatedMinutes = patch.estimatedMinutes;
    if (patch.repeat !== undefined) Object.assign(values, this.repeatColumns(patch.repeat));
    if (patch.sequential !== undefined) values.sequential = patch.sequential;
    if (patch.completedByChildren !== undefined) values.completedByChildren = patch.completedByChildren;
    if (patch.assignedProjectId !== undefined) {
      if (patch.assignedProjectId !== null) this.requireProject(patch.assignedProjectId);
      if (!(row.parentId === null && row.inInbox) && patch.assignedProjectId !== null) {
        throw new DomainError("invalid_operation", "Only inbox items have an assigned project; move the task instead");
      }
      values.assignedProjectId = patch.assignedProjectId;
    }
    if (Object.keys(values).length > 0) this.writeTask(id, values);
    if (patch.tagIds !== undefined) this.setTaskTags(id, patch.tagIds);
  }

  updateTask(id: string, patch: TaskPatchInput): Task {
    this.mutate("Edit Action", () => this.applyPatch(id, patch));
    return this.getTask(id);
  }

  batchUpdate(ids: string[], patch: TaskPatchInput): Changed {
    return this.mutate("Edit Actions", () => {
      for (const id of ids) this.applyPatch(id, patch);
      return this.changed();
    });
  }

  async deleteTask(id: string): Promise<void> {
    this.requireTask(id);
    this.mutate(this.snap().isProject(id) ? "Delete Project" : "Delete Action", () => {
      this.removeTaskRows(this.snap().subtreeIds(id));
    });
    await this.gcBlobs();
  }

  /**
   * Discards a freshly created task: when the newest change group is exactly its creation, that group is
   * reverted and erased (no undo/redo trace); otherwise this is a normal, undoable delete.
   */
  async discardTask(id: string): Promise<void> {
    this.requireTask(id);
    let discarded: boolean;
    try {
      discarded = this.sqlite.transaction(() => this.journal.discardCreation(id))();
    } finally {
      this.invalidate();
    }
    if (discarded) {
      const steps = this.undoSteps.getStore();
      if (steps) steps.net--;
    } else await this.deleteTask(id);
  }

  // --- completion / drop / repeat ---------------------------------------------

  /** Sets/clears completion. Completing clears `dropped`; a project's status follows (spec §1.2). */
  private setCompleted(id: string, ts: string | null): void {
    const snap = this.snap();
    this.writeTask(id, ts === null ? { completed: null } : { completed: ts, dropped: null });
    const p = snap.projects.get(id);
    if (p) {
      if (ts !== null && p.status !== "completed") this.writeProject(id, { status: "completed" });
      if (ts === null && p.status === "completed") this.writeProject(id, { status: "active" });
    }
  }

  /** Sets/clears the drop date. Dropping clears `completed`; a project's status follows. */
  private setDropped(id: string, ts: string | null): void {
    const snap = this.snap();
    this.writeTask(id, ts === null ? { dropped: null } : { dropped: ts, completed: null });
    const p = snap.projects.get(id);
    if (p) {
      if (ts !== null && p.status !== "dropped") this.writeProject(id, { status: "dropped" });
      if (ts === null && p.status === "dropped") this.writeProject(id, { status: "active" });
    }
  }

  /** Clones a subtree as a finished occurrence; returns the clone root id. */
  private cloneSubtree(source: TaskRow, cloneId: string, parentId: string | null, rank: number, mark: Partial<TaskRow>): void {
    const snap = this.snap();
    const children = snap.childrenOf(source.id);
    this.insertTaskRow({ ...source, id: cloneId, parentId, rank, nextCloneId: 0, ...mark });
    const links = snap.taskTags.get(source.id) ?? [];
    if (links.length) {
      const rows = links.map((l) => ({ ...l, taskId: cloneId, added: this.mutationNow }));
      this.db.insert(schema.taskTags).values(rows).run();
      snap.taskTags.set(cloneId, rows);
    }
    const p = snap.projects.get(source.id);
    if (p) {
      const status = mark.dropped ? ("dropped" as const) : ("completed" as const);
      const row = { ...p, taskId: cloneId, status, folderId: p.folderId };
      this.db.insert(schema.projects).values(row).run();
      snap.projects.set(cloneId, row);
    }
    children.forEach((c, i) => this.cloneSubtree(c, `${cloneId}.${i}`, cloneId, c.rank, {}));
  }

  /** Finishes one occurrence of a repeating task (clone marked completed/dropped, original advanced). */
  private finishOccurrence(id: string, ts: string, kind: "completed" | "dropped"): boolean {
    const snap = this.snap();
    const row = this.requireTask(id);
    const settings = this.getSettings();
    const advance = advanceRepeat(
      {
        rule: row.repeatRule!,
        scheduleType: row.repeatScheduleType ?? "regularly",
        anchorDate: row.repeatAnchor ?? "due",
        catchUpAutomatically: row.repeatCatchUp,
      },
      { deferDate: row.deferDate, plannedDate: row.plannedDate, dueDate: row.dueDate },
      { completedAt: Date.parse(ts), now: this.clock().getTime(), timeZone: settings.timeZone },
    );
    if (!advance) return false;

    let n = row.nextCloneId;
    while (snap.tasks.has(`${id}.${n}`)) n++;
    const cloneId = `${id}.${n}`;
    // Insert the clone directly before the original: projects among their folder's folders/projects, tasks among siblings.
    const project = snap.projects.get(id);
    let cloneRank: number;
    if (project) {
      const folderId = project.folderId !== null && snap.folders.has(project.folderId) ? project.folderId : null;
      cloneRank = this.containerRank(folderId, { before: id }, null);
    } else {
      const siblings = this.siblingsIn(this.containerOf(row));
      const plan = planRank(siblings, siblings.findIndex((s) => s.id === id));
      for (const [sid, rank] of plan.renumber) this.writeTask(sid, { rank }, false);
      cloneRank = plan.rank;
    }
    const fresh = this.requireTask(id);
    this.cloneSubtree(fresh, cloneId, fresh.parentId, cloneRank, { [kind]: ts, modified: this.mutationNow });

    this.writeTask(id, { ...advance.dates, repeatRule: advance.rule, nextCloneId: n + 1, completed: null, dropped: null });
    for (const did of snap.subtreeIds(id).slice(1)) {
      if (snap.tasks.get(did)!.completed !== null) this.writeTask(did, { completed: null });
    }
    return true;
  }

  private completeOne(id: string, ts: string): void {
    const row = this.requireTask(id);
    if (row.completed !== null) return;
    if (row.repeatRule !== null && this.finishOccurrence(id, ts, "completed")) return;
    this.setCompleted(id, ts);
    this.cascadeParent(row.parentId, ts);
  }

  /** "Complete with last action": finish the parent once no child remains. */
  private cascadeParent(parentId: string | null, ts: string): void {
    if (parentId === null) return;
    const snap = this.snap();
    const parent = snap.tasks.get(parentId);
    if (!parent || !parent.completedByChildren || parent.completed !== null || parent.dropped !== null) return;
    const children = snap.childrenOf(parentId);
    if (children.some((c) => c.completed === null && c.dropped === null)) return;
    if (children.some((c) => c.completed !== null)) this.completeOne(parentId, ts);
    else this.dropOne(parentId, ts, "series");
  }

  private dropOne(id: string, ts: string, scope: "occurrence" | "series"): void {
    const row = this.requireTask(id);
    if (row.dropped !== null) return;
    if (scope === "occurrence" && row.repeatRule !== null && this.finishOccurrence(id, ts, "dropped")) return;
    this.setDropped(id, ts);
    this.cascadeParent(row.parentId, ts);
  }

  completeTask(id: string, completed: boolean): Changed {
    return this.completeTasks([id], completed);
  }

  /** Completes or un-completes several tasks as one undo group. */
  completeTasks(ids: string[], completed: boolean): Changed {
    return this.setTasksStatus(ids, completed ? "completed" : "active", "series", completed ? "Complete" : "Mark Incomplete");
  }

  dropTask(id: string, dropped: boolean, scope: "occurrence" | "series" = "series"): Changed {
    return this.dropTasks([id], dropped, scope);
  }

  /** Drops or reactivates several tasks as one undo group. */
  dropTasks(ids: string[], dropped: boolean, scope: "occurrence" | "series" = "series"): Changed {
    return this.setTasksStatus(ids, dropped ? "dropped" : "active", scope, dropped ? "Drop" : "Mark Active");
  }

  /**
   * Sets each task to `status` as one undo group: active clears both completion and drop; completed and
   * dropped are mutually exclusive (repeating tasks advance on completion, and on drop with scope occurrence).
   */
  setTasksStatus(
    ids: string[],
    status: "active" | "completed" | "dropped",
    scope: "occurrence" | "series" = "series",
    label = status === "completed" ? "Complete" : status === "dropped" ? "Drop" : "Mark Active",
  ): Changed {
    const unique = [...new Set(ids)];
    for (const id of unique) this.requireTask(id);
    return this.mutate(label, () => {
      for (const id of unique) {
        if (status === "completed") this.completeOne(id, this.mutationNow);
        else if (status === "dropped") this.dropOne(id, this.mutationNow, scope);
        else {
          if (this.requireTask(id).completed !== null) this.setCompleted(id, null);
          if (this.requireTask(id).dropped !== null) this.setDropped(id, null);
        }
      }
      return this.changed();
    });
  }

  // --- move / tags / outline ---------------------------------------------------

  private moveInto(id: string, c: Container, position: Position): void {
    const snap = this.snap();
    const row = this.requireTask(id);
    if (snap.isProject(id)) throw new DomainError("invalid_operation", "Projects are moved with POST /projects/:id/move");
    if (c.parentId !== null && (c.parentId === id || snap.isAncestor(id, c.parentId))) {
      throw new DomainError("invalid_operation", "Cannot move a task into itself");
    }
    const rank = this.rankIn(c, position, id);
    const inInbox = c.parentId === null && c.inbox;
    this.writeTask(id, {
      parentId: c.parentId,
      inInbox,
      rank,
      assignedProjectId: inInbox ? row.assignedProjectId : null,
    });
  }

  moveTask(id: string, move: z.input<typeof TaskMove>): Changed {
    this.requireTask(id);
    return this.mutate("Move", () => {
      const position = move.position ?? "end";
      this.moveInto(id, this.resolveContainer({ ...move, position }), position);
      return this.changed();
    });
  }

  /** Moves several tasks to one place as one undo group, keeping their outline order. */
  moveTasks(ids: string[], move: z.input<typeof TaskMove>): Changed {
    for (const id of ids) this.requireTask(id);
    const position = move.position ?? "end";
    if (typeof position === "object" && ids.includes("before" in position ? position.before : position.after)) {
      throw new DomainError("validation_error", "The position anchor cannot be one of the moved tasks");
    }
    return this.mutate("Move", () => {
      const snap = this.snap();
      const d = this.derived();
      const selected = new Set(ids);
      // Descendants of selected tasks travel with their ancestor.
      const roots = [...selected]
        .filter((id) => ![...selected].some((other) => other !== id && snap.isAncestor(other, id)))
        .sort((a, b) => (d.tasks.get(a)?.order ?? 0) - (d.tasks.get(b)?.order ?? 0));
      const container = this.resolveContainer({ ...move, position });
      let previous: string | null = null;
      for (const id of roots) {
        this.moveInto(id, container, previous === null ? position : { after: previous });
        previous = id;
      }
      return this.changed();
    });
  }

  /** Replaces a task's tags (ordered), honouring mutually exclusive tag groups (later tags win). */
  private setTaskTags(taskId: string, tagIds: string[]): void {
    const snap = this.snap();
    const result: string[] = [];
    for (const tagId of tagIds) {
      const tag = snap.tags.get(tagId);
      if (!tag) throw notFound("Tag", tagId);
      if (result.includes(tagId)) continue;
      const parent = tag.parentId === null ? undefined : snap.tags.get(tag.parentId);
      if (parent?.childrenMutuallyExclusive) {
        for (let i = result.length - 1; i >= 0; i--) {
          if (snap.tags.get(result[i]!)?.parentId === parent.id) result.splice(i, 1);
        }
      }
      result.push(tagId);
    }
    const existing = snap.taskTags.get(taskId) ?? [];
    const same = existing.length === result.length && existing.every((l, i) => l.tagId === result[i]);
    if (same) return;
    this.db.delete(schema.taskTags).where(eq(schema.taskTags.taskId, taskId)).run();
    const rows = result.map((tagId, i) => {
      const prev = existing.find((l) => l.tagId === tagId);
      const rankInTag =
        prev?.rankInTag ??
        snap.tagTasks(tagId).reduce((m, l) => Math.max(m, l.rankInTag ?? -1), -1) + 1;
      return { taskId, tagId, rankInTask: i, rankInTag, added: prev?.added ?? this.mutationNow };
    });
    if (rows.length) this.db.insert(schema.taskTags).values(rows).run();
    if (rows.length) snap.taskTags.set(taskId, rows);
    else snap.taskTags.delete(taskId);
    snap.touch();
    this.writeTask(taskId, {});
  }

  addTag(taskId: string, tagId: string): Task {
    this.requireTask(taskId);
    if (!this.snap().tags.has(tagId)) throw notFound("Tag", tagId);
    this.mutate("Add Tag", () => this.setTaskTags(taskId, [...this.snap().tagIdsOf(taskId), tagId]));
    return this.getTask(taskId);
  }

  removeTag(taskId: string, tagId: string): Task {
    this.requireTask(taskId);
    this.mutate("Remove Tag", () => this.setTaskTags(taskId, this.snap().tagIdsOf(taskId).filter((t) => t !== tagId)));
    return this.getTask(taskId);
  }

  /** Adds and removes tags on several tasks as one undo group (mutually exclusive groups honoured). */
  tagTasks(ids: string[], change: { add?: string[]; remove?: string[] }): Changed {
    const unique = [...new Set(ids)];
    for (const id of unique) this.requireTask(id);
    for (const tagId of change.add ?? []) this.requireTag(tagId);
    const remove = new Set(change.remove ?? []);
    return this.mutate("Edit Tags", () => {
      for (const id of unique) {
        const kept = this.snap().tagIdsOf(id).filter((t) => !remove.has(t));
        this.setTaskTags(id, [...kept, ...(change.add ?? [])]);
      }
      return this.changed();
    });
  }

  outline(op: z.infer<typeof OutlineOp>["op"], ids: string[], groupId?: string): Changed {
    const snap = this.snap();
    for (const id of ids) {
      this.requireTask(id);
      if (snap.isProject(id)) throw new DomainError("invalid_operation", "Outline operations apply to actions, not projects");
    }
    const d = this.derived();
    const ordered = [...new Set(ids)].sort((a, b) => (d.tasks.get(a)?.order ?? 0) - (d.tasks.get(b)?.order ?? 0));
    const selected = new Set(ordered);
    const labels = { indent: "Indent", outdent: "Outdent", group: "Group", ungroup: "Ungroup", moveUp: "Move Up", moveDown: "Move Down" };
    return this.mutate(labels[op], () => {
      switch (op) {
        case "indent":
          for (const id of ordered) {
            const row = this.requireTask(id);
            if (row.parentId !== null && selected.has(row.parentId)) continue;
            const siblings = this.siblingsIn(this.containerOf(row));
            const idx = siblings.findIndex((s) => s.id === id);
            let prev: TaskRow | undefined;
            for (let i = idx - 1; i >= 0; i--) {
              if (!selected.has(siblings[i]!.id)) {
                prev = siblings[i];
                break;
              }
            }
            if (prev) this.moveInto(id, { parentId: prev.id, inbox: false }, "end");
          }
          break;
        case "outdent":
          for (const id of [...ordered].reverse()) {
            const row = this.requireTask(id);
            if (row.parentId === null || snap.isProject(row.parentId) || selected.has(row.parentId)) continue;
            const parent = this.requireTask(row.parentId);
            this.moveInto(id, this.containerOf(parent), { after: parent.id });
          }
          break;
        case "moveUp":
          for (const id of ordered) {
            const row = this.requireTask(id);
            const siblings = this.siblingsIn(this.containerOf(row));
            const idx = siblings.findIndex((s) => s.id === id);
            const prev = siblings[idx - 1];
            if (!prev || selected.has(prev.id)) continue;
            this.moveInto(id, this.containerOf(row), { before: prev.id });
          }
          break;
        case "moveDown":
          for (const id of [...ordered].reverse()) {
            const row = this.requireTask(id);
            const siblings = this.siblingsIn(this.containerOf(row));
            const idx = siblings.findIndex((s) => s.id === id);
            const next = siblings[idx + 1];
            if (!next || selected.has(next.id)) continue;
            this.moveInto(id, this.containerOf(row), { after: next.id });
          }
          break;
        case "group": {
          const first = this.requireTask(ordered[0]!);
          const c = this.containerOf(first);
          const group = this.applyCreate({ name: "", position: { before: first.id } }, c, this.claimId("Task", groupId, this.snap().tasks));
          for (const id of ordered) {
            const row = this.requireTask(id);
            if (row.parentId !== null && selected.has(row.parentId)) continue;
            this.moveInto(id, { parentId: group.id, inbox: false }, "end");
          }
          break;
        }
        case "ungroup":
          for (const id of ordered) {
            const group = this.snap().tasks.get(id);
            if (!group) continue;
            const children = this.snap().childrenOf(id);
            if (children.length === 0) continue;
            const c = this.containerOf(group);
            for (const child of children) this.moveInto(child.id, c, { before: group.id });
            this.removeTaskRows([id]);
          }
          break;
      }
      return this.changed();
    });
  }

  /** Clean Up: inbox items with an assigned project or a tag leave the inbox. */
  cleanup(): Changed {
    return this.mutate("Clean Up", () => {
      const snap = this.snap();
      for (const row of snap.inboxRoots()) {
        if (row.assignedProjectId && snap.projects.has(row.assignedProjectId)) {
          this.moveInto(row.id, { parentId: row.assignedProjectId, inbox: false }, "end");
        } else if (snap.tagIdsOf(row.id).length > 0) {
          this.moveInto(row.id, { parentId: null, inbox: false }, "end");
        }
      }
      return this.changed();
    });
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  listProjects(filter: { status?: ProjectRow["status"]; folderId?: string } = {}): Project[] {
    const v = this.view();
    return v
      .projectRows()
      .filter((p) => !filter.status || p.status === filter.status)
      .filter((p) => !filter.folderId || v.d.projects.get(p.taskId)?.folderIds.includes(filter.folderId))
      .map((p) => v.project(p.taskId));
  }

  getProject(id: string): Project {
    this.requireProject(id);
    return this.view().project(id);
  }

  private nextReviewFrom(lastReviewIso: string, steps: number, unit: ProjectRow["reviewIntervalUnit"]): string {
    const tz = this.getSettings().timeZone;
    const naive = instantToNaive(Date.parse(lastReviewIso), tz);
    const day = Math.floor(naive / 86_400_000) * 86_400_000;
    return formatFloating(addToNaive(day, steps, unit));
  }

  createProject(input: z.input<typeof ProjectCreate>): Project {
    const id = this.mutate("New Project", () => {
      if (input.folderId) this.requireFolder(input.folderId);
      // A project's id is its root task's id, so it must be unused by any task.
      const id = this.claimId("Project", input.id, this.snap().tasks);
      const folderId = input.folderId ?? null;
      const rank = this.containerRank(folderId, input.position ?? "end", null);
      const now = this.mutationNow;
      const status = input.status ?? "active";
      const row: TaskRow = {
        id,
        parentId: null,
        inInbox: false,
        rank,
        name: input.name,
        note: input.note ?? "",
        flagged: input.flagged ?? false,
        deferDate: this.normaliseDate(input.deferDate, "defer"),
        plannedDate: this.normaliseDate(input.plannedDate, "planned"),
        dueDate: this.normaliseDate(input.dueDate, "due"),
        estimatedMinutes: input.estimatedMinutes ?? null,
        completed: status === "completed" ? now : null,
        dropped: status === "dropped" ? now : null,
        added: now,
        modified: now,
        sequential: false,
        completedByChildren: input.completedByChildren ?? false,
        repeatRule: null,
        repeatScheduleType: null,
        repeatAnchor: null,
        repeatCatchUp: false,
        nextCloneId: 0,
        assignedProjectId: null,
        ...this.repeatColumns(input.repeat ?? null),
      };
      this.insertTaskRow(row);
      const interval = input.reviewInterval ?? { steps: 1, unit: "week" as const };
      const project: ProjectRow = {
        taskId: id,
        folderId,
        type: input.type ?? "parallel",
        status,
        reviewIntervalSteps: interval.steps,
        reviewIntervalUnit: interval.unit,
        reviewIntervalRaw: null,
        lastReview: now,
        nextReview: this.nextReviewFrom(now, interval.steps, interval.unit),
      };
      this.db.insert(schema.projects).values(project).run();
      this.snap().projects.set(id, project);
      this.snap().touch();
      if (input.tagIds?.length) this.setTaskTags(id, input.tagIds);
      return id;
    });
    return this.getProject(id);
  }

  private applyProjectPatch(id: string, patch: z.input<typeof ProjectPatch>): void {
    const p = this.requireProject(id);
    const { type, status, folderId, reviewInterval, nextReview, ...taskPatch } = patch;
    this.applyPatch(id, taskPatch);
    const values: Partial<ProjectRow> = {};
    if (type !== undefined) values.type = type;
    if (reviewInterval !== undefined) {
      values.reviewIntervalSteps = reviewInterval.steps;
      values.reviewIntervalUnit = reviewInterval.unit;
      values.reviewIntervalRaw = null;
      values.nextReview = this.nextReviewFrom(p.lastReview, reviewInterval.steps, reviewInterval.unit);
    }
    if (nextReview !== undefined) values.nextReview = this.normaliseDate(nextReview, "defer");
    if (Object.keys(values).length) this.writeProject(id, values);
    if (folderId !== undefined && folderId !== p.folderId) {
      if (folderId !== null) this.requireFolder(folderId);
      const rank = this.containerRank(folderId, "end", id);
      this.writeProject(id, { folderId });
      this.writeTask(id, { rank });
    }
    if (status !== undefined && status !== this.requireProject(id).status) {
      const now = this.mutationNow;
      // Completing/dropping goes through the task rules so repeating projects repeat and parents cascade.
      if (status === "completed") this.completeOne(id, now);
      else if (status === "dropped") this.dropOne(id, now, "series");
      else {
        if (this.requireTask(id).completed !== null) this.setCompleted(id, null);
        if (this.requireTask(id).dropped !== null) this.setDropped(id, null);
        this.writeProject(id, { status });
      }
    }
  }

  updateProject(id: string, patch: z.input<typeof ProjectPatch>): Project {
    this.requireProject(id);
    this.mutate("Edit Project", () => this.applyProjectPatch(id, patch));
    return this.getProject(id);
  }

  /** Applies one patch to several projects as a single undo group. */
  updateProjects(ids: string[], patch: z.input<typeof ProjectPatch>): Project[] {
    const unique = [...new Set(ids)];
    for (const id of unique) this.requireProject(id);
    this.mutate(unique.length === 1 ? "Edit Project" : "Edit Projects", () => {
      for (const id of unique) this.applyProjectPatch(id, patch);
    });
    return unique.map((id) => this.getProject(id));
  }

  async deleteProject(id: string): Promise<void> {
    this.requireProject(id);
    await this.deleteTask(id);
  }

  markReviewed(id: string): Project {
    const p = this.requireProject(id);
    this.mutate("Mark Reviewed", () => {
      const now = this.mutationNow;
      this.writeProject(id, { lastReview: now, nextReview: this.nextReviewFrom(now, p.reviewIntervalSteps, p.reviewIntervalUnit) });
    });
    return this.getProject(id);
  }

  moveProject(id: string, move: z.input<typeof ContainerMove>): Project {
    this.requireProject(id);
    this.mutate("Move Project", () => {
      const folderId = move.parentId;
      if (folderId !== null) this.requireFolder(folderId);
      const rank = this.containerRank(folderId, move.position ?? "end", id);
      this.writeProject(id, { folderId });
      this.writeTask(id, { rank });
    });
    return this.getProject(id);
  }

  // -------------------------------------------------------------------------
  // Folders
  // -------------------------------------------------------------------------

  private requireFolder(id: string): FolderRow {
    const f = this.snap().folders.get(id);
    if (!f) throw notFound("Folder", id);
    return f;
  }

  listFolders(): Folder[] {
    const v = this.view();
    return [...this.snap().folders.values()]
      .sort((a, b) => (v.d.folders.get(a.id)?.order ?? 0) - (v.d.folders.get(b.id)?.order ?? 0))
      .map((f) => folderDto(v.d, f));
  }

  getFolder(id: string): Folder {
    return folderDto(this.derived(), this.requireFolder(id));
  }

  createFolder(input: z.input<typeof FolderCreate>): Folder {
    const id = this.mutate("New Folder", () => {
      const parentId = input.parentId ?? null;
      if (parentId !== null) this.requireFolder(parentId);
      const id = this.claimId("Folder", input.id, this.snap().folders);
      const now = this.mutationNow;
      const row: FolderRow = {
        id,
        parentId,
        name: input.name,
        note: input.note ?? "",
        rank: this.containerRank(parentId, input.position ?? "end", null),
        status: "active",
        added: now,
        modified: now,
      };
      this.db.insert(schema.folders).values(row).run();
      this.snap().folders.set(id, row);
      this.snap().touch();
      return id;
    });
    return this.getFolder(id);
  }

  /** Updates fields and optionally moves the folder, as one undo group. */
  updateFolder(id: string, patch: z.input<typeof FolderPatch>, move?: z.input<typeof ContainerMove>): Folder {
    this.requireFolder(id);
    this.mutate(move ? "Move Folder" : "Edit Folder", () => {
      if (Object.keys(patch).length) this.writeFolder(id, patch);
      if (move) this.applyFolderMove(id, move);
    });
    return this.getFolder(id);
  }

  private folderSubtree(id: string): string[] {
    const out = [id];
    for (const f of this.snap().folders.values()) if (f.parentId === id) out.push(...this.folderSubtree(f.id));
    return out;
  }

  private applyFolderMove(id: string, move: z.input<typeof ContainerMove>): void {
    const parentId = move.parentId;
    if (parentId !== null) {
      this.requireFolder(parentId);
      if (this.folderSubtree(id).includes(parentId)) throw new DomainError("invalid_operation", "Cannot move a folder into itself");
    }
    const rank = this.containerRank(parentId, move.position ?? "end", id);
    this.writeFolder(id, { parentId, rank });
  }

  moveFolder(id: string, move: z.input<typeof ContainerMove>): Folder {
    return this.updateFolder(id, {}, move);
  }

  async deleteFolder(id: string): Promise<void> {
    this.requireFolder(id);
    this.mutate("Delete Folder", () => this.removeFolderTree(id));
    await this.gcBlobs();
  }

  /** Removes a folder, its subfolders and every contained project subtree. */
  private removeFolderTree(id: string): void {
    const snap = this.snap();
    const folderIds = new Set(this.folderSubtree(id));
    const taskIds: string[] = [];
    for (const p of snap.projects.values()) if (p.folderId !== null && folderIds.has(p.folderId)) taskIds.push(...snap.subtreeIds(p.taskId));
    this.removeTaskRows(taskIds);
    this.db.delete(schema.folders).where(inArray(schema.folders.id, [...folderIds])).run();
    for (const f of folderIds) snap.folders.delete(f);
    snap.touch();
  }

  /**
   * Deletes a mixed selection as one undo group. Unknown ids fail before any change; items whose ancestor
   * is also selected go with it.
   */
  async deleteMany(sel: { taskIds?: string[]; projectIds?: string[]; folderIds?: string[]; tagIds?: string[] }): Promise<void> {
    const taskIds = [...new Set(sel.taskIds ?? [])];
    const projectIds = [...new Set(sel.projectIds ?? [])];
    const folderIds = [...new Set(sel.folderIds ?? [])];
    const tagIds = [...new Set(sel.tagIds ?? [])];
    for (const id of taskIds) this.requireTask(id);
    for (const id of projectIds) this.requireProject(id);
    for (const id of folderIds) this.requireFolder(id);
    for (const id of tagIds) this.requireTag(id);
    const total = taskIds.length + projectIds.length + folderIds.length + tagIds.length;
    if (total === 0) return;
    this.mutate(total === 1 ? "Delete" : "Delete Items", () => {
      const snap = this.snap();
      // Containers first; anything already removed with a selected ancestor is skipped.
      for (const id of folderIds) if (snap.folders.has(id)) this.removeFolderTree(id);
      for (const id of [...projectIds, ...taskIds]) if (snap.tasks.has(id)) this.removeTaskRows(snap.subtreeIds(id));
      for (const id of tagIds) if (snap.tags.has(id)) this.removeTagTree(id);
    });
    await this.gcBlobs();
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  private requireTag(id: string): TagRow {
    const t = this.snap().tags.get(id);
    if (!t) throw notFound("Tag", id);
    return t;
  }

  listTags(): Tag[] {
    const d = this.derived();
    return [...this.snap().tags.values()]
      .sort((a, b) => (d.tags.get(a.id)?.order ?? 0) - (d.tags.get(b.id)?.order ?? 0))
      .map((t) => tagDto(d, t));
  }

  getTag(id: string): Tag {
    return tagDto(this.derived(), this.requireTag(id));
  }

  createTag(input: z.input<typeof TagCreate>): Tag {
    const id = this.mutate("New Tag", () => {
      const parentId = input.parentId ?? null;
      if (parentId !== null) this.requireTag(parentId);
      const id = this.claimId("Tag", input.id, this.snap().tags);
      const now = this.mutationNow;
      const row: TagRow = {
        id,
        parentId,
        name: input.name,
        note: input.note ?? "",
        rank: this.tagRank(parentId, input.position ?? "end", null),
        status: input.status ?? "active",
        childrenMutuallyExclusive: input.childrenMutuallyExclusive ?? false,
        added: now,
        modified: now,
      };
      this.db.insert(schema.tags).values(row).run();
      this.snap().tags.set(id, row);
      this.snap().touch();
      return id;
    });
    return this.getTag(id);
  }

  /** Updates fields and optionally moves the tag, as one undo group. */
  updateTag(id: string, patch: z.input<typeof TagPatch>, move?: z.input<typeof ContainerMove>): Tag {
    this.requireTag(id);
    this.mutate(move ? "Move Tag" : "Edit Tag", () => {
      if (Object.keys(patch).length) this.writeTag(id, patch);
      if (move) {
        const parentId = move.parentId;
        if (parentId !== null) {
          this.requireTag(parentId);
          if (this.tagSubtree(id).includes(parentId)) throw new DomainError("invalid_operation", "Cannot move a tag into itself");
        }
        this.writeTag(id, { parentId, rank: this.tagRank(parentId, move.position ?? "end", id) });
      }
    });
    return this.getTag(id);
  }

  private tagSubtree(id: string): string[] {
    return [id, ...this.snap().tagChildren(id).flatMap((c) => this.tagSubtree(c.id))];
  }

  moveTag(id: string, move: z.input<typeof ContainerMove>): Tag {
    return this.updateTag(id, {}, move);
  }

  deleteTag(id: string): void {
    this.requireTag(id);
    this.mutate("Delete Tag", () => this.removeTagTree(id));
  }

  /** Removes a tag, its descendants and their task links. */
  private removeTagTree(id: string): void {
    const snap = this.snap();
    const ids = this.tagSubtree(id);
    const gone = new Set(ids);
    this.db.delete(schema.taskTags).where(inArray(schema.taskTags.tagId, ids)).run();
    this.db.delete(schema.tags).where(inArray(schema.tags.id, ids)).run();
    for (const [taskId, links] of snap.taskTags) {
      const kept = links.filter((l) => !gone.has(l.tagId));
      if (kept.length !== links.length) {
        this.touched.add(taskId);
        if (kept.length) snap.taskTags.set(taskId, kept);
        else snap.taskTags.delete(taskId);
      }
    }
    for (const t of ids) snap.tags.delete(t);
    const settings = this.getSettings();
    if (settings.forecastTagId && gone.has(settings.forecastTagId)) this.writeSetting("forecastTagId", null);
    snap.touch();
  }

  // -------------------------------------------------------------------------
  // Perspectives
  // -------------------------------------------------------------------------

  listPerspectives(): Perspective[] {
    return [...this.snap().perspectives.values()]
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
      .map(perspectiveDto);
  }

  getPerspective(id: string): Perspective {
    const p = this.snap().perspectives.get(id);
    if (!p) throw notFound("Perspective", id);
    return perspectiveDto(p);
  }

  perspectiveContents(id: string, params: ContentsParams = {}): PerspectiveContents {
    const p = this.getPerspective(id);
    return contentsFor(this.view(), p, params);
  }

  createPerspective(input: z.input<typeof PerspectiveCreate>): Perspective {
    const id = this.mutate("New Perspective", () => {
      const snap = this.snap();
      const id = this.claimId("Perspective", input.id, snap.perspectives);
      const now = this.mutationNow;
      const maxRank = Math.max(0, ...[...snap.perspectives.values()].map((p) => p.rank));
      const row = {
        id,
        builtin: false,
        name: input.name,
        icon: input.icon ?? "list",
        color: input.color ?? null,
        favorite: input.favorite ?? false,
        rank: Math.min(maxRank + 65_536, 2_147_483_647),
        aggregation: input.aggregation ?? ("all" as const),
        rulesJson: JSON.stringify(input.rules ?? []),
        presentationJson: JSON.stringify(PerspectivePresentation.parse(input.presentation ?? {})),
        viewOptionsJson: "{}",
        importExtrasJson: null,
        added: now,
        modified: now,
      };
      this.db.insert(schema.perspectives).values(row).run();
      snap.perspectives.set(id, row);
      snap.touch();
      return id;
    });
    return this.getPerspective(id);
  }

  updatePerspective(id: string, patch: z.input<typeof PerspectivePatch>): Perspective {
    const current = this.snap().perspectives.get(id);
    if (!current) throw notFound("Perspective", id);
    if (current.builtin) {
      const allowed = ["favorite", "rank"];
      const extra = Object.keys(patch).filter((k) => !allowed.includes(k) && patch[k as keyof typeof patch] !== undefined);
      if (extra.length) throw new DomainError("invalid_operation", `Built-in perspectives only allow favorite and rank changes`, { fields: extra });
    }
    this.mutate("Edit Perspective", () => {
      const values: Partial<typeof current> = { modified: this.mutationNow };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.icon !== undefined) values.icon = patch.icon;
      if (patch.color !== undefined) values.color = patch.color;
      if (patch.favorite !== undefined) values.favorite = patch.favorite;
      if (patch.rank !== undefined) values.rank = patch.rank;
      if (patch.aggregation !== undefined) values.aggregation = patch.aggregation;
      if (patch.rules !== undefined) values.rulesJson = JSON.stringify(patch.rules);
      if (patch.presentation !== undefined) {
        const prev = perspectiveDto(current).presentation;
        values.presentationJson = JSON.stringify(PerspectivePresentation.parse({ ...prev, ...patch.presentation }));
      }
      this.db.update(schema.perspectives).set(values).where(eq(schema.perspectives.id, id)).run();
      this.snap().perspectives.set(id, { ...current, ...values });
      this.snap().touch();
    });
    return this.getPerspective(id);
  }

  deletePerspective(id: string): void {
    const p = this.snap().perspectives.get(id);
    if (!p) throw notFound("Perspective", id);
    if (p.builtin) throw new DomainError("invalid_operation", "Built-in perspectives cannot be deleted");
    this.mutate("Delete Perspective", () => {
      this.db.delete(schema.perspectives).where(eq(schema.perspectives.id, id)).run();
      this.snap().perspectives.delete(id);
      this.snap().touch();
    });
  }

  /** Saves per-perspective view options (UI state: not journaled, so it never disturbs undo/redo). */
  setViewOptions(id: string, options: ViewOptions): Perspective {
    const p = this.snap().perspectives.get(id);
    if (!p) throw notFound("Perspective", id);
    const parsed = ViewOptionsSchema.parse(options);
    const viewOptionsJson = JSON.stringify(parsed);
    this.db.update(schema.perspectives).set({ viewOptionsJson }).where(eq(schema.perspectives.id, id)).run();
    this.snap().perspectives.set(id, { ...p, viewOptionsJson });
    return this.getPerspective(id);
  }

  // -------------------------------------------------------------------------
  // Forecast / review / search
  // -------------------------------------------------------------------------

  forecast(opts: { from?: string; days?: number } = {}): Forecast {
    const days = Math.min(Math.max(opts.days ?? 7, 1), 60);
    if (opts.from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.from)) {
      throw new DomainError("validation_error", "from must be YYYY-MM-DD");
    }
    return this.view().forecast(this.getPerspective("forecast").viewOptions, opts.from, days);
  }

  reviewQueue(): Project[] {
    return this.view().reviewProjects();
  }

  search(q: string, availability: Availability = "remaining"): SearchResults {
    return this.view().search(q, availability);
  }

  quickOpen(q: string): QuickOpenResult[] {
    return this.view().quickOpen(q, this.listPerspectives());
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  private writeSetting(key: string, value: unknown): void {
    const valueJson = JSON.stringify(value);
    this.db
      .insert(schema.settings)
      .values({ key, valueJson })
      .onConflictDoUpdate({ target: schema.settings.key, set: { valueJson } })
      .run();
    const snap = this.snap();
    snap.settingRows = [...snap.settingRows.filter((r) => r.key !== key), { key, valueJson }];
    snap.touch();
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const parsed = SettingsSchema.partial().parse(patch);
    if (parsed.timeZone !== undefined && !isValidTimeZone(parsed.timeZone)) {
      throw new DomainError("validation_error", `Unknown time zone: ${parsed.timeZone}`);
    }
    if (parsed.forecastTagId) this.requireTag(parsed.forecastTagId);
    this.mutate("Change Settings", () => {
      for (const key of SETTINGS_KEYS) if (parsed[key] !== undefined) this.writeSetting(key, parsed[key]);
    });
    return this.getSettings();
  }

  /** Restore Defaults: removes stored values for every setting key. */
  resetSettings(): Settings {
    this.mutate("Restore Default Settings", () => {
      this.db.delete(schema.settings).where(inArray(schema.settings.key, SETTINGS_KEYS as string[])).run();
      const snap = this.snap();
      snap.settingRows = snap.settingRows.filter((r) => !(SETTINGS_KEYS as string[]).includes(r.key));
      snap.touch();
    });
    return this.getSettings();
  }

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  listAttachments(taskId: string): Attachment[] {
    this.requireTask(taskId);
    return this.snap().attachmentsOf(taskId).map(attachmentDto);
  }

  getAttachment(id: string): Attachment {
    const a = this.snap().attachments.get(id);
    if (!a) throw notFound("Attachment", id);
    return attachmentDto(a);
  }

  private storageKey(sha256: string): string {
    const blob = this.db.select().from(schema.blobs).where(eq(schema.blobs.sha256, sha256)).get();
    return blob?.storageKey ?? blobKey(sha256);
  }

  async attachmentBytes(id: string): Promise<{ attachment: Attachment; bytes: Uint8Array }> {
    const attachment = this.getAttachment(id);
    return { attachment, bytes: await this.blobStore.get(this.storageKey(attachment.sha256)) };
  }

  /** Presigned URL for downloads, or null when the caller must stream `attachmentBytes`. */
  async attachmentDownloadUrl(id: string): Promise<string | null> {
    const a = this.getAttachment(id);
    return this.blobStore.downloadUrl(this.storageKey(a.sha256), a.name, a.contentType);
  }

  async uploadAttachment(taskId: string, file: AttachmentFile): Promise<Attachment> {
    this.requireTask(taskId);
    const blob = await this.storeBlob(file);
    const id = this.mutate("Add Attachment", () => this.insertAttachment(taskId, blob));
    return this.getAttachment(id);
  }

  private checkAttachmentSize(file: AttachmentFile): void {
    if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new DomainError("payload_too_large", "Attachments are limited to 100 MB");
    }
  }

  /** Puts the bytes in the blob store unless already there. Runs before the transaction because blob stores are async. */
  private async storeBlob(file: AttachmentFile): Promise<StoredBlob> {
    this.checkAttachmentSize(file);
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    const contentType = sniffContentType(file.bytes, file.name, file.contentType);
    const key = blobKey(sha256);
    const existing = this.db.select().from(schema.blobs).where(eq(schema.blobs.sha256, sha256)).get();
    if (!existing) await this.blobStore.put(key, file.bytes, contentType);
    return { sha256, contentType, key, size: file.bytes.byteLength, name: file.name || "attachment" };
  }

  /** Adds an attachment row for a stored blob at the end of the task's attachments; returns its id. */
  private insertAttachment(taskId: string, blob: StoredBlob): string {
    this.db
      .insert(schema.blobs)
      .values({ sha256: blob.sha256, size: blob.size, contentType: blob.contentType, storageKey: blob.key })
      .onConflictDoNothing()
      .run();
    const snap = this.snap();
    const rank = snap.attachmentsOf(taskId).reduce((m, a) => Math.max(m, a.rank), -1) + 1;
    const row = {
      id: newId(),
      taskId,
      blobSha256: blob.sha256,
      name: blob.name,
      contentType: blob.contentType,
      size: blob.size,
      rank,
      added: this.mutationNow,
    };
    this.db.insert(schema.attachments).values(row).run();
    snap.attachments.set(row.id, row);
    snap.touch();
    this.writeTask(taskId, {});
    return row.id;
  }

  // -------------------------------------------------------------------------
  // Mail Drop
  // -------------------------------------------------------------------------

  isMailDropProcessed(source: MailDropSource): boolean {
    return this.findMailDropMessage(source) !== undefined;
  }

  private findMailDropMessage(source: MailDropSource) {
    const m = schema.mailDropMessages;
    return this.db
      .select({ taskId: m.taskId })
      .from(m)
      .where(and(eq(m.accountId, source.accountId), eq(m.emailId, source.emailId)))
      .get();
  }

  /**
   * Adds an emailed item, with its attachments, at the end of the inbox and records the message as processed in the
   * same transaction. Returns null, changing nothing, when the message was processed before. The item arrives
   * without an undo group: it is not something the user did, so Undo keeps reverting their own last change.
   */
  async createMailDropItem(input: {
    source: MailDropSource;
    name: string;
    note: string;
    attachments: AttachmentFile[];
  }): Promise<Task | null> {
    if (this.isMailDropProcessed(input.source)) return null;
    input.attachments.forEach((file) => this.checkAttachmentSize(file));
    const blobs: StoredBlob[] = [];
    for (const file of input.attachments) blobs.push(await this.storeBlob(file));
    const id = this.transact(() => {
      if (this.findMailDropMessage(input.source)) return null;
      const container = { parentId: null, inbox: true };
      const row = this.applyCreate({ name: input.name, note: input.note, inbox: true }, container);
      for (const blob of blobs) this.insertAttachment(row.id, blob);
      this.db
        .insert(schema.mailDropMessages)
        .values({ ...input.source, taskId: row.id, processedAt: this.mutationNow })
        .run();
      return row.id;
    });
    return id === null ? null : this.getTask(id);
  }

  async deleteAttachment(id: string): Promise<void> {
    const a = this.snap().attachments.get(id);
    if (!a) throw notFound("Attachment", id);
    this.mutate("Delete Attachment", () => {
      this.db.delete(schema.attachments).where(eq(schema.attachments.id, id)).run();
      this.snap().attachments.delete(id);
      this.snap().touch();
      this.writeTask(a.taskId, {});
    });
    await this.gcBlobs();
  }

  /**
   * Deletes blobs referenced neither by an attachment nor by any undo-journal row (docs/plan.md §Blob storage).
   * Returns the deleted sha256 values.
   */
  async gcBlobs(): Promise<string[]> {
    const orphans = this.sqlite
      .prepare(
        `SELECT sha256, storage_key AS storageKey FROM blobs b
         WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.blob_sha256 = b.sha256)
           AND NOT EXISTS (SELECT 1 FROM change_rows c WHERE c.table_name = 'attachments'
             AND (json_extract(c.before_json, '$.blob_sha256') = b.sha256
               OR json_extract(c.after_json, '$.blob_sha256') = b.sha256))`,
      )
      .all() as { sha256: string; storageKey: string }[];
    for (const o of orphans) {
      await this.blobStore.delete(o.storageKey);
      this.db.delete(schema.blobs).where(eq(schema.blobs.sha256, o.sha256)).run();
    }
    return orphans.map((o) => o.sha256);
  }

  // -------------------------------------------------------------------------
  // Undo / redo / import runs
  // -------------------------------------------------------------------------

  history(): History {
    const undo = this.journal.newestApplied();
    const redo = this.journal.oldestUndone();
    return {
      canUndo: !!undo,
      canRedo: !!redo,
      undoLabel: undo?.label ?? null,
      redoLabel: redo?.label ?? null,
      undoId: undo?.id ?? null,
      redoId: redo?.id ?? null,
    };
  }

  undo(): History {
    const group = this.sqlite.transaction(() => this.journal.undo())();
    if (!group) throw new DomainError("conflict", "Nothing to undo");
    this.invalidate();
    return this.history();
  }

  redo(): History {
    const group = this.sqlite.transaction(() => this.journal.redo())();
    if (!group) throw new DomainError("conflict", "Nothing to redo");
    this.invalidate();
    return this.history();
  }

  lastImportRun(): ImportRun | null {
    const r = this.db.select().from(schema.importRuns).orderBy(desc(schema.importRuns.id)).limit(1).get();
    if (!r) return null;
    const parse = <T>(text: string, fallback: T): T => {
      try {
        return JSON.parse(text) as T;
      } catch {
        return fallback;
      }
    };
    return {
      id: r.id,
      importedAt: r.importedAt,
      source: r.source,
      appId: r.appId,
      appVersion: r.appVersion,
      counts: parse<Record<string, number>>(r.countsJson, {}),
      warnings: parse<string[]>(r.warningsJson, []),
    };
  }
}

export function createDomain(deps: DomainDeps): Domain {
  return new Domain(deps);
}
