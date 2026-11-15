import { elements, textOf, type XElement } from "./xml.js";

export type PlistValue = string | number | boolean | null | PlistValue[] | { [key: string]: PlistValue };

/**
 * Decodes an Apple XML plist value element (`dict`, `array`, `string`, …) to JSON-compatible data.
 * `date` becomes an ISO string and `data` a base64 string.
 */
export function plistValue(el: XElement): PlistValue {
  switch (el.name) {
    case "dict": {
      const out: { [key: string]: PlistValue } = {};
      const items = elements(el);
      for (let i = 0; i + 1 < items.length; i += 2) {
        const key = items[i]!;
        if (key.name !== "key") continue;
        out[textOf(key)] = plistValue(items[i + 1]!);
      }
      return out;
    }
    case "array":
      return elements(el).map(plistValue);
    case "string":
    case "key":
      return textOf(el);
    case "integer":
    case "real": {
      const n = Number(textOf(el).trim());
      return Number.isFinite(n) ? n : null;
    }
    case "true":
      return true;
    case "false":
      return false;
    case "date": {
      const d = new Date(textOf(el).trim());
      return Number.isNaN(d.getTime()) ? textOf(el).trim() : d.toISOString();
    }
    case "data":
      return textOf(el).replace(/\s+/g, "");
    default:
      return null;
  }
}

/** Decodes the root value of a `<plist>` element (first element child), or null when empty. */
export function plistRoot(plist: XElement | undefined): PlistValue {
  const first = plist ? elements(plist)[0] : undefined;
  return first ? plistValue(first) : null;
}
