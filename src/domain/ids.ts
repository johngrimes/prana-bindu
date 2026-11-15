import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** New entity id: 11 random characters from [A-Za-z0-9_-] (docs/spec.md §1). */
export function newId(): string {
  const bytes = randomBytes(11);
  let id = "";
  for (const b of bytes) id += ALPHABET[b & 63];
  return id;
}
