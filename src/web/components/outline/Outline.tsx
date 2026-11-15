import { ApiError, api } from "../../api/client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OutlineGroup, OutlineRow, Task } from "../../../shared/schemas";
import { actions, isOccurrenceStandIn, occurrenceId, onTasksChanged, useFolders, useProjects, useSettingsValue, useTags, writesQueued, type TaskCreateInput } from "../../api/queries";
import { resetSticky, stickyEpoch, undo } from "../../lib/commands";
import type { DragSource, DropTarget } from "../../lib/dnd";
import { dndStore } from "../../lib/dnd";
import { draftTask, newId } from "../../lib/drafts";
import { byId, folderPath } from "../../lib/entities";
import { hasCommandKey, isTypingTarget } from "../../lib/keys";
import { previewGroups, type RowChange, type RowPlace } from "../../lib/optimistic";
import { findRow as locateRow, leavingRows, mergeContents, placementOf, visibleRows, withCachedContainers, type DisplayRow, type StickyRow } from "../../lib/outlineModel";
import { moveChanges, outlineOpChanges, type OutlineOp } from "../../lib/outlineOps";
import { useStore } from "../../lib/store";
import { folderKey, isMobile, overlayOpen, parseSelectionKey, registerOutline, select, showInspector, tagKey, ui } from "../../lib/ui";
import { usePendingChanges } from "../../lib/writes";
import { Icon } from "../Icons";
import { MenuItem, Popover } from "../Overlay";
import { toast } from "../Toasts";
import { Row, type RowCallbacks } from "./Row";

/** Where "New item" goes when nothing is selected. */
export type NewItemTarget = { inbox: true; tagIds?: string[]; flagged?: boolean } | { projectId: string; tagIds?: string[]; flagged?: boolean };

function rowKey(row: OutlineRow): string {
  if (row.kind === "folder") return folderKey(row.id);
  if (row.kind === "tag") return tagKey(row.id);
  return row.id;
}

function rowTask(row: OutlineRow): Task | undefined {
  return row.kind === "task" ? row.task : row.kind === "project" ? row.project?.task : undefined;
}

function rowTitle(row: OutlineRow): string {
  return rowTask(row)?.name ?? row.folder?.name ?? row.tag?.name ?? "";
}

interface KeptState {
  scope: string;
  /** `writesQueued()` when the scope began: rows from writes queued earlier (before a Clean Up) are not kept. */
  since: number;
  journal: number;
  sticky: StickyRow[];
  deleted: Set<string>;
}

