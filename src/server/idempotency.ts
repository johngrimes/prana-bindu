import type { MiddlewareHandler } from "hono";

/** A completed response kept for replay. */
interface Stored {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
  expires: number;
}

/** In-flight requests resolve to their stored response, or null when it was not cacheable (≥ 500 or thrown). */
type Entry = { done: Stored } | { pending: Promise<Stored | null> };

export interface IdempotencyOptions {
  /** Completed responses kept; the oldest are evicted first. Default 1000. */
  maxEntries?: number;
  /** How long a completed response is replayable. Default 10 minutes. */
  ttlMs?: number;
  now?: () => number;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_KEY_LENGTH = 200;

const replay = (s: Stored): Response =>
  new Response(s.body.byteLength === 0 ? null : s.body.slice(0), { status: s.status, headers: s.headers });

/**
 * Honours `Idempotency-Key` on unsafe methods: the first response (< 500) for a method + path + key is
 * cached in memory and replayed to later requests with the same key without re-running the handler.
 * A duplicate arriving while the first is still running waits for it; if that one fails (≥ 500 or
 * throws), the duplicate runs normally. Keys outside 1–200 characters are ignored. Mount after
 * authentication so replays never bypass it. The request body is never read here.
 */
export function idempotency(options: IdempotencyOptions = {}): MiddlewareHandler {
  const maxEntries = options.maxEntries ?? 1000;
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  /** Insertion order: completed entries are re-inserted on completion, so iteration runs oldest first. */
  const entries = new Map<string, Entry>();

  const evict = () => {
    let excess = entries.size - maxEntries;
    const t = now();
    for (const [key, entry] of entries) {
      if (!("done" in entry)) continue;
      if (excess <= 0 && entry.done.expires > t) break;
      entries.delete(key);
      excess--;
    }
  };

  return async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (!UNSAFE.has(c.req.method) || key === undefined || key.length < 1 || key.length > MAX_KEY_LENGTH) return next();
    const cacheKey = `${c.req.method} ${c.req.path} ${key}`;

    for (let entry = entries.get(cacheKey); entry; entry = entries.get(cacheKey)) {
      if ("done" in entry) {
        if (entry.done.expires > now()) return replay(entry.done);
        entries.delete(cacheKey);
        break;
      }
      const result = await entry.pending;
      if (result) return replay(result);
      // The earlier request failed; run unless another waiter has already taken over the key.
    }

    let settle!: (stored: Stored | null) => void;
    entries.set(cacheKey, { pending: new Promise((resolve) => (settle = resolve)) });
    let stored: Stored | null = null;
    try {
      await next();
      const res = c.res;
      if (res.status < 500) {
        stored = { status: res.status, headers: [...res.headers], body: await res.clone().arrayBuffer(), expires: now() + ttlMs };
      }
    } finally {
      entries.delete(cacheKey);
      if (stored) {
        entries.set(cacheKey, { done: stored });
        evict();
      }
      settle(stored);
    }
  };
}
