// Test support: an in-memory JMAP server with the subset of Fastmail's behaviour Mail Drop uses (session, Mailbox/get,
// Email/query, Email/get, Email/set, blob downloads and the EventSource push channel).
import { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import type { EmailBodyPart, JmapEmail } from "./message.js";

export const FAKE_TOKEN = "fmu1-test";
export const ACCOUNT_ID = "u1234";

export interface FakeMailbox {
  id: string;
  name: string;
  role: string | null;
}

interface StoredEmail extends JmapEmail {
  receivedAt: string;
  mailboxIds: Record<string, true>;
  keywords: Record<string, true>;
}

export interface Delivery {
  subject?: string | null;
  text?: string;
  html?: string;
  attachments?: DeliveredPart[];
  mailbox?: string;
  /** Send a push notification (default true). */
  notify?: boolean;
}

/**
 * A non-body part, filed the way RFC 8621 §4.1.4 files it: `attachment` (the default) in `attachments`; `inline`
 * media inside a multipart/mixed (iPhone Mail photos) in `textBody` and `htmlBody` only; `embedded` (a multipart/related
 * part the HTML references by `cid`, e.g. a signature logo) in `attachments` with inline disposition.
 */
export interface DeliveredPart {
  name: string | null;
  type: string;
  bytes: Uint8Array;
  kind?: "attachment" | "inline" | "embedded";
  cid?: string;
  /** Reported size, when it should differ from the bytes' length. */
  size?: number;
}

type Failure = "http500" | "notUpdated";

export class FakeJmap {
  readonly app = new Hono();
  readonly mailboxes: FakeMailbox[] = [
    { id: "mb-inbox", name: "Inbox", role: "inbox" },
    { id: "mb-trash", name: "Trash", role: "trash" },
    { id: "mb-drop", name: "Mail Drop", role: null },
  ];
  readonly emails = new Map<string, StoredEmail>();
  readonly blobs = new Map<string, Uint8Array>();
  /** Method names in the order they were called. */
  readonly calls: string[] = [];
  /** Open push connections. */
  readonly streams = new Set<SSEStreamingApi>();
  private readonly failures = new Map<string, Failure[]>();
  private seq = 0;
  private state = 0;
  /** Query parameters of each push connection. */
  readonly pushQueries: Record<string, string>[] = [];

  /**
   * `templatedEventSource` advertises an RFC 8620 URI template as eventSourceUrl; by default it is a plain URL, as
   * Fastmail's is.
   */
  constructor(
    readonly origin = "http://jmap.test",
    opts: { templatedEventSource?: boolean } = {},
  ) {
    this.app.use("*", async (c, next) => {
      if (c.req.header("Authorization") !== `Bearer ${FAKE_TOKEN}`) return c.text("Unauthorized", 401);
      await next();
    });
    this.app.get("/jmap/session", (c) =>
      c.json({
        apiUrl: `${this.origin}/jmap/api/`,
        downloadUrl: `${this.origin}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
        eventSourceUrl: opts.templatedEventSource
          ? `${this.origin}/jmap/event/?types={types}&closeafter={closeafter}&ping={ping}`
          : `${this.origin}/jmap/event/`,
        primaryAccounts: { "urn:ietf:params:jmap:mail": ACCOUNT_ID },
      }),
    );
    this.app.get("/jmap/download/:account/:blob/:name", (c) => {
      const bytes = this.blobs.get(c.req.param("blob"));
      if (!bytes) return c.text("Not found", 404);
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { "Content-Type": c.req.query("type") ?? "application/octet-stream" });
    });
    this.app.get("/jmap/event/", (c) => {
      this.pushQueries.push(c.req.query());
      return streamSSE(c, async (stream) => {
        this.streams.add(stream);
        stream.onAbort(() => {
          this.streams.delete(stream);
        });
        await stream.writeSSE({ event: "ping", data: JSON.stringify({ interval: Number(c.req.query("ping")) }) });
        while (!stream.aborted && !stream.closed) await stream.sleep(20);
        this.streams.delete(stream);
      });
    });
    this.app.post("/jmap/api/", async (c) => {
      const { methodCalls } = await c.req.json<{ methodCalls: [string, Record<string, unknown>, string][] }>();
      const responses: [string, Record<string, unknown>, string][] = [];
      for (const [name, args, callId] of methodCalls) {
        this.calls.push(name);
        const failure = this.failures.get(name)?.shift();
        if (failure === "http500") return c.text("Internal error", 500);
        responses.push([name, this.handle(name, args, responses, failure), callId]);
      }
      return c.json({ methodResponses: responses });
    });
  }

  /** `fetch` that routes to this server in-process. */
  readonly fetch: typeof fetch = (input, init) => Promise.resolve(this.app.fetch(new Request(input, init)));

  /** Makes the next call(s) to `method` fail. */
  failNext(method: string, failure: Failure, times = 1): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...Array<Failure>(times).fill(failure)]);
  }

  /** Files a message into a mailbox (default "Mail Drop") and notifies push listeners. Returns its id. */
  deliver(d: Delivery): string {
    const id = `M${++this.seq}`;
    const textBody: EmailBodyPart[] = [];
    const htmlBody: EmailBodyPart[] = [];
    const attachments: EmailBodyPart[] = [];
    const bodyValues: JmapEmail["bodyValues"] = {};
    let part = 0;
    const addValue = (type: string, value: string): EmailBodyPart => {
      const partId = String(++part);
      bodyValues[partId] = { value, isEncodingProblem: false, isTruncated: false };
      return { partId, blobId: `${id}-${partId}`, size: value.length, name: null, type, disposition: null, cid: null };
    };
    if (d.text !== undefined) textBody.push(addValue("text/plain", d.text));
    if (d.html !== undefined) htmlBody.push(addValue("text/html", d.html));
    if (d.text === undefined && d.html !== undefined) textBody.push(htmlBody[0]!);
    if (d.html === undefined && d.text !== undefined) htmlBody.push(textBody[0]!);
    for (const a of d.attachments ?? []) {
      const partId = String(++part);
      const blobId = `${id}-${partId}`;
      this.blobs.set(blobId, a.bytes);
      const kind = a.kind ?? "attachment";
      const bodyPart: EmailBodyPart = {
        partId,
        blobId,
        size: a.size ?? a.bytes.byteLength,
        name: a.name,
        type: a.type,
        disposition: kind === "attachment" ? "attachment" : "inline",
        cid: a.cid ?? null,
      };
      if (kind === "inline") {
        textBody.push(bodyPart);
        htmlBody.push(bodyPart);
      } else attachments.push(bodyPart);
    }
    const mailbox = this.mailboxes.find((m) => m.name === (d.mailbox ?? "Mail Drop"))!;
    this.emails.set(id, {
      id,
      subject: d.subject === undefined ? "Subject" : d.subject,
      textBody,
      htmlBody,
      attachments,
      bodyValues,
      receivedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, this.seq)).toISOString(),
      mailboxIds: { [mailbox.id]: true },
      keywords: {},
    });
    if (d.notify !== false) this.changed();
    return id;
  }

  /** Ids of the messages in a mailbox, by name. */
  inMailbox(name: string): string[] {
    const mailbox = this.mailboxes.find((m) => m.name === name)!;
    return [...this.emails.values()].filter((e) => e.mailboxIds[mailbox.id]).map((e) => e.id);
  }

  /** Sends a StateChange for Email to every push listener. */
  changed(): void {
    const data = JSON.stringify({ "@type": "StateChange", changed: { [ACCOUNT_ID]: { Email: String(++this.state) } } });
    for (const s of this.streams) void s.writeSSE({ event: "state", data });
  }

  /** Ends every push connection from the server side. */
  async dropStreams(): Promise<void> {
    await Promise.all([...this.streams].map((s) => s.close()));
    this.streams.clear();
  }

  private handle(name: string, args: Record<string, unknown>, previous: [string, Record<string, unknown>, string][], failure?: Failure) {
    switch (name) {
      case "Mailbox/get":
        return { accountId: ACCOUNT_ID, list: this.mailboxes.map(({ id, name, role }) => ({ id, name, role })), notFound: [] };
      case "Email/query": {
        const filter = args.filter as { inMailbox: string };
        const position = (args.position as number | undefined) ?? 0;
        const limit = (args.limit as number | undefined) ?? 1000;
        const ids = [...this.emails.values()]
          .filter((e) => e.mailboxIds[filter.inMailbox])
          .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
          .map((e) => e.id);
        return { accountId: ACCOUNT_ID, ids: ids.slice(position, position + limit), position };
      }
      case "Email/get": {
        const ref = args["#ids"] as { resultOf: string } | undefined;
        const ids = ref ? (previous.find((r) => r[2] === ref.resultOf)![1].ids as string[]) : (args.ids as string[]);
        const props = args.properties as string[];
        const list = ids.map((id) => {
          const e = this.emails.get(id)!;
          return Object.fromEntries(props.map((p) => [p, e[p as keyof StoredEmail]]));
        });
        return { accountId: ACCOUNT_ID, list, notFound: [] };
      }
      case "Email/set": {
        const update = args.update as Record<string, Record<string, unknown>>;
        const updated: Record<string, null> = {};
        const notUpdated: Record<string, { type: string }> = {};
        for (const [id, patch] of Object.entries(update)) {
          const e = this.emails.get(id);
          if (!e || failure === "notUpdated") {
            notUpdated[id] = { type: e ? "serverFail" : "notFound" };
            continue;
          }
          for (const [path, value] of Object.entries(patch)) {
            if (path === "mailboxIds") e.mailboxIds = value as Record<string, true>;
            else if (path.startsWith("keywords/")) e.keywords[path.slice(9)] = true;
          }
          updated[id] = null;
        }
        this.changed();
        return { accountId: ACCOUNT_ID, updated, notUpdated: Object.keys(notUpdated).length ? notUpdated : null };
      }
      default:
        throw new Error(`FakeJmap: unsupported method ${name}`);
    }
  }
}
