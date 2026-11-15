// Attachment content-type detection: magic bytes first, then the client's type, then the file extension.

const MAGIC: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
  [[0x47, 0x49, 0x46, 0x38], "image/gif"],
  [[0x25, 0x50, 0x44, 0x46, 0x2d], "application/pdf"],
  [[0x50, 0x4b, 0x03, 0x04], "application/zip"],
  [[0x1f, 0x8b], "application/gzip"],
];

const EXTENSIONS: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  zip: "application/zip",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
};

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

/** Detects a content type for uploaded bytes. */
export function sniffContentType(bytes: Uint8Array, name: string, declared: string | undefined): string {
  for (const [sig, type] of MAGIC) if (startsWith(bytes, sig)) return type;
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  const declaredType = declared?.split(";")[0]?.trim().toLowerCase();
  if (declaredType && declaredType !== "application/octet-stream") return declaredType;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return EXTENSIONS[ext] ?? "application/octet-stream";
}

/** True when bytes can be returned as text to MCP clients (text/* or JSON). */
export function isTextual(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return t.startsWith("text/") || t === "application/json" || t.endsWith("+json");
}
