import type * as schema from "../db/schema.js";
import type { BuiltinPerspectiveId } from "../domain/builtins.js";
import { blobKey } from "../storage/types.js";
import { contentTypeFor } from "./blobs.js";
import { noteToMarkdown } from "./notes.js";
import { builtinFor, customPerspectiveRow, RANK_STEP } from "./perspectives.js";
import { plistRoot, type PlistValue } from "./plist.js";
import type { OfObject, ParsedPackage } from "./transactions.js";
import { elements, serialize, textOf, type XElement } from "./xml.js";

type Row<T extends { $inferInsert: unknown }> = T["$inferInsert"];
type FolderRow = Row<typeof schema.folders>;
type TagRow = Row<typeof schema.tags>;
type TaskRow = Row<typeof schema.tasks>;
type ProjectRow = Row<typeof schema.projects>;
type TaskTagRow = Row<typeof schema.taskTags>;
type AlarmRow = Row<typeof schema.alarms>;
type AttachmentRow = Row<typeof schema.attachments>;
type BlobRow = Row<typeof schema.blobs>;
type PerspectiveRow = Row<typeof schema.perspectives>;
type SettingRow = Row<typeof schema.settings>;

export interface BlobInfo {
  size: number;
  sniffed: string | null;
}

export interface BuiltinPlacement {
  favorite: boolean;
  rank: number;
}

export interface MappedData {
  folders: FolderRow[];
  tags: TagRow[];
  tasks: TaskRow[];
  projects: ProjectRow[];
  taskTags: TaskTagRow[];
  alarms: AlarmRow[];
  attachments: AttachmentRow[];
  blobs: BlobRow[];
  customPerspectives: PerspectiveRow[];
  /** Favorite/rank for built-in perspectives from the backup's sidebar order; null when the backup has none. */
  builtinPlacement: Map<BuiltinPerspectiveId, BuiltinPlacement> | null;
  settings: SettingRow[];
  counts: Record<string, number>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

const MAX_EXAMPLES = 3;
const MAX_RAW = 400;

class Warnings {
  private readonly messages: string[] = [];
  private readonly tallies = new Map<string, { n: number; examples: string[] }>();

  add(message: string): void {
    this.messages.push(message);
  }

  /** Aggregates repeated warnings into one line with a count and a few example ids. */
  tally(message: string, example: string): void {
    let t = this.tallies.get(message);
    if (!t) this.tallies.set(message, (t = { n: 0, examples: [] }));
    t.n++;
    if (t.examples.length < MAX_EXAMPLES) t.examples.push(example);
  }

