// Background writes (docs/spec.md §2 "Instant writes"): every write shows its changes at once and is sent from one
// serial queue, in gesture order. Network errors and 5xx retry with backoff (an Idempotency-Key makes a retry apply
// once). A 4xx, or running out of retries, discards that write and every write queued after it, reverts their
// previews and refetches. Previews of confirmed writes stay until a refresh after the queue drains has succeeded.
// Attachment uploads run in their own lane so they never hold up other writes.
import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { toast } from "../components/Toasts";
import { invertChanges, type Change, type StateReader } from "./optimistic";
import { createStore, useStore } from "./store";

/** Waits between attempts of a write that failed transiently: about 5 s in all. */
export const RETRY_DELAYS_MS = [500, 1500, 3000];
/** How long writes may be retrying before the header shows "Saving…". */
export const STALLED_AFTER_MS = 2000;

/** An undo step the server recorded for a write, and the step before it (0 for none). */
export interface RecordedStep {
  id: number;
  previous: number;
}

export interface WriteSpec<T> {
  /** Sends the request with `key` as its Idempotency-Key. */
  send: (key: string) => Promise<T>;
  /** Shown from now until the refresh after the write lands; reverted if it fails. */
  changes?: readonly Change[];
  /** Replaces `changes` once the write lands (e.g. a stand-in id swapped for the server's), until the refresh. */
  landed?: (result: T) => readonly Change[];
  /** Ids this write creates: requests about them wait until it lands. */
  creates?: readonly string[];
  /** The server's undo label when the write is a journaled change: records an undo snapshot for this tab. */
  label?: string;
  /** The write erases the newest undo step instead of adding one (discarding a just-created item). */
  erases?: boolean;
  /** The undo steps the server said the write added (`X-Undo-Steps`), once it has answered; null when unknown. */
  undoSteps?: () => number | null;
  /** The undo step the server recorded for the write (`X-Undo-Step`, `X-Undo-Previous`), once it has answered. */
  recordedStep?: () => RecordedStep | null;
  /** Uploads run beside the main queue, after the writes creating `waitFor` land. */
  lane?: "upload";
  waitFor?: readonly string[];
  onSuccess?: (result: T) => void;
  /** Checked when the write's turn comes: true finishes it without sending (an undo of a step the server never recorded). */
  skip?: () => boolean;
}

/** A write discarded because an earlier one failed. */
export class DiscardedError extends Error {
  constructor() {
    super("Discarded after an earlier change failed");
  }
}

