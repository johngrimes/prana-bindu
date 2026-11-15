import { child, elements, textOf, type XElement } from "./xml.js";

/** Escapes characters that would start inline Markdown constructs (emphasis, code, links, escapes). */
function escapeInline(text: string): string {
  return text
    .replace(/[\\*`[\]]/g, (c) => `\\${c}`)
    .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace("_", "\\_"));
}

function encodeUrl(url: string): string {
  return url.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

interface Run {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: string | null;
  /** Rendered (escaped) content without marks. */
  content: string;
  /** Unescaped literal text, for autolink detection. */
  plain: string;
}

function styleOf(run: XElement): Map<string, string> {
  const out = new Map<string, string>();
  const style = child(run, "style");
  if (style) for (const v of elements(style)) if (v.name === "value" && v.attrs.key) out.set(v.attrs.key, textOf(v));
  return out;
}

function readRun(run: XElement, attachmentName: (id: string) => string | undefined): Run {
  const style = styleOf(run);
  const code = style.get("font-fixed-pitch") === "yes";
  let content = "";
  let plain = "";
  const lit = child(run, "lit");
  for (const n of lit?.children ?? []) {
    if (typeof n === "string") {
      plain += n;
      content += code ? n : escapeInline(n);
    } else if (n.name === "cell" && n.attrs.refid) {
      const name = attachmentName(n.attrs.refid) ?? n.attrs.name ?? n.attrs.refid;
      content += `[${escapeInline(name)}](attachment:${n.attrs.refid})`;
      plain += "\uFFFC";
    } else {
      const t = textOf(n);
      plain += t;
      content += code ? t : escapeInline(t);
    }
  }
  const weight = Number(style.get("font-weight"));
  const strike = style.get("strikethrough-style");
  const link = style.get("link")?.trim();
  return {
    bold: Number.isFinite(weight) && weight >= 7,
    italic: style.get("font-italic") === "yes",
    strike: strike !== undefined && strike !== "none",
    code: code && !plain.includes("\uFFFC"),
    link: link ? link : null,
    content,
    plain,
  };
}

const sameMarks = (a: Run, b: Run) =>
  a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code && a.link === b.link;

/** Wraps one line segment in marks, keeping surrounding whitespace outside the delimiters. */
function markSegment(run: Run, segment: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment)!;
  let core = m[2]!;
  if (core === "") return segment;
  if (run.code) {
    const fence = core.includes("`") ? "``" : "`";
    core = fence === "``" ? `\`\` ${core} \`\`` : `\`${core}\``;
  }
  if (run.strike) core = `~~${core}~~`;
  if (run.italic) core = `*${core}*`;
  if (run.bold) core = `**${core}**`;
  if (run.link) {
    const url = encodeUrl(run.link);
    const autolink = !run.bold && !run.italic && !run.strike && !run.code && segment.trim() === run.plain.trim() && run.plain.trim() === run.link;
    core = autolink ? `<${url}>` : `[${core}](${url})`;
  }
  return m[1] + core + m[3];
}

function renderRun(run: Run): string {
  if (!run.bold && !run.italic && !run.strike && !run.code && !run.link) return run.content;
  return run.content.split("\n").map((seg) => markSegment(run, seg)).join("\n");
}

/**
 * Converts an OmniFocus rich-text `<note>` to Markdown (F§2.8): paragraphs become lines, bold/italic/strike/
 * fixed-pitch/link styles become inline marks, inline attachments become `[name](attachment:<id>)`.
 * Fonts, colours, indents and spacing are dropped.
 */
export function noteToMarkdown(note: XElement | undefined, attachmentName: (id: string) => string | undefined): string {
  if (!note) return "";
  const text = child(note, "text");
  if (!text) return textOf(note).trim();
  const lines: string[] = [];
  for (const p of elements(text)) {
    if (p.name !== "p") continue;
    const runs: Run[] = [];
    for (const r of elements(p)) {
      if (r.name !== "run") continue;
      const run = readRun(r, attachmentName);
      const prev = runs.at(-1);
      if (prev && sameMarks(prev, run)) {
        prev.content += run.content;
        prev.plain += run.plain;
      } else runs.push(run);
    }
    lines.push(runs.map(renderRun).join(""));
  }
  return lines.join("\n").replace(/\n+$/, "");
}
