export interface BlobStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  /** Presigned GET URL (S3) or null when the app must stream the bytes itself (filesystem driver). */
  downloadUrl(key: string, filename: string, contentType: string): Promise<string | null>;
}

/** Content-addressed key for a blob. */
export const blobKey = (sha256: string): string => `blobs/${sha256}`;