interface Entry {
  spec: WriteSpec<unknown>;
  key: string;
  state: "queued" | "sending" | "done";
  changes: readonly Change[];
  /** When its attempts started failing transiently (null while not retrying). */
  retryingSince: number | null;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** One step of this tab's undo history: changes that show the state before (undo) and after (redo) it. */
export interface UndoStep {
  label: string;
  undo: readonly Change[];
  redo: readonly Change[];
  creates: readonly string[];
  entry: Entry;
}

interface WriteState {
  entries: readonly Entry[];
  /** Every pending preview, in write order. */
  changes: readonly Change[];
  /** Ids created by writes that have not landed. */
  unconfirmed: ReadonlySet<string>;
  busy: boolean;
  /** When the longest-retrying pending write started retrying (null when none is). */
  retryingSince: number | null;
  undo: readonly UndoStep[];
  redo: readonly UndoStep[];
  /** When this tab last queued a journaled write (the server's redo list is gone after it). */
  journaledAt: number;
}

export const writes = createStore<WriteState>({
  entries: [],
  changes: [],
  unconfirmed: new Set(),
  busy: false,
  retryingSince: null,
  undo: [],
  redo: [],
  journaledAt: 0,
});

interface Deps {
  /** Refetches all data; resolves to false when the server could not be reached for it. */
  refresh: () => Promise<boolean>;
  read: StateReader;
}
let deps: Deps | null = null;

/** Wires the queue to the query cache (src/web/api/queries.ts). */
export function configureWrites(d: Deps): void {
  deps = d;
}

const MAX_UNDO = 200;
/** How long to wait before refreshing again when a refresh could not reach the server. */
const REFRESH_RETRY_MS = 3000;

function update(entries: readonly Entry[], extra: Partial<WriteState> = {}): void {
  const retrying = entries.flatMap((e) => (e.retryingSince === null ? [] : [e.retryingSince]));
  writes.set({
    entries,
    changes: entries.flatMap((e) => e.changes),
    unconfirmed: new Set(entries.filter((e) => e.state !== "done").flatMap((e) => e.spec.creates ?? [])),
    busy: entries.some((e) => e.state !== "done"),
    retryingSince: retrying.length ? Math.min(...retrying) : null,
    ...extra,
  });
}

/** Queues a write; its preview shows at once. The promise settles when the server answers (or it is discarded). */
export function write<T>(spec: WriteSpec<T>): Promise<T> {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value: unknown) => void;
    reject = rej;
  });
  // Callers need not handle failures: the queue reports them.
  promise.catch(() => {});
  const entry: Entry = { spec: spec as WriteSpec<unknown>, key: crypto.randomUUID(), state: "queued", changes: spec.changes ?? [], retryingSince: null, resolve, reject };
  const s = writes.get();
  let history: Partial<WriteState> = {};
  if (spec.label && deps) {
    const changes = spec.changes ?? [];
    const step: UndoStep = { label: spec.label, undo: invertChanges(changes, deps.read), redo: changes, creates: spec.creates ?? [], entry };
    history = { redo: [], journaledAt: Date.now(), ...(spec.lane ? {} : { undo: [...s.undo, step].slice(-MAX_UNDO) }) };
    if (spec.lane) pendingUploadSteps.set(entry, step);
  }
  update([...s.entries, entry], history);
  for (const id of spec.creates ?? []) created.add(id);
  if (spec.lane === "upload") void sendUpload(entry);
  else void drain();
  return promise;
}

/** Undo steps of uploads, recorded when they land (the server journals them then). */
const pendingUploadSteps = new Map<Entry, UndoStep>();

/** Ids of items created in this tab. */
const created = new Set<string>();

/** Whether this tab created the item `id` (it may be saved by now). */
export function createdHere(id: string): boolean {
  return created.has(id);
}

let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const entry = writes.get().entries.find((e) => e.state === "queued" && e.spec.lane !== "upload");
      if (!entry) break;
      setState(entry, "sending");
      try {
        const result = entry.spec.skip?.() ? undefined : await sendWithRetry(entry);
        reconcileUndo(entry);
        succeed(entry, result);
      } catch (error) {
        fail(entry, error);
      }
    }
  } finally {
    draining = false;
  }
  void refreshAndRelease();
}

async function sendUpload(entry: Entry): Promise<void> {
  try {
    for (const id of entry.spec.waitFor ?? []) await whenCreated(id);
    setState(entry, "sending");
    const result = await sendWithRetry(entry);
    const queued = pendingUploadSteps.get(entry);
    if (queued && deps && entry.spec.undoSteps?.() !== 0) {
      // The landed attachment has the server's id: undo removes it and redo shows it under that id.
      const redo = entry.spec.landed?.(result) ?? queued.redo;
      const added = invertChanges(redo.filter((c) => c.kind === "attachment"), deps.read);
      const step: UndoStep = { ...queued, redo, undo: [...queued.undo, ...added] };
      // The server journaled the upload now: it goes below the steps of writes that have not landed yet.
      const undo = [...writes.get().undo];
      const at = undo.findIndex((u) => u.entry.state !== "done");
      undo.splice(at < 0 ? undo.length : at, 0, step);
      writes.set({ undo: undo.slice(-MAX_UNDO) });
    }
    succeed(entry, result);
  } catch (error) {
    update(writes.get().entries.filter((e) => e !== entry));
    entry.reject(error);
    // A discarded upload was counted in its task's failure report.
    if (!(error instanceof DiscardedError)) report(error, 0);
  } finally {
    pendingUploadSteps.delete(entry);
  }
  void refreshAndRelease();
}

function setState(entry: Entry, state: Entry["state"]): void {
  entry.state = state;
  update(writes.get().entries);
}

