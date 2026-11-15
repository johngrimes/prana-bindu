import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createTestEnv } from "../domain/testkit.js";
import { MailDrop } from "./index.js";
import { FAKE_TOKEN, FakeJmap } from "./testkit.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

function setup(
  opts: {
    mailbox?: string;
    token?: string;
    wrapFetch?: (f: typeof fetch) => typeof fetch;
    pollIntervalMs?: number;
    pushSilenceTimeoutMs?: number;
    templatedEventSource?: boolean;
  } = {},
) {
  const env = createTestEnv();
  const fake = new FakeJmap(undefined, { templatedEventSource: opts.templatedEventSource });
  const logs = { info: [] as string[], errors: [] as string[] };
  const mailDrop = new MailDrop({
    domain: env.domain,
    config: { token: opts.token ?? FAKE_TOKEN, mailbox: opts.mailbox ?? "Mail Drop", sessionUrl: `${fake.origin}/jmap/session` },
    fetch: opts.wrapFetch ? opts.wrapFetch(fake.fetch) : fake.fetch,
    log: { log: (m: string) => logs.info.push(m), error: (m: string) => logs.errors.push(m) },
    pollIntervalMs: opts.pollIntervalMs,
    pushSilenceTimeoutMs: opts.pushSilenceTimeoutMs,
    reconnectDelayMs: { min: 20, max: 40 },
  });
  onTestFinished(() => mailDrop.stop());
  const inbox = () => env.domain.listTasks({ inbox: true }).items;
  return { ...env, fake, logs, mailDrop, inbox };
}

