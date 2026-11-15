// Client-side ids and the records shown for items this tab creates until the server's copy arrives.
import type { Folder, Perspective, Project, Settings, Tag, Task } from "../../shared/schemas";
import { projectTask } from "./optimistic";

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** A new id in the server's format (11 characters of `[A-Za-z0-9_-]`, like src/domain/ids.ts). */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(11));
  let id = "";
  for (const b of bytes) id += ID_ALPHABET[b & 63];
  return id;
}

/** A new task as the server would return it, with `fields` applied and derived fields previewed. */
export function draftTask(id: string, fields: Partial<Task>, settings: Settings): Task {
  const now = new Date().toISOString();
  const base: Task = {
    id,
    name: "",
    note: "",
    parentId: null,
    projectId: null,
    isProject: false,
    inInbox: false,
    rank: 0,
    flagged: false,
    deferDate: null,
    plannedDate: null,
    dueDate: null,
    estimatedMinutes: null,
    completed: null,
    dropped: null,
    added: now,
    modified: now,
    sequential: false,
    completedByChildren: false,
    repeat: null,
    assignedProjectId: null,
    tagIds: [],
    attachmentCount: 0,
    childCount: 0,
    remainingChildCount: 0,
    effectiveFlagged: false,
    effectiveDeferDate: null,
    effectivePlannedDate: null,
    effectiveDueDate: null,
    effectiveCompleted: false,
    effectiveDropped: false,
    remaining: true,
    deferred: false,
    blocked: false,
    available: true,
    firstAvailable: false,
    overdue: false,
    dueSoon: false,
    status: "available",
    projectName: null,
  };
  return projectTask(base, fields, settings);
}

export function draftProject(
  id: string,
  fields: Partial<Task> & { type: Project["type"]; folderId: string | null; status?: Project["status"]; reviewInterval?: Project["reviewInterval"] },
  settings: Settings,
): Project {
  const { type, folderId, status = "active", reviewInterval = { steps: 1, unit: "week" }, ...task } = fields;
  return {
    id,
    task: draftTask(id, { ...task, isProject: true, projectId: id, projectName: task.name ?? "", rank: Number.MAX_SAFE_INTEGER }, settings),
    folderId,
    type,
    status,
    effectiveStatus: status,
    reviewInterval,
    lastReview: new Date().toISOString(),
    nextReview: null,
    stalled: false,
    pending: false,
    remainingCount: 0,
    availableCount: 0,
    dueSoonCount: 0,
    overdueCount: 0,
  };
}

export function draftFolder(id: string, fields: Pick<Folder, "name" | "parentId" | "rank">): Folder {
  const now = new Date().toISOString();
  return { id, note: "", status: "active", effectiveActive: true, added: now, modified: now, ...fields };
}

export function draftTag(id: string, fields: Pick<Tag, "name" | "parentId" | "rank">): Tag {
  const now = new Date().toISOString();
  return {
    id,
    note: "",
    status: "active",
    effectiveStatus: "active",
    childrenMutuallyExclusive: false,
    added: now,
    modified: now,
    remainingCount: 0,
    availableCount: 0,
    ...fields,
  };
}

export function draftPerspective(id: string, fields: Partial<Perspective> & Pick<Perspective, "name" | "rank">): Perspective {
  return {
    id,
    builtin: false,
    icon: "perspective",
    color: null,
    favorite: false,
    aggregation: "all",
    rules: [],
    presentation: { layout: "projects", grouping: "none", sorting: "manual", sidebar: "projects" },
    viewOptions: {},
    ...fields,
  };
}

/**
 * Rank that places an item at `position` among `siblings` (folders, tags, projects and perspectives sort by rank).
 * Previews may use fractional ranks; the server renumbers.
 */
export function rankAt(siblings: ReadonlyArray<{ id: string; rank: number }>, position: "start" | "end" | { before: string } | { after: string }): number {
  const ranks = siblings.map((s) => s.rank);
  if (position === "start") return ranks.length ? Math.min(...ranks) - 1 : 0;
  if (position === "end") return ranks.length ? Math.max(...ranks) + 1 : 0;
  const sorted = [...siblings].sort((a, b) => a.rank - b.rank);
  const anchor = "before" in position ? position.before : position.after;
  const i = sorted.findIndex((s) => s.id === anchor);
  const at = sorted[i];
  if (!at) return ranks.length ? Math.max(...ranks) + 1 : 0;
  const neighbour = "before" in position ? sorted[i - 1] : sorted[i + 1];
  if (!neighbour) return at.rank + ("before" in position ? -1 : 1);
  return (at.rank + neighbour.rank) / 2;
}