async function sendWithRetry(entry: Entry): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await entry.spec.send(entry.key);
      entry.retryingSince = null;
      return result;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      // Only network errors and 5xx are worth another attempt.
      const transient = error instanceof ApiError && (error.status === 0 || error.status >= 500);
      if (!transient || delay === undefined) throw error;
      if (entry.retryingSince === null) {
        entry.retryingSince = Date.now();
        update(writes.get().entries);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Keeps this tab's undo history in line with the server's: a write that recorded no step (nothing changed) loses its
 * snapshot, wherever it is (an undo or redo of it is then skipped); any other surprise (e.g. a discard that deleted
 * instead of erasing) leaves undo to the server.
 */
function reconcileUndo(entry: Entry): void {
  const recorded = entry.spec.undoSteps?.() ?? null;
  const expected = entry.spec.label ? 1 : entry.spec.erases ? -1 : 0;
  if (recorded === null || recorded === expected) return;
  const s = writes.get();
  if (expected === 1 && recorded === 0) writes.set({ undo: s.undo.filter((u) => u.entry !== entry), redo: s.redo.filter((u) => u.entry !== entry) });
  else writes.set({ undo: [], redo: [] });
}

/** Whether the server recorded no undo step for this step's write (so undoing or redoing it changes nothing there). */
export function unrecorded(step: UndoStep): boolean {
  return step.entry.spec.undoSteps?.() === 0;
}

function succeed(entry: Entry, result: unknown): void {
  // First, so caches it seeds are in place when requests waiting for this write are let through.
  entry.spec.onSuccess?.(result);
  if (entry.spec.landed) entry.changes = entry.spec.landed(result);
  const recorded = entry.spec.recordedStep?.();
  if (recorded) recordOwnStep(recorded);
  setState(entry, "done");
  entry.resolve(result);
}

/** Discards `failed` and every main-lane write queued after it (and uploads waiting for them), then reports once. */
function fail(failed: Entry, error: unknown): void {
  const entries = writes.get().entries;
  const from = entries.indexOf(failed);
  const discarded = entries.filter((e, i) => e === failed || (i > from && e.state === "queued" && e.spec.lane !== "upload"));
  const lost = new Set(discarded.flatMap((e) => e.spec.creates ?? []));
  const uploads = entries.filter((e) => e.spec.lane === "upload" && e.state === "queued" && e.spec.waitFor?.some((id) => lost.has(id)));
  // This tab's undo snapshots no longer match the server's journal.
  update(
    entries.filter((e) => !discarded.includes(e)),
    { undo: [], redo: [] },
  );
  failed.reject(error);
  for (const e of discarded) if (e !== failed) e.reject(new DiscardedError());
  report(error, discarded.length - 1 + uploads.length);
}

function report(error: unknown, later: number): void {
  if (error instanceof ApiError && error.status === 401) return;
  const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
  const tail = later > 0 ? ` ${later} later change${later === 1 ? " was" : "s were"} undone.` : "";
  toast(`Couldn't save: ${reason}.${tail}`, { kind: "error" });
}

let refreshRetry: ReturnType<typeof setTimeout> | undefined;

/**
 * Once the main queue is idle, refetches, then drops the previews of writes that had landed when the refetch
 * started. When the refetch cannot reach the server, the previews stay (they are what was saved) and it tries again.
 */
async function refreshAndRelease(): Promise<void> {
  const entries = writes.get().entries;
  if (!deps || entries.some((e) => e.state !== "done" && e.spec.lane !== "upload")) return;
  const landed = new Set(entries.filter((e) => e.state === "done"));
  clearTimeout(refreshRetry);
  if (await deps.refresh()) update(writes.get().entries.filter((e) => !landed.has(e)));
  else refreshRetry = setTimeout(() => void refreshAndRelease(), REFRESH_RETRY_MS);
}

/** Resolves once the write creating `id` has landed (at once when none is pending); rejects if it was discarded. */
export function whenCreated(id: string): Promise<void> {
  const entry = writes.get().entries.find((e) => e.state !== "done" && e.spec.creates?.includes(id));
  if (!entry) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const unsubscribe = writes.subscribe(() => {
      if (entry.state === "done") {
        unsubscribe();
        resolve();
      } else if (!writes.get().entries.includes(entry)) {
        unsubscribe();
        reject(new DiscardedError());
      }
    });
  });
}

