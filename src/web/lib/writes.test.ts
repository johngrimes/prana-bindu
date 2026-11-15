import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type * as ClientModule from "../api/client";
import type { Change, StateReader } from "./optimistic";
import type * as WritesModule from "./writes";

const toast = vi.fn();
vi.mock("../components/Toasts", () => ({ toast }));

let w: typeof WritesModule;
let ApiError: typeof ClientModule.ApiError;
let refresh: Mock<() => Promise<boolean>>;
const reader: StateReader = {
  task: (id) => ({ id, name: "old", flagged: false }) as never,
  projectRecord: () => undefined,
  outline: () => null,
  item: () => undefined,
  settings: () => undefined,
  attachment: () => undefined,
};

/** A send whose answer the test controls; records the idempotency keys of its attempts. */
function deferredSend<T = unknown>() {
  const calls: Array<{ key: string; resolve: (v: T) => void; reject: (e: unknown) => void }> = [];
  const send = (key: string) =>
    new Promise<T>((resolve, reject) => {
      calls.push({ key, resolve, reject });
    });
  return { send, calls };
}

const rename = (id: string, name: string): Change[] => [{ kind: "task", ids: [id], task: { name } }];
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  // Imported per test so each starts with an empty queue (the queue is module state).
  w = await import("./writes");
  ({ ApiError } = await import("../api/client"));
  refresh = vi.fn(() => Promise.resolve(true));
  w.configureWrites({ refresh, read: reader });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("write queue", () => {
  it("shows previews at once and sends one write at a time, in order", async () => {
    const a = deferredSend();
    const b = deferredSend();
    void w.write({ send: a.send, changes: rename("t", "A") });
    void w.write({ send: b.send, changes: rename("t", "B") });
    expect(w.writes.get().changes).toHaveLength(2);
    await flush();
    expect([a.calls.length, b.calls.length]).toEqual([1, 0]);
    a.calls[0]?.resolve({});
    await flush();
    expect(b.calls.length).toBe(1);
  });

  it("keeps landed previews until the refresh after the queue drains has landed", async () => {
    const a = deferredSend();
    let finishRefresh!: (ok: boolean) => void;
    refresh.mockImplementation(() => new Promise<boolean>((r) => (finishRefresh = r)));
    void w.write({ send: a.send, changes: rename("t", "A") });
    await flush();
    a.calls[0]?.resolve({});
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(w.writes.get().changes).toHaveLength(1);
    expect(w.writes.get().busy).toBe(false);
    finishRefresh(true);
    await flush();
    expect(w.writes.get().changes).toHaveLength(0);
  });

  it("retries network errors and 5xx with the same idempotency key, flagging the stall meanwhile", async () => {
    const a = deferredSend();
    const done = w.write({ send: a.send, changes: rename("t", "A") });
    await flush();
    a.calls[0]?.reject(new ApiError(0, "network", "Network error"));
    await flush();
    expect(w.writes.get().retryingSince).not.toBeNull();
    await vi.advanceTimersByTimeAsync(w.RETRY_DELAYS_MS[0] ?? 0);
    a.calls[1]?.reject(new ApiError(503, "unavailable", "Down"));
    await vi.advanceTimersByTimeAsync(w.RETRY_DELAYS_MS[1] ?? 0);
    a.calls[2]?.resolve("ok");
    await expect(done).resolves.toBe("ok");
    expect(new Set(a.calls.map((c) => c.key)).size).toBe(1);
    expect(w.writes.get().retryingSince).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it("on a 4xx discards the write and the ones queued after it, reverting their previews, with one toast", async () => {
    const a = deferredSend();
    const b = deferredSend();
    const c = deferredSend();
    // The refresh after the failure never lands here, so the landed write's preview stays.
    refresh.mockImplementation(() => new Promise<boolean>(() => {}));
    void w.write({ send: a.send, changes: rename("t", "A") });
    const failing = w.write({ send: b.send, changes: rename("t", "B"), label: "Edit Action" });
    const later = w.write({ send: c.send, changes: rename("u", "C"), label: "Edit Action" });
    await flush();
    a.calls[0]?.resolve({});
    await flush();
    b.calls[0]?.reject(new ApiError(422, "invalid", "Bad date."));
    await expect(failing).rejects.toThrow("Bad date.");
    await expect(later).rejects.toBeInstanceOf(w.DiscardedError);
    expect(c.calls).toHaveLength(0);
    expect(w.writes.get().changes).toEqual(rename("t", "A"));
    expect(w.writes.get().undo).toEqual([]);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]?.[0]).toBe("Couldn't save: Bad date. 1 later change was undone.");
  });

  it("gives up after the retries run out", async () => {
    const a = deferredSend();
    const done = w.write({ send: a.send, changes: rename("t", "A") });
    for (let i = 0; i <= w.RETRY_DELAYS_MS.length; i++) {
      await flush();
      a.calls[i]?.reject(new ApiError(502, "bad_gateway", "Bad gateway"));
      await vi.advanceTimersByTimeAsync(w.RETRY_DELAYS_MS[i] ?? 0);
    }
    await expect(done).rejects.toThrow("Bad gateway");
    expect(a.calls).toHaveLength(w.RETRY_DELAYS_MS.length + 1);
    expect(w.writes.get().changes).toEqual([]);
  });

  it("records undo steps with the overwritten values, and clears redo on a new write", async () => {
    const ok = () => Promise.resolve({});
    void w.write({ send: ok, changes: rename("t", "new"), label: "Edit Action" });
    expect(w.writes.get().undo).toHaveLength(1);
    const step = w.takeStep("undo", null);
    expect(step?.undo).toEqual([{ kind: "task", ids: ["t"], task: { name: "old" } }]);
    expect(w.writes.get().redo).toHaveLength(1);
    void w.write({ send: ok, changes: rename("t", "other"), label: "Edit Action" });
    expect(w.writes.get().redo).toEqual([]);
  });

  it("keeps using its own snapshots while the server's newest step is one of this tab's, not after one made elsewhere", async () => {
    const ok = () => Promise.resolve({});
    void w.write({ send: ok, changes: rename("t", "A"), label: "Edit Action", undoSteps: () => 1, recordedStep: () => ({ id: 5, previous: 0 }) });
    void w.write({ send: ok, changes: rename("t", "B"), label: "Edit Action", undoSteps: () => 1, recordedStep: () => ({ id: 6, previous: 5 }) });
    await flush();
    // History read before either undo still names step 6, which this tab made.
    expect(w.takeStep("undo", 6)?.redo).toEqual(rename("t", "B"));
    expect(w.takeStep("undo", 6)?.redo).toEqual(rename("t", "A"));
    expect(w.takeStep("redo", 6)?.redo).toEqual(rename("t", "A"));
    // Step 9 was made elsewhere: the server will act on that one, so this tab's snapshots no longer apply.
    expect(w.takeStep("redo", 9)).toBeNull();
    expect([w.writes.get().undo, w.writes.get().redo]).toEqual([[], []]);
  });

  it("stops using its own snapshots past a step made elsewhere between two of this tab's", async () => {
    const ok = () => Promise.resolve({});
    void w.write({ send: ok, changes: rename("t", "A"), label: "Edit Action", undoSteps: () => 1, recordedStep: () => ({ id: 5, previous: 0 }) });
    // Step 6 was made elsewhere, then this tab recorded step 7 on top of it.
    void w.write({ send: ok, changes: rename("t", "C"), label: "Edit Action", undoSteps: () => 1, recordedStep: () => ({ id: 7, previous: 6 }) });
    await flush();
    expect(w.takeStep("undo", 7)?.redo).toEqual(rename("t", "C"));
    // The server's next undo is step 6, not this tab's step 5.
    expect(w.takeStep("undo", 7)).toBeNull();
  });

  it("sees a step made elsewhere between its own even before its history has caught up", async () => {
    const ok = () => Promise.resolve({});
    void w.write({ send: ok, changes: rename("t", "A"), label: "Edit Action", undoSteps: () => 1, recordedStep: () => ({ id: 5, previous: 0 }) });
    void w.write({ send: ok, changes: rename("t", "C"), label: "Edit Action", undoSteps: () => 1, recordedStep: () => ({ id: 7, previous: 6 }) });
    await flush();
    // History still names step 5, but this tab knows the server has step 7, which follows step 6.
    expect(w.takeStep("undo", 5)?.redo).toEqual(rename("t", "C"));
    expect(w.takeStep("undo", 5)).toBeNull();
  });

  it("follows the server's undo history: a write it records no step for loses its own, a surprise clears them all", async () => {
    const ok = () => Promise.resolve({});
    void w.write({ send: ok, changes: rename("t", "A"), label: "Edit Action", undoSteps: () => 1 });
    void w.write({ send: ok, changes: [], label: "Clean Up", undoSteps: () => 0 });
    expect(w.writes.get().undo.map((s) => s.label)).toEqual(["Edit Action", "Clean Up"]);
    await flush();
    expect(w.writes.get().undo.map((s) => s.label)).toEqual(["Edit Action"]);
    // A discard expected to erase the creation step deleted the item instead.
    void w.write({ send: ok, erases: true, undoSteps: () => 1 });
    await flush();
    expect(w.writes.get().undo).toEqual([]);
  });

  it("keeps landed previews while the refresh cannot reach the server, and tries again", async () => {
    refresh.mockResolvedValueOnce(false);
    void w.write({ send: () => Promise.resolve({}), changes: rename("t", "A") });
    await flush();
    expect(w.writes.get().changes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(w.writes.get().changes).toHaveLength(0);
  });

  it("starts an upload only after the write creating its task has landed", async () => {
    const create = deferredSend();
    const upload = deferredSend();
    void w.write({ send: create.send, creates: ["n"] });
    expect(w.writes.get().unconfirmed.has("n")).toBe(true);
    void w.write({ send: upload.send, lane: "upload", waitFor: ["n"] });
    await flush();
    expect(upload.calls).toHaveLength(0);
    create.calls[0]?.resolve({});
    await flush();
    expect(upload.calls).toHaveLength(1);
    expect(w.writes.get().unconfirmed.has("n")).toBe(false);
  });

  it("counts an upload waiting for a rejected create in the one failure report", async () => {
    const create = deferredSend();
    void w.write({ send: create.send, creates: ["n"], changes: rename("n", "N") });
    const upload = w.write({ send: () => Promise.resolve({}), lane: "upload", waitFor: ["n"] });
    await flush();
    create.calls[0]?.reject(new ApiError(422, "invalid", "Nope."));
    await expect(upload).rejects.toBeInstanceOf(w.DiscardedError);
    expect(toast.mock.calls.map((c) => c[0])).toEqual(["Couldn't save: Nope. 1 later change was undone."]);
  });

  it("stops flagging a stall once an upload gives up", async () => {
    const upload = w.write({ send: () => Promise.reject(new ApiError(503, "down", "Storage down")), lane: "upload" });
    await flush();
    expect(w.writes.get().retryingSince).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(upload).rejects.toThrow("Storage down");
    expect(w.writes.get().retryingSince).toBeNull();
  });
});