  list(): string[] {
    const tallied = [...this.tallies].map(
      ([msg, t]) => `${msg}: ${t.n} (e.g. ${t.examples.join(", ")}${t.n > t.examples.length ? ", …" : ""})`,
    );
    return [...this.messages, ...tallied];
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

const DATE = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** User-facing date: fixed (`…Z`) stays fixed (normalised to UTC), floating keeps its wall-clock time (F§2.2). */
export function userDate(raw: string): string | null | undefined {
  const s = raw.trim();
  if (!s) return null;
  const m = DATE.exec(s);
  if (!m) return undefined;
  if (m[6]) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const ms = (m[5] ?? "0").padEnd(3, "0").slice(0, 3);
  return `${m[1]}T${m[2] ?? "00"}:${m[3] ?? "00"}:${m[4] ?? "00"}.${ms}`;
}

/** Bookkeeping timestamp: always fixed UTC (a floating value is read as UTC). */
function stamp(raw: string): string | null {
  const v = userDate(raw);
  if (!v) return null;
  return v.endsWith("Z") ? v : `${v}Z`;
}

function int32(raw: string): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(-2147483648, Math.min(2147483647, n));
}

const text = (o: OfObject, name: string): string => textOf(o.fields.get(name));
const bool = (o: OfObject, name: string): boolean => text(o, name).trim() === "true";
const ref = (o: OfObject | XElement, name: string): string | null => {
  const el = "fields" in o ? o.fields.get(name) : elements(o).find((e) => e.name === name);
  return el?.attrs.idref || null;
};

const KNOWN_FIELDS: Record<string, readonly string[]> = {
  folder: ["folder", "added", "modified", "name", "note", "rank", "hidden"],
  context: [
    "context",
    "added",
    "modified",
    "name",
    "note",
    "rank",
    "hidden",
    "prohibits-next-action",
    "location",
    "tasks-user-ordered",
    "children-are-mutually-exclusive",
  ],
  task: [
    "project",
    "inbox",
    "task",
    "added",
    "modified",
    "name",
    "note",
    "rank",
    "hidden",
    "context",
    "start",
    "planned",
    "due",
    "completed",
    "estimated-minutes",
    "order",
    "flagged",
    "completed-by-children",
    "repetition-rule",
    "repetition-method",
    "repetition-schedule-type",
    "repetition-anchor-date",
    "catch-up-automatically",
    "repeat",
    "next-clone-identifier",
    "due-date-alarm-policy",
    "defer-date-alarm-policy",
    "latest-time-to-start-alarm-policy",
    "planned-date-alarm-policy",
  ],
  "task-to-tag": ["added", "modified", "task", "context", "rank-in-task", "rank-in-tag"],
  alarm: ["added", "modified", "task", "kind", "variant", "fire-date", "fire-offset", "repeat-interval"],
  attachment: ["added", "modified", "task", "name", "preview-image", "data-identifier"],
  perspective: ["added", "modified", "plist", "icon-attachment"],
  setting: ["added", "modified", "plist"],
};
const PROJECT_FIELDS = ["folder", "singleton", "last-review", "review-interval", "next-review", "status"];
const ALARM_POLICIES = [
  "due-date-alarm-policy",
  "defer-date-alarm-policy",
  "latest-time-to-start-alarm-policy",
  "planned-date-alarm-policy",
];

/** Unknown element names (per type) are reported once with a count and the first raw element verbatim. */
function reportUnknown(pkg: ParsedPackage, warnings: Warnings): void {
  const unknown = new Map<string, { n: number; raw: string }>();
  const note = (key: string, el: XElement) => {
    const u = unknown.get(key);
    if (u) u.n++;
    else unknown.set(key, { n: 1, raw: serialize(el).slice(0, MAX_RAW) });
  };
  for (const [type, byId] of pkg.objects) {
    const known = KNOWN_FIELDS[type];
    if (!known) {
      for (const o of byId.values()) {
        const el: XElement = { name: type, attrs: { id: o.id }, children: [...o.fields.values()] };
        note(`<${type}>`, el);
      }
      continue;
    }
    for (const o of byId.values()) {
      for (const [name, el] of o.fields) if (!known.includes(name)) note(`<${type}> child <${name}>`, el);
      const project = type === "task" ? o.fields.get("project") : undefined;
      if (project) for (const el of elements(project)) if (!PROJECT_FIELDS.includes(el.name)) note(`<project> child <${el.name}>`, el);
    }
  }
  for (const [key, u] of unknown) {
    warnings.add(`Unknown element ${key} on ${u.n} object(s) was not imported; first occurrence: ${u.raw}`);
  }
}

/** Groups items by key, preserving first-seen group order. */
function groupBy<T>(items: Iterable<T>, key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const g = groups.get(k);
    if (g) g.push(item);
    else groups.set(k, [item]);
  }
  return [...groups.values()];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Breaks parent cycles and dangling parents in a tree; returns ids whose parent was cleared. */
function repairParents<T extends { id: string; parentId?: string | null }>(rows: Map<string, T>): string[] {
  const cleared: string[] = [];
  for (const row of rows.values()) {
    if (row.parentId && !rows.has(row.parentId)) {
      row.parentId = null;
      cleared.push(row.id);
    }
  }
  for (const row of rows.values()) {
    const seen = new Set<string>([row.id]);
    let cur = row.parentId ? rows.get(row.parentId) : undefined;
    while (cur) {
      if (seen.has(cur.id)) {
        cur.parentId = null;
        cleared.push(cur.id);
        break;
      }
      seen.add(cur.id);
      cur = cur.parentId ? rows.get(cur.parentId) : undefined;
    }
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// Repeats (F§2.6)
// ---------------------------------------------------------------------------

const LEGACY_REPEAT = /^[@~]?(\d+)([hdwmy])$/;
const LEGACY_FREQ: Record<string, string> = { h: "HOURLY", d: "DAILY", w: "WEEKLY", m: "MONTHLY", y: "YEARLY" };

interface RepeatFields {
  repeatRule: string | null;
  repeatScheduleType: "regularly" | "fromCompletion" | null;
  repeatAnchor: "due" | "defer" | "planned" | null;
  repeatCatchUp: boolean;
}

function mapRepeat(o: OfObject, dates: { due: string | null; defer: string | null; planned: string | null }, warnings: Warnings): RepeatFields {
  const none: RepeatFields = { repeatRule: null, repeatScheduleType: null, repeatAnchor: null, repeatCatchUp: false };
  let rule = text(o, "repetition-rule").trim().replace(/^RRULE:/i, "");
  if (!rule) {
    const legacy = LEGACY_REPEAT.exec(text(o, "repeat").trim());
    if (!legacy) return none;
    rule = `FREQ=${LEGACY_FREQ[legacy[2]!]};INTERVAL=${legacy[1]}`;
  }
  const parts = rule.split(";");
  const wellFormed = parts.every((p) => /^[A-Z]+=[^;=]+$/i.test(p));
  if (!wellFormed || !parts.some((p) => /^FREQ=(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)$/i.test(p))) {
    warnings.tally("Repeat rules that could not be parsed were dropped", o.id);
    return none;
  }
  const method = text(o, "repetition-method").trim();
  const schedule = text(o, "repetition-schedule-type").trim();
  const anchor = text(o, "repetition-anchor-date").trim();

  const methodSchedule = method === "due-after-completion" || method === "start-after-completion" ? "fromCompletion" : "regularly";
  if (method && !["fixed", "due-after-completion", "start-after-completion"].includes(method)) {
    warnings.tally(`Unknown repetition-method "${method}" treated as fixed`, o.id);
  }
  const scheduleType =
    schedule === "from-completion" ? "fromCompletion" : schedule === "from-assigned" ? "regularly" : methodSchedule;

  const anchorMap: Record<string, RepeatFields["repeatAnchor"]> = { dateDue: "due", dateToStart: "defer", datePlanned: "planned" };
  let repeatAnchor = anchorMap[anchor] ?? null;
  if (!repeatAnchor) {
    if (method === "due-after-completion") repeatAnchor = "due";
    else if (method === "start-after-completion") repeatAnchor = "defer";
    else if (dates.due) repeatAnchor = "due";
    else if (dates.planned && !dates.defer) repeatAnchor = "planned";
    else repeatAnchor = "defer";
  }
  return { repeatRule: rule, repeatScheduleType: scheduleType, repeatAnchor, repeatCatchUp: bool(o, "catch-up-automatically") };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const REVIEW_INTERVAL = /^[@~]?(\d+)([dwmy])$/;
const REVIEW_UNIT = { d: "day", w: "week", m: "month", y: "year" } as const;
const PROJECT_STATUS: Record<string, ProjectRow["status"]> = {
  active: "active",
  inactive: "onHold",
  done: "completed",
  dropped: "dropped",
};

export function parseReviewInterval(raw: string): { steps: number; unit: "day" | "week" | "month" | "year" } | null {
  const m = REVIEW_INTERVAL.exec(raw.trim());
  if (!m || Number(m[1]) < 1) return null;
  return { steps: Number(m[1]), unit: REVIEW_UNIT[m[2] as keyof typeof REVIEW_UNIT] };
}

// ---------------------------------------------------------------------------
// Settings (spec §1.2)
// ---------------------------------------------------------------------------

const TIME_SETTINGS: Record<string, string> = {
  DefaultDueTime: "defaultDueTime",
  DefaultStartTime: "defaultDeferTime",
  DefaultPlannedTime: "defaultPlannedTime",
};

function mapSetting(id: string, value: PlistValue, warnings: Warnings): SettingRow {
  const time = TIME_SETTINGS[id];
  if (time) {
    const m = typeof value === "string" ? /^(\d{1,2}):(\d{2})/.exec(value.trim()) : null;
    if (m && Number(m[1]) < 24) return { key: time, valueJson: JSON.stringify(`${m[1]!.padStart(2, "0")}:${m[2]}`) };
    warnings.add(`Setting ${id} has an unexpected value and was kept raw.`);
  }
  if (id === "DueSoonInterval") {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      return { key: "dueSoonSeconds", valueJson: JSON.stringify(value) };
    }
    warnings.add(`Setting ${id} has an unexpected value and was kept raw.`);
  }
  return { key: `of.${id}`, valueJson: JSON.stringify(value) };
}

// ---------------------------------------------------------------------------
// Main mapping
// ---------------------------------------------------------------------------

const DATA_ID = /^data-([0-9a-f]{64})$/;

/** sha256 → package path for every blob referenced by an attachment whose task survives. */
export function referencedBlobs(pkg: ParsedPackage): Map<string, string> {
  const tasks = pkg.objects.get("task") ?? new Map();
  const out = new Map<string, string>();
  for (const a of pkg.objects.get("attachment")?.values() ?? []) {
    const m = DATA_ID.exec(text(a, "data-identifier").trim());
    const taskId = ref(a, "task");
    if (m && taskId && tasks.has(taskId)) out.set(m[1]!, `data/${m[0]}.zip`);
  }
  return out;
}

export function mapPackage(pkg: ParsedPackage, blobInfo: Map<string, BlobInfo>, now: string): MappedData {
  const warnings = new Warnings();
  pkg.warnings.forEach((w) => warnings.add(w));
  reportUnknown(pkg, warnings);
  const all = (type: string): OfObject[] => [...(pkg.objects.get(type)?.values() ?? [])];

  const added = (o: OfObject) => stamp(text(o, "added")) ?? now;
  const modified = (o: OfObject) => stamp(text(o, "modified")) ?? added(o);
  const rank = (o: OfObject) => int32(text(o, "rank")) ?? 0;

  // Attachment names are needed by note conversion.
  const attachmentObjects = all("attachment");
  const attachmentNames = new Map(attachmentObjects.map((a) => [a.id, text(a, "name").trim() || a.id]));
  const note = (o: OfObject) => noteToMarkdown(o.fields.get("note"), (id) => attachmentNames.get(id));

  /** Drop marker: a date, `true` (no date → modified), or empty/`false`. */
  const dropDate = (o: OfObject): string | null => {
    const raw = text(o, "hidden").trim();
    if (!raw || raw === "false") return null;
    return stamp(raw) ?? modified(o);
  };

  // Folders (F§2.3)
  const folders = new Map<string, FolderRow>();
  for (const o of all("folder")) {
    folders.set(o.id, {
      id: o.id,
      parentId: ref(o, "folder"),
      name: text(o, "name"),
      note: note(o),
      rank: rank(o),
      status: dropDate(o) ? "dropped" : "active",
      added: added(o),
      modified: modified(o),
    });
  }
  for (const id of repairParents(folders)) warnings.tally("Folders with a missing or circular parent moved to the top level", id);

  // Tags (F§2.4)
  const tags = new Map<string, TagRow>();
  for (const o of all("context")) {
    const exclusive = o.fields.get("children-are-mutually-exclusive");
    tags.set(o.id, {
      id: o.id,
      parentId: ref(o, "context"),
      name: text(o, "name"),
      note: note(o),
      rank: rank(o),
      status: bool(o, "hidden") ? "dropped" : bool(o, "prohibits-next-action") ? "onHold" : "active",
      childrenMutuallyExclusive: exclusive !== undefined && textOf(exclusive).trim() !== "false",
      added: added(o),
      modified: modified(o),
    });
    const location = o.fields.get("location");
    if (location && Object.keys(location.attrs).length > 0) {
      warnings.tally("Tag locations (Nearby) are not supported and were not imported", o.id);
    }
  }
  for (const id of repairParents(tags)) warnings.tally("Tags with a missing or circular parent moved to the top level", id);

  // Tasks and projects (F§2.5, F§2.6)
  const tasks = new Map<string, TaskRow>();
  const projects = new Map<string, ProjectRow>();
  const dateField = (o: OfObject, name: string): string | null => {
    const v = userDate(text(o, name));
    if (v === undefined) {
      warnings.tally(`Unreadable <${name}> dates were cleared`, o.id);
      return null;
    }
    return v;
  };
  for (const o of all("task")) {
    const deferDate = dateField(o, "start");
    const plannedDate = dateField(o, "planned");
    const dueDate = dateField(o, "due");
    const order = text(o, "order").trim();
    const estimate = int32(text(o, "estimated-minutes"));
    const row: TaskRow = {
      id: o.id,
      parentId: ref(o, "task"),
      inInbox: bool(o, "inbox"),
      rank: rank(o),
      name: text(o, "name"),
      note: note(o),
      flagged: bool(o, "flagged"),
      deferDate,
      plannedDate,
      dueDate,
      estimatedMinutes: estimate !== null && estimate >= 0 ? estimate : null,
      completed: stamp(text(o, "completed")),
      dropped: dropDate(o),
      added: added(o),
      modified: modified(o),
      sequential: order !== "parallel",
      completedByChildren: bool(o, "completed-by-children"),
      ...mapRepeat(o, { due: dueDate, defer: deferDate, planned: plannedDate }, warnings),
      nextCloneId: Math.max(0, int32(text(o, "next-clone-identifier")) ?? 0),
      assignedProjectId: null,
    };
    tasks.set(o.id, row);
    for (const p of ALARM_POLICIES) {
      const el = o.fields.get(p);
      if (el && el.children.length > 0) warnings.tally(`Non-empty <${p}> not imported`, o.id);
    }

    const project = o.fields.get("project");
    if (!project || elements(project).length === 0) continue;
    const pf = (name: string) => textOf(elements(project).find((e) => e.name === name)).trim();
    const intervalRaw = pf("review-interval");
    const interval = parseReviewInterval(intervalRaw);
    if (!interval) warnings.tally("Projects with an unreadable review interval now review weekly", o.id);
    const statusRaw = pf("status");
    let status = PROJECT_STATUS[statusRaw || "active"];
    if (!status) {
      warnings.tally(`Unknown project status "${statusRaw}" imported as active`, o.id);
      status = "active";
    }
    // Keep status and the task's completed/dropped timestamps consistent (spec §1.2).
    if (status === "completed" && !row.completed) row.completed = row.modified;
    if (status === "dropped" && !row.dropped) row.dropped = row.modified;
    if (status !== "completed" && status !== "dropped") {
      if (row.dropped) status = "dropped";
      else if (row.completed) status = "completed";
    }
    const nextReview = userDate(pf("next-review"));
    projects.set(o.id, {
      taskId: o.id,
      folderId: ref(project, "folder"),
      type: pf("singleton") === "true" ? "singleActions" : row.sequential ? "sequential" : "parallel",
      status,
      reviewIntervalSteps: interval?.steps ?? 1,
      reviewIntervalUnit: interval?.unit ?? "week",
      reviewIntervalRaw: intervalRaw || null,
      lastReview: stamp(pf("last-review")) ?? row.added,
      nextReview: nextReview ?? null,
    });
  }

  for (const id of repairParents(tasks)) warnings.tally("Tasks with a missing or circular parent moved to the Inbox", id);
  for (const row of tasks.values()) {
    const isProject = projects.has(row.id);
    if (isProject && row.parentId) {
      warnings.tally("Projects nested inside tasks moved to the top level", row.id);
      row.parentId = null;
    }
    if (row.parentId || isProject) row.inInbox = false;
    else if (!row.inInbox) {
      warnings.tally("Top-level actions outside any project moved to the Inbox", row.id);
      row.inInbox = true;
    }
  }
  for (const p of projects.values()) {
    if (p.folderId && !folders.has(p.folderId)) {
      warnings.tally("Projects in a missing folder moved to the top level", p.taskId);
      p.folderId = null;
    }
  }

  // Task–tag links (F§2.7)
  interface Link {
    taskId: string;
    tagId: string;
    rankInTask: string;
    rankInTag: string;
    added: string;
  }
  const links = new Map<string, Link>();
  for (const o of all("task-to-tag")) {
    const dot = o.id.lastIndexOf(".");
    const taskId = ref(o, "task") ?? (dot > 0 ? o.id.slice(0, dot) : null);
    const tagId = ref(o, "context") ?? (dot > 0 ? o.id.slice(dot + 1) : null);
    if (!taskId || !tagId || !tasks.has(taskId) || !tags.has(tagId)) {
      warnings.tally("Tag links to a missing task or tag were skipped", o.id);
      continue;
    }
    links.set(`${taskId}\u0000${tagId}`, {
      taskId,
      tagId,
      rankInTask: text(o, "rank-in-task").trim(),
      rankInTag: text(o, "rank-in-tag").trim(),
      added: added(o),
    });
  }
  for (const o of all("task")) {
    const tagId = ref(o, "context");
    if (!tagId || !tasks.has(o.id) || links.has(`${o.id}\u0000${tagId}`)) continue;
    if (!tags.has(tagId)) {
      warnings.tally("Tasks whose primary tag is missing lost that tag", o.id);
      continue;
    }
    // The primary tag sorts first (F§2.7).
    links.set(`${o.id}\u0000${tagId}`, { taskId: o.id, tagId, rankInTask: "", rankInTag: "", added: added(o) });
  }
  const taskTags: TaskTagRow[] = [];
  const rankInTag = new Map<Link, number>();
  for (const group of groupBy(links.values(), (l) => l.tagId)) {
    group
      .filter((l) => l.rankInTag)
      .sort((a, b) => cmp(a.rankInTag, b.rankInTag) || cmp(a.taskId, b.taskId))
      .forEach((l, i) => rankInTag.set(l, i));
  }
  for (const group of groupBy(links.values(), (l) => l.taskId)) {
    group
      .sort((a, b) => cmp(a.rankInTask, b.rankInTask) || cmp(a.added, b.added) || cmp(a.tagId, b.tagId))
      .forEach((l, i) =>
        taskTags.push({ taskId: l.taskId, tagId: l.tagId, rankInTask: i, rankInTag: rankInTag.get(l) ?? null, added: l.added }),
      );
  }

  // Alarms (F§2.12; offsets in seconds)
  const ALARM_KIND: Record<string, AlarmRow["kind"]> = {
    absolute: "absolute",
    "due-relative": "dueRelative",
    "defer-relative": "deferRelative",
    "start-relative": "deferRelative",
    "planned-relative": "plannedRelative",
  };
  const alarms: AlarmRow[] = [];
  for (const o of all("alarm")) {
    const taskId = ref(o, "task");
    if (!taskId || !tasks.has(taskId)) {
      warnings.tally("Alarms on a missing task were skipped", o.id);
      continue;
    }
    const kindRaw = text(o, "kind").trim();
    const kind = ALARM_KIND[kindRaw];
    if (!kind) {
      warnings.tally(`Alarms of unknown kind "${kindRaw}" were skipped`, o.id);
      continue;
    }
    const fireDate = kind === "absolute" ? userDate(text(o, "fire-date")) : null;
    if (kind === "absolute" && !fireDate) {
      warnings.tally("Absolute alarms without a fire date were skipped", o.id);
      continue;
    }
    alarms.push({
      id: o.id,
      taskId,
      kind,
      fireDate: fireDate ?? null,
      offsetSeconds: kind === "absolute" ? null : (int32(text(o, "fire-offset")) ?? 0),
      repeatIntervalSeconds: Math.max(0, int32(text(o, "repeat-interval")) ?? 0),
      snoozed: text(o, "variant").trim() === "snoozed",
      added: added(o),
    });
  }

  // Attachments and blobs (F§2.9)
  const cellOrder = new Map<string, number>();
  for (const t of tasks.values()) {
    let i = 0;
    for (const m of t.note?.matchAll(/\]\(attachment:([^)]+)\)/g) ?? []) if (!cellOrder.has(m[1]!)) cellOrder.set(m[1]!, i++);
  }
  const attachments: AttachmentRow[] = [];
  const blobs = new Map<string, BlobRow>();
  for (const o of attachmentObjects) {
    const taskId = ref(o, "task");
    if (!taskId || !tasks.has(taskId)) {
      warnings.tally("Attachments on a missing task were skipped", o.id);
      continue;
    }
    const sha = DATA_ID.exec(text(o, "data-identifier").trim())?.[1];
    const info = sha ? blobInfo.get(sha) : undefined;
    if (!sha || !info) {
      warnings.tally("Attachments whose file is missing or corrupt were skipped", o.id);
      continue;
    }
    const name = attachmentNames.get(o.id)!;
    const contentType = contentTypeFor(name, info.sniffed);
    if (!blobs.has(sha)) blobs.set(sha, { sha256: sha, size: info.size, contentType, storageKey: blobKey(sha) });
    attachments.push({
      id: o.id,
      taskId,
      blobSha256: sha,
      name,
      contentType,
      size: info.size,
      rank: 0,
      added: added(o),
    });
  }
  for (const group of groupBy(attachments, (a) => a.taskId)) {
    group
      .sort(
        (a, b) =>
          (cellOrder.get(a.id) ?? Infinity) - (cellOrder.get(b.id) ?? Infinity) ||
          cmp(a.added!, b.added!) ||
          cmp(a.id, b.id),
      )
      .forEach((a, i) => (a.rank = i));
  }

  // Settings (F§2.13 → spec §1.2)
  const settingValues = new Map<string, PlistValue>();
  const settings: SettingRow[] = [];
  for (const o of all("setting")) {
    const value = plistRoot(o.fields.get("plist"));
    settingValues.set(o.id, value);
    settings.push(mapSetting(o.id, value, warnings));
  }

  // Perspectives (F§2.10)
  const customPerspectives = new Map<string, PerspectiveRow>();
  let builtinElements = 0;
  for (const o of all("perspective")) {
    const builtin = builtinFor(o.id);
    if (builtin !== undefined) {
      builtinElements++;
      continue;
    }
    const icon = o.fields.get("icon-attachment");
    customPerspectives.set(
      o.id,
      customPerspectiveRow(
        {
          id: o.id,
          plist: plistRoot(o.fields.get("plist")),
          added: added(o),
          modified: modified(o),
          iconAttachment: icon && (icon.children.length > 0 || Object.keys(icon.attrs).length > 0) ? serialize(icon) : null,
        },
        (msg) => warnings.add(msg),
      ),
    );
  }
  const order = settingValues.get("PerspectiveOrder_v3") ?? settingValues.get("PerspectiveOrder");
  let builtinPlacement: Map<BuiltinPerspectiveId, BuiltinPlacement> | null = null;
  let nextRank = 0;
  if (Array.isArray(order)) {
    builtinPlacement = new Map();
    for (const entry of order) {
      if (typeof entry !== "string") continue;
      const builtin = builtinFor(entry);
      if (builtin) {
        if (!builtinPlacement.has(builtin)) builtinPlacement.set(builtin, { favorite: true, rank: nextRank++ * RANK_STEP });
      } else if (builtin === undefined) {
        const custom = customPerspectives.get(entry);
        if (custom && !custom.favorite) {
          custom.favorite = true;
          custom.rank = nextRank++ * RANK_STEP;
        }
      }
    }
  } else nextRank = 9;
  for (const custom of customPerspectives.values()) if (!custom.favorite) custom.rank = nextRank++ * RANK_STEP;
  const firstFreeRank = nextRank;
  if (builtinPlacement) {
    // Built-ins missing from the backup's order go after everything else, not favourited.
    let r = firstFreeRank;
    for (const id of ["inbox", "projects", "tags", "forecast", "flagged", "review", "completed", "changed", "search"] as const) {
      if (!builtinPlacement.has(id)) builtinPlacement.set(id, { favorite: false, rank: r++ * RANK_STEP });
    }
  }

  const result = {
    folders: [...folders.values()],
    tags: [...tags.values()],
    tasks: [...tasks.values()],
    projects: [...projects.values()],
    taskTags,
    alarms,
    attachments,
    blobs: [...blobs.values()],
    customPerspectives: [...customPerspectives.values()],
    builtinPlacement,
    settings,
  };
  const counts: Record<string, number> = {
    tasks: result.tasks.length,
    projects: result.projects.length,
    folders: result.folders.length,
    tags: result.tags.length,
    taskTags: result.taskTags.length,
    alarms: result.alarms.length,
    attachments: result.attachments.length,
    blobs: result.blobs.length,
    customPerspectives: result.customPerspectives.length,
    builtinPerspectives: builtinElements,
    settings: result.settings.length,
    repeatClones: result.tasks.filter((t) => t.id.includes(".")).length,
    transactions: pkg.transactions.length,
  };
  return { ...result, counts, warnings: warnings.list() };
}
