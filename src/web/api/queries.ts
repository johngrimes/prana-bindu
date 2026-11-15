// React-query hooks and the web client's writes. All data queries live under the `["d"]` key prefix so a write can
// refresh every derived value (status, counts, perspectives) with one invalidation. Hooks return server data with the
// pending writes' changes applied (src/web/lib/writes.ts); every write shows its change at once and is sent in the
// background (docs/spec.md §2 "Instant writes").
import { QueryCache, QueryClient, keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import type {
  Attachment,
  Folder,
  Forecast,
  History,
  ImportRun,
  OutlineRow,
  Perspective,
  PerspectiveContents,
  Position,
  Project,
  QuickOpenResult,
  RepeatRule,
  SearchResults,
  Settings,
  Tag,
  Task,
  TaskDetail,
  TaskPatch,
  ViewOptions,
} from "../../shared/schemas";
import { addToNaive, formatFloating, instantToNaive } from "../../shared/datetime";
import { ApiError, api, type RequestOptions } from "./client";
import { toastError } from "../components/Toasts";
import { draftFolder, draftPerspective, draftProject, draftTag, draftTask, rankAt } from "../lib/drafts";
import {
  changesFromPatch,
  previewDetail,
  previewList,
  previewProjectRecord,
  previewSearch,
  previewSettings,
  previewTask,
  resolveDateInput,
  type Change,
  type ItemChange,
  type ListName,
  type Lists,
  type ProjectChanges,
  type TaskChanges,
  type RowChange,
  type RowPlace,
  type StateReader,
} from "../lib/optimistic";
import { placeAt } from "../lib/outlineModel";
import { browserTimeZone } from "../lib/dates";
import { outline } from "../lib/ui";
import { configureWrites, createdHere, forgetCreation, stepIsCurrent, usePendingChanges, useUnconfirmed, write, writes, type RecordedStep, type WriteSpec } from "../lib/writes";
import { useStore } from "../lib/store";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && (error.status === 401 || error.status === 404)) return;
      toastError(error);
    },
  }),
});

interface Items<T> {
  items: T[];
}

export const keys = {
  settings: ["d", "settings"] as const,
  perspectives: ["d", "perspectives"] as const,
  projects: ["d", "projects"] as const,
  folders: ["d", "folders"] as const,
  tags: ["d", "tags"] as const,
  history: ["d", "history"] as const,
  contents: (id: string, params: ContentsParams) => ["d", "contents", id, params] as const,
  forecast: ["d", "forecast"] as const,
  review: ["d", "review"] as const,
  task: (id: string) => ["d", "task", id] as const,
  search: (q: string, availability: string) => ["d", "search", q, availability] as const,
  quickOpen: (q: string) => ["d", "quick-open", q] as const,
  lastImport: ["d", "import-last"] as const,
};

/** Refreshes every data query (derived state ripples across views). */
export function refreshAll(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ["d"] });
}

export const DEFAULT_SETTINGS: Omit<Settings, "timeZone"> = {
  dateFormat: "MM/dd/yyyy",
  firstWeekday: 1,
  use24HourTime: false,
  defaultDeferTime: "00:00",
  defaultDueTime: "17:00",
  defaultPlannedTime: "09:00",
  dueSoonSeconds: 172800,
  theme: "system",
  forecastTagId: null,
};

// ---------------------------------------------------------------------------------------------
// Reading the cache as shown (server data + pending changes)
// ---------------------------------------------------------------------------------------------

/** Current settings as shown, for computing previews outside React. */
function shownSettings(): Settings {
  const cached = queryClient.getQueryData<Settings>(keys.settings) ?? { ...DEFAULT_SETTINGS, timeZone: browserTimeZone() };
  return previewSettings(cached, writes.get().changes);
}

const LIST_KEYS: { [L in ListName]: readonly unknown[] } = { folders: keys.folders, tags: keys.tags, perspectives: keys.perspectives, projects: keys.projects };

/** A cached list as shown (pending changes applied), for handlers outside React; undefined until loaded. */
export function shownList<L extends ListName>(list: L): Lists[L][] | undefined {
  const cached = queryClient.getQueryData<Lists[L][]>(LIST_KEYS[list]);
  return cached && previewList(list, cached, writes.get().changes, shownSettings());
}

/** The task with `id` in any cached query, as the server last returned it (or as created here). */
function cachedTask(id: string): Task | undefined {
  const fromRows = (rows: readonly OutlineRow[]) => {
    const r = rows.find((x) => x.id === id);
    return r?.task ?? r?.project?.task;
  };
  for (const [key, data] of queryClient.getQueriesData<unknown>({ queryKey: ["d"] })) {
    if (!data) continue;
    let found: Task | undefined;
    switch (key[1]) {
      case "task": {
        const d = data as TaskDetail;
        found = d.id === id ? d : d.children.find((c) => c.id === id);
        break;
      }
      case "contents":
        for (const g of (data as PerspectiveContents).groups) found ??= fromRows(g.rows);
        break;
      case "forecast":
        for (const d of (data as Forecast).days) found ??= fromRows(d.rows);
        break;
      case "search": {
        const s = data as SearchResults;
        found = s.tasks.find((t) => t.id === id) ?? s.projects.find((p) => p.id === id)?.task;
        break;
      }
      case "projects":
        found = (data as Project[]).find((p) => p.id === id)?.task;
        break;
    }
    if (found) return found;
  }
  for (const c of writes.get().changes) {
    if (c.kind === "row" && c.id === id && c.rows?.[0]?.task) return c.rows[0].task;
    if (c.kind === "item" && c.list === "projects" && c.id === id && c.value) return c.value.task;
  }
  return undefined;
}

