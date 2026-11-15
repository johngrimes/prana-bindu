// Mail Drop: turns messages filed into one Fastmail mailbox into inbox items, then moves them to Trash
// (docs/spec.md §14). Watches the mailbox through JMAP push, with a periodic full check as a safety net.
import { setTimeout as sleep } from "node:timers/promises";
import type { MailDropConfig } from "../config.js";
import { MAX_ATTACHMENT_BYTES, type Domain } from "../domain/index.js";
import { JmapClient, type MethodCall } from "./jmap.js";
import { EMAIL_PROPERTIES, mailDropItem, type JmapEmail } from "./message.js";

const BATCH_SIZE = 50;
const BODY_PROPERTIES = ["partId", "blobId", "size", "name", "type", "disposition", "cid"];

export interface MailDropOptions {
  domain: Domain;
  config: MailDropConfig;
  fetch?: typeof fetch;
  log?: Pick<Console, "log" | "error">;
  /** Full check interval (default 5 minutes). */
  pollIntervalMs?: number;
  /** Push reconnect delay: starts at `min`, doubles after each failure up to `max` (default 5 s to 5 min). */
  reconnectDelayMs?: { min: number; max: number };
  /** The push connection is dropped and reconnected after this long without data (default 3 minutes: three pings). */
  pushSilenceTimeoutMs?: number;
}

interface Mailbox {
  id: string;
  name: string;
  role: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class MailDrop {
  private readonly client: JmapClient;
  private readonly log: Pick<Console, "log" | "error">;
  private readonly stopController = new AbortController();
  private pollTimer: NodeJS.Timeout | undefined;
  private pushLoop: Promise<void> | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly opts: MailDropOptions) {
    this.client = new JmapClient({
      sessionUrl: opts.config.sessionUrl,
      token: opts.config.token,
      signal: this.stopController.signal,
      fetch: opts.fetch,
      silenceTimeoutMs: opts.pushSilenceTimeoutMs,
    });
    this.log = opts.log ?? console;
  }

  /**
   * Starts watching: connects the push channel and schedules the full checks. Each push connection attempt runs a
   * check, once open (catching up on mail that arrived while disconnected) or once it has failed, so a check also
   * runs at startup when push is unavailable.
   */
  start(): void {
    this.log.log(`Mail Drop: watching mailbox "${this.opts.config.mailbox}"`);
    this.pollTimer = setInterval(() => void this.check(), this.opts.pollIntervalMs ?? 5 * 60_000);
    this.pushLoop = this.runPush();
  }

  /** Stops watching: aborts open requests and waits for a running check to finish. */
  async stop(): Promise<void> {
    this.stopController.abort();
    clearInterval(this.pollTimer);
    await Promise.all([this.pushLoop, this.running]);
  }

