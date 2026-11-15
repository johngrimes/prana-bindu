import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BlobNotFoundError } from "./errors.js";
import { contentDisposition, S3BlobStore } from "./s3.js";

describe("contentDisposition", () => {
  it("keeps ASCII names and adds an RFC 5987 UTF-8 variant", () => {
    expect(contentDisposition('Rëport "Q1".pdf')).toBe(
      `attachment; filename="R_port _Q1_.pdf"; filename*=UTF-8''R%C3%ABport%20%22Q1%22.pdf`,
    );
  });
});

// Opt-in integration test against a real S3-compatible bucket. Set PRANA_S3_ENDPOINT, PRANA_S3_REGION,
// PRANA_S3_BUCKET, PRANA_S3_ACCESS_KEY_ID and PRANA_S3_SECRET_ACCESS_KEY to run it.
const env = process.env;
const configured = Boolean(
  env.PRANA_S3_ENDPOINT && env.PRANA_S3_REGION && env.PRANA_S3_BUCKET && env.PRANA_S3_ACCESS_KEY_ID && env.PRANA_S3_SECRET_ACCESS_KEY,
);

describe.skipIf(!configured)("S3BlobStore (live bucket)", () => {
  it("puts, gets, serves a presigned download and deletes an object", { timeout: 60_000 }, async () => {
    const store = new S3BlobStore({
      endpoint: env.PRANA_S3_ENDPOINT!,
      region: env.PRANA_S3_REGION!,
      bucket: env.PRANA_S3_BUCKET!,
      accessKeyId: env.PRANA_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.PRANA_S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.PRANA_S3_FORCE_PATH_STYLE !== "false",
    });
    const key = `test/prana-bindu-${randomBytes(8).toString("hex")}`;
    const body = new TextEncoder().encode("hello from prana-bindu ✓");
    try {
      await store.put(key, body, "text/plain; charset=utf-8");
      expect(new TextDecoder().decode(await store.get(key))).toBe("hello from prana-bindu ✓");

      const url = await store.downloadUrl(key, "grüße.txt", "text/plain; charset=utf-8");
      expect(url).toMatch(/X-Amz-Expires=300/);
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe(contentDisposition("grüße.txt"));
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
    } finally {
      await store.delete(key);
    }
    await expect(store.get(key)).rejects.toBeInstanceOf(BlobNotFoundError);
    store.destroy();
  });
});
