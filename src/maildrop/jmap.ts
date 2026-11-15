// Minimal JMAP client (RFC 8620/8621) for Mail Drop: session discovery, method calls, blob downloads and the
// EventSource push channel. Authenticates with a bearer API token, which is never logged.

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** Seconds between server pings requested on the push channel. */
export const PUSH_PING_SECONDS = 60;
/** The push connection counts as dead when nothing arrives for three ping intervals. */
const PUSH_SILENCE_TIMEOUT_MS = 3 * PUSH_PING_SECONDS * 1000;

export class JmapError extends Error {
  override name = "JmapError";
}

export interface JmapSession {
  accountId: string;
  apiUrl: string;
  downloadUrl: string;
  eventSourceUrl: string;
}

export type MethodCall = [name: string, args: Record<string, unknown>, callId: string];
type MethodResponse = [name: string, args: Record<string, unknown>, callId: string];

export interface PushHandlers {
  /** The push connection is open. */
  onOpen(): void;
  /** Emails in the account changed. */
  onEmailChange(): void;
}

const expand = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? encodeURIComponent(values[key]!) : whole));

export class JmapClient {
  private sessionPromise: Promise<JmapSession> | null = null;
  private readonly fetch: typeof fetch;

  /** `signal` aborts every request, including the push connection. `silenceTimeoutMs` defaults to three ping intervals. */
  constructor(
    private readonly opts: { sessionUrl: string; token: string; signal: AbortSignal; fetch?: typeof fetch; silenceTimeoutMs?: number },
  ) {
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  /** The session resource, fetched once and cached until a request fails. */
  session(): Promise<JmapSession> {
    this.sessionPromise ??= this.loadSession().catch((e: unknown) => {
      this.sessionPromise = null;
      throw e;
    });
    return this.sessionPromise;
  }

  private async loadSession(): Promise<JmapSession> {
    const body = (await (await this.request(this.opts.sessionUrl, {}, REQUEST_TIMEOUT_MS)).json()) as {
      apiUrl?: string;
      downloadUrl?: string;
      eventSourceUrl?: string;
      primaryAccounts?: Record<string, string>;
    };
    const accountId = body.primaryAccounts?.[MAIL_CAPABILITY];
    if (!accountId || !body.apiUrl || !body.downloadUrl || !body.eventSourceUrl) {
      throw new JmapError("JMAP session has no mail account (does the token have the Mail scope?)");
    }
    return { accountId, apiUrl: body.apiUrl, downloadUrl: body.downloadUrl, eventSourceUrl: body.eventSourceUrl };
  }

  /** Sends one request; returns each method's response arguments by call id. Any method error throws. */
  async call(calls: MethodCall[]): Promise<Map<string, Record<string, unknown>>> {
    const session = await this.session();
    const res = await this.guard(
      this.request(
        session.apiUrl,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ using: USING, methodCalls: calls }) },
        REQUEST_TIMEOUT_MS,
      ),
    );
    const { methodResponses } = (await res.json()) as { methodResponses: MethodResponse[] };
    const results = new Map<string, Record<string, unknown>>();
    for (const [name, args, callId] of methodResponses) {
      if (name === "error") {
        const call = calls.find((c) => c[2] === callId)?.[0] ?? callId;
        throw new JmapError(`${call} failed: ${String(args.type)}${args.description ? ` (${String(args.description)})` : ""}`);
      }
      results.set(callId, args);
    }
    return results;
  }

  async download(blobId: string, name: string, type: string): Promise<Uint8Array> {
    const session = await this.session();
    const url = expand(session.downloadUrl, { accountId: session.accountId, blobId, name, type });
    const res = await this.guard(this.request(url, {}, DOWNLOAD_TIMEOUT_MS));
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Holds the push connection open, reporting email changes, until the server closes it (resolves), it fails or is
   * silent for `silenceTimeoutMs`, from the request on (rejects), or the client's signal aborts (resolves).
   */
  async listen(handlers: PushHandlers): Promise<void> {
    const { signal } = this.opts;
    const silenceTimeoutMs = this.opts.silenceTimeoutMs ?? PUSH_SILENCE_TIMEOUT_MS;
    const session = await this.session();
    const params = { types: "Email", closeafter: "no", ping: String(PUSH_PING_SECONDS) };
    let url: string;
    if (session.eventSourceUrl.includes("{")) url = expand(session.eventSourceUrl, params);
    else {
      // Fastmail's eventSourceUrl is a plain URL that takes the RFC 8620 template variables as query parameters.
      const u = new URL(session.eventSourceUrl);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      url = u.href;
    }
    const silent = new AbortController();
    let lastActivity = Date.now();
    const watchdog = setInterval(
      () => {
        if (Date.now() - lastActivity >= silenceTimeoutMs) silent.abort();
      },
      Math.min(10_000, silenceTimeoutMs / 4),
    );
    let reader: ReadableStreamDefaultReader<string> | undefined;
    const cancel = () => void reader?.cancel().catch(() => {});
    signal.addEventListener("abort", cancel);
    silent.signal.addEventListener("abort", cancel);
    try {
      const res = await this.guard(this.request(url, { headers: { Accept: "text/event-stream" }, signal: silent.signal }, null));
      if (!res.body) throw new JmapError("Push connection has no body");
      reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      lastActivity = Date.now();
      handlers.onOpen();
      let buffer = "";
      let event = { type: "", data: [] as string[] };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        lastActivity = Date.now();
        let text = buffer + value;
        // A CR at the end may be the first half of a CRLF split across chunks.
        const held = text.endsWith("\r") ? "\r" : "";
        if (held) text = text.slice(0, -1);
        const lines = text.split(/\r\n|\r|\n/);
        buffer = lines.pop()! + held;
        for (const line of lines) {
          if (line === "") {
            if (event.type === "state" && this.emailChanged(event.data.join("\n"), session.accountId)) handlers.onEmailChange();
            event = { type: "", data: [] };
          } else if (line.startsWith("event:")) event.type = line.slice(6).trim();
          else if (line.startsWith("data:")) event.data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    } catch (e) {
      if (!signal.aborted && !silent.signal.aborted) throw e;
    } finally {
      clearInterval(watchdog);
      signal.removeEventListener("abort", cancel);
    }
    if (silent.signal.aborted && !signal.aborted) {
      this.sessionPromise = null;
      throw new JmapError(`Push connection silent for ${silenceTimeoutMs / 1000} seconds`);
    }
  }

  private emailChanged(data: string, accountId: string): boolean {
    try {
      const change = JSON.parse(data) as { changed?: Record<string, Record<string, string>> };
      return change.changed?.[accountId]?.Email !== undefined;
    } catch {
      return false;
    }
  }

  /** Forgets the session after a failed request, so the next request rediscovers the API endpoints. */
  private async guard(res: Promise<Response>): Promise<Response> {
    try {
      return await res;
    } catch (e) {
      this.sessionPromise = null;
      throw e;
    }
  }

  private async request(url: string, init: RequestInit, timeoutMs: number | null): Promise<Response> {
    const signals = [this.opts.signal, init.signal, timeoutMs === null ? null : AbortSignal.timeout(timeoutMs)].filter((s) => s != null);
    const res = await this.fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.opts.token}` },
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) {
      await res.body?.cancel();
      const hint = res.status === 401 || res.status === 403 ? " (check PRANA_MAIL_DROP_FASTMAIL_TOKEN)" : "";
      throw new JmapError(`${init.method ?? "GET"} ${new URL(url).pathname} returned HTTP ${res.status}${hint}`);
    }
    return res;
  }
}
