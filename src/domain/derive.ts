// Derived state (docs/spec.md §1.3), computed for a snapshot, settings and `now`.
import { addDaysToKey, dayStartInstant, localDayKey } from "../shared/datetime.js";
import type { Settings, TaskStatus } from "../shared/schemas.js";
import type { ProjectRow, Snapshot, TaskRow } from "./snapshot.js";

export type ProjectStatus = ProjectRow["status"];
export type TagStatus = "active" | "onHold" | "dropped";

export interface TaskState {
  effectiveFlagged: boolean;
  effectiveDeferDate: string | null;
  effectivePlannedDate: string | null;
  effectiveDueDate: string | null;
  deferMs: number | null;
  plannedMs: number | null;
  dueMs: number | null;
  effectiveCompleted: boolean;
  effectiveDropped: boolean;
  remaining: boolean;
  deferred: boolean;
  /** Blocked for a reason other than having remaining children (inherited by children). */
  blockedOther: boolean;
  blocked: boolean;
  available: boolean;
  firstAvailable: boolean;
  overdue: boolean;
  dueSoon: boolean;
  status: TaskStatus;
  projectId: string | null;
  /** Number of task ancestors (a project root or top-level task has depth 0). */
  depth: number;
  /** Global outline order: inbox, then projects in sidebar order, then other top-level tasks. */
  order: number;
  remainingChildCount: number;
  /** True for inbox items and their descendants. */
  inInboxTree: boolean;
}

export interface ProjectState {
  effectiveStatus: ProjectStatus;
  stalled: boolean;
  pending: boolean;
  remainingCount: number;
  availableCount: number;
  dueSoonCount: number;
  overdueCount: number;
  /** Names of containing folders, outermost first. */
  folderPath: string[];
  /** Folder ids containing the project, outermost first. */
  folderIds: string[];
  order: number;
}

export interface TagState {
  effectiveStatus: TagStatus;
  remainingCount: number;
  availableCount: number;
  stalled: boolean;
  order: number;
  depth: number;
}

export interface FolderState {
  effectiveActive: boolean;
  order: number;
  depth: number;
}

export interface Derived {
  version: number;
  now: number;
  /** Instant of the start of today / tomorrow in the user's zone. */
  todayStart: number;
  tomorrowStart: number;
  todayKey: string;
  tasks: Map<string, TaskState>;
  projects: Map<string, ProjectState>;
  tags: Map<string, TagState>;
  folders: Map<string, FolderState>;
  /** Task ids in global outline order. */
  taskOrder: string[];
  toMs: (value: string) => number;
}

interface ProjectCtx {
  projectId: string;
  type: ProjectRow["type"];
  nextFound: boolean;
  remainingCount: number;
  availableCount: number;
  dueSoonCount: number;
  overdueCount: number;
}