describe("MailDrop", () => {
  it("turns each message into an inbox item, oldest first, and moves it to Trash marked read", async () => {
    const { fake, mailDrop, inbox, domain, logs } = setup();
    fake.deliver({ subject: "RE: Book flights [SEC=OFFICIAL]", text: "Melbourne, 3 nights" });
    const second = fake.deliver({
      subject: "Fwd: Invoice",
      html: '<p>Pay by Friday</p><img src="cid:logo@x">',
      attachments: [
        { name: "invoice.pdf", type: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7") },
        { name: "logo.png", type: "image/png", bytes: png, cid: "logo@x", kind: "embedded" },
      ],
    });
    fake.deliver({ subject: "Not for Mail Drop", text: "hello", mailbox: "Inbox" });

    await mailDrop.check();

    expect(inbox().map((t) => [t.name, t.note])).toEqual([
      ["Book flights", "Melbourne, 3 nights"],
      ["Invoice", "Pay by Friday"],
    ]);
    expect(domain.listAttachments(inbox()[1]!.id).map((a) => [a.name, a.contentType])).toEqual([["invoice.pdf", "application/pdf"]]);
    expect(fake.inMailbox("Mail Drop")).toEqual([]);
    expect(fake.inMailbox("Trash")).toEqual(["M1", "M2"]);
    expect(fake.inMailbox("Inbox")).toEqual(["M3"]);
    expect(fake.emails.get(second)!.keywords).toEqual({ $seen: true });
    expect(logs.info).toEqual(['Mail Drop: added "Book flights"', 'Mail Drop: added "Invoice" with 1 attachment']);
    expect(logs.errors).toEqual([]);
  });

  it("attaches a photo sent the iPhone way, inline in the text body", async () => {
    const { fake, mailDrop, inbox, domain } = setup();
    fake.deliver({ subject: "Receipt photo", text: "For the tax return", attachments: [{ name: "IMG_0042.jpg", type: "image/jpeg", bytes: png, kind: "inline" }] });
    await mailDrop.check();
    const [item] = inbox();
    expect(item!.name).toBe("Receipt photo");
    expect(domain.listAttachments(item!.id).map((a) => [a.name, a.contentType, a.size])).toEqual([["IMG_0042.jpg", "image/png", png.byteLength]]);
  });

  it("leaves a message with an attachment over 100 MB in the mailbox without downloading it", async () => {
    const requests: string[] = [];
    const { fake, mailDrop, inbox, logs } = setup({
      wrapFetch: (f) => (input, init) => (requests.push(String(input)), f(input, init)),
    });
    fake.deliver({ subject: "Huge", text: "", attachments: [{ name: "disk.img", type: "application/octet-stream", bytes: png, size: 100 * 1024 * 1024 + 1 }] });
    await mailDrop.check();
    expect(inbox()).toEqual([]);
    expect(fake.inMailbox("Mail Drop")).toEqual(["M1"]);
    expect(logs.errors).toEqual(['Mail Drop: message M1 failed: attachment "disk.img" is larger than 100 MB']);
    expect(requests.filter((url) => url.includes("/jmap/download/"))).toEqual([]);
  });

  it("does not create a second item when moving the message to Trash failed", async () => {
    const { fake, mailDrop, inbox, logs } = setup();
    fake.deliver({ subject: "Once only", text: "" });
    fake.failNext("Email/set", "notUpdated");
    await mailDrop.check();
    expect(inbox().map((t) => t.name)).toEqual(["Once only"]);
    expect(fake.inMailbox("Mail Drop")).toEqual(["M1"]);
    expect(logs.errors).toEqual(["Mail Drop: message M1 failed: moving to Trash failed: serverFail"]);

    await mailDrop.check();
    expect(inbox().map((t) => t.name)).toEqual(["Once only"]);
    expect(fake.inMailbox("Trash")).toEqual(["M1"]);
  });

  it("keeps a failing message for the next check without holding up later ones", async () => {
    const { fake, mailDrop, inbox, logs } = setup();
    fake.deliver({ subject: "Broken", text: "", attachments: [{ name: "a.png", type: "image/png", bytes: png }] });
    fake.deliver({ subject: "Fine", text: "" });
    const blob = fake.blobs.get("M1-2")!;
    fake.blobs.delete("M1-2");

    await mailDrop.check();
    expect(inbox().map((t) => t.name)).toEqual(["Fine"]);
    expect(fake.inMailbox("Mail Drop")).toEqual(["M1"]);
    expect(logs.errors).toEqual([expect.stringMatching(/^Mail Drop: message M1 failed: GET \/jmap\/download\/.* returned HTTP 404$/)]);

    fake.blobs.set("M1-2", blob);
    await mailDrop.check();
    expect(inbox().map((t) => t.name)).toEqual(["Fine", "Broken"]);
    expect(fake.inMailbox("Mail Drop")).toEqual([]);
  });

  it("works through more messages than fit in one request", async () => {
    const { fake, mailDrop, inbox } = setup();
    for (let i = 1; i <= 120; i++) fake.deliver({ subject: `Item ${i}`, text: "", notify: false });
    await mailDrop.check();
    expect(inbox().map((t) => t.name)).toEqual(Array.from({ length: 120 }, (_, i) => `Item ${i + 1}`));
    expect(fake.inMailbox("Mail Drop")).toEqual([]);
  });

  it.each([
    ["Inbox", undefined, 'Mail Drop: check failed: mailbox "Inbox" is the inbox mailbox; Mail Drop needs a mailbox of its own'],
    ["Tasks", undefined, 'Mail Drop: check failed: mailbox "Tasks" not found'],
    ["Mail Drop", "Mail Drop", 'Mail Drop: check failed: 2 mailboxes are named "Mail Drop"; rename all but one'],
  ])("refuses mailbox %j (duplicate: %s) without reading any mail", async (mailbox, duplicate, error) => {
    const { fake, mailDrop, inbox, logs } = setup({ mailbox });
    if (duplicate) fake.mailboxes.push({ id: "mb-dup", name: duplicate, role: null });
    fake.deliver({ subject: "x", text: "", mailbox: "Inbox" });
    await mailDrop.check();
    expect(logs.errors).toEqual([error]);
    expect(fake.calls).toEqual(["Mailbox/get"]);
    expect(inbox()).toEqual([]);
  });

  it("reports a rejected token", async () => {
    const { mailDrop, logs } = setup({ token: "wrong" });
    await mailDrop.check();
    expect(logs.errors).toEqual(["Mail Drop: check failed: GET /jmap/session returned HTTP 401 (check PRANA_MAIL_DROP_FASTMAIL_TOKEN)"]);
  });

  it("catches up when started, then adds new mail as it arrives, also after the push connection drops", async () => {
    const { fake, mailDrop, inbox, logs } = setup({ pollIntervalMs: 60_000 });
    fake.deliver({ subject: "Waiting", text: "" });
    mailDrop.start();
    await vi.waitFor(() => expect(inbox().map((t) => t.name)).toEqual(["Waiting"]));
    await vi.waitFor(() => expect(fake.streams.size).toBe(1));

    fake.deliver({ subject: "Pushed", text: "" });
    await vi.waitFor(() => expect(inbox().map((t) => t.name)).toEqual(["Waiting", "Pushed"]));

    await fake.dropStreams();
    await vi.waitFor(() => expect(fake.streams.size).toBe(1));
    fake.deliver({ subject: "After reconnect", text: "" });
    await vi.waitFor(() => expect(inbox().map((t) => t.name)).toEqual(["Waiting", "Pushed", "After reconnect"]));
    expect(logs.errors).toEqual([]);

    await mailDrop.stop();
    expect(fake.streams.size).toBe(0);
  });

  it("finds mail the push channel missed on the periodic check", async () => {
    const { fake, mailDrop, inbox } = setup({ pollIntervalMs: 50 });
    mailDrop.start();
    await vi.waitFor(() => expect(fake.streams.size).toBe(1));
    fake.deliver({ subject: "Silent", text: "", notify: false });
    await vi.waitFor(() => expect(inbox().map((t) => t.name)).toEqual(["Silent"]));
  });

  it.each([
    ["a plain URL (as Fastmail's is)", false],
    ["an RFC 8620 URI template", true],
  ])("asks for Email changes with 60-second pings when the push URL is %s", async (_, templatedEventSource) => {
    const { fake, mailDrop, inbox } = setup({ pollIntervalMs: 60_000, templatedEventSource });
    mailDrop.start();
    await vi.waitFor(() => expect(fake.streams.size).toBe(1));
    expect(fake.pushQueries).toEqual([{ types: "Email", closeafter: "no", ping: "60" }]);
    fake.deliver({ subject: "Pushed", text: "" });
    await vi.waitFor(() => expect(inbox().map((t) => t.name)).toEqual(["Pushed"]));
  });

  it("checks at startup and reconnects with doubling delays, up to the maximum, while push is unreachable", async () => {
    let down = true;
    const { fake, mailDrop, logs, inbox } = setup({
      pollIntervalMs: 60_000,
      wrapFetch: (f) => (input, init) =>
        down && String(input).includes("/jmap/event/") ? Promise.reject(new TypeError("fetch failed")) : f(input, init),
    });
    fake.deliver({ subject: "Waiting", text: "", notify: false });
    mailDrop.start();
    await vi.waitFor(() => expect(inbox().map((t) => t.name)).toEqual(["Waiting"]));
    await vi.waitFor(() => expect(logs.errors.length).toBeGreaterThanOrEqual(3));
    expect(logs.errors.slice(0, 3)).toEqual([
      "Mail Drop: push connection failed: fetch failed; reconnecting in 0.02s",
      "Mail Drop: push connection failed: fetch failed; reconnecting in 0.04s",
      "Mail Drop: push connection failed: fetch failed; reconnecting in 0.04s",
    ]);
    down = false;
    await vi.waitFor(() => expect(fake.streams.size).toBe(1));
  });

  it("drops and reconnects a push connection that goes silent, before or after its headers arrive", async () => {
    let eventRequests = 0;
    const { fake, mailDrop, logs, inbox } = setup({
      pollIntervalMs: 60_000,
      pushSilenceTimeoutMs: 100,
      wrapFetch: (f) => (input, init) => {
        if (!String(input).includes("/jmap/event/") || ++eventRequests > 1) return f(input, init);
        // The first connection never answers (ES2023 lib: no Promise.withResolvers).
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      },
    });
    mailDrop.start();
    // The second connection gets one ping and then nothing, like a connection lost without a FIN.
    await vi.waitFor(() => expect(fake.pushQueries.length).toBeGreaterThanOrEqual(2));
    fake.deliver({ subject: "Missed while silent", text: "", notify: false });
    await vi.waitFor(() => expect(inbox().map((t) => t.name)).toEqual(["Missed while silent"]));
    expect(logs.errors.slice(0, 2)).toEqual([
      "Mail Drop: push connection failed: Push connection silent for 0.1 seconds; reconnecting in 0.02s",
      "Mail Drop: push connection failed: Push connection silent for 0.1 seconds; reconnecting in 0.02s",
    ]);
  });
});
