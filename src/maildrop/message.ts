// Turns a JMAP Email (RFC 8621) into the parts of a Mail Drop inbox item (docs/spec.md §14). Pure.
import { convert, type HtmlToTextOptions } from "html-to-text";

/** The EmailBodyPart properties Mail Drop requests. */
export interface EmailBodyPart {
  partId: string | null;
  blobId: string | null;
  size: number;
  name: string | null;
  type: string;
  disposition: string | null;
  /** Content-Id without angle brackets. */
  cid: string | null;
}

/** The Email properties Mail Drop requests (`EMAIL_PROPERTIES`). */
export interface JmapEmail {
  id: string;
  subject: string | null;
  textBody: EmailBodyPart[];
  htmlBody: EmailBodyPart[];
  attachments: EmailBodyPart[];
  bodyValues: Record<string, { value: string; isEncodingProblem: boolean; isTruncated: boolean }>;
}

export const EMAIL_PROPERTIES = ["id", "subject", "textBody", "htmlBody", "attachments", "bodyValues"] as const;

export interface AttachmentRef {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

export interface MailDropItem {
  name: string;
  note: string;
  attachments: AttachmentRef[];
}

/** Australian Government email protective markings, e.g. `[SEC=OFFICIAL:Sensitive]`, and the older `[DLM=…]`. */
const SECURITY_LABEL = /\[\s*(?:SEC|DLM)\s*=[^\]]*\]/gi;
/** `Re:`, `Fw:`, `Fwd:`, optionally counted (`Re[2]:`, `Re (3):`). */
const REPLY_PREFIX = /^(?:re|fwd?)\s*(?:[[(]\d+[\])]\s*)?:\s*/i;

/** Removes security labels anywhere and reply/forward prefixes at the start, and collapses whitespace. */
export function cleanSubject(subject: string | null): string {
  let s = (subject ?? "").replace(SECURITY_LABEL, " ").replace(/\s+/g, " ").trim();
  for (let next = s.replace(REPLY_PREFIX, ""); next !== s; next = s.replace(REPLY_PREFIX, "")) s = next;
  return s;
}

const HTML_TO_TEXT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } })),
    { selector: "table", format: "dataTable", options: { uppercaseHeaderCells: false } },
  ],
};

function bodyText(email: JmapEmail): string {
  const texts: string[] = [];
  for (const p of email.textBody) {
    const value = p.partId === null ? undefined : email.bodyValues[p.partId]?.value;
    if (value === undefined) continue;
    if (p.type === "text/plain") texts.push(value);
    // Skipped images can leave runs of blank lines behind.
    else if (p.type === "text/html") texts.push(convert(value, HTML_TO_TEXT_OPTIONS).replace(/\n{3,}/g, "\n\n"));
  }
  return texts.join("\n").replace(/\r\n?/g, "\n").trim();
}

/**
 * Attachments to keep: first the media the text body shows inline (RFC 8621 lists an inline image, audio or video
 * part of a multipart/mixed, such as a photo sent from iPhone Mail, in textBody and htmlBody but not in attachments),
 * then every attachment part except images the HTML body embeds by Content-ID (signature logos and the like).
 */
function attachmentRefs(email: JmapEmail): AttachmentRef[] {
  const html = email.htmlBody
    .filter((p) => p.type === "text/html" && p.partId !== null)
    .map((p) => email.bodyValues[p.partId!]?.value ?? "")
    .join("\n")
    .toLowerCase();
  const inline = email.textBody.filter((p) => /^(?:image|audio|video)\//.test(p.type));
  const inlineIds = new Set(inline.map((p) => p.partId));
  const attached = email.attachments.filter(
    (p) => !inlineIds.has(p.partId) && !(p.cid && html.includes(`cid:${p.cid.toLowerCase()}`)),
  );
  return [...inline, ...attached]
    .filter((p) => p.blobId !== null)
    .map((p) => ({
      blobId: p.blobId!,
      name: p.name || (p.type === "message/rfc822" ? "Forwarded message.eml" : "attachment"),
      type: p.type,
      size: p.size,
    }));
}

export function mailDropItem(email: JmapEmail): MailDropItem {
  const note = bodyText(email);
  const firstLine = note
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return { name: cleanSubject(email.subject) || firstLine || "(No subject)", note, attachments: attachmentRefs(email) };
}
