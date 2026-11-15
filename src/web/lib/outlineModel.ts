// Pure outline display model: merges server contents with rows the client keeps visible until Clean Up
// (completed/dropped/edited rows that no longer match, and freshly created rows), then applies collapse state.
import type { Folder, OutlineGroup, OutlineRow, Tag } from "../../shared/schemas";
import type { RowChange, RowPlace } from "./optimistic";

export type Placement =
  | { type: "after"; id: string; skipSubtree: boolean }
  | { type: "before"; id: string }
  | { type: "start" }
  | { type: "end" };

export interface StickyRow {
  row: OutlineRow;
  groupKey: string;
  placement: Placement;
  /** Server contents current when the row was kept; until newer contents arrive its absence proves nothing. */
  since?: OutlineGroup[];
}

export interface DisplayRow {
  row: OutlineRow;
  groupKey: string;
  /** Has visible children in the display (disclosure triangle). */
  hasChildren: boolean;
}

export interface DisplayGroup {
  group: OutlineGroup;
  rows: DisplayRow[];
}

function insertAt(rows: OutlineRow[], sticky: StickyRow): void {
  const p = sticky.placement;
  if (p.type === "start") {
    rows.unshift(sticky.row);
    return;
  }
  if (p.type === "end") {
    rows.push(sticky.row);
    return;
  }
  const idx = rows.findIndex((r) => r.id === p.id);
  if (idx < 0) {
    rows.push(sticky.row);
    return;
  }
  if (p.type === "before") {
    rows.splice(idx, 0, sticky.row);
    return;
  }
  let at = idx + 1;
  if (p.skipSubtree) {
    const depth = rows[idx]?.depth ?? 0;
    while (at < rows.length && (rows[at]?.depth ?? 0) > depth) at++;
  }
  rows.splice(at, 0, sticky.row);
}

/** Server groups + kept rows (in insertion order) − deleted ids. */
export function mergeContents(groups: OutlineGroup[], sticky: StickyRow[], deleted: ReadonlySet<string>): OutlineGroup[] {
  const out = groups.map((g) => ({ ...g, rows: g.rows.filter((r) => !deleted.has(r.id)) }));
  for (const s of sticky) {
    if (deleted.has(s.row.id)) continue;
    const group = out.find((g) => g.key === s.groupKey) ?? out[0];
    if (!group) {
      out.push({ key: s.groupKey, title: "", kind: "none", rows: [s.row] });
      continue;
    }
    if (group.rows.some((r) => r.id === s.row.id)) continue;
    insertAt(group.rows, s);
  }
  return out;
}

/** Flattens groups into visible rows, hiding descendants of collapsed rows. */
export function visibleRows(groups: OutlineGroup[], collapsed: Readonly<Record<string, true>>): DisplayGroup[] {
  return groups.map((group) => {
    const rows: DisplayRow[] = [];
    let hideDeeperThan = Number.POSITIVE_INFINITY;
    group.rows.forEach((row, i) => {
      if (row.depth > hideDeeperThan) return;
      hideDeeperThan = Number.POSITIVE_INFINITY;
      const next = group.rows[i + 1];
      const hasChildren = !!next && next.depth > row.depth;
      rows.push({ row, groupKey: group.key, hasChildren });
      if (hasChildren && collapsed[`${group.key}/${row.id}`]) hideDeeperThan = row.depth;
    });
    return { group, rows };
  });
}

/** Placement that keeps `id` where it currently is in `rows` (used when a mutation makes it stop matching). */
export function placementOf(rows: OutlineRow[], id: string): Placement {
  const idx = rows.findIndex((r) => r.id === id);
  if (idx <= 0) return { type: "start" };
  const prev = rows[idx - 1];
  return prev ? { type: "after", id: prev.id, skipSubtree: false } : { type: "start" };
}

/** Folder and tag rows carrying the cached folder/tag records, which show edits before the server confirms them. */
export function withCachedContainers(groups: OutlineGroup[], folders: ReadonlyMap<string, Folder>, tags: ReadonlyMap<string, Tag>): OutlineGroup[] {
  const cached = (row: OutlineRow): OutlineRow => {
    const folder = row.kind === "folder" ? folders.get(row.id) : undefined;
    if (folder) return { ...row, folder };
    const tag = row.kind === "tag" ? tags.get(row.id) : undefined;
    return tag ? { ...row, tag } : row;
  };
  return groups.map((g) => ({ ...g, rows: g.rows.map(cached) }));
}

/**
 * Keys (`groupKey/id`) of rows Clean Up will remove from the view (docs/spec.md §2 Inbox, §3 Row): kept rows that
 * newer server contents no longer include, and inbox items Clean Up files away (with their subtrees). Rows `placed`
 * by pending writes are not judged until the server has them.
 */
export function leavingRows(
  merged: OutlineGroup[],
  server: OutlineGroup[],
  sticky: StickyRow[],
  projectIds: ReadonlySet<string>,
  placed: ReadonlySet<string> = new Set(),
): Set<string> {
  const serverKeys = new Set(server.flatMap((g) => g.rows.map((r) => `${g.key}/${r.id}`)));
  const unconfirmed = new Set([...sticky.filter((s) => s.since === server).map((s) => s.row.id), ...placed]);
  const out = new Set<string>();
  for (const g of merged) {
    let filedDepth: number | null = null;
    for (const row of g.rows) {
      const key = `${g.key}/${row.id}`;
      if (filedDepth !== null && row.depth > filedDepth) {
        out.add(key);
        continue;
      }
      filedDepth = null;
      if (!serverKeys.has(key) && !unconfirmed.has(row.id)) out.add(key);
      const t = row.kind === "task" ? row.task : undefined;
      if (g.key === "inbox" && t?.inInbox && t.parentId === null && ((t.assignedProjectId !== null && projectIds.has(t.assignedProjectId)) || t.tagIds.length > 0)) {
        out.add(key);
        filedDepth = row.depth;
      }
    }
  }
  return out;
}

