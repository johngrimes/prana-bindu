import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { BlobNotFoundError } from "./errors.js";
import type { BlobStore } from "./types.js";

/** Stores blobs as files at `<root>/<key>`. Downloads are streamed by the app (`downloadUrl` → null). */
export class FsBlobStore implements BlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const norm = normalize(key);
    if (key === "" || isAbsolute(key) || norm.split(sep).includes("..") || norm.startsWith(".")) {
      throw new Error(`Invalid blob key: ${key}`);
    }
    return join(this.root, norm);
  }

  async put(key: string, body: Uint8Array, _contentType: string): Promise<void> {
    const file = this.pathFor(key);
    await mkdir(dirname(file), { recursive: true });
    // Write-then-rename so readers never observe a partially written blob.
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new BlobNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async downloadUrl(): Promise<string | null> {
    return null;
  }
}