  /**
   * Processes every message in the mailbox. Calls during a check make it run once more afterwards, so a message
   * that arrives mid-check is not missed. Never rejects: problems are logged and retried by the next check.
   */
  check(): Promise<void> {
    if (this.stopController.signal.aborted) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.processMailbox();
        } catch (e) {
          if (!this.stopController.signal.aborted) this.log.error(`Mail Drop: check failed: ${message(e)}`);
        }
      } while (this.again && !this.stopController.signal.aborted);
      this.running = null;
    })();
    return this.running;
  }

  private async runPush(): Promise<void> {
    const { min, max } = this.opts.reconnectDelayMs ?? { min: 5_000, max: 5 * 60_000 };
    const signal = this.stopController.signal;
    let delay = min;
    while (!signal.aborted) {
      let opened = false;
      try {
        await this.client.listen({
          onOpen: () => {
            opened = true;
            delay = min;
            void this.check();
          },
          onEmailChange: () => void this.check(),
        });
      } catch (e) {
        if (signal.aborted) break;
        this.log.error(`Mail Drop: push connection failed: ${message(e)}; reconnecting in ${delay / 1000}s`);
        if (!opened) void this.check();
      }
      // Rejects when stopped; the loop condition then ends the loop.
      await sleep(delay, undefined, { signal }).catch(() => {});
      delay = Math.min(delay * 2, max);
    }
  }

  private async mailboxes(): Promise<{ source: Mailbox; trash: Mailbox }> {
    const { accountId } = await this.client.session();
    const res = await this.client.call([["Mailbox/get", { accountId, ids: null, properties: ["id", "name", "role"] }, "m"]]);
    const list = res.get("m")!.list as Mailbox[];
    const name = this.opts.config.mailbox;
    const named = list.filter((m) => m.name === name);
    if (named.length === 0) throw new Error(`mailbox "${name}" not found`);
    if (named.length > 1) throw new Error(`${named.length} mailboxes are named "${name}"; rename all but one`);
    const source = named[0]!;
    if (source.role) throw new Error(`mailbox "${name}" is the ${source.role} mailbox; Mail Drop needs a mailbox of its own`);
    const trash = list.find((m) => m.role === "trash");
    if (!trash) throw new Error("the account has no Trash mailbox");
    return { source, trash };
  }

  private async processMailbox(): Promise<void> {
    const { accountId } = await this.client.session();
    const { source, trash } = await this.mailboxes();
    // Messages that fail stay in the mailbox, ahead of the rest in receivedAt order, until the next check.
    let failed = 0;
    for (;;) {
      if (this.stopController.signal.aborted) return;
      const calls: MethodCall[] = [
        [
          "Email/query",
          {
            accountId,
            filter: { inMailbox: source.id },
            sort: [{ property: "receivedAt", isAscending: true }],
            position: failed,
            limit: BATCH_SIZE,
          },
          "q",
        ],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: EMAIL_PROPERTIES,
            bodyProperties: BODY_PROPERTIES,
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
          },
          "g",
        ],
      ];
      const res = await this.client.call(calls);
      const ids = res.get("q")!.ids as string[];
      // Email/get may answer in any order (RFC 8620 §5.1); keep the query's oldest-first order.
      const order = new Map(ids.map((id, i) => [id, i]));
      const emails = (res.get("g")!.list as JmapEmail[]).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      for (const email of emails) {
        if (this.stopController.signal.aborted) return;
        try {
          await this.processEmail(accountId, email, trash.id);
        } catch (e) {
          if (this.stopController.signal.aborted) return;
          failed++;
          this.log.error(`Mail Drop: message ${email.id} failed: ${message(e)}`);
        }
      }
      if (ids.length < BATCH_SIZE) return;
    }
  }

  private async processEmail(accountId: string, email: JmapEmail, trashId: string): Promise<void> {
    const source = { accountId, emailId: email.id };
    if (!this.opts.domain.isMailDropProcessed(source)) {
      const item = mailDropItem(email);
      const oversized = item.attachments.find((a) => a.size > MAX_ATTACHMENT_BYTES);
      if (oversized) throw new Error(`attachment "${oversized.name}" is larger than 100 MB`);
      const attachments = [];
      for (const a of item.attachments) {
        attachments.push({ name: a.name, bytes: await this.client.download(a.blobId, a.name, a.type), contentType: a.type });
      }
      const task = await this.opts.domain.createMailDropItem({ source, name: item.name, note: item.note, attachments });
      if (task) {
        const extra = attachments.length > 0 ? ` with ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}` : "";
        this.log.log(`Mail Drop: added "${task.name}"${extra}`);
      }
    }
    const res = await this.client.call([
      ["Email/set", { accountId, update: { [email.id]: { mailboxIds: { [trashId]: true }, "keywords/$seen": true } } }, "s"],
    ]);
    const notUpdated = (res.get("s")!.notUpdated as Record<string, { type: string; description?: string }> | null)?.[email.id];
    if (notUpdated) throw new Error(`moving to Trash failed: ${notUpdated.type}${notUpdated.description ? ` (${notUpdated.description})` : ""}`);
  }
}
