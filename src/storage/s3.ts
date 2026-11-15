import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { S3Config } from "../config.js";
import { BlobNotFoundError } from "./errors.js";
import type { BlobStore } from "./types.js";

/** Presigned download URLs are valid for 5 minutes. */
export const PRESIGN_SECONDS = 300;

/** `attachment` Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 filename. */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** S3 client for an S3-compatible provider. */
export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Some S3-compatible providers reject the newer default CRC32 checksum headers.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** S3-compatible object storage. */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = createS3Client(config);
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.byteLength }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) throw new BlobNotFoundError(key);
      return await out.Body.transformToByteArray();
    } catch (err) {
      if (err instanceof NoSuchKey || (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404)) {
        throw new BlobNotFoundError(key);
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async downloadUrl(key: string, filename: string, contentType: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: contentDisposition(filename),
      ResponseContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn: PRESIGN_SECONDS });
  }

  destroy(): void {
    this.client.destroy();
  }
}
