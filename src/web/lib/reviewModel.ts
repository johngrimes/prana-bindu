// The Review perspective's frozen project list (docs/spec.md §3). Pure functions; state lives in ./review.
import type { Project } from "../../shared/schemas";

/** A project in the review list, with the `lastReview` it had when it joined the list. */
export interface ReviewEntry {
  id: string;
  joinedLastReview: string;
}

export interface ReviewItem {
  project: Project;
  /** Marked reviewed since it joined the list (undoing Mark Reviewed clears it again). */
  reviewed: boolean;
}

/**
 * Appends due projects that are not listed yet. Listed projects keep their place even when they stop
 * being due, so nothing leaves the list until Clean Up or leaving Review.
 */
export function mergeDue(entries: ReviewEntry[], due: Project[]): ReviewEntry[] {
  const listed = new Set(entries.map((e) => e.id));
  const added = due.filter((p) => !listed.has(p.id)).map((p) => ({ id: p.id, joinedLastReview: p.lastReview }));
  return added.length ? [...entries, ...added] : entries;
}

/** Listed projects that still exist, in list order. */
export function reviewItems(entries: ReviewEntry[], projects: ReadonlyMap<string, Project>): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const e of entries) {
    const project = projects.get(e.id);
    if (project) items.push({ project, reviewed: project.lastReview !== e.joinedLastReview });
  }
  return items;
}

/**
 * The first unreviewed project after `fromId`, wrapping round to ones skipped earlier; with no `fromId`,
 * the first unreviewed project. Null when every listed project is reviewed.
 */
export function nextUnreviewed(items: ReviewItem[], fromId: string | null): string | null {
  const start = fromId === null ? -1 : items.findIndex((i) => i.project.id === fromId);
  for (let step = 1; step <= items.length; step++) {
    const item = items[(start + step) % items.length]!;
    if (!item.reviewed && item.project.id !== fromId) return item.project.id;
  }
  return null;
}
