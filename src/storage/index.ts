import type { Config } from "../config.js";
import { FsBlobStore } from "./fs.js";
import { S3BlobStore } from "./s3.js";
import type { BlobStore } from "./types.js";

export { BlobNotFoundError } from "./errors.js";
export { FsBlobStore } from "./fs.js";
export { S3BlobStore } from "./s3.js";
export { blobKey, type BlobStore } from "./types.js";

/** Blob store for the configured driver (`PRANA_BLOB_DRIVER`). */
export function createBlobStore(config: Pick<Config, "blob">): BlobStore {
  return config.blob.driver === "s3" ? new S3BlobStore(config.blob.s3) : new FsBlobStore(config.blob.dir);
}