export function computeDerived(
  snap: Snapshot,
  settings: Settings,
  now: number,
  toMs: (value: string) => number,
): Derived {
  const todayKey = localDayKey(now, settings.timeZone);
  const todayStart = dayStartInstant(todayKey, settings.timeZone);
  const tomorrowStart = dayStartInstant(addDaysToKey(todayKey, 1), settings.timeZone);
  const dueSoonLimit = settings.dueSoonSeconds === 0 ? tomorrowStart : now + settings.dueSoonSeconds * 1000;

  const d: Derived = {
    version: snap.version,
    now,
    todayStart,
    tomorrowStart,
    todayKey,
    tasks: new Map(),
    projects: new Map(),
    tags: new Map(),
    folders: new Map(),
    taskOrder: [],
    toMs,
  };

  // Tags: effective status top-down.
  let tagOrder = 0;
  const visitTag = (parentId: string | null, parentStatus: TagStatus, depth: number): void => {
    for (const tag of snap.tagChildren(parentId)) {
      let eff: TagStatus = tag.status;
      if (parentStatus === "dropped" || tag.status === "dropped") eff = "dropped";
      else if (parentStatus === "onHold" || tag.status === "onHold") eff = "onHold";
      d.tags.set(tag.id, {
        effectiveStatus: eff,
        remainingCount: 0,
        availableCount: 0,
        stalled: false,
        order: tagOrder++,
        depth,
      });
      visitTag(tag.id, eff, depth + 1);
    }
  };
  visitTag(null, "active", 0);

  let order = 0;
  const visitTask = (row: TaskRow, parent: TaskState | null, ctx: ProjectCtx | null, extra: {
    seqBlocked: boolean;
    projectStatus?: ProjectStatus;
    inInbox: boolean;
    depth: number;
  }): TaskState => {
    const dueOwn = row.dueDate === null ? null : toMs(row.dueDate);
    const deferOwn = row.deferDate === null ? null : toMs(row.deferDate);
    const plannedOwn = row.plannedDate === null ? null : toMs(row.plannedDate);

    let dueMs = dueOwn;
    let effectiveDueDate = row.dueDate;
    if (parent && parent.dueMs !== null && (dueMs === null || parent.dueMs < dueMs)) {
      dueMs = parent.dueMs;
      effectiveDueDate = parent.effectiveDueDate;
    }
    let deferMs = deferOwn;
    let effectiveDeferDate = row.deferDate;
    if (parent && parent.deferMs !== null && (deferMs === null || parent.deferMs > deferMs)) {
      deferMs = parent.deferMs;
      effectiveDeferDate = parent.effectiveDeferDate;
    }
    let plannedMs = plannedOwn;
    let effectivePlannedDate = row.plannedDate;
    if (plannedMs === null && parent) {
      plannedMs = parent.plannedMs;
      effectivePlannedDate = parent.effectivePlannedDate;
    }

    const effectiveCompleted =
      row.completed !== null || (parent?.effectiveCompleted ?? false) || extra.projectStatus === "completed";
    const effectiveDropped =
      row.dropped !== null || (parent?.effectiveDropped ?? false) || extra.projectStatus === "dropped";
    const remaining = !effectiveCompleted && !effectiveDropped;
    const deferred = deferMs !== null && deferMs > now;

    let tagsBlocked = false;
    for (const link of snap.taskTags.get(row.id) ?? []) {
      const ts = d.tags.get(link.tagId);
      if (ts && ts.effectiveStatus !== "active") {
        tagsBlocked = true;
        break;
      }
    }
    const projectHold = extra.projectStatus === "onHold" || extra.projectStatus === "dropped";
    const blockedOther =
      deferred || extra.seqBlocked || tagsBlocked || projectHold || (parent?.blockedOther ?? false);

    const children = snap.childrenOf(row.id);
    let remainingChildCount = 0;
    if (remaining) for (const c of children) if (c.completed === null && c.dropped === null) remainingChildCount++;

    const blocked = remaining && (remainingChildCount > 0 || blockedOther);
    const available = remaining && !blocked;
    const isRoot = ctx !== null && ctx.projectId === row.id;
    let firstAvailable = false;
    if (available && ctx && !isRoot && !extra.inInbox) {
      if (ctx.type === "singleActions") firstAvailable = true;
      else if (!ctx.nextFound) {
        firstAvailable = true;
        ctx.nextFound = true;
      }
    }
    const overdue = remaining && dueMs !== null && dueMs < now;
    const dueSoon = remaining && !overdue && dueMs !== null && dueMs <= dueSoonLimit;
    const status: TaskStatus = effectiveCompleted
      ? "completed"
      : effectiveDropped
        ? "dropped"
        : overdue
          ? "overdue"
          : dueSoon
            ? "dueSoon"
            : blocked
              ? "blocked"
              : firstAvailable
                ? "next"
                : "available";

    const state: TaskState = {
      effectiveFlagged: row.flagged || (parent?.effectiveFlagged ?? false),
      effectiveDeferDate,
      effectivePlannedDate,
      effectiveDueDate,
      deferMs,
      plannedMs,
      dueMs,
      effectiveCompleted,
      effectiveDropped,
      remaining,
      deferred,
      blockedOther,
      blocked,
      available,
      firstAvailable,
      overdue,
      dueSoon,
      status,
      projectId: ctx?.projectId ?? null,
      depth: extra.depth,
      order: order++,
      remainingChildCount,
      inInboxTree: extra.inInbox,
    };
    d.tasks.set(row.id, state);
    d.taskOrder.push(row.id);

    if (ctx && !isRoot) {
      if (remaining) ctx.remainingCount++;
      if (available) ctx.availableCount++;
      if (dueSoon) ctx.dueSoonCount++;
      if (overdue) ctx.overdueCount++;
    }
    if (remaining) {
      for (const link of snap.taskTags.get(row.id) ?? []) {
        const ts = d.tags.get(link.tagId);
        if (!ts) continue;
        ts.remainingCount++;
        if (available) ts.availableCount++;
      }
    }

    // Project roots order children by project type (single-action lists never block); other tasks by their flag.
    const sequential = isRoot ? ctx.type === "sequential" : row.sequential;
    let firstRemainingSeen = false;
    for (const child of children) {
      const childRemaining = child.completed === null && child.dropped === null;
      const seqBlocked = sequential && firstRemainingSeen;
      if (childRemaining) firstRemainingSeen = true;
      visitTask(child, state, ctx, { seqBlocked, inInbox: extra.inInbox, depth: extra.depth + 1 });
    }
    return state;
  };

  for (const row of snap.inboxRoots()) visitTask(row, null, null, { seqBlocked: false, inInbox: true, depth: 0 });

  let containerOrder = 0;
  const visitContainer = (folderId: string | null, dropped: boolean, path: string[], ids: string[], depth: number): void => {
    for (const item of snap.containerChildren(folderId)) {
      if (item.kind === "folder") {
        const effDropped = dropped || item.row.status === "dropped";
        d.folders.set(item.row.id, { effectiveActive: !effDropped, order: containerOrder++, depth });
        visitContainer(item.row.id, effDropped, [...path, item.row.name], [...ids, item.row.id], depth + 1);
        continue;
      }
      const p = item.row;
      const effectiveStatus: ProjectStatus = dropped || item.task.dropped !== null ? "dropped" : p.status;
      const ctx: ProjectCtx = {
        projectId: p.taskId,
        type: p.type,
        nextFound: false,
        remainingCount: 0,
        availableCount: 0,
        dueSoonCount: 0,
        overdueCount: 0,
      };
      const root = visitTask(item.task, null, ctx, {
        seqBlocked: false,
        projectStatus: effectiveStatus,
        inInbox: false,
        depth: 0,
      });
      d.projects.set(p.taskId, {
        effectiveStatus,
        stalled: effectiveStatus === "active" && ctx.availableCount === 0 && ctx.remainingCount > 0,
        pending: effectiveStatus === "active" && root.deferred,
        remainingCount: ctx.remainingCount,
        availableCount: ctx.availableCount,
        dueSoonCount: ctx.dueSoonCount,
        overdueCount: ctx.overdueCount,
        folderPath: path,
        folderIds: ids,
        order: containerOrder++,
      });
    }
  };
  visitContainer(null, false, [], [], 0);

  for (const row of snap.orphanRoots()) visitTask(row, null, null, { seqBlocked: false, inInbox: false, depth: 0 });

  for (const ts of d.tags.values()) ts.stalled = ts.remainingCount > 0 && ts.availableCount === 0;
  return d;
}
