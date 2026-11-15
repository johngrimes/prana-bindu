import { describe, expect, it } from "vitest";
import { contentTypeFor, sniffContentType } from "./blobs.js";
import { parseReviewInterval, userDate } from "./mapping.js";
import { noteToMarkdown } from "./notes.js";
import { builtinFor, tintToHex } from "./perspectives.js";
import { parseXml } from "./xml.js";

const md = (paragraphs: string, names: Record<string, string> = {}) =>
  noteToMarkdown(parseXml(`<note><text>${paragraphs}</text></note>`, "note"), (id) => names[id]);
const run = (lit: string, style: Record<string, string> = {}) => {
  const values = Object.entries(style)
    .map(([k, v]) => `<value key="${k}">${v}</value>`)
    .join("");
  return `<run>${values ? `<style>${values}</style>` : ""}<lit>${lit}</lit></run>`;
};

describe("noteToMarkdown", () => {
  it("merges adjacent runs with the same marks and keeps whitespace outside delimiters", () => {
    expect(md(`<p>${run("bold ", { "font-weight": "9" })}${run("text ", { "font-weight": "11", "font-family": "X" })}${run("end")}</p>`)).toBe(
      "**bold text** end",
    );
  });

  it("treats light weights as plain and renders strike, fixed pitch and combined marks", () => {
    expect(md(`<p>${run("light", { "font-weight": "5" })}</p>`)).toBe("light");
    expect(md(`<p>${run("gone", { "strikethrough-style": "single" })}</p>`)).toBe("~~gone~~");
    expect(md(`<p>${run("a*b", { "font-fixed-pitch": "yes" })}</p>`)).toBe("`a*b`");
    expect(md(`<p>${run("x`y", { "font-fixed-pitch": "yes" })}</p>`)).toBe("`` x`y ``");
    expect(md(`<p>${run("both", { "font-weight": "9", "font-italic": "yes" })}</p>`)).toBe("***both***");
  });

  it("renders links, autolinks and encodes awkward URL characters", () => {
    const url = "https://example.com/a b_(c)";
    expect(md(`<p>${run("docs", { link: url })}</p>`)).toBe("[docs](https://example.com/a%20b_%28c%29)");
    expect(md(`<p>${run("mailto:x@example.com", { link: "mailto:x@example.com" })}</p>`)).toBe("<mailto:x@example.com>");
  });

  it("applies marks per line when a run spans line breaks", () => {
    expect(md(`<p>${run("one\ntwo", { "font-italic": "yes" })}</p>`)).toBe("*one*\n*two*");
  });

  it("escapes inline metacharacters but not intraword underscores or list markers", () => {
    expect(md(`<p>${run("- a_b _c_ \\ `x`")}</p>`)).toBe("- a_b \\_c\\_ \\\\ \\`x\\`");
  });

  it("keeps blank paragraphs as blank lines and trims trailing ones", () => {
    expect(md(`<p>${run("a")}</p><p/><p>${run("b")}</p><p/><p/>`)).toBe("a\n\nb");
  });

  it("links inline attachments using the attachment name, falling back to the cell name", () => {
    expect(md(`<p>${run('see <cell refid="att1" name="cell.png"/>')}</p>`, { att1: "real.png" })).toBe(
      "see [real.png](attachment:att1)",
    );
    expect(md(`<p>${run('<cell refid="att2" name="[draft].png"/>')}</p>`)).toBe("[\\[draft\\].png](attachment:att2)");
  });

  it("accepts plain-text and empty notes", () => {
    expect(noteToMarkdown(parseXml("<note>  plain  </note>", "n"), () => undefined)).toBe("plain");
    expect(noteToMarkdown(undefined, () => undefined)).toBe("");
  });
});

describe("userDate", () => {
  it("keeps floating wall-clock values and normalises fixed ones to UTC", () => {
    expect(userDate("2026-11-03T09:00:00.000")).toBe("2026-11-03T09:00:00.000");
    expect(userDate("2026-11-03T09:00")).toBe("2026-11-03T09:00:00.000");
    expect(userDate("2026-11-03")).toBe("2026-11-03T00:00:00.000");
    expect(userDate("2026-11-03T09:00:00Z")).toBe("2026-11-03T09:00:00.000Z");
    expect(userDate("2026-11-03T09:00:00+10:00")).toBe("2026-11-02T23:00:00.000Z");
  });

  it("returns null for empty and undefined for unreadable values", () => {
    expect(userDate("  ")).toBeNull();
    expect(userDate("next tuesday")).toBeUndefined();
  });
});

describe("parseReviewInterval", () => {
  it("parses @/~ prefixed intervals", () => {
    expect(parseReviewInterval("@1w")).toEqual({ steps: 1, unit: "week" });
    expect(parseReviewInterval("~14d")).toEqual({ steps: 14, unit: "day" });
    expect(parseReviewInterval("3m")).toEqual({ steps: 3, unit: "month" });
    expect(parseReviewInterval("@1y")).toEqual({ steps: 1, unit: "year" });
  });

  it("rejects zero and unknown units", () => {
    expect(parseReviewInterval("@0w")).toBeNull();
    expect(parseReviewInterval("@2h")).toBeNull();
    expect(parseReviewInterval("weekly")).toBeNull();
  });
});

describe("perspective helpers", () => {
  it("maps versioned built-in ids by stem", () => {
    expect(builtinFor("ProcessTags.v3")).toBe("tags");
    expect(builtinFor("ProcessContexts")).toBe("tags");
    expect(builtinFor("ProcessFlaggedItems.v2")).toBe("flagged");
    expect(builtinFor("ProcessRecentChanges")).toBe("changed");
    expect(builtinFor("ProcessNearby.v4")).toBeNull();
    expect(builtinFor("aB3dE5fG7hJ")).toBeUndefined();
  });

  it("converts tint colours", () => {
    expect(tintToHex("0 0.5 1 1")).toBe("#0080ff");
    expect(tintToHex("1.2 -1 0")).toBe("#ff0000");
    expect(tintToHex("red")).toBeNull();
    expect(tintToHex(undefined)).toBeNull();
  });
});

describe("content types", () => {
  it("prefers the extension, then magic bytes, then octet-stream", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(contentTypeFor("Report.DOCX", sniffContentType(png))).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(contentTypeFor("scan", sniffContentType(png))).toBe("image/png");
    expect(contentTypeFor("blob", sniffContentType(new Uint8Array([1, 2, 3])))).toBe("application/octet-stream");
  });
});