/** Resolves when no write is pending (e.g. before signing out). */
export function whenIdle(): Promise<void> {
  if (!writes.get().busy) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = writes.subscribe(() => {
      if (writes.get().busy) return;
      unsubscribe();
      resolve();
    });
  });
}

/** The server's id for a step of this tab's history (null until its write has landed). */
export function serverStepId(step: UndoStep): number | null {
  return step.entry.spec.recordedStep?.()?.id ?? null;
}

/** The undo steps this tab's writes recorded, each with the step before it (0 for none). */
const ownSteps = new Map<number, number>();
/** The newest step this tab recorded: the server has at least this one, even before its history says so. */
let newestOwnStep = 0;

function recordOwnStep({ id, previous }: RecordedStep): void {
  ownSteps.set(id, previous);
  newestOwnStep = Math.max(newestOwnStep, id);
  // The server keeps 200 steps; older ones can no longer be walked through anyway.
  const oldest = ownSteps.keys().next().value;
  if (ownSteps.size > MAX_UNDO * 2 && oldest !== undefined) ownSteps.delete(oldest);
}

/**
 * Whether `step` is still what the server would undo or redo next: false when a step made elsewhere (MCP, another
 * device or tab) lies between it and the newest step the server has (`serverNewest`, from its history, or this
 * tab's own newest, whichever is later).
 */
export function stepIsCurrent(step: UndoStep, serverNewest: number | null): boolean {
  const id = serverStepId(step);
  if (id === null) return true;
  // Walk back from the newest step to this one: every step on the way must be this tab's.
  for (let at: number | undefined = Math.max(serverNewest ?? 0, newestOwnStep); at !== undefined && at > id; at = ownSteps.get(at)) {
    if (!ownSteps.has(at)) return false;
  }
  return true;
}

/** Forgets this tab's undo history: undo and redo then wait for the server. */
export function forgetUndoHistory(): void {
  writes.set({ undo: [], redo: [] });
}

/**
 * Takes this tab's newest undo step (moving it to the redo list), or its next redo step (moving it back), or null
 * when the server must decide: when there is none, or when a later step was made elsewhere (the server will undo that
 * one, and has no redo left).
 */
export function takeStep(list: "undo" | "redo", serverNewest: number | null): UndoStep | null {
  const s = writes.get();
  const step = s[list].at(-1);
  if (!step) return null;
  if (!stepIsCurrent(step, serverNewest)) {
    forgetUndoHistory();
    return null;
  }
  const other = list === "undo" ? "redo" : "undo";
  writes.set({ [list]: s[list].slice(0, -1), [other]: [...s[other], step] });
  return step;
}

/** Forgets the undo step that created `id` when it is the newest one (the server erases that creation). */
export function forgetCreation(id: string): boolean {
  const s = writes.get();
  const top = s.undo.at(-1);
  if (!top?.creates.includes(id)) return false;
  writes.set({ undo: s.undo.slice(0, -1) });
  return true;
}

export function usePendingChanges(): readonly Change[] {
  return useStore(writes, (s) => s.changes);
}

export function useUnconfirmed(id: string | null | undefined): boolean {
  return useStore(writes, (s) => !!id && s.unconfirmed.has(id));
}

/** True once writes have been retrying for longer than STALLED_AFTER_MS (the header then shows "Saving…"). */
export function useStalled(): boolean {
  const since = useStore(writes, (s) => s.retryingSince);
  // The retry spell (identified by its start) that has lasted long enough.
  const [stalled, setStalled] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) return;
    const timer = setTimeout(() => setStalled(since), Math.max(0, since + STALLED_AFTER_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [since]);
  return since !== null && stalled === since;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (!writes.get().busy) return;
    e.preventDefault();
    e.returnValue = "";
  });
}
