import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobNotFoundError } from "./errors.js";
import { FsBlobStore } from "./fs.js";
import { blobKey } from "./types.js";

describe("FsBlobStore", () => {
  let dir: string;
  let store: FsBlobStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-blobs-"));
    store = new FsBlobStore(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("round-trips bytes under <root>/blobs/<sha> and leaves no temp files", async () => {
    const key = blobKey("abc123");
    await store.put(key, new Uint8Array([1, 2, 3]), "application/octet-stream");
    expect(Array.from(await store.get(key))).toEqual([1, 2, 3]);
    expect(await readdir(join(dir, "blobs"))).toEqual(["abc123"]);
  });

  it("overwrites an existing key", async () => {
    await store.put("blobs/x", new Uint8Array([1]), "text/plain");
    await store.put("blobs/x", new Uint8Array([2, 2]), "text/plain");
    expect(Array.from(await store.get("blobs/x"))).toEqual([2, 2]);
  });

  it("throws BlobNotFoundError for a missing key and deletes idempotently", async () => {
    await expect(store.get("blobs/missing")).rejects.toBeInstanceOf(BlobNotFoundError);
    await store.put("blobs/y", new Uint8Array([9]), "text/plain");
    await store.delete("blobs/y");
    await store.delete("blobs/y");
    await expect(store.get("blobs/y")).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("rejects keys that escape the root", async () => {
    for (const key of ["../evil", "blobs/../../evil", "/etc/passwd", ""]) {
      await expect(store.put(key, new Uint8Array([1]), "text/plain")).rejects.toThrow(/Invalid blob key/);
    }
  });

  it("never offers a presigned URL", async () => {
    expect(await store.downloadUrl()).toBeNull();
  });
});