const reader: StateReader = {
  task(id) {
    for (const g of outline()?.groups() ?? []) {
      const r = g.rows.find((x) => x.id === id);
      const shown = r?.task ?? r?.project?.task;
      if (shown) return shown;
    }
    const task = cachedTask(id);
    return task && previewTask(task, writes.get().changes, shownSettings());
  },
  projectRecord(id) {
    const project = shownList("projects")?.find((p) => p.id === id);
    if (project) return project;
    const detail = queryClient.getQueryData<TaskDetail>(keys.task(id));
    return detail?.project ? previewProjectRecord(id, detail.project, writes.get().changes) : undefined;
  },
  outline: () => outline()?.groups() ?? null,
  item(list, id) {
    const items = shownList(list);
    return items ? (items.find((i) => i.id === id) ?? null) : undefined;
  },
  settings: () => (queryClient.getQueryData(keys.settings) ? shownSettings() : undefined),
  attachment(taskId, id) {
    const detail = queryClient.getQueryData<TaskDetail>(keys.task(taskId));
    if (!detail) return undefined;
    return previewDetail(detail, writes.get().changes, shownSettings()).attachments.find((a) => a.id === id) ?? null;
  },
};

/** Refreshes for the write queue: false when an active query could not reach the server (its previews then stay). */
async function refreshForWrites(): Promise<boolean> {
  const started = Date.now();
  await refreshAll();
  return !queryClient
    .getQueryCache()
    .findAll({ queryKey: ["d"], type: "active" })
    .some((q) => q.state.errorUpdatedAt >= started && q.state.error instanceof ApiError && (q.state.error.status === 0 || q.state.error.status >= 500));
}

configureWrites({ refresh: refreshForWrites, read: reader });

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

export function useSettings() {
  const changes = usePendingChanges();
  const select = useCallback((s: Settings) => previewSettings(s, changes), [changes]);
  return useQuery({ queryKey: keys.settings, queryFn: () => api.get<Settings>("/settings"), staleTime: 60_000, select });
}

/** Settings with defaults while loading, so date rendering never blocks. */
export function useSettingsValue(): Settings {
  const { data } = useSettings();
  return data ?? { ...DEFAULT_SETTINGS, timeZone: browserTimeZone() };
}

function useList<L extends ListName>(list: L, path: string) {
  const changes = usePendingChanges();
  const settings = useSettingsValue();
  const select = useCallback((items: Lists[L][]) => previewList(list, items, changes, settings), [list, changes, settings]);
  return useQuery({ queryKey: LIST_KEYS[list], queryFn: async () => (await api.get<Items<Lists[L]>>(path)).items, select });
}

export const usePerspectives = () => useList("perspectives", "/perspectives");
export const useProjects = () => useList("projects", "/projects");
export const useFolders = () => useList("folders", "/folders");
export const useTags = () => useList("tags", "/tags");

/**
 * Undo/redo availability: this tab's own steps first (unless the server's history has a newer step made elsewhere),
 * then the server's (its redo list is stale once this tab writes).
 */
export function useHistory(): { data: History | undefined } {
  const undoStep = useStore(writes, (s) => s.undo.at(-1));
  const redoStep = useStore(writes, (s) => s.redo.at(-1));
  const journaledAt = useStore(writes, (s) => s.journaledAt);
  const { data: server, dataUpdatedAt } = useQuery({ queryKey: keys.history, queryFn: () => api.get<History>("/history"), staleTime: 0 });
  if (!server) return { data: undefined };
  const undo = undoStep && stepIsCurrent(undoStep, server.undoId) ? undoStep.label : null;
  const redo = redoStep && stepIsCurrent(redoStep, server.undoId) ? redoStep.label : null;
  const stale = journaledAt > dataUpdatedAt;
  return {
    data: {
      ...server,
      canUndo: undo !== null || server.canUndo,
      undoLabel: undo ?? server.undoLabel,
      canRedo: redo !== null || (!stale && server.canRedo),
      redoLabel: redo ?? (stale ? null : server.redoLabel),
    },
  };
}

export interface ContentsParams {
  project?: string;
  folder?: string;
  tag?: string;
  day?: string;
  q?: string;
}

/**
 * Raw contents (the outline applies pending changes over its kept rows). A perspective or project created here and
 * not yet saved is shown from its preview until the server has it.
 */
export function useContents(perspectiveId: string, params: ContentsParams, enabled = true) {
  const perspectiveNew = useUnconfirmed(perspectiveId);
  const projectNew = useUnconfirmed(params.project);
  const { data: projects } = useProjects();
  const pending = perspectiveNew || projectNew;
  // A project created here is shown from its preview until its view first loads, even after it is saved, so the
  // title being typed into it stays put.
  const project = params.project && createdHere(params.project) ? projects?.find((p) => p.id === params.project) : undefined;
  const placeholder: PerspectiveContents | undefined =
    pending || project
      ? {
          perspectiveId,
          viewOptions: {},
          groups: project ? [{ key: project.id, title: project.task.name, kind: "project", rows: [{ kind: "project", id: project.id, depth: 0, project }] }] : [],
          emptyText: "No items",
        }
      : undefined;
  return useQuery({
    queryKey: keys.contents(perspectiveId, params),
    queryFn: () => api.get<PerspectiveContents>(`/perspectives/${encodeURIComponent(perspectiveId)}/contents`, { ...params }),
    placeholderData: placeholder ?? keepPreviousData,
    // Always revalidate when a view mounts so changes made through the API/MCP show up on navigation.
    staleTime: 0,
    enabled: enabled && !pending,
  });
}

