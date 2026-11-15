// Global commands shared by the header, menus and keyboard shortcuts.
import { api } from "../api/client";
import type { History } from "../../shared/schemas";
import { actions, keys, queryClient, refreshAll } from "../api/queries";
import { toast } from "../components/Toasts";
import type { RowChange } from "./optimistic";
import { createStore } from "./store";
import { outline } from "./ui";
import { forgetUndoHistory, serverStepId, takeStep, unrecorded, whenIdle } from "./writes";

/**
 * `epoch` is bumped when rows kept visible after completion should be dropped (Clean Up, navigation, drops).
 * `journal` is bumped on undo/redo: kept rows stay put (and are re-read), but locally hidden
 * deletions are forgotten because they may be restored. `cleanups` counts explicit
 * Clean Ups only (the Review list rebuilds on it).
 */
export const stickyEpoch = createStore<{ epoch: number; journal: number; cleanups: number }>({ epoch: 0, journal: 0, cleanups: 0 });
export function resetSticky(): void {
  stickyEpoch.set((s) => ({ epoch: s.epoch + 1 }));
}

/** Clean Up: the greyed rows leave the outline at once. */
export function cleanUp(): void {
  const rows = (outline()?.leaving() ?? []).map(({ groupKey, id }): RowChange => ({ kind: "row", id, at: null, inGroup: groupKey }));
  void actions.cleanup(rows);
  resetSticky();
  stickyEpoch.set((s) => ({ cleanups: s.cleanups + 1 }));
}

/**
 * Undo/redo show this tab's snapshot of the state they return to at once. A change made elsewhere (MCP, another
 * device, before a reload) has no snapshot, so its undo shows when the server answers; so does undo when the server's
 * history (or its answer) shows a newer change made elsewhere. Undoing a step the server turned out not to record
 * (a Clean Up with nothing to file away) sends nothing.
 */
function travel(direction: "undo" | "redo"): void {
  const verb = direction === "undo" ? "Undid" : "Redid";
  const announce = (history: History) => {
    stickyEpoch.set((s) => ({ journal: s.journal + 1 }));
    const label = direction === "undo" ? history.redoLabel : history.undoLabel;
    toast(label ? `${verb} ${label}` : direction === "undo" ? "Undone" : "Redone");
  };
  const step = takeStep(direction, queryClient.getQueryData<History>(keys.history)?.undoId ?? null);
  if (!step) {
    actions[direction]().then(announce, () => {});
    return;
  }
  const id = serverStepId(step);
  actions[direction](direction === "undo" ? step.undo : step.redo, () => unrecorded(step), id).then((history) => {
    // The server reverted a different (newer) step than this tab's: show what it did instead.
    if (!history || id === null || (direction === "undo" ? history.redoId : history.undoId) === id) return;
    forgetUndoHistory();
    announce(history);
  }, () => {});
  stickyEpoch.set((s) => ({ journal: s.journal + 1 }));
  toast(`${verb} ${step.label}`);
}

export function undo(): void {
  travel("undo");
}

export function redo(): void {
  travel("redo");
}

export function refresh(): void {
  void refreshAll();
  toast("Refreshed", { durationMs: 1500 });
}

/** Signing out waits for unsent changes first (auth is not part of the instant write queue). */
export async function signOut(): Promise<void> {
  await whenIdle();
  try {
    await api.post("/auth/logout", {}, { allowUnauthorized: true });
  } finally {
    queryClient.clear();
    window.location.assign("/login");
  }
}
