// Previews of outline restructuring (indent, outdent, group, ungroup, move up/down, drag moves), computed on the
// displayed rows the way the server applies them to the task tree (src/domain/index.ts `outline`, `moveTasks`).
import type { OutlineGroup, OutlineRow } from "../../shared/schemas";
import type { RowChange, RowPlace } from "./optimistic";
import { applyRowChanges, blockEnd } from "./outlineModel";

export type OutlineOp = "indent" | "outdent" | "group" | "ungroup" | "moveUp" | "moveDown";

interface Located {
  rows: OutlineRow[];
  idx: number;
  groupKey: string;
  /** Displayed parent row index, or -1 for a group root. */
  parent: number;
}

function locate(groups: readonly OutlineGroup[], id: string): Located | null {
  for (const g of groups) {
    const idx = g.rows.findIndex((r) => r.id === id);
    const row = g.rows[idx];
    if (!row) continue;
    let parent = idx - 1;
    while (parent >= 0 && (g.rows[parent]?.depth ?? 0) >= row.depth) parent--;
    return { rows: g.rows, idx, groupKey: g.key, parent };
  }
  return null;
}

/** Sibling row ids of `loc` (same displayed parent and depth), in order. */
function siblings(loc: Located): string[] {
  const { rows, parent } = loc;
  const depth = rows[loc.idx]?.depth ?? 0;
  const out: string[] = [];
  const end = parent >= 0 ? blockEnd(rows, parent) : rows.length;
  for (let i = parent + 1; i < end; i = blockEnd(rows, i)) {
    const r = rows[i];
    if (r && r.depth === depth) out.push(r.id);
  }
  return out;
}

const parentIdOf = (loc: Located): string | null => loc.rows[loc.parent]?.id ?? loc.rows[loc.idx]?.task?.parentId ?? null;

/** Ids in display order. */
function ordered(groups: readonly OutlineGroup[], ids: readonly string[]): string[] {
  const order = new Map<string, number>();
  let n = 0;
  for (const g of groups) for (const r of g.rows) if (!order.has(r.id)) order.set(r.id, n++);
  return ids.filter((id) => order.has(id)).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * Row changes for an outline operation on the selected task ids, simulated step by step like the server does.
 * `groupRow` is the new (untitled) group for "group".
 */
export function outlineOpChanges(op: OutlineOp, ids: readonly string[], groups: OutlineGroup[], groupRow?: OutlineRow): RowChange[] {
  const selected = new Set(ids);
  const order = ordered(groups, ids);
  const changes: RowChange[] = [];
  let state = groups;
  const place = (id: string, at: RowPlace | null, rows?: OutlineRow[]) => {
    const change: RowChange = rows ? { kind: "row", id, at, rows } : { kind: "row", id, at };
    changes.push(change);
    state = applyRowChanges(state, [change]);
  };
  const parentSelected = (loc: Located) => {
    const p = parentIdOf(loc);
    return p !== null && selected.has(p);
  };

  switch (op) {
    case "indent":
      for (const id of order) {
        const loc = locate(state, id);
        if (!loc || parentSelected(loc)) continue;
        const sibs = siblings(loc);
        const prev = sibs.slice(0, sibs.indexOf(id)).reverse().find((s) => !selected.has(s));
        if (prev) place(id, { parentId: prev, after: null, last: true });
      }
      break;
    case "outdent":
      for (const id of [...order].reverse()) {
        const loc = locate(state, id);
        if (!loc || loc.parent < 0 || parentSelected(loc)) continue;
        const parent = loc.rows[loc.parent];
        if (!parent || parent.kind !== "task") continue;
        const parentLoc = locate(state, parent.id);
        if (!parentLoc) continue;
        place(id, { parentId: parentIdOf(parentLoc), after: parent.id, groupKey: parentLoc.groupKey });
      }
      break;
    case "moveUp":
      for (const id of order) {
        const loc = locate(state, id);
        if (!loc) continue;
        const sibs = siblings(loc);
        const i = sibs.indexOf(id);
        const prev = sibs[i - 1];
        if (!prev || selected.has(prev)) continue;
        place(id, { parentId: parentIdOf(loc), after: sibs[i - 2] ?? null, groupKey: loc.groupKey });
      }
      break;
    case "moveDown":
      for (const id of [...order].reverse()) {
        const loc = locate(state, id);
        if (!loc) continue;
        const sibs = siblings(loc);
        const next = sibs[sibs.indexOf(id) + 1];
        if (!next || selected.has(next)) continue;
        place(id, { parentId: parentIdOf(loc), after: next, groupKey: loc.groupKey });
      }
      break;
    case "group": {
      const first = order[0];
      const loc = first ? locate(state, first) : null;
      if (!loc || !groupRow) break;
      const sibs = siblings(loc);
      const depth = loc.rows[loc.idx]?.depth ?? 0;
      place(groupRow.id, { parentId: parentIdOf(loc), after: sibs[sibs.indexOf(loc.rows[loc.idx]?.id ?? "") - 1] ?? null, groupKey: loc.groupKey }, [{ ...groupRow, depth }]);
      for (const id of order) {
        const l = locate(state, id);
        if (!l || parentSelected(l)) continue;
        place(id, { parentId: groupRow.id, after: null, last: true });
      }
      break;
    }
    case "ungroup":
      for (const id of order) {
        const loc = locate(state, id);
        if (!loc) continue;
        const depth = loc.rows[loc.idx]?.depth ?? 0;
        const children: string[] = [];
        for (let i = loc.idx + 1; i < blockEnd(loc.rows, loc.idx); i = blockEnd(loc.rows, i)) {
          const r = loc.rows[i];
          if (r && r.depth === depth + 1) children.push(r.id);
        }
        if (children.length === 0) continue;
        const sibs = siblings(loc);
        let after = sibs[sibs.indexOf(id) - 1] ?? null;
        const parentId = parentIdOf(loc);
        for (const child of children) {
          place(child, { parentId, after, groupKey: loc.groupKey });
          after = child;
        }
        place(id, null);
      }
      break;
  }
  return changes;
}

export type MoveTarget = { position: { before: string } | { after: string } } | { parentId: string; position: "start" | "end" };

/** Row changes for moving tasks (their subtrees travel with them), keeping their display order, like `moveTasks`. */
export function moveChanges(ids: readonly string[], target: MoveTarget, groups: OutlineGroup[]): RowChange[] {
  const selected = new Set(ids);
  const roots = ordered(groups, ids).filter((id) => {
    let loc = locate(groups, id);
    while (loc && loc.parent >= 0) {
      const p = loc.rows[loc.parent];
      if (p && selected.has(p.id)) return false;
      loc = p ? locate(groups, p.id) : null;
    }
    return true;
  });
  let first: RowPlace;
  if ("parentId" in target) first = { parentId: target.parentId, after: null, last: target.position === "end", groupKey: target.parentId };
  else {
    const anchorId = "before" in target.position ? target.position.before : target.position.after;
    const loc = locate(groups, anchorId);
    if (!loc) return [];
    const parentId = parentIdOf(loc);
    if ("before" in target.position) {
      const sibs = siblings(loc).filter((s) => !selected.has(s));
      first = { parentId, after: sibs[sibs.indexOf(anchorId) - 1] ?? null, groupKey: loc.groupKey };
    } else first = { parentId, after: anchorId, groupKey: loc.groupKey };
  }
  const changes: RowChange[] = [];
  let at = first;
  for (const id of roots) {
    changes.push({ kind: "row", id, at });
    at = { parentId: at.parentId, after: id, groupKey: at.groupKey };
  }
  return changes;
}