export function useForecast(params: { from?: string; days?: number } = {}) {
  return useQuery({ queryKey: [...keys.forecast, params], queryFn: () => api.get<Forecast>("/forecast", params), placeholderData: keepPreviousData, staleTime: 0 });
}

/** Projects due for review (docs/spec.md §1.4), oldest next review first. */
export function useReviewQueue() {
  const changes = usePendingChanges();
  const settings = useSettingsValue();
  // Edits and removals only: projects created here join the queue when the server says they are due.
  const select = useCallback(
    (items: Project[]) => previewList("projects", items, changes.filter((c) => c.kind !== "item" || c.value === null), settings),
    [changes, settings],
  );
  return useQuery({ queryKey: keys.review, queryFn: async () => (await api.get<Items<Project>>("/review")).items, staleTime: 0, select });
}

/** The detail shown for an item created here until the server has it (it has no children, alarms or attachments yet). */
function draftDetail(id: string): TaskDetail | undefined {
  const project = shownList("projects")?.find((p) => p.id === id);
  if (project) {
    const { task, ...record } = project;
    return { ...task, children: [], alarms: [], attachments: [], project: record };
  }
  const task = cachedTask(id);
  return task && { ...task, children: [], alarms: [], attachments: [], project: null };
}

/** A task's detail; one created here and not yet saved is shown from its preview until the server has it. */
export function useTaskDetail(id: string | null) {
  const changes = usePendingChanges();
  const settings = useSettingsValue();
  const pending = useUnconfirmed(id);
  const select = useCallback((d: TaskDetail) => previewDetail(d, changes, settings), [changes, settings]);
  return useQuery({
    queryKey: keys.task(id ?? ""),
    queryFn: () => api.get<TaskDetail>(`/tasks/${encodeURIComponent(id ?? "")}`),
    enabled: !!id && !pending,
    placeholderData: pending && id ? draftDetail(id) : undefined,
    select,
  });
}

/** Details of several tasks (a multi-selection), each loaded like `useTaskDetail`; undefined while loading. */
export function useTaskDetails(ids: readonly string[]): Array<TaskDetail | undefined> {
  const changes = usePendingChanges();
  const settings = useSettingsValue();
  const unconfirmed = useStore(writes, (s) => s.unconfirmed);
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: keys.task(id),
      queryFn: () => api.get<TaskDetail>(`/tasks/${encodeURIComponent(id)}`),
      enabled: !unconfirmed.has(id),
      placeholderData: unconfirmed.has(id) ? draftDetail(id) : undefined,
    })),
  });
  return results.map((r) => r.data && previewDetail(r.data, changes, settings));
}

export function useSearch(q: string, availability: string) {
  const changes = usePendingChanges();
  const settings = useSettingsValue();
  const select = useCallback((r: SearchResults) => previewSearch(r, changes, settings), [changes, settings]);
  return useQuery({
    queryKey: keys.search(q, availability),
    queryFn: () => api.get<SearchResults>("/search", { q, availability }),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
    select,
  });
}

export function useQuickOpen(q: string) {
  return useQuery({
    queryKey: keys.quickOpen(q),
    queryFn: async () => (await api.get<Items<QuickOpenResult>>("/quick-open", { q })).items,
    placeholderData: keepPreviousData,
    enabled: q.trim().length > 0,
  });
}

