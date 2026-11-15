import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const webDir = import.meta.dirname;

/** PNG chunk types in file order, plus the IHDR fields iOS cares about. */
function readPng(bytes: Buffer): { width: number; height: number; colorType: number; chunks: string[] } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const chunks: string[] = [];
  for (let offset = 8; offset < bytes.length; offset += 12 + bytes.readUInt32BE(offset)) {
    chunks.push(bytes.toString("latin1", offset + 4, offset + 8));
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes.readUInt8(25), chunks };
}

describe("iOS home-screen icon", () => {
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  const href = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html)?.[1];

  it("is linked from the shell as a root-relative public file", () => {
    expect(href).toMatch(/^\/[\w.-]+\.png$/);
  });

  it("is a 180×180 PNG without transparency (iOS renders transparent pixels black)", () => {
    const png = readPng(readFileSync(join(webDir, "public", href!)));
    expect([png.width, png.height]).toEqual([180, 180]);
    expect([0, 2]).toContain(png.colorType); // greyscale or truecolour, no alpha channel
    expect(png.chunks).not.toContain("tRNS");
    expect(png.chunks.at(-1)).toBe("IEND");
  });
});
