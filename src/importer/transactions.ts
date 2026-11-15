import { unzipSync } from "fflate";
import { ImportError } from "./errors.js";
import { plistRoot } from "./plist.js";
import { BASE_TRANSACTION, type PackageReader } from "./source.js";
import { elements, parseXml, type XElement } from "./xml.js";

const NS_V2 = "http://www.omnigroup.com/namespace/OmniFocus/v2";
const NS_V1 = "http://www.omnigroup.com/namespace/OmniFocus/v1";
const TRANSACTION = /^(\d{14})=([A-Za-z0-9_-]+(?:\+[A-Za-z0-9_-]+)+)\.zip$/;

const KNOWN_CAPABILITIES: Record<string, true> = {
  delta_transactions: true,
  external_attachments: true,
  unknown_element_import: true,
  stable_repeats: true,
  versioned_perspectives: true,
  active_object_hidden_dates: true,
  floating_time_zones: true,
  v4_7_features: true,
};

/** One OmniFocus object after all transactions were applied. Fields are the object's child elements by name. */
export interface OfObject {
  type: string;
  id: string;
  fields: Map<string, XElement>;
}

export interface ParsedPackage {
  /** Objects by type, each keyed by id, in first-seen order. */
  objects: Map<string, Map<string, OfObject>>;
  appId: string | null;
  appVersion: string | null;
  capabilities: string[];
  transactions: string[];
  warnings: string[];
}

function toObject(el: XElement, id: string): OfObject {
  const fields = new Map<string, XElement>();
  for (const c of elements(el)) fields.set(c.name, c);
  return { type: el.name, id, fields };
}

function readContents(reader: PackageReader, file: string): XElement {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(reader.read(file));
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError("corrupt", `Transaction ${file} is not a readable zip file.`, { cause: err });
  }
  const bytes = entries["contents.xml"] ?? Object.values(entries)[0];
  if (!bytes) throw new ImportError("corrupt", `Transaction ${file} is empty.`);
  const root = parseXml(new TextDecoder().decode(bytes), `Transaction ${file}`);
  const ns = root.attrs.xmlns;
  if (root.name !== "omnifocus") {
    throw new ImportError("invalid_format", `Transaction ${file} is not an OmniFocus document (root <${root.name}>).`);
  }
  if (ns === NS_V1) {
    throw new ImportError(
      "unsupported_version",
      "This backup uses the OmniFocus 1 file format, which is not supported. Open it in a current OmniFocus version and export a new backup.",
    );
  }
  if (ns !== NS_V2) {
    throw new ImportError("unsupported_version", `Transaction ${file} uses an unsupported OmniFocus namespace (${ns ?? "none"}).`);
  }
  return root;
}

function readCapabilities(reader: PackageReader, warnings: string[]): string[] {
  const names: string[] = [];
  for (const file of reader.files) {
    if (file.includes("/") || !file.endsWith(".capability")) continue;
    const stem = file.slice(0, -".capability".length);
    let name = stem;
    try {
      const value = plistRoot(parseXml(new TextDecoder().decode(reader.read(file)), file));
      if (value && typeof value === "object" && !Array.isArray(value) && typeof value.name === "string") name = value.name;
    } catch {
      warnings.push(`Capability file ${file} could not be read; assumed name "${stem}".`);
    }
    names.push(name);
    if (!Object.hasOwn(KNOWN_CAPABILITIES, name)) {
      warnings.push(`Unknown capability "${name}"; data that depends on it may be incomplete.`);
    }
  }
  return names.sort();
}

/** Lists base + delta transactions in application order and applies them to an object map (F§3). */
export function readPackage(reader: PackageReader): ParsedPackage {
  const warnings: string[] = [];
  const capabilities = readCapabilities(reader, warnings);
  const txFiles = reader.files.filter((f) => !f.includes("/") && TRANSACTION.test(f));
  const bases = txFiles.filter((f) => BASE_TRANSACTION.test(f));
  if (bases.length !== 1) {
    throw new ImportError("invalid_format", `Expected exactly one base transaction, found ${bases.length}.`);
  }
  const deltas = txFiles.filter((f) => !BASE_TRANSACTION.test(f)).sort();
  const ordered = [bases[0]!, ...deltas];

  const known = new Set<string>();
  const objects = new Map<string, Map<string, OfObject>>();
  let appId: string | null = null;
  let appVersion: string | null = null;
  let reconstructed = 0;

  for (const file of ordered) {
    const ids = TRANSACTION.exec(file)![2]!.split("+");
    const tail = ids.at(-1)!;
    const parents = ids.slice(0, -1);
    if (file === bases[0]) parents.forEach((p) => known.add(p));
    else if (!parents.every((p) => known.has(p))) {
      warnings.push(`Transaction ${file} does not follow an earlier transaction; applied in name order anyway.`);
    }
    known.add(tail);

    const root = readContents(reader, file);
    appId = root.attrs["app-id"] ?? appId;
    appVersion = root.attrs["app-version"] ?? appVersion;

    for (const el of elements(root)) {
      const id = el.attrs.id;
      if (!id) {
        warnings.push(`Ignored <${el.name}> without an id in ${file}.`);
        continue;
      }
      let byId = objects.get(el.name);
      if (!byId) objects.set(el.name, (byId = new Map()));
      const op = el.attrs.op;
      switch (op) {
        case undefined:
          byId.set(id, toObject(el, id));
          break;
        case "update": {
          const existing = byId.get(id);
          if (!existing) byId.set(id, toObject(el, id));
          else for (const c of elements(el)) existing.fields.set(c.name, c);
          break;
        }
        case "delete":
          byId.delete(id);
          break;
        case "reference":
          if (!byId.has(id) && elements(el).length > 0) {
            byId.set(id, toObject(el, id));
            reconstructed++;
          }
          break;
        default:
          throw new ImportError("invalid_format", `Transaction ${file} contains an unknown operation op="${op}".`);
      }
    }
  }
  if (reconstructed > 0) {
    warnings.push(`${reconstructed} object(s) missing from the base were reconstructed from op="reference" copies.`);
  }
  return { objects, appId, appVersion, capabilities, transactions: ordered, warnings };
}
