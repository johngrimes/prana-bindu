/** Thrown by `BlobStore.get` when the key does not exist. */
export class BlobNotFoundError extends Error {
  override name = "BlobNotFoundError";
  constructor(readonly key: string) {
    super(`Blob not found: ${key}`);
  }
}