export function useLastImport() {
  return useQuery({ queryKey: keys.lastImport, queryFn: async () => (await api.get<{ run: ImportRun | null }>("/import/last")).run });
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/** Normalises a write response (entity, `{changed}`, or nothing) into the tasks it reports. */
export function tasksFrom(response: unknown): Task[] {
  if (!response || typeof response !== "object") return [];
  const r = response as { changed?: Task[]; task?: Task; id?: string; status?: string; name?: string };
  if (Array.isArray(r.changed)) return r.changed;
  if (r.task && typeof r.task === "object") return [r.task];
  if (typeof r.id === "string" && typeof r.name === "string" && "remaining" in r) return [r as unknown as Task];
  return [];
}

/** `queued` is the write's place in queue order (compare with `writesQueued()`). */
type TaskListener = (tasks: Task[], queued: number) => void;
const taskListeners = new Set<TaskListener>();
let queuedCount = 0;

/** How many writes have been queued so far: a write reported with a lower number was queued before now. */
export function writesQueued(): number {
  return queuedCount;
}

/** Subscribe to tasks returned by writes (the outline uses this to keep completed rows visible). */
export function onTasksChanged(listener: TaskListener): () => void {
  taskListeners.add(listener);
  return () => taskListeners.delete(listener);
}

/**
 * Queues a write (src/web/lib/writes.ts) and reports the tasks it returns, so the outline keeps them visible until
 * Clean Up; `keepRows: false` lets rows leave as soon as the refresh says so.
 */
function queue<T>(request: (options: RequestOptions) => Promise<T>, spec: Omit<WriteSpec<T>, "send"> & { keepRows?: boolean } = {}): Promise<T> {
  const { keepRows = true, ...rest } = spec;
  const queued = queuedCount++;
  let undoSteps: number | null = null;
  let recordedStep: RecordedStep | null = null;
  return write({
    ...rest,
    send: (key) =>
      request({
        idempotencyKey: key,
        onHeaders: (headers) => {
          const steps = headers.get("X-Undo-Steps");
          const step = headers.get("X-Undo-Step");
          undoSteps = steps === null ? null : Number(steps);
          recordedStep = step === null ? null : { id: Number(step), previous: Number(headers.get("X-Undo-Previous") ?? 0) };
        },
      }),
    undoSteps: () => undoSteps,
    recordedStep: () => recordedStep,
    onSuccess: (result) => {
      rest.onSuccess?.(result);
      const tasks = keepRows ? tasksFrom(result) : [];
      if (tasks.length) for (const l of taskListeners) l(tasks, queued);
    },
  });
}

/** Fire-and-forget wrapper for UI handlers: failures are reported by the write queue. */
export async function attempt<P extends Promise<unknown>>(promise: P): Promise<Awaited<P> | undefined> {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

const enc = encodeURIComponent;

export interface TaskCreateInput {
  /** Client-generated id (src/web/lib/drafts.ts `newId`). */
  id: string;
  name: string;
  note?: string;
  parentId?: string;
  projectId?: string;
  inbox?: boolean;
  position?: Position;
  flagged?: boolean;
  deferDate?: string | null;
  plannedDate?: string | null;
  dueDate?: string | null;
  estimatedMinutes?: number | null;
  tagIds?: string[];
  repeat?: RepeatRule | null;
  sequential?: boolean;
  completedByChildren?: boolean;
}

export interface ProjectPatchInput extends Omit<TaskPatch, "sequential" | "assignedProjectId"> {
  type?: Project["type"];
  status?: Project["status"];
  folderId?: string | null;
  reviewInterval?: Project["reviewInterval"];
  nextReview?: string | null;
}

export type MoveTarget = { parentId?: string; projectId?: string; inbox?: boolean; position: Position };

const nowIso = () => new Date().toISOString();

/** Caches a just-created item's detail from the create response (it has no children, alarms or attachments yet). */
function seedDetail(task: Task, project: TaskDetail["project"]): void {
  queryClient.setQueryData<TaskDetail>(keys.task(task.id), (old) => old ?? { ...task, children: [], alarms: [], attachments: [], project });
}

const taskChange = (ids: readonly string[], task?: TaskChanges, project?: ProjectChanges): Change => ({ kind: "task", ids, task, project });

/** Project record changes implied by a project PATCH body (dates resolved as the server will). */
function projectChangesFromPatch(patch: ProjectPatchInput, settings: Settings): { task: Partial<Task>; project: ProjectChanges } {
  const { type, status, folderId, reviewInterval, nextReview, ...taskPatch } = patch;
  const task = changesFromPatch(taskPatch, settings);
  const project: ProjectChanges = {};
  if (type !== undefined) project.type = type;
  if (folderId !== undefined) project.folderId = folderId;
  if (reviewInterval !== undefined) project.reviewInterval = reviewInterval;
  if (nextReview !== undefined) {
    const resolved = resolveDateInput(nextReview, "defer", settings);
    if (resolved !== undefined) project.nextReview = resolved;
  }
  if (status !== undefined) {
    project.status = status;
    project.effectiveStatus = status;
    // A project's completed/dropped timestamps live on its task (docs/spec.md §1.2).
    task.completed = status === "completed" ? nowIso() : null;
    task.dropped = status === "dropped" ? nowIso() : null;
  }
  return { task, project };
}

/** The finished-occurrence row shown above a repeating task completed or dropped here, until the server's clone arrives. */
export const occurrenceId = (id: string) => `${id}.~`;
/** Stand-in rows are not items yet: they cannot be selected or changed until the server's copy replaces them. */
export const isOccurrenceStandIn = (id: string) => id.endsWith(".~");

/** Status changes: finished tasks are marked, repeating ones get a finished occurrence above them instead. */
function statusChanges(ids: readonly string[], status: "active" | "completed" | "dropped", scope: "occurrence" | "series" = "series"): Change[] {
  const ts = nowIso();
  const fields: Partial<Task> = status === "active" ? { completed: null, dropped: null } : status === "completed" ? { completed: ts, dropped: null } : { dropped: ts, completed: null };
  const settings = shownSettings();
  const groups = reader.outline() ?? [];
  const changes: Change[] = [];
  const plain: string[] = [];
  for (const id of ids) {
    const task = reader.task(id);
    const repeats = !!task?.repeat && status !== "active" && (status === "completed" || scope === "occurrence");
    if (!task || !repeats) {
      plain.push(id);
      continue;
    }
    for (const g of groups) {
      const idx = g.rows.findIndex((r) => r.id === id);
      const row = g.rows[idx];
      if (!row || row.kind !== "task") continue;
      const clone = draftTask(occurrenceId(id), { ...task, ...fields, id: occurrenceId(id), repeat: null }, settings);
      changes.push({ kind: "row", id: clone.id, at: placeAt(g.rows, idx, g.key), rows: [{ kind: "task", id: clone.id, depth: row.depth, task: clone }], inGroup: g.key });
    }
  }
  if (plain.length) {
    const projects = plain.filter((id) => reader.task(id)?.isProject);
    changes.push(taskChange(plain, fields));
    if (projects.length) changes.push(taskChange(projects, undefined, { status, effectiveStatus: status }));
  }
  return changes;
}

/** The server's undo labels for status changes. */
const STATUS_LABEL = { active: "Mark Active", completed: "Complete", dropped: "Drop" } as const;

/** Field changes of tasks moved to a container; rows are placed by the caller's `rows` changes. */
function moveFields(ids: readonly string[], target: MoveTarget): Change[] {
  const projectId = target.projectId ?? (target.parentId ? (reader.task(target.parentId)?.projectId ?? null) : target.inbox ? null : undefined);
  if (projectId === undefined && !target.parentId && !target.inbox) return [];
  const project = projectId ? shownList("projects")?.find((p) => p.id === projectId) : undefined;
  const fields: Partial<Task> = {
    parentId: target.parentId ?? target.projectId ?? null,
    inInbox: !!target.inbox,
    projectId: projectId ?? null,
    projectName: project?.task.name ?? null,
  };
  if (!target.inbox) fields.assignedProjectId = null;
  // Descendants of moved tasks keep their parent.
  const roots = ids.filter((id) => {
    for (let p = reader.task(id)?.parentId; p; p = reader.task(p)?.parentId) if (ids.includes(p)) return false;
    return true;
  });
  return [taskChange(roots, fields)];
}

/** Every row and list entry for deleted items goes. */
function deleteChanges(sel: { taskIds?: string[]; projectIds?: string[]; folderIds?: string[]; tagIds?: string[] }): Change[] {
  return [
    ...[...(sel.taskIds ?? []), ...(sel.projectIds ?? []), ...(sel.folderIds ?? []), ...(sel.tagIds ?? [])].map((id): RowChange => ({ kind: "row", id, at: null })),
    ...(sel.projectIds ?? []).map((id): Change => ({ kind: "item", list: "projects", id, value: null })),
    ...(sel.folderIds ?? []).map((id): Change => ({ kind: "item", list: "folders", id, value: null })),
    ...(sel.tagIds ?? []).map((id): Change => ({ kind: "item", list: "tags", id, value: null })),
  ];
}

/** Where a created task shows when the caller does not place it: inbox end, or the start of its project. */
function defaultPlace(input: TaskCreateInput): RowPlace | null {
  if (input.parentId) return { parentId: input.parentId, after: null, last: input.position !== "start" };
  if (input.projectId) return { parentId: input.projectId, after: null, last: input.position !== "start", groupKey: input.projectId };
  if (input.inbox || !input.position || typeof input.position === "string") {
    // On the Inbox page the first item also brings the (until then absent) inbox group.
    return { parentId: null, after: null, last: input.position !== "start", groupKey: "inbox", ensureGroup: window.location.pathname === "/inbox" };
  }
  return null;
}

/** A container item moved to `parentId` at `position` among its siblings (folders/tags/projects share ranks). */
function containerMove<L extends "folders" | "tags">(list: L, id: string, parentId: string | null, position: Position): ItemChange {
  const items = (shownList(list) ?? []) as Array<Folder | Tag>;
  const siblings = items.filter((i) => i.parentId === parentId && i.id !== id);
  return { kind: "item", list, id, patch: { parentId, rank: rankAt(siblings, position) } } as ItemChange;
}

/** Every write the web client makes. Each shows its change at once and is sent in the background. */
export const actions = {
  createTask(input: TaskCreateInput, at: RowPlace | null = defaultPlace(input)) {
    const settings = shownSettings();
    const container = input.projectId ?? (input.parentId ? (reader.task(input.parentId)?.projectId ?? null) : null);
    const task = draftTask(
      input.id,
      {
        name: input.name,
        note: input.note ?? "",
        parentId: input.parentId ?? input.projectId ?? null,
        projectId: container,
        projectName: container ? (shownList("projects")?.find((p) => p.id === container)?.task.name ?? null) : null,
        inInbox: !input.parentId && !input.projectId && (input.inbox ?? true),
        flagged: input.flagged ?? false,
        tagIds: input.tagIds ?? [],
        estimatedMinutes: input.estimatedMinutes ?? null,
        repeat: input.repeat ?? null,
        sequential: input.sequential ?? false,
        completedByChildren: input.completedByChildren ?? false,
        ...changesFromPatch({ deferDate: input.deferDate, plannedDate: input.plannedDate, dueDate: input.dueDate }, settings),
      },
      settings,
    );
    const changes: Change[] = at ? [{ kind: "row", id: input.id, at, rows: [{ kind: "task", id: input.id, depth: 0, task }] }] : [];
    return queue((o) => api.post<Task>("/tasks", input, o), {
      changes,
      creates: [input.id],
      label: "Add Action",
      // The inspector keeps showing the new item while its full detail loads.
      onSuccess: (created) => seedDetail(created, null),
    });
  },
  patchTask: (id: string, patch: TaskPatch) =>
    queue((o) => api.patch<Task>(`/tasks/${enc(id)}`, patch, o), { changes: [taskChange([id], changesFromPatch(patch, shownSettings()))], label: "Edit Action" }),
  batchPatch: (ids: string[], patch: TaskPatch) =>
    queue((o) => api.post<{ changed: Task[] }>("/tasks/batch", { ids, patch }, o), { changes: [taskChange(ids, changesFromPatch(patch, shownSettings()))], label: "Edit Actions" }),
  // Multi-item actions: each is one server change group, so one undo reverts the whole action.
  completeMany: (ids: string[], completed: boolean) =>
    queue((o) => api.post<{ changed: Task[] }>("/tasks/complete", { ids, completed }, o), {
      changes: statusChanges(ids, completed ? "completed" : "active"),
      label: completed ? "Complete" : "Mark Incomplete",
    }),
  dropMany: (ids: string[], dropped: boolean, scope?: "occurrence" | "series") =>
    queue((o) => api.post<{ changed: Task[] }>("/tasks/drop", { ids, dropped, scope }, o), {
      changes: statusChanges(ids, dropped ? "dropped" : "active", scope),
      label: dropped ? "Drop" : "Mark Active",
    }),
  setStatus: (ids: string[], status: "active" | "completed" | "dropped", scope?: "occurrence" | "series") =>
    queue((o) => api.post<{ changed: Task[] }>("/tasks/status", { ids, status, scope }, o), { changes: statusChanges(ids, status, scope), label: STATUS_LABEL[status] }),
  complete: (id: string, completed: boolean) =>
    queue((o) => api.post<{ changed: Task[] }>(`/tasks/${enc(id)}/complete`, { completed }, o), {
      changes: statusChanges([id], completed ? "completed" : "active"),
      label: completed ? "Complete" : "Mark Incomplete",
    }),
  drop: (id: string, dropped: boolean, scope?: "occurrence" | "series") =>
    queue((o) => api.post<{ changed: Task[] }>(`/tasks/${enc(id)}/drop`, { dropped, scope }, o), {
      changes: statusChanges([id], dropped ? "dropped" : "active", scope),
      label: dropped ? "Drop" : "Mark Active",
    }),
  batchPatchProjects: (ids: string[], patch: ProjectPatchInput) => {
    const { task, project } = projectChangesFromPatch(patch, shownSettings());
    return queue((o) => api.post<{ items: Project[] }>("/projects/batch", { ids, patch }, o), {
      changes: [taskChange(ids, task, project)],
      label: ids.length === 1 ? "Edit Project" : "Edit Projects",
    });
  },
  /** `rows` places the moved rows in the shown outline (src/web/lib/outlineOps.ts `moveChanges`). */
  moveMany: (ids: string[], target: MoveTarget, rows: readonly Change[] = []) =>
    queue((o) => api.post<{ changed: Task[] }>("/tasks/move", { ids, ...target }, o), { changes: [...moveFields(ids, target), ...rows], label: "Move" }),
  moveTask: (id: string, target: MoveTarget, rows: readonly Change[] = []) =>
    queue((o) => api.post<{ changed: Task[] }>(`/tasks/${enc(id)}/move`, target, o), { changes: [...moveFields([id], target), ...rows], label: "Move" }),
  deleteMany: (sel: { taskIds?: string[]; projectIds?: string[]; folderIds?: string[]; tagIds?: string[] }) => {
    const total = Object.values(sel).reduce((n, ids) => n + (ids?.length ?? 0), 0);
    return queue((o) => api.post<void>("/delete", sel, o), { changes: deleteChanges(sel), label: total === 1 ? "Delete" : "Delete Items" });
  },
  tagsMany: (ids: string[], change: { add?: string[]; remove?: string[] }) =>
    queue((o) => api.post<{ changed: Task[] }>("/tasks/tags", { ids, ...change }, o), {
      changes: [taskChange(ids, (t) => ({ tagIds: [...t.tagIds.filter((x) => !change.remove?.includes(x)), ...(change.add ?? []).filter((x) => !t.tagIds.includes(x))] }))],
      label: "Edit Tags",
    }),
  deleteTask: (id: string) => queue((o) => api.del(`/tasks/${enc(id)}`, o), { changes: deleteChanges({ taskIds: [id] }), label: "Delete Action" }),
  /**
   * Discards a just-created, still-untitled item: the server reverts its creation if that is still the newest change
   * (no journal entry remains, so this tab forgets its undo step too), otherwise deletes it normally.
   */
  discardTask: (id: string) => {
    const erased = forgetCreation(id);
    return queue((o) => api.post<unknown>(`/tasks/${enc(id)}/discard`, {}, o), {
      changes: deleteChanges({ taskIds: [id] }),
      keepRows: false,
      ...(erased ? { erases: true } : { label: "Delete Action" }),
    });
  },
  addTag: (id: string, tagId: string) =>
    queue((o) => api.post<Task>(`/tasks/${enc(id)}/tags`, { tagId }, o), {
      changes: [taskChange([id], (t) => ({ tagIds: t.tagIds.includes(tagId) ? t.tagIds : [...t.tagIds, tagId] }))],
      label: "Add Tag",
    }),
  removeTag: (id: string, tagId: string) =>
    queue((o) => api.del<Task>(`/tasks/${enc(id)}/tags/${enc(tagId)}`, o), {
      changes: [taskChange([id], (t) => ({ tagIds: t.tagIds.filter((x) => x !== tagId) }))],
      label: "Remove Tag",
    }),
  /** `rows` is the restructuring preview (src/web/lib/outlineOps.ts); `groupId` names the new group for "group". */
  outline: (op: "indent" | "outdent" | "group" | "ungroup" | "moveUp" | "moveDown", ids: string[], rows: readonly Change[], groupId?: string) =>
    queue((o) => api.post<{ changed: Task[] }>("/tasks/outline", { op, ids, ...(groupId ? { groupId } : {}) }, o), {
      changes: rows,
      creates: groupId ? [groupId] : [],
      label: { indent: "Indent", outdent: "Outdent", group: "Group", ungroup: "Ungroup", moveUp: "Move Up", moveDown: "Move Down" }[op],
    }),
  /** `rows` removes the rows Clean Up files away from the shown outline. */
  cleanup: (rows: readonly Change[]) => queue((o) => api.post<{ changed: Task[] }>("/cleanup", {}, o), { changes: rows, label: "Clean Up" }),
  /**
   * `changes` shows this tab's snapshot of the state being returned to (none when the server must decide); it is
   * dropped if the server's answer shows it undid (or redid) a different step than `step`, the one the snapshot is for.
   */
  undo: (changes: readonly Change[] = [], skip?: () => boolean, step?: number | null) =>
    queue((o) => api.post<History>("/undo", {}, o), { changes, skip, landed: (h) => (!h || step == null || h.redoId === step ? changes : []) }),
  redo: (changes: readonly Change[] = [], skip?: () => boolean, step?: number | null) =>
    queue((o) => api.post<History>("/redo", {}, o), { changes, skip, landed: (h) => (!h || step == null || h.undoId === step ? changes : []) }),

  createProject(input: Omit<TaskCreateInput, "parentId" | "projectId" | "inbox" | "sequential"> & { type: Project["type"]; folderId?: string | null; position?: Position }) {
    const settings = shownSettings();
    const folderId = input.folderId ?? null;
    const { dueDate = null, deferDate = null } = changesFromPatch({ dueDate: input.dueDate, deferDate: input.deferDate }, settings);
    const project = draftProject(
      input.id,
      { name: input.name, note: input.note ?? "", flagged: input.flagged ?? false, tagIds: input.tagIds ?? [], type: input.type, folderId, dueDate, deferDate },
      settings,
    );
    return queue((o) => api.post<Project>("/projects", input, o), {
      changes: [{ kind: "item", list: "projects", id: input.id, value: project }],
      creates: [input.id],
      label: "New Project",
      onSuccess: ({ task, ...record }) => seedDetail(task, record),
    });
  },
  patchProject: (id: string, patch: ProjectPatchInput) => {
    const { task, project } = projectChangesFromPatch(patch, shownSettings());
    return queue((o) => api.patch<Project>(`/projects/${enc(id)}`, patch, o), { changes: [taskChange([id], task, project)], label: "Edit Project" });
  },
  deleteProject: (id: string) => queue((o) => api.del(`/projects/${enc(id)}`, o), { changes: deleteChanges({ projectIds: [id] }), label: "Delete Project" }),
  // The Review perspective keeps reviewed projects listed itself, until Clean Up (docs/spec.md §3).
  markReviewed: (id: string) => {
    const project = reader.item("projects", id);
    const settings = shownSettings();
    const now = Date.now();
    const changes: Change[] = [];
    if (project) {
      const day = Math.floor(instantToNaive(now, settings.timeZone) / 86_400_000) * 86_400_000;
      const nextReview = formatFloating(addToNaive(day, project.reviewInterval.steps, project.reviewInterval.unit));
      changes.push({ kind: "task", ids: [id], project: { lastReview: new Date(now).toISOString(), nextReview } });
    }
    return queue((o) => api.post<Project>(`/projects/${enc(id)}/review`, {}, o), { changes, keepRows: false, label: "Mark Reviewed" });
  },
  moveProject: (id: string, parentId: string | null, position: Position) => {
    const projects = shownList("projects") ?? [];
    const current = projects.find((p) => p.id === id);
    const siblings = [
      ...(shownList("folders") ?? []).filter((f) => f.parentId === parentId).map((f) => ({ id: f.id, rank: f.rank })),
      ...projects.filter((p) => p.folderId === parentId && p.id !== id).map((p) => ({ id: p.id, rank: p.task.rank })),
    ];
    const changes: Change[] = current ? [{ kind: "item", list: "projects", id, patch: { folderId: parentId, task: { ...current.task, rank: rankAt(siblings, position) } } }] : [];
    return queue((o) => api.post<Project>(`/projects/${enc(id)}/move`, { parentId, position }, o), { changes, label: "Move Project" });
  },

  createFolder: (input: { id: string; name: string; parentId?: string | null; position?: Position }) => {
    const parentId = input.parentId ?? null;
    const siblings = [
      ...(shownList("folders") ?? []).filter((f) => f.parentId === parentId),
      ...(shownList("projects") ?? []).filter((p) => p.folderId === parentId).map((p) => ({ id: p.id, rank: p.task.rank })),
    ];
    const folder = draftFolder(input.id, { name: input.name, parentId, rank: rankAt(siblings, input.position ?? "end") });
    return queue((o) => api.post<Folder>("/folders", input, o), { changes: [{ kind: "item", list: "folders", id: input.id, value: folder }], creates: [input.id], label: "New Folder" });
  },
  patchFolder: (id: string, patch: Partial<Pick<Folder, "name" | "note" | "status">>) =>
    queue((o) => api.patch<Folder>(`/folders/${enc(id)}`, patch, o), { changes: [{ kind: "item", list: "folders", id, patch }], label: "Edit Folder" }),
  deleteFolder: (id: string) => queue((o) => api.del(`/folders/${enc(id)}`, o), { changes: deleteChanges({ folderIds: [id] }), label: "Delete Folder" }),
  moveFolder: (id: string, parentId: string | null, position: Position) =>
    queue((o) => api.post<Folder>(`/folders/${enc(id)}/move`, { parentId, position }, o), { changes: [containerMove("folders", id, parentId, position)], label: "Move Folder" }),

  createTag: (input: { id: string; name: string; parentId?: string | null; position?: Position }) => {
    const parentId = input.parentId ?? null;
    const siblings = (shownList("tags") ?? []).filter((t) => t.parentId === parentId);
    const tag = draftTag(input.id, { name: input.name, parentId, rank: rankAt(siblings, input.position ?? "end") });
    return queue((o) => api.post<Tag>("/tags", input, o), { changes: [{ kind: "item", list: "tags", id: input.id, value: tag }], creates: [input.id], label: "New Tag" });
  },
  patchTag: (id: string, patch: Partial<Pick<Tag, "name" | "note" | "status" | "childrenMutuallyExclusive">>) =>
    queue((o) => api.patch<Tag>(`/tags/${enc(id)}`, patch, o), {
      changes: [{ kind: "item", list: "tags", id, patch: patch.status ? { ...patch, effectiveStatus: patch.status } : patch }],
      label: "Edit Tag",
    }),
  deleteTag: (id: string) => queue((o) => api.del(`/tags/${enc(id)}`, o), { changes: deleteChanges({ tagIds: [id] }), label: "Delete Tag" }),
  moveTag: (id: string, parentId: string | null, position: Position) =>
    queue((o) => api.post<Tag>(`/tags/${enc(id)}/move`, { parentId, position }, o), { changes: [containerMove("tags", id, parentId, position)], label: "Move Tag" }),

  createPerspective: (input: { id: string; name: string } & Partial<Omit<Perspective, "id" | "builtin" | "rank" | "viewOptions">>) => {
    const ranks = (shownList("perspectives") ?? []).map((p) => p.rank);
    const perspective = draftPerspective(input.id, { ...input, rank: ranks.length ? Math.max(...ranks) + 1 : 0 });
    return queue((o) => api.post<Perspective>("/perspectives", input, o), {
      changes: [{ kind: "item", list: "perspectives", id: input.id, value: perspective }],
      creates: [input.id],
      label: "New Perspective",
    });
  },
  patchPerspective: (id: string, patch: Partial<Omit<Perspective, "id" | "builtin" | "viewOptions" | "presentation">> & { presentation?: Partial<Perspective["presentation"]> }) => {
    const current = reader.item("perspectives", id);
    const preview: Partial<Perspective> = { ...patch, presentation: current ? { ...current.presentation, ...patch.presentation } : undefined };
    if (!patch.presentation) delete preview.presentation;
    return queue((o) => api.patch<Perspective>(`/perspectives/${enc(id)}`, patch, o), {
      changes: [{ kind: "item", list: "perspectives", id, patch: preview }],
      label: "Edit Perspective",
    });
  },
  deletePerspective: (id: string) =>
    queue((o) => api.del(`/perspectives/${enc(id)}`, o), { changes: [{ kind: "item", list: "perspectives", id, value: null }], label: "Delete Perspective" }),
  // View options are UI state: not journaled, so not undoable.
  setViewOptions: (id: string, viewOptions: ViewOptions) =>
    queue((o) => api.put<Perspective>(`/perspectives/${enc(id)}/view-options`, viewOptions, o), { changes: [{ kind: "item", list: "perspectives", id, patch: { viewOptions } }] }),

  patchSettings: (patch: Partial<Settings>) =>
    queue((o) => api.patch<Settings>("/settings", patch, o), { changes: [{ kind: "settings", changes: patch }], label: "Change Settings" }),
  /** Restores every setting but the time zone, which defaults to the server's and shows on refresh. */
  resetSettings: () =>
    queue((o) => api.post<Settings>("/settings/reset", {}, o), { changes: [{ kind: "settings", changes: DEFAULT_SETTINGS }], label: "Restore Default Settings" }),

  /** Uploads beside the queue (after the task's own creation lands); the file shows as uploading meanwhile. */
  uploadAttachment: (taskId: string, file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    const id = `upload:${crypto.randomUUID()}`;
    const pending = { id, taskId, name: file.name, contentType: file.type || "application/octet-stream", size: file.size, sha256: "", added: nowIso(), uploading: true };
    // An absolute count, so it still holds once the refreshed task includes the upload.
    const shown = reader.task(taskId)?.attachmentCount;
    const count = taskChange(shown === undefined ? [] : [taskId], { attachmentCount: (shown ?? 0) + 1 });
    return queue((o) => api.upload<Attachment>(`/tasks/${enc(taskId)}/attachments`, form, o), {
      changes: [{ kind: "attachment", taskId, id, value: pending }, count],
      // Under its real id, so the refreshed detail does not list it twice.
      landed: (attachment) => [{ kind: "attachment", taskId, id: attachment.id, value: attachment }, count],
      lane: "upload",
      waitFor: [taskId],
      label: "Add Attachment",
    });
  },
  deleteAttachment: (taskId: string, id: string) => {
    const shown = reader.task(taskId)?.attachmentCount;
    return queue((o) => api.del(`/attachments/${enc(id)}`, o), {
      changes: [
        { kind: "attachment", taskId, id, value: null },
        taskChange(shown === undefined ? [] : [taskId], { attachmentCount: Math.max(0, (shown ?? 1) - 1) }),
      ],
      label: "Delete Attachment",
    });
  },
};

export const attachmentDownloadUrl = (id: string) => `/api/v1/attachments/${enc(id)}/download`;
