// Row + derived state → API DTOs (src/shared/schemas.ts).
import {
  addToNaive,
  dateValueToInstant,
  formatFixed,
  formatFloating,
  instantToNaive,
  isFloating,
  parseFloating,
} from "../shared/datetime.js";
import {
  PerspectivePresentation,
  ViewOptions,
  type Alarm,
  type Attachment,
  type Folder,
  type Perspective,
  type Project,
  type Settings,
  type Tag,
  type Task,
} from "../shared/schemas.js";
import { BUILTIN_META, type BuiltinPerspectiveId } from "./builtins.js";
import type { Derived } from "./derive.js";
import type {
  AlarmRow,
  AttachmentRow,
  FolderRow,
  PerspectiveRow,
  ProjectRow,
  Snapshot,
  TagRow,
  TaskRow,
} from "./snapshot.js";

export function taskDto(snap: Snapshot, d: Derived, row: TaskRow): Task {
  const s = d.tasks.get(row.id);
  if (!s) throw new Error(`No derived state for task ${row.id}`);
  const projectId = s.projectId;
  const projectNameId = projectId ?? row.assignedProjectId;
  const children = snap.childrenOf(row.id);
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    parentId: row.parentId,
    projectId,
    isProject: snap.isProject(row.id),
    inInbox: row.inInbox,
    rank: row.rank,
    flagged: row.flagged,
    deferDate: row.deferDate,
    plannedDate: row.plannedDate,
    dueDate: row.dueDate,
    estimatedMinutes: row.estimatedMinutes,
    completed: row.completed,
    dropped: row.dropped,
    added: row.added,
    modified: row.modified,
    sequential: row.sequential,
    completedByChildren: row.completedByChildren,
    repeat:
      row.repeatRule === null
        ? null
        : {
            rule: row.repeatRule,
            scheduleType: row.repeatScheduleType ?? "regularly",
            anchorDate: row.repeatAnchor ?? "due",
            catchUpAutomatically: row.repeatCatchUp,
          },
    assignedProjectId: row.assignedProjectId,
    tagIds: snap.tagIdsOf(row.id),
    attachmentCount: snap.attachmentsOf(row.id).length,
    childCount: children.length,
    remainingChildCount: s.remainingChildCount,
    effectiveFlagged: s.effectiveFlagged,
    effectiveDeferDate: s.effectiveDeferDate,
    effectivePlannedDate: s.effectivePlannedDate,
    effectiveDueDate: s.effectiveDueDate,
    effectiveCompleted: s.effectiveCompleted,
    effectiveDropped: s.effectiveDropped,
    remaining: s.remaining,
    deferred: s.deferred,
    blocked: s.blocked,
    available: s.available,
    firstAvailable: s.firstAvailable,
    overdue: s.overdue,
    dueSoon: s.dueSoon,
    status: s.status,
    projectName: projectNameId ? (snap.tasks.get(projectNameId)?.name ?? null) : null,
  };
}

/** Floating start-of-day `lastReview`'s local day + interval. */
export function computeNextReview(p: ProjectRow, timeZone: string): string {
  const lastNaive = instantToNaive(Date.parse(p.lastReview), timeZone);
  const day = Math.floor(lastNaive / 86_400_000) * 86_400_000;
  return formatFloating(addToNaive(day, p.reviewIntervalSteps, p.reviewIntervalUnit));
}

export function projectDto(snap: Snapshot, d: Derived, p: ProjectRow, settings: Settings): Project {
  const task = snap.tasks.get(p.taskId);
  const ps = d.projects.get(p.taskId);
  if (!task || !ps) throw new Error(`Project ${p.taskId} has no root task`);
  return {
    id: p.taskId,
    task: taskDto(snap, d, task),
    folderId: p.folderId,
    type: p.type,
    status: p.status,
    effectiveStatus: ps.effectiveStatus,
    reviewInterval: { steps: p.reviewIntervalSteps, unit: p.reviewIntervalUnit },
    lastReview: p.lastReview,
    nextReview: p.nextReview ?? computeNextReview(p, settings.timeZone),
    stalled: ps.stalled,
    pending: ps.pending,
    remainingCount: ps.remainingCount,
    availableCount: ps.availableCount,
    dueSoonCount: ps.dueSoonCount,
    overdueCount: ps.overdueCount,
  };
}

