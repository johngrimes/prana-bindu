// Review perspective session: the frozen project list and Mark Reviewed → next project (docs/spec.md §3).
import { useEffect, useMemo, useRef } from "react";
import type { NavigateFunction } from "react-router";
import { actions, shownList, useProjects, useReviewQueue } from "../api/queries";
import { stickyEpoch } from "./commands";
import { mergeDue, nextUnreviewed, reviewItems, type ReviewEntry, type ReviewItem } from "./reviewModel";
import { createStore, useStore } from "./store";

/** `loaded` turns true once the due list has been read for this visit to Review. */
const session = createStore<{ entries: ReviewEntry[]; loaded: boolean }>({ entries: [], loaded: false });

export const reviewPath = (id: string | null) => (id ? `/review?project=${encodeURIComponent(id)}` : "/review");

/**
 * Owns the list while the Review page is mounted: starts it from the due projects, appends projects that
 * become due, rebuilds it on Clean Up, and forgets it on leaving. Returns null until the list is ready.
 */
export function useReviewSession(): ReviewItem[] | null {
  const { data: due, isFetching } = useReviewQueue();
  const { data: projects, isFetching: projectsFetching } = useProjects();
  const cleanups = useStore(stickyEpoch, (s) => s.cleanups);
  const seenCleanups = useRef(cleanups);
  const entries = useStore(session, (s) => s.entries);
  const loaded = useStore(session, (s) => s.loaded);

  // Act only on settled data: a cached list from an earlier visit, or one read before Clean Up, is stale.
  // The first read also waits for fresh projects, whose lastReview decides what counts as reviewed.
  useEffect(() => {
    if (!due || isFetching || (projectsFetching && !session.get().loaded)) return;
    const rebuild = seenCleanups.current !== cleanups;
    seenCleanups.current = cleanups;
    session.set((s) => ({ entries: mergeDue(rebuild ? [] : s.entries, due), loaded: true }));
  }, [due, isFetching, projectsFetching, cleanups]);
  useEffect(() => () => session.set({ entries: [], loaded: false }), []);

  return useMemo(
    () => (loaded && projects ? reviewItems(entries, new Map(projects.map((p) => [p.id, p]))) : null),
    [entries, loaded, projects],
  );
}

/**
 * Mark Reviewed (review bar, shortcut and inspector). On the Review page it then opens the next unreviewed
 * project, or the "All projects reviewed" screen when none is left.
 */
export function markReviewedAndAdvance(id: string, navigate: NavigateFunction): void {
  void actions.markReviewed(id);
  if (window.location.pathname !== "/review") return;
  const projects = shownList("projects") ?? [];
  const items = reviewItems(session.get().entries, new Map(projects.map((p) => [p.id, p])));
  navigate(reviewPath(nextUnreviewed(items, id)));
}