export function Outline({
  groups,
  scopeKey,
  newItemTarget,
  showProject,
  emptyText,
  groupHeaderExtra,
  label,
}: {
  groups: OutlineGroup[];
  scopeKey: string;
  newItemTarget: NewItemTarget | null;
  showProject: boolean;
  emptyText: string;
  groupHeaderExtra?: (group: OutlineGroup) => ReactNode;
  label: string;
}) {
  const settings = useSettingsValue();
  const { data: tagList } = useTags();
  const tags = useMemo(() => byId(tagList), [tagList]);
  const { data: folderList } = useFolders();
  const folders = useMemo(() => byId(folderList), [folderList]);
  const { data: projects } = useProjects();
  const projectIds = useMemo(() => new Set((projects ?? []).map((p) => p.id)), [projects]);
  const changes = usePendingChanges();
  const selection = useStore(ui, (s) => s.selection);
  const editingId = useStore(ui, (s) => s.editingId);
  const collapsed = useStore(ui, (s) => s.collapsed);
  const reordering = useStore(ui, (s) => s.reordering);
  const epoch = useStore(stickyEpoch, (s) => s.epoch);
  const journal = useStore(stickyEpoch, (s) => s.journal);
  const dndKey = useStore(dndStore, (s) => s.targetKey);
  const dndPos = useStore(dndStore, (s) => s.targetPos);
  const containerRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; row: OutlineRow } | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);

  // Rows kept visible until Clean Up / navigation (docs/spec.md §3: completed rows persist).
  const scope = `${scopeKey}#${epoch}`;
  const fresh = (): KeptState => ({ scope, since: writesQueued(), journal, sticky: [], deleted: new Set() });
  const [kept, setKept] = useState<KeptState>(fresh);
  let state = kept;
  if (kept.scope !== scope) state = fresh();
  // After undo/redo, locally hidden deletions may have been restored on the server.
  else if (kept.journal !== journal) state = { ...kept, journal, deleted: new Set() };
  if (state !== kept) setKept(state);

  // Kept rows the server no longer returns are re-read so they show current data (e.g. after undo/redo);
  // rows that no longer exist (undone creation) are dropped.
  const rereadFor = useRef<OutlineGroup[] | null>(null);
  useEffect(() => {
    if (rereadFor.current === groups) return;
    const present = new Set(groups.flatMap((g) => g.rows.map((r) => r.id)));
    const missing = kept.sticky.filter((s) => s.row.kind === "task" && !present.has(s.row.id) && !kept.deleted.has(s.row.id));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map((s) =>
        api.get<Task>(`/tasks/${encodeURIComponent(s.row.id)}`).then(
          (task) => ({ id: s.row.id, task }),
          (error: unknown) => ({ id: s.row.id, task: error instanceof ApiError && error.status === 404 ? null : undefined }),
        ),
      ),
    ).then((results) => {
      if (cancelled) return;
      rereadFor.current = groups;
      setKept((prev) => {
        let changed = false;
        const sticky = prev.sticky.flatMap((s) => {
          const r = results.find((x) => x.id === s.row.id);
          if (!r || r.task === undefined) return [s];
          changed = true;
          return r.task === null ? [] : [{ ...s, row: withTask(s.row, r.task) }];
        });
        return changed && prev.scope === kept.scope ? { ...prev, sticky } : prev;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [groups, kept.sticky, kept.deleted, kept.scope]);

  const merged = useMemo(() => {
    const previewed = previewGroups(mergeContents(groups, state.sticky, state.deleted), changes, settings);
    // Locally hidden rows stay hidden even where a pending change would place them.
    const shown = state.deleted.size ? previewed.map((g) => ({ ...g, rows: g.rows.filter((r) => !state.deleted.has(r.id)) })) : previewed;
    return withCachedContainers(shown, folders, tags);
  }, [groups, state.sticky, state.deleted, changes, settings, folders, tags]);
  const display = useMemo(() => visibleRows(merged, collapsed), [merged, collapsed]);
  const flat = useMemo(() => display.flatMap((g) => g.rows), [display]);
  // Rows placed by pending writes (new, moved or restored ones) are not leaving just because the server lacks them yet.
  const placed = useMemo(() => new Set(changes.flatMap((c) => (c.kind === "row" && c.at ? [c.id] : []))), [changes]);
  const leaving = useMemo(() => leavingRows(merged, groups, state.sticky, projectIds, placed), [merged, groups, state.sticky, projectIds, placed]);
  const disclosureColumn = flat.some((r) => r.hasChildren);
  const mergedRef = useRef(merged);
  const flatRef = useRef(flat);
  const groupsRef = useRef(groups);
  const leavingRef = useRef(leaving);
  useEffect(() => {
    mergedRef.current = merged;
    flatRef.current = flat;
    groupsRef.current = groups;
    leavingRef.current = leaving;
  });

  // Keep rows touched by mutations in place, with their fresh data.
  useEffect(
    () =>
      onTasksChanged((tasks, queued) => {
        setKept((prev) => {
          if (prev.scope !== scope || queued < prev.since) return prev;
          const sticky = [...prev.sticky];
          let deleted = prev.deleted;
          let changed = false;
          for (const t of tasks) {
            const existing = sticky.findIndex((s) => s.row.id === t.id);
            if (existing >= 0) {
              const s = sticky[existing];
              if (s) sticky[existing] = { ...s, row: withTask(s.row, t) };
              changed = true;
              continue;
            }
            for (const g of mergedRef.current) {
              // A repeating task finished here shows its occurrence under a stand-in id until the server's clone arrives.
              const base = /^(.+)\.\d+$/.exec(t.id)?.[1];
              const r = g.rows.find((x) => x.id === t.id) ?? (base ? g.rows.find((x) => x.id === occurrenceId(base)) : undefined);
              if (!r) continue;
              sticky.push({ row: withTask({ ...r, id: t.id }, t), groupKey: g.key, placement: placementOf(g.rows, r.id), since: groupsRef.current });
              if (r.id !== t.id) deleted = new Set([...deleted, r.id]);
              changed = true;
              break;
            }
          }
          return changed ? { ...prev, sticky, deleted } : prev;
        });
      }),
    [scope],
  );

  const hideRows = useCallback(
    (ids: string[]) => {
      setKept((prev) => (prev.scope !== scope ? prev : { ...prev, deleted: new Set([...prev.deleted, ...ids]) }));
    },
    [scope],
  );

  const unhideRows = useCallback(
    (ids: string[]) => {
      setKept((prev) => (prev.scope !== scope ? prev : { ...prev, deleted: new Set([...prev.deleted].filter((id) => !ids.includes(id))) }));
    },
    [scope],
  );

  const findRow = useCallback((id: string): DisplayRow | undefined => flatRef.current.find((r) => r.row.id === id), []);

  const selectedTaskIds = useCallback(
    () =>
      ui
        .get()
        .selection.map(parseSelectionKey)
        .filter((k) => k.kind === "task")
        .map((k) => k.id),
    [],
  );

  // ---------------------------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------------------------

  /** Rows this outline created that have not been titled yet (discarded if left empty). */
  const untitledNew = useRef(new Set<string>());
  const createItem = useCallback(
    (relativeTo: DisplayRow | null, where: "after" | "before" | "child" | "outdented") => {
      let input: Omit<TaskCreateInput, "id">;
      let at: RowPlace;
      if (!relativeTo) {
        if (!newItemTarget) {
          ui.set({ quickEntry: true });
          return;
        }
        const { tagIds, flagged } = newItemTarget;
        input = { name: "", tagIds, flagged, ...("projectId" in newItemTarget ? { projectId: newItemTarget.projectId } : { inbox: true }), position: "end" };
        const projectGroup = "projectId" in newItemTarget ? mergedRef.current.find((g) => g.key === newItemTarget.projectId) : undefined;
        // At the end of the project's group when shown, else of the first group (a new one in an empty outline).
        at = projectGroup
          ? { parentId: projectGroup.key, after: null, last: true, groupKey: projectGroup.key }
          : { parentId: null, after: null, last: true, groupKey: mergedRef.current[0]?.key ?? ("inbox" in newItemTarget ? "inbox" : newItemTarget.projectId), ensureGroup: true };
      } else {
        const r = relativeTo.row;
        const groupKey = relativeTo.groupKey;
        const task = rowTask(r);
        const extra = newItemTarget ? { tagIds: newItemTarget.tagIds, flagged: newItemTarget.flagged } : {};
        if (r.kind === "folder" || r.kind === "tag" || !task) {
          ui.set({ quickEntry: true });
          return;
        }
        if (r.kind === "project" || where === "child") {
          input = { name: "", ...extra, ...(r.kind === "project" ? { projectId: r.id } : { parentId: r.id }), position: "start" };
          at = { parentId: r.id, after: null, groupKey };
        } else {
          const parent = where === "outdented" && task.parentId ? findRow(task.parentId) : undefined;
          const anchor = parent && parent.row.kind !== "project" ? parent.row : r;
          const place = locateRow(mergedRef.current, anchor.id)?.at;
          input = { name: "", ...extra, position: where === "before" ? { before: r.id } : { after: anchor.id } };
          at = { parentId: place?.parentId ?? null, after: where === "before" ? (place?.after ?? null) : anchor.id, groupKey };
        }
      }
      const id = newId();
      void actions.createTask({ ...input, id }, at);
      untitledNew.current.add(id);
      // A child added under a collapsed row would be hidden: expand its parent so the editor is visible.
      const parentId = at.parentId;
      if (parentId) {
        ui.set((s) => {
          const next: Record<string, true> = {};
          for (const key of Object.keys(s.collapsed)) if (!key.endsWith(`/${parentId}`)) next[key] = true;
          return { collapsed: next };
        });
      }
      ui.set({ selection: [id], anchor: id, editingId: id });
    },
    [newItemTarget, findRow],
  );

  const lastSelectedRow = useCallback((): DisplayRow | null => {
    const sel = ui.get().selection;
    for (let i = flatRef.current.length - 1; i >= 0; i--) {
      const r = flatRef.current[i];
      if (r && sel.includes(rowKey(r.row))) return r;
    }
    return null;
  }, []);

  const firstSelectedRow = useCallback((): DisplayRow | null => {
    const sel = ui.get().selection;
    return flatRef.current.find((r) => sel.includes(rowKey(r.row))) ?? null;
  }, []);

  /** Restructures the selected tasks at once (the server applies the same operation in the background). */
  const outlineOp = useCallback(
    (op: OutlineOp): RowChange[] => {
      const ids = selectedTaskIds().filter((id) => findRow(id)?.row.kind === "task");
      if (ids.length === 0) return [];
      let group: OutlineRow | undefined;
      if (op === "group") {
        const first = flatRef.current.find((r) => ids.includes(r.row.id))?.row.task;
        const id = newId();
        const fields = first ? { parentId: first.parentId, projectId: first.projectId, projectName: first.projectName, inInbox: first.inInbox } : {};
        group = { kind: "task", id, depth: 0, task: draftTask(id, fields, settings) };
      }
      const rows = outlineOpChanges(op, ids, mergedRef.current, group);
      void actions.outline(op, ids, rows, group?.id);
      // The new group is unnamed: select it and start editing its title.
      if (group) ui.set({ selection: [group.id], anchor: group.id, editingId: group.id });
      return rows;
    },
    [selectedTaskIds, findRow, settings],
  );

  /** Expands `taskId`'s ancestors (in every group) so a row being edited is never hidden in a collapsed parent. */
  const expandAncestors = useCallback((taskId: string, moved: RowChange[] = []) => {
    const parentOf = (id: string): string | null =>
      moved.find((c) => c.id === id && c.at)?.at?.parentId ?? (flatRef.current.find((r) => r.row.id === id)?.row.task?.parentId ?? null);
    const ancestors = new Set<string>();
    for (let p = parentOf(taskId); p && !ancestors.has(p); p = parentOf(p)) ancestors.add(p);
    if (ancestors.size === 0) return;
    ui.set((s) => {
      const next: Record<string, true> = {};
      for (const key of Object.keys(s.collapsed)) if (!ancestors.has(key.slice(key.indexOf("/") + 1))) next[key] = true;
      return { collapsed: next };
    });
  }, []);

  const toggleComplete = useCallback((row: OutlineRow) => {
    const task = rowTask(row);
    if (!task) return;
    if (task.dropped) void actions.drop(task.id, false);
    else void actions.complete(task.id, task.completed === null);
  }, []);

  const toggleFlag = useCallback((row: OutlineRow) => {
    const task = rowTask(row);
    if (!task) return;
    if (row.kind === "project") void actions.patchProject(task.id, { flagged: !task.flagged });
    else void actions.patchTask(task.id, { flagged: !task.flagged });
  }, []);

  /** Completes (or, when all are done, reopens) the selected items in one request = one undo step. */
  const completeSelection = useCallback((keys: string[]) => {
    const tasks = keys.flatMap((k) => {
      const t = flatRef.current.find((r) => rowKey(r.row) === k);
      const task = t ? rowTask(t.row) : undefined;
      return task ? [task] : [];
    });
    if (tasks.length === 0) return;
    const open = tasks.filter((t) => !t.completed && !t.dropped);
    if (open.length > 0) void actions.completeMany(open.map((t) => t.id), true);
    else void actions.setStatus(tasks.map((t) => t.id), "active");
  }, []);

  /** Flags (or unflags, when all are flagged) the selection with one batch request per entity kind. */
  const flagSelection = useCallback((keys: string[]) => {
    const rows = keys.flatMap((k) => {
      const r = flatRef.current.find((x) => rowKey(x.row) === k);
      return r && rowTask(r.row) ? [r.row] : [];
    });
    if (rows.length === 0) return;
    const flagged = !rows.every((r) => rowTask(r)?.flagged);
    const projectIds = rows.filter((r) => r.kind === "project").map((r) => r.id);
    const taskIds = rows.filter((r) => r.kind === "task").map((r) => r.id);
    if (taskIds.length) void actions.batchPatch(taskIds, { flagged });
    if (projectIds.length) void actions.batchPatchProjects(projectIds, { flagged });
  }, []);

  /** Deletes the selection with one request (one undo step); descendants of selected items are skipped. */
  const deleteKeys = useCallback(
    (keys: string[]) => {
      if (keys.length === 0) return;
      const parsed = keys.map(parseSelectionKey);
      const sel = { taskIds: [] as string[], projectIds: [] as string[], folderIds: [] as string[], tagIds: [] as string[] };
      for (const p of parsed) {
        if (p.kind === "folder") sel.folderIds.push(p.id);
        else if (p.kind === "tag") sel.tagIds.push(p.id);
        else if (findRow(p.id)?.row.kind === "project") sel.projectIds.push(p.id);
        else sel.taskIds.push(p.id);
      }
      const ids = parsed.map((p) => p.id);
      // Kept rows stay hidden after the refresh too; a failed delete shows them again.
      actions.deleteMany(sel).catch(() => unhideRows(ids));
      hideRows(ids);
      ui.set({ selection: [], anchor: null, editingId: null });
      toast(keys.length === 1 ? "Deleted 1 item" : `Deleted ${keys.length} items`, { action: { label: "Undo", run: undo } });
    },
    [hideRows, unhideRows, findRow],
  );

  const commitEdit = useCallback(
    (row: OutlineRow, text: string, then?: "after" | "above" | "indent" | "outdent" | "stop") => {
      const empty = text.trim() === "";
      const isNew = untitledNew.current.has(row.id);
      // Tab / Shift-Tab on a fresh row restructures it and keeps editing; it stays "untitled new" while empty.
      if (then === "indent" || then === "outdent") {
        if (!empty) untitledNew.current.delete(row.id);
        if (text !== rowTitle(row)) void actions.patchTask(row.id, { name: text });
        select([row.id]);
        expandAncestors(row.id, outlineOp(then));
        ui.set({ selection: [row.id], anchor: row.id, editingId: row.id });
        return;
      }
      ui.set({ editingId: null });
      untitledNew.current.delete(row.id);
      // A freshly created row left untitled (Escape, blur, Enter, Shift-Enter) is discarded; the server reverts
      // its creation atomically when that is still the newest change, otherwise deletes it.
      if (isNew && row.kind === "task" && empty) {
        hideRows([row.id]);
        ui.set({ selection: [], anchor: null });
        // A discard thrown away with an earlier failed write leaves the row in place.
        actions.discardTask(row.id).catch(() => unhideRows([row.id]));
        return;
      }
      if (text !== rowTitle(row)) {
        if (row.kind === "folder") void actions.patchFolder(row.id, { name: text });
        else if (row.kind === "tag") void actions.patchTag(row.id, { name: text });
        else if (row.kind === "project") void actions.patchProject(row.id, { name: text });
        else void actions.patchTask(row.id, { name: text });
      }
      const current = findRow(row.id);
      if (then === "after" && current) createItem(current, "after");
      else if (then === "above" && current) createItem(current, "before");
      else containerRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(row.id)}"] [role=treeitem]`)?.focus();
    },
    [createItem, expandAncestors, findRow, hideRows, unhideRows, outlineOp],
  );

  const newItem = useCallback(() => {
    createItem(lastSelectedRow(), "after");
  }, [createItem, lastSelectedRow]);

  useEffect(() => {
    registerOutline({
      newItem,
      groups: () => mergedRef.current,
      leaving: () =>
        [...leavingRef.current].map((key) => {
          const slash = key.lastIndexOf("/");
          return { groupKey: key.slice(0, slash), id: key.slice(slash + 1) };
        }),
    });
    return () => registerOutline(null);
  }, [newItem]);

  // ---------------------------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------------------------

  const selectRow = useCallback((dr: DisplayRow, e?: React.MouseEvent | React.KeyboardEvent) => {
    const key = rowKey(dr.row);
    const s = ui.get();
    if (e && (e.metaKey || e.ctrlKey)) {
      const next = s.selection.includes(key) ? s.selection.filter((k) => k !== key) : [...s.selection, key];
      ui.set({ selection: next, anchor: key, editingId: null });
      return;
    }
    if (e && e.shiftKey && s.anchor) {
      const keys = flatRef.current.filter((r) => !isOccurrenceStandIn(r.row.id)).map((r) => rowKey(r.row));
      const a = keys.indexOf(s.anchor);
      const b = keys.indexOf(key);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        ui.set({ selection: keys.slice(lo, hi + 1), editingId: null });
        return;
      }
    }
    ui.set({ selection: [key], anchor: key, editingId: null });
    if (isMobile()) showInspector();
  }, []);

  const moveSelection = useCallback((delta: 1 | -1, extend: boolean) => {
    const rows = flatRef.current.filter((r) => !isOccurrenceStandIn(r.row.id));
    if (rows.length === 0) return;
    const keys = rows.map((r) => rowKey(r.row));
    const s = ui.get();
    const focusKey = extend ? (s.selection.length ? (delta > 0 ? s.selection[s.selection.length - 1] : s.selection[0]) : null) : null;
    let idx: number;
    if (extend && focusKey) idx = keys.indexOf(focusKey) + delta;
    else {
      const current = delta > 0 ? keys.findLastIndex((k) => s.selection.includes(k)) : keys.findIndex((k) => s.selection.includes(k));
      idx = current < 0 ? (delta > 0 ? 0 : keys.length - 1) : current + delta;
    }
    idx = Math.max(0, Math.min(keys.length - 1, idx));
    const key = keys[idx];
    if (!key) return;
    if (extend && s.anchor) {
      const a = keys.indexOf(s.anchor);
      const [lo, hi] = a < idx ? [a, idx] : [idx, a];
      ui.set({ selection: keys.slice(lo, hi + 1), editingId: null });
    } else ui.set({ selection: [key], anchor: key, editingId: null });
  }, []);

  const setCollapsed = useCallback((dr: DisplayRow, value: boolean) => {
    const k = `${dr.groupKey}/${dr.row.id}`;
    ui.set((s) => {
      const next = { ...s.collapsed };
      if (value) next[k] = true;
      else delete next[k];
      return { collapsed: next };
    });
  }, []);

  // ---------------------------------------------------------------------------------------------
  // Keyboard (docs/spec.md §2), inactive while typing or when a dialog is open
  // ---------------------------------------------------------------------------------------------

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || isTypingTarget(e.target) || overlayOpen()) return;
      const target = e.target as Node | null;
      if (target !== document.body && !(target && containerRef.current?.contains(target))) return;
      const s = ui.get();
      const key = e.key;
      const cmd = hasCommandKey(e);
      const first = firstSelectedRow();
      const last = lastSelectedRow();
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (cmd) {
        if (key === "Enter" && first) run(() => ui.set({ editingId: first.row.id }));
        return;
      }
      switch (key) {
        case "ArrowDown":
        case "ArrowUp":
          if (e.altKey && e.shiftKey) run(() => void outlineOp(key === "ArrowUp" ? "moveUp" : "moveDown"));
          else run(() => moveSelection(key === "ArrowDown" ? 1 : -1, e.shiftKey));
          return;
        case "ArrowLeft":
        case "ArrowRight":
          if (e.shiftKey) run(() => void outlineOp(key === "ArrowLeft" ? "outdent" : "indent"));
          else if (first) run(() => s.selection.forEach((k) => {
            const dr = flatRef.current.find((r) => rowKey(r.row) === k);
            if (dr?.hasChildren) setCollapsed(dr, key === "ArrowLeft");
          }));
          return;
        case "Enter":
          if (s.selection.length) run(() => void createItem(e.shiftKey ? first : last, e.shiftKey ? "before" : "after"));
          return;
        case "Tab":
        case "e":
        case "E":
          if (first && !e.altKey) run(() => ui.set({ editingId: first.row.id }));
          return;
        case "'":
          if (first)
            run(() => {
              showInspector();
              window.setTimeout(() => document.getElementById("pb-inspector-note")?.focus(), 60);
            });
          return;
        case "]":
          run(() => void outlineOp("indent"));
          return;
        case "[":
          run(() => void outlineOp("outdent"));
          return;
        case "}":
          if (last) run(() => void createItem(last, "child"));
          return;
        case "{":
          if (last) run(() => void createItem(last, "outdented"));
          return;
        case "g":
          run(() => void outlineOp("group"));
          return;
        case "u":
          run(() => void outlineOp("ungroup"));
          return;
        case " ":
          if (s.selection.length) run(() => void completeSelection(s.selection));
          return;
        case "f":
          if (s.selection.length) run(() => void flagSelection(s.selection));
          return;
        case "Backspace":
        case "Delete":
          if (s.selection.length) run(() => void deleteKeys(s.selection));
          return;
        case "Escape":
          if (s.selection.length) run(() => ui.set({ selection: [], anchor: null }));
          return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [completeSelection, createItem, deleteKeys, firstSelectedRow, flagSelection, lastSelectedRow, moveSelection, outlineOp, setCollapsed]);

  // ---------------------------------------------------------------------------------------------
  // Drag and drop
  // ---------------------------------------------------------------------------------------------

  /** Rows dropped on a sidebar project or the inbox leave the group of their old container and join the new one's. */
  const containerMoveRows = useCallback((ids: string[], projectId: string | null): RowChange[] => {
    const groupKey = projectId ?? "inbox";
    return ids.flatMap((id): RowChange[] => {
      const found = locateRow(mergedRef.current, id);
      const task = found?.row.task;
      // Descendants of a moved row travel with it.
      if (!found || !task || ids.some((other) => other !== id && locateRow(mergedRef.current, other)?.block.some((r) => r.id === id))) return [];
      const at: RowPlace = { parentId: projectId, after: null, last: true, groupKey };
      return [
        ...mergedRef.current
          .filter((g) => g.key === (task.inInbox ? "inbox" : (task.projectId ?? "no-project")) && g.key !== groupKey)
          .map((g): RowChange => ({ kind: "row", id, at: null, inGroup: g.key })),
        { kind: "row", id, at, rows: found.block },
      ];
    });
  }, []);

  /** Drops dragged tasks with one request (one undo step), whatever the selection size. */
  const dropTasks = useCallback(
    (ids: string[], target: Omit<DropTarget, "el">) => {
      const groups = mergedRef.current;
      const request = (): Promise<unknown> | null => {
        if (target.kind === "tag") return actions.tagsMany(ids, { add: [target.id] });
        if (target.kind === "inbox") return actions.moveMany(ids, { inbox: true, position: "end" }, containerMoveRows(ids, null));
        if (target.kind === "project") return actions.moveMany(ids, { projectId: target.id, position: "end" }, containerMoveRows(ids, target.id));
        if (target.kind !== "row") return null;
        const t = findRow(target.id)?.row;
        if (!t) return null;
        if (t.kind === "project") return actions.moveMany(ids, { projectId: t.id, position: "end" }, moveChanges(ids, { parentId: t.id, position: "end" }, groups));
        if (target.pos === "inside") return actions.moveMany(ids, { parentId: t.id, position: "end" }, moveChanges(ids, { parentId: t.id, position: "end" }, groups));
        const position = target.pos === "before" ? { before: t.id } : { after: t.id };
        return actions.moveMany(ids, { position }, moveChanges(ids, { position }, groups));
      };
      const pending = request();
      if (!pending) return;
      // Rows kept in place before the move are dropped once it lands (they may have moved away).
      pending.then(resetSticky, () => {});
      if (target.kind === "tag") toast(ids.length === 1 ? "Tag added" : `Tag added to ${ids.length} items`);
    },
    [findRow, containerMoveRows],
  );

  const dragSourceFor = useCallback(
    (dr: DisplayRow): DragSource | null => {
      if (dr.row.kind !== "task" || !dr.row.task) return null;
      const sel = ui.get().selection;
      const ids = sel.includes(dr.row.id) ? flatRef.current.filter((r) => r.row.kind === "task" && sel.includes(r.row.id)).map((r) => r.row.id) : [dr.row.id];
      return {
        type: "task",
        ids,
        label: dr.row.task.name || "Untitled",
        accept: (t) => {
          if (t.kind === "tag" || t.kind === "project" || t.kind === "inbox") return true;
          if (t.kind !== "row") return false;
          const target = findRow(t.id)?.row;
          if (!target || target.kind === "folder" || target.kind === "tag") return false;
          // A task cannot be dropped into its own subtree.
          let parentId = rowTask(target)?.parentId ?? null;
          while (parentId) {
            if (ids.includes(parentId)) return false;
            parentId = findRow(parentId)?.row.task?.parentId ?? null;
          }
          return true;
        },
        drop: (t) => void dropTasks(ids, t),
      };
    },
    [findRow, dropTasks],
  );

  // ---------------------------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------------------------

  const callbacksFor = (dr: DisplayRow): RowCallbacks => ({
    onSelect: (e) => selectRow(dr, e),
    onToggleComplete: () => void toggleComplete(dr.row),
    onToggleFlag: () => void toggleFlag(dr.row),
    onToggleCollapse: () => setCollapsed(dr, !collapsed[`${dr.groupKey}/${dr.row.id}`]),
    onStartEdit: () => ui.set({ selection: [rowKey(dr.row)], anchor: rowKey(dr.row), editingId: dr.row.id }),
    onCommitEdit: (text, then) => void commitEdit(dr.row, text, then),
    onRemoveTag: (tagId) => void actions.removeTag(dr.row.id, tagId),
    onMenu: (el) => setMenu({ anchor: el, row: dr.row }),
    onDelete: () => void deleteKeys([rowKey(dr.row)]),
    dragSource: () => dragSourceFor(dr),
  });

  const totalRows = flat.length;

  return (
    <div ref={containerRef} data-outline className="pb-2" onClick={(e) => {
      if (e.target === e.currentTarget) ui.set({ selection: [], anchor: null });
    }}>
      {totalRows === 0 && (
        <p className="px-6 py-16 text-center text-muted" data-testid="empty-state">
          {emptyText}
        </p>
      )}
      <div role="tree" aria-label={label} aria-multiselectable="true">
        {display.map(({ group, rows }) =>
          rows.length === 0 ? null : (
            <section key={group.key} role="group" aria-label={group.title || label} className="mb-3">
              {group.title && group.kind !== "project" && !(display.length === 1 && group.kind === "none") && (
                <div
                  className={`sticky top-0 z-[1] flex min-h-[40px] items-center gap-2 border-b border-line bg-bg/95 px-4 pt-2 text-sm font-semibold backdrop-blur ${
                    dndKey === `${group.kind}:${group.key}` ? "ring-2 ring-inset ring-accent" : ""
                  }`}
                  data-testid="group-header"
                  {...(group.kind === "tag" && group.key !== "untagged" ? { "data-drop-kind": "tag", "data-drop-id": group.key, "data-drop-modes": "inside" } : {})}
                >
                  {group.kind === "tag" && <Icon name="tag" size={15} className="text-muted" />}
                  {group.kind === "date" && <Icon name="calendar" size={15} className="text-muted" />}
                  <h3 className="flex-1">{(group.kind === "tag" && tags.get(group.key)?.name) || group.title}</h3>
                  {groupHeaderExtra?.(group)}
                </div>
              )}
              {rows.map((dr) => {
                const key = rowKey(dr.row);
                const isGroupHead = group.kind === "project" && dr.row.kind === "project";
                // The folder path comes from the cached folders (so renames and Folder changes show at once) once loaded.
                const folderPrefix = !isGroupHead
                  ? undefined
                  : folderList
                    ? folderPath(dr.row.project?.folderId ?? null, folders) || undefined
                    : group.title.includes(" : ")
                      ? group.title.slice(0, group.title.lastIndexOf(" : "))
                      : undefined;
                return (
                  // A finished occurrence's stand-in cannot be used until the server's copy replaces it.
                  <div key={`${group.key}/${dr.row.id}`} className={isGroupHead ? "sticky top-0 z-[1]" : undefined} inert={isOccurrenceStandIn(dr.row.id) || undefined}>
                    <Row
                      row={dr.row}
                      title={rowTitle(dr.row)}
                      subtitle={folderPrefix ? `${folderPrefix} :` : undefined}
                      depth={dr.row.depth}
                      selected={selection.includes(key)}
                      editing={editingId === dr.row.id && (selection.includes(key) || selection.length === 0)}
                      hasChildren={dr.hasChildren}
                      disclosureColumn={disclosureColumn}
                      reordering={reordering}
                      leaving={leaving.has(`${dr.groupKey}/${dr.row.id}`)}
                      collapsed={!!collapsed[`${dr.groupKey}/${dr.row.id}`]}
                      showProject={showProject}
                      settings={settings}
                      tags={tags}
                      dropState={dndKey === `row:${dr.row.id}` ? dndPos : null}
                      revealed={revealedId === `${group.key}/${dr.row.id}`}
                      onReveal={(open) => setRevealedId(open ? `${group.key}/${dr.row.id}` : null)}
                      cb={callbacksFor(dr)}
                    />
                  </div>
                );
              })}
            </section>
          ),
        )}
      </div>
      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} label="Row actions" align="right" width={220}>
          <div role="menu" className="py-1">
            {(menu.row.kind === "task" || menu.row.kind === "project") && (
              <MenuItem
                icon="plus"
                label="New Action"
                onSelect={() => {
                  const dr = findRow(menu.row.id);
                  setMenu(null);
                  if (dr) createItem(dr, menu.row.kind === "project" ? "child" : "after");
                }}
              />
            )}
            <MenuItem
              icon="trash"
              danger
              label={menu.row.kind === "project" ? "Delete Project" : menu.row.kind === "folder" ? "Delete Folder" : menu.row.kind === "tag" ? "Delete Tag" : "Delete"}
              onSelect={() => {
                const k = rowKey(menu.row);
                setMenu(null);
                void deleteKeys([k]);
              }}
            />
          </div>
        </Popover>
      )}
    </div>
  );
}

function withTask(row: OutlineRow, task: Task): OutlineRow {
  if (row.kind === "project" && row.project) return { ...row, project: { ...row.project, task } };
  return { ...row, task };
}