export function folderDto(d: Derived, f: FolderRow): Folder {
  return {
    id: f.id,
    name: f.name,
    note: f.note,
    parentId: f.parentId,
    rank: f.rank,
    status: f.status,
    effectiveActive: d.folders.get(f.id)?.effectiveActive ?? f.status === "active",
    added: f.added,
    modified: f.modified,
  };
}

export function tagDto(d: Derived, t: TagRow): Tag {
  const ts = d.tags.get(t.id);
  return {
    id: t.id,
    name: t.name,
    note: t.note,
    parentId: t.parentId,
    rank: t.rank,
    status: t.status,
    effectiveStatus: ts?.effectiveStatus ?? t.status,
    childrenMutuallyExclusive: t.childrenMutuallyExclusive,
    added: t.added,
    modified: t.modified,
    remainingCount: ts?.remainingCount ?? 0,
    availableCount: ts?.availableCount ?? 0,
  };
}

export function alarmDto(d: Derived, a: AlarmRow, timeZone: string): Alarm {
  let effectiveFireDate: string | null = null;
  if (a.kind === "absolute") effectiveFireDate = a.fireDate;
  else {
    const s = d.tasks.get(a.taskId);
    const anchor =
      a.kind === "dueRelative"
        ? s?.effectiveDueDate
        : a.kind === "deferRelative"
          ? s?.effectiveDeferDate
          : s?.effectivePlannedDate;
    if (anchor) {
      const offset = (a.offsetSeconds ?? 0) * 1000;
      effectiveFireDate = isFloating(anchor)
        ? formatFloating(parseFloating(anchor)! + offset)
        : formatFixed(dateValueToInstant(anchor, timeZone) + offset);
    }
  }
  return {
    id: a.id,
    taskId: a.taskId,
    kind: a.kind,
    fireDate: a.fireDate,
    offsetSeconds: a.offsetSeconds,
    effectiveFireDate,
  };
}

export function attachmentDto(a: AttachmentRow): Attachment {
  return {
    id: a.id,
    taskId: a.taskId,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    sha256: a.blobSha256,
    added: a.added,
  };
}

function parseJson(text: string | null, fallback: unknown): unknown {
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function perspectiveDto(p: PerspectiveRow): Perspective {
  const rules = parseJson(p.rulesJson, []);
  const presentation = PerspectivePresentation.safeParse(parseJson(p.presentationJson, {}));
  const stored = ViewOptions.safeParse(parseJson(p.viewOptionsJson, {}));
  const defaults = p.builtin && p.id in BUILTIN_META ? BUILTIN_META[p.id as BuiltinPerspectiveId].viewOptions : {};
  const storedOptions = stored.success ? stored.data : {};
  const viewOptions = ViewOptions.parse({
    ...defaults,
    ...storedOptions,
    ...(defaults.forecast || storedOptions.forecast
      ? { forecast: { ...(defaults.forecast as object | undefined), ...storedOptions.forecast } }
      : {}),
  });
  return {
    id: p.id,
    builtin: p.builtin,
    name: p.name,
    icon: p.icon,
    color: p.color,
    favorite: p.favorite,
    rank: p.rank,
    aggregation: p.aggregation,
    rules: Array.isArray(rules) ? (rules.filter((r) => r && typeof r === "object") as Record<string, unknown>[]) : [],
    presentation: presentation.success ? presentation.data : PerspectivePresentation.parse({}),
    viewOptions,
  };
}
