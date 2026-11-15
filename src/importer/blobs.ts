import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

const BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  json: "application/json",
  har: "application/json",
  ipynb: "application/x-ipynb+json",
  csv: "text/csv",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  rtf: "application/rtf",
  zip: "application/zip",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  eml: "message/rfc822",
  ics: "text/calendar",
  vcf: "text/vcard",
};

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

/** Content type from magic bytes, or null when unrecognised. */
export function sniffContentType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return "application/x-ole-storage";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp";
  }
  return null;
}

/** Content type from the file name's extension, else the blob's sniffed type, else `application/octet-stream`. */
export function contentTypeFor(name: string, sniffed: string | null): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return BY_EXTENSION[ext] ?? sniffed ?? "application/octet-stream";
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Extracts the single payload of a `data/data-<sha256>.zip` blob and verifies its SHA-256.
 * Returns an error string instead of throwing so the caller can skip just that blob.
 */
export function extractBlob(zipBytes: Uint8Array, sha256: string): { bytes: Uint8Array } | { error: string } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch {
    return { error: "is not a readable zip" };
  }
  const payload = Object.entries(entries).find(([name]) => !name.endsWith("/"))?.[1];
  if (!payload) return { error: "is empty" };
  if (sha256Hex(payload) !== sha256) return { error: "failed its SHA-256 check" };
  return { bytes: payload };
}