/** Index just past `rows[idx]` and its subtree (the deeper rows that follow it). */
export function blockEnd(rows: readonly OutlineRow[], idx: number): number {
  const depth = rows[idx]?.depth ?? 0;
  let end = idx + 1;
  while (end < rows.length && (rows[end]?.depth ?? 0) > depth) end++;
  return end;
}

/** Where `rows[idx]` sits: its displayed parent (else its task's parent) and previous sibling. */
export function placeAt(rows: readonly OutlineRow[], idx: number, groupKey: string): RowPlace {
  const row = rows[idx];
  const depth = row?.depth ?? 0;
  let after: string | null = null;
  let parentId: string | null = null;
  let parentShown = false;
  for (let i = idx - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r) continue;
    if (r.depth < depth) {
      parentId = r.id;
      parentShown = true;
      break;
    }
    if (r.depth === depth && after === null) after = r.id;
  }
  if (!parentShown) parentId = row?.task?.parentId ?? null;
  return { parentId, after, groupKey };
}

/** The first displayed occurrence of `id`: its index over all groups, place, row and subtree. */
export function findRow(groups: readonly OutlineGroup[], id: string): { index: number; at: RowPlace; row: OutlineRow; block: OutlineRow[] } | null {
  let offset = 0;
  for (const g of groups) {
    const idx = g.rows.findIndex((r) => r.id === id);
    const row = g.rows[idx];
    if (row) return { index: offset + idx, at: placeAt(g.rows, idx, g.key), row, block: g.rows.slice(idx, blockEnd(g.rows, idx)) };
    offset += g.rows.length;
  }
  return null;
}

function withParent(row: OutlineRow, parentId: string | null): OutlineRow {
  if (row.kind === "task" && row.task && row.task.parentId !== parentId) return { ...row, task: { ...row.task, parentId } };
  return row;
}

/**
 * Moves, adds or removes one row (with its subtree) in a group's rows. A row is placed after its displayed sibling
 * anchor, else under its displayed parent, else at the start/end of the group named by `groupKey`; when no anchor
 * is shown in this group, a present row stays where it is and an absent one is not added.
 */
function applyRowChange(rows: OutlineRow[], c: RowChange, groupKey: string): OutlineRow[] {
  if (c.inGroup !== undefined && c.inGroup !== groupKey) return rows;
  const idx = rows.findIndex((r) => r.id === c.id);
  if (c.at === null) return idx < 0 ? rows : [...rows.slice(0, idx), ...rows.slice(blockEnd(rows, idx))];
  let block: OutlineRow[];
  let rest: OutlineRow[];
  if (idx >= 0) {
    const end = blockEnd(rows, idx);
    block = rows.slice(idx, end);
    rest = [...rows.slice(0, idx), ...rows.slice(end)];
  } else {
    if (!c.rows?.length) return rows;
    // Rows of the block shown elsewhere in the group are placed by their own changes.
    const shown = new Set(rows.map((r) => r.id));
    block = c.rows.filter((r, i) => i === 0 || !shown.has(r.id));
    rest = rows;
  }
  const at = c.at;
  const anchor = !at.last && at.after !== null ? rest.findIndex((r) => r.id === at.after) : -1;
  const parent = at.parentId !== null ? rest.findIndex((r) => r.id === at.parentId) : -1;
  const first = at.last || at.after === null;
  let pos: number;
  let depth: number;
  if (anchor >= 0) {
    pos = blockEnd(rest, anchor);
    depth = rest[anchor]?.depth ?? 0;
  } else if (parent >= 0 && first) {
    pos = at.last ? blockEnd(rest, parent) : parent + 1;
    depth = (rest[parent]?.depth ?? 0) + 1;
  } else if (at.parentId === null && at.groupKey === groupKey && (first || idx < 0)) {
    pos = at.after === null && !at.last ? 0 : rest.length;
    depth = 0;
  } else if (idx >= 0) {
    pos = idx;
    depth = block[0]?.depth ?? 0;
  } else return rows;
  const shift = depth - (block[0]?.depth ?? 0);
  const moved = block.map((r, i) => {
    const shifted = shift === 0 ? r : { ...r, depth: r.depth + shift };
    return i === 0 ? withParent(shifted, at.parentId) : shifted;
  });
  return [...rest.slice(0, pos), ...moved, ...rest.slice(pos)];
}

/** Groups with row changes applied in order. */
export function applyRowChanges(groups: OutlineGroup[], changes: readonly RowChange[]): OutlineGroup[] {
  let out = groups;
  for (const c of changes) {
    out = out.map((g) => {
      const rows = applyRowChange(g.rows, c, g.key);
      return rows === g.rows ? g : { ...g, rows };
    });
    const key = c.at?.ensureGroup ? c.at.groupKey : undefined;
    if (key !== undefined && c.rows?.length && !out.some((g) => g.key === key)) {
      out = [...out, { key, title: "", kind: "none", rows: c.rows.map((r) => ({ ...r, depth: r.depth - (c.rows?.[0]?.depth ?? 0) })) }];
    }
  }
  return out;
}
