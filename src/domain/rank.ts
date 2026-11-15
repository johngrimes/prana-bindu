// Sibling ordering with signed int32 ranks (docs/spec.md §1.4 Ordering).
import type { Position } from "../shared/schemas.js";
import { DomainError } from "./errors.js";

export const RANK_MIN = -2_147_483_648;
export const RANK_MAX = 2_147_483_647;
const STEP = 65_536;

export interface Ranked {
  id: string;
  rank: number;
}

export interface RankPlan {
  rank: number;
  /** Siblings that must be renumbered first (id → new rank) because there was no gap left. */
  renumber: Map<string, number>;
}

/** Evenly spaced ranks centred on 0 for `n` items. */
export function spacedRanks(n: number): number[] {
  const step = Math.min(STEP, Math.floor((RANK_MAX - RANK_MIN) / (n + 2)));
  const start = -Math.floor(((n - 1) * step) / 2);
  return Array.from({ length: n }, (_, i) => start + i * step);
}

function slot(lower: number | null, upper: number | null): number | null {
  const lo = lower ?? RANK_MIN - 1;
  const hi = upper ?? RANK_MAX + 1;
  if (lower === null && upper === null) return 0;
  if (lower === null) return hi - STEP >= RANK_MIN ? hi - STEP : hi - lo > 1 ? Math.floor((lo + hi) / 2) : null;
  if (upper === null) return lo + STEP <= RANK_MAX ? lo + STEP : hi - lo > 1 ? Math.floor((lo + hi) / 2) : null;
  return hi - lo > 1 ? Math.floor((lo + hi) / 2) : null;
}

/** Index in `siblings` (sorted, excluding the moving item) at which a new item is inserted. */
export function insertionIndex(siblings: Ranked[], position: Position): number {
  if (position === "start") return 0;
  if (position === "end") return siblings.length;
  const anchor = "before" in position ? position.before : position.after;
  const i = siblings.findIndex((s) => s.id === anchor);
  if (i < 0) throw new DomainError("validation_error", `Position anchor is not a sibling: ${anchor}`);
  return "before" in position ? i : i + 1;
}

/**
 * Computes a rank for inserting at `index` among `siblings` (sorted ascending, excluding the item itself).
 * Takes the midpoint between neighbours; renumbers all siblings when no gap is left.
 */
export function planRank(siblings: Ranked[], index: number): RankPlan {
  const lower = index > 0 ? siblings[index - 1]!.rank : null;
  const upper = index < siblings.length ? siblings[index]!.rank : null;
  const r = slot(lower, upper);
  if (r !== null) return { rank: r, renumber: new Map() };
  const ranks = spacedRanks(siblings.length + 1);
  const renumber = new Map<string, number>();
  let j = 0;
  for (let i = 0; i <= siblings.length; i++) {
    if (i === index) continue;
    renumber.set(siblings[j]!.id, ranks[i]!);
    j++;
  }
  return { rank: ranks[index]!, renumber };
}
