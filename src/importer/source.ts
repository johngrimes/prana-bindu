import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { unzipSync } from "fflate";
import { ImportError } from "./errors.js";

export type ImportSource = { path: string } | { url: string } | { zip: Uint8Array; name: string };

/** Read access to the files of one `.ofocus` package, addressed relative to the package root with `/`. */
export interface PackageReader {
  /** Human-readable source description for `import_runs.source` (never contains URL query secrets). */
  label: string;
  files: string[];
  read(path: string): Uint8Array;
}

export const BASE_TRANSACTION = /^0{14}=[A-Za-z0-9_-]+(?:\+[A-Za-z0-9_-]+)+\.zip$/;

const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** macOS resource-fork junk (`__MACOSX/…`, `._name`) and directory entries. */
function isJunk(path: string): boolean {
  if (path.endsWith("/")) return true;
  return path.split("/").some((seg) => seg === "__MACOSX" || seg.startsWith("._") || seg === ".DS_Store");
}

/** Finds the package root (directory holding the base transaction) and returns paths relative to it. */
function locateRoot(all: string[], what: string): { root: string; files: string[] } {
  const roots = new Set<string>();
  for (const p of all) {
    if (BASE_TRANSACTION.test(basename(p))) roots.add(p.slice(0, p.length - basename(p).length));
  }
  if (roots.size === 0) {
    if (all.some((p) => basename(p) === "encrypted")) throw encryptedError();
    throw new ImportError(
      "invalid_format",
      `${what} is not an OmniFocus backup: no .ofocus package with a base transaction (00000000000000=….zip) was found.`,
    );
  }
  if (roots.size > 1) {
    throw new ImportError("invalid_format", `${what} contains more than one OmniFocus database; import one at a time.`);
  }
  const root = [...roots][0]!;
  const files = all.filter((p) => p.startsWith(root)).map((p) => p.slice(root.length));
  if (files.includes("encrypted")) throw encryptedError();
  return { root, files };
}

const encryptedError = () =>
  new ImportError(
    "encrypted",
    "This OmniFocus database is encrypted. Export an unencrypted backup (File ▸ Export… or a local backup) and import that instead.",
  );

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);
}

function zipReader(bytes: Uint8Array, label: string): PackageReader {
  if (!isZip(bytes)) throw new ImportError("invalid_format", `${label} is not a zip file.`);
  const names: string[] = [];
  try {
    unzipSync(bytes, {
      filter: (f) => {
        names.push(f.name);
        return false;
      },
    });
  } catch (err) {
    throw new ImportError("invalid_format", `${label} is not a readable zip file.`, { cause: err });
  }
  const { root, files } = locateRoot(
    names.filter((n) => !isJunk(n)),
    label,
  );
  return {
    label,
    files,
    read(path) {
      const full = root + path;
      let out: Uint8Array | undefined;
      try {
        out = unzipSync(bytes, { filter: (f) => f.name === full })[full];
      } catch (err) {
        throw new ImportError("corrupt", `Could not decompress ${path} from ${label}.`, { cause: err });
      }
      if (!out) throw new ImportError("corrupt", `${path} is missing from ${label}.`);
      return out;
    },
  };
}

function walk(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join("/"));
  }
}

function dirReader(dir: string): PackageReader {
  const all: string[] = [];
  walk(dir, dir, all);
  const { root, files } = locateRoot(
    all.filter((p) => !isJunk(p)),
    dir,
  );
  return {
    label: dir,
    files,
    read: (path) => new Uint8Array(readFileSync(join(dir, root, path))),
  };
}

async function download(url: string): Promise<{ bytes: Uint8Array; label: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImportError("invalid_format", `"${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ImportError("invalid_format", `Only http(s) URLs can be imported (got ${parsed.protocol}).`);
  }
  const label = `${parsed.origin}${parsed.pathname}`;
  let res: Response;
  try {
    res = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new ImportError("network", `Could not download ${label}: ${reason}.`, { cause: err });
  }
  if (!res.ok) {
    throw new ImportError("network", `Could not download ${label}: the server answered HTTP ${res.status}.`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw new ImportError("network", `The download of ${label} was interrupted.`, { cause: err });
  }
  if (!isZip(bytes)) {
    const type = res.headers.get("content-type") ?? "unknown content type";
    throw new ImportError(
      "invalid_format",
      `${label} did not return a zip file (received ${type}). Use a direct download link to a zipped .ofocus backup.`,
    );
  }
  return { bytes, label };
}

/** Opens any supported source and locates the `.ofocus` package inside it. */
export async function openSource(source: ImportSource): Promise<PackageReader> {
  if ("zip" in source) return zipReader(source.zip, source.name);
  if ("url" in source) {
    const { bytes, label } = await download(source.url);
    return zipReader(bytes, label);
  }
  let isDir: boolean;
  try {
    isDir = statSync(source.path).isDirectory();
  } catch (err) {
    throw new ImportError("not_found", `${source.path} does not exist or cannot be read.`, { cause: err });
  }
  if (isDir) return dirReader(source.path);
  return zipReader(new Uint8Array(readFileSync(source.path)), source.path);
}
