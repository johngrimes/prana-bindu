import { describe, expect, it } from "vitest";
import { cleanSubject, mailDropItem, type EmailBodyPart, type JmapEmail } from "./message.js";

function part(partId: string, type: string, extra: Partial<EmailBodyPart> = {}): EmailBodyPart {
  return { partId, blobId: `B${partId}`, size: 10, name: null, type, disposition: null, cid: null, ...extra };
}

function email(fields: Partial<JmapEmail> & { values?: Record<string, string> }): JmapEmail {
  const { values = {}, ...rest } = fields;
  return {
    id: "M1",
    subject: "Subject",
    textBody: [],
    htmlBody: [],
    attachments: [],
    bodyValues: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value, isEncodingProblem: false, isTruncated: false }])),
    ...rest,
  };
}

describe("cleanSubject", () => {
  it.each([
    ["Buy milk", "Buy milk"],
    ["Re: Buy milk", "Buy milk"],
    ["RE: FW: Fwd: re: Buy milk", "Buy milk"],
    ["Re[2]: Buy milk", "Buy milk"],
    ["Re (3) : Buy milk", "Buy milk"],
    ["FWD:Buy milk", "Buy milk"],
    ["Buy milk [SEC=OFFICIAL]", "Buy milk"],
    ["[SEC=OFFICIAL:Sensitive] RE: Budget", "Budget"],
    ["RE: [SEC=PROTECTED, CAVEAT=SH:CABINET] Budget [DLM=For-Official-Use-Only]", "Budget"],
    ["  Spaced \t out  ", "Spaced out"],
    ["Reply to Fred: about re: things", "Reply to Fred: about re: things"],
    ["Fwdx: not a prefix", "Fwdx: not a prefix"],
    ["[Ticket 12] Reboot", "[Ticket 12] Reboot"],
    ["Re: ", ""],
    [null, ""],
  ])("%j → %j", (subject, expected) => {
    expect(cleanSubject(subject)).toBe(expected);
  });
});

describe("mailDropItem", () => {
  it("uses the cleaned subject as the name and the plain-text body as the note", () => {
    const item = mailDropItem(
      email({ subject: "Fwd: Renew passport [SEC=OFFICIAL]", textBody: [part("1", "text/plain")], values: { "1": "Form is online.\r\n\r\nDue in May.\r\n" } }),
    );
    expect(item).toEqual({ name: "Renew passport", note: "Form is online.\n\nDue in May.", attachments: [] });
  });

  it("joins text parts and converts HTML-only bodies to text", () => {
    const html = '<html><head><style>p{color:red}</style></head><body><h1>Agenda</h1><p>See <a href="https://x.test/doc">the doc</a> &amp; reply.</p><img src="cid:logo"><ul><li>One</li><li>Two</li></ul></body></html>';
    const item = mailDropItem(
      email({
        textBody: [part("1", "text/plain"), part("2", "image/jpeg", { disposition: "inline" }), part("3", "text/html")],
        values: { "1": "Intro", "3": html },
      }),
    );
    expect(item.note).toBe("Intro\nAgenda\n\nSee the doc [https://x.test/doc] & reply.\n\n * One\n * Two");
  });

  it("names an item without a subject after the first non-empty body line, else '(No subject)'", () => {
    const body = (text: string) => ({ textBody: [part("1", "text/plain")], values: { "1": text } });
    expect(mailDropItem(email({ subject: "", ...body("\n\n  Pick up the dry cleaning  \nby Friday") }))).toMatchObject({
      name: "Pick up the dry cleaning",
      note: "Pick up the dry cleaning  \nby Friday",
    });
    expect(mailDropItem(email({ subject: "RE: [SEC=OFFICIAL]", ...body("Line") })).name).toBe("Line");
    expect(mailDropItem(email({ subject: null, ...body(" \n ") }))).toMatchObject({ name: "(No subject)", note: "" });
  });

  // Fixtures follow RFC 8621 §4.1.4: inline media inside a multipart/mixed goes to textBody and htmlBody only; parts
  // of a multipart/related (or inline media under the HTML side of a multipart/alternative) go to attachments.
  it("keeps photos inlined in a multipart/mixed, as iPhone Mail sends them, ahead of the attachments", () => {
    const photo = part("2", "image/jpeg", { name: "IMG_0001.jpg", disposition: "inline" });
    const video = part("4", "video/quicktime", { name: "IMG_0002.MOV", disposition: "inline" });
    const pdf = part("6", "application/pdf", { name: "Quote.pdf", disposition: "attachment" });
    const item = mailDropItem(
      email({
        textBody: [part("1", "text/plain"), photo, part("3", "text/plain"), video],
        htmlBody: [part("1", "text/plain"), photo, part("3", "text/plain"), video],
        attachments: [pdf],
        values: { "1": "Receipt", "3": "and the video" },
      }),
    );
    expect(item.note).toBe("Receipt\nand the video");
    expect(item.attachments).toEqual([
      { blobId: "B2", name: "IMG_0001.jpg", type: "image/jpeg", size: 10 },
      { blobId: "B4", name: "IMG_0002.MOV", type: "video/quicktime", size: 10 },
      { blobId: "B6", name: "Quote.pdf", type: "application/pdf", size: 10 },
    ]);
  });

  it("skips images the HTML embeds by Content-ID, such as signature logos, but keeps other attachments", () => {
    const logo = part("3", "image/png", { name: "image001.png", disposition: "inline", cid: "image001.png@01DA" });
    const unreferenced = part("4", "image/gif", { name: "spacer.gif", disposition: "inline", cid: "unused" });
    const pdf = part("5", "application/pdf", { name: "Quote.pdf", disposition: "attachment" });
    const forwarded = part("6", "message/rfc822", { disposition: "attachment" });
    const item = mailDropItem(
      email({
        textBody: [part("1", "text/plain")],
        htmlBody: [part("2", "text/html")],
        attachments: [logo, unreferenced, pdf, forwarded],
        values: { "1": "Hi", "2": '<p>Hi</p><img src="CID:image001.png@01da">' },
      }),
    );
    expect(item.attachments.map((a) => a.name)).toEqual(["spacer.gif", "Quote.pdf", "Forwarded message.eml"]);
  });

  it("keeps a picture placed in the HTML side of a multipart/alternative, as Apple Mail sends it", () => {
    const picture = part("3", "image/jpeg", { name: "photo.jpg", disposition: "inline", cid: "B2A9@apple" });
    const item = mailDropItem(
      email({
        textBody: [part("1", "text/plain")],
        htmlBody: [part("2", "text/html"), picture],
        attachments: [picture],
        values: { "1": "Look", "2": "<p>Look</p>" },
      }),
    );
    expect(item.attachments.map((a) => a.name)).toEqual(["photo.jpg"]);
  });

  it("names unnamed attachments 'attachment'", () => {
    const item = mailDropItem(email({ attachments: [part("3", "application/octet-stream", { disposition: "attachment" })] }));
    expect(item.attachments).toEqual([{ blobId: "B3", name: "attachment", type: "application/octet-stream", size: 10 }]);
  });
});
