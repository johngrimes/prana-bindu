import { XMLParser } from "fast-xml-parser";
import { ImportError } from "./errors.js";

/** Minimal ordered XML tree: elements keep attributes and mixed content in document order. */
export interface XElement {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
}
export type XNode = XElement | string;

type RawNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

function convert(raw: RawNode[]): XNode[] {
  const out: XNode[] = [];
  for (const node of raw) {
    if ("#text" in node) {
      out.push(String(node["#text"]));
      continue;
    }
    const attrs = (node[":@"] as Record<string, string> | undefined) ?? {};
    for (const key of Object.keys(node)) {
      if (key === ":@") continue;
      out.push({ name: key, attrs, children: convert(node[key] as RawNode[]) });
    }
  }
  return out;
}

/** Parses an XML document and returns its root element. */
export function parseXml(text: string, what: string): XElement {
  let raw: RawNode[];
  try {
    raw = parser.parse(text) as RawNode[];
  } catch (err) {
    throw new ImportError("corrupt", `${what} is not well-formed XML.`, { cause: err });
  }
  const root = convert(raw).find((n): n is XElement => typeof n !== "string");
  if (!root) throw new ImportError("corrupt", `${what} has no XML root element.`);
  return root;
}

export const isElement = (n: XNode): n is XElement => typeof n !== "string";

export function elements(el: XElement): XElement[] {
  return el.children.filter(isElement);
}

export function child(el: XElement, name: string): XElement | undefined {
  return el.children.find((n): n is XElement => typeof n !== "string" && n.name === name);
}

/** Concatenated text content (descendants included). */
export function textOf(el: XElement | undefined): string {
  if (!el) return "";
  let s = "";
  for (const n of el.children) s += typeof n === "string" ? n : textOf(n);
  return s;
}

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Serialises an element back to XML (used to keep unknown elements verbatim in import warnings). */
export function serialize(el: XElement): string {
  const attrs = Object.entries(el.attrs)
    .map(([k, v]) => ` ${k}="${escapeText(v).replace(/"/g, "&quot;")}"`)
    .join("");
  if (el.children.length === 0) return `<${el.name}${attrs}/>`;
  const inner = el.children.map((n) => (typeof n === "string" ? escapeText(n) : serialize(n))).join("");
  return `<${el.name}${attrs}>${inner}</${el.name}>`;
}
