// Renders the widget to PNGs (medium and large, light and dark) without an iPhone:
//
//   npm run widget:preview                                  # sample data (Sat 31 Oct 2026, Brisbane)
//   npm run widget:preview -- --origin https://tasks.example.com --token pb_…   # your server
//
// The layout is an approximation of WidgetKit's (see render-html.ts); check the result on a device too.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { openDatabase } from "../../src/db/connection.js";
import { createDomain } from "../../src/domain/index.js";
import { createApp } from "../../src/server/app.js";
import { AuthService } from "../../src/server/auth/service.js";
import { FsBlobStore } from "../../src/storage/fs.js";
import { seedTypicalDay } from "./fixture.js";
import { renderHtml, WIDGET_SIZES, type Mode } from "./render-html.js";
import { runScript, type Fetch } from "./scriptable.js";

const { values } = parseArgs({
  options: {
    origin: { type: "string" },
    token: { type: "string" },
    out: { type: "string", default: "test-results/widget" },
  },
});

async function sampleServer(): Promise<{ origin: string; token: string; fetch: Fetch; now: Date; cleanup: () => void }> {
  const origin = "https://tasks.example.com";
  const now = new Date("2026-10-31T04:20:00.000Z");
  const blobDir = mkdtempSync(join(tmpdir(), "pb-widget-"));
  const { db, sqlite } = openDatabase(":memory:");
  const blobStore = new FsBlobStore(blobDir);
  const domain = createDomain({ db, sqlite, blobStore, now: () => now, defaultTimeZone: "Australia/Brisbane" });
  seedTypicalDay(domain);
  const config = { origin, rpId: "tasks.example.com", rpName: "prana-bindu" };
  const app = createApp({ config, db, domain, blobStore, runImport: () => Promise.reject(new Error("unused")), now: () => now });
  const token = new AuthService(db, config, () => now).createApiToken("preview").plaintext;
  const fetch: Fetch = async (url, headers) => {
    const res = await app.request(url.slice(origin.length), { headers });
    return { status: res.status, body: await res.text() };
  };
  return { origin, token, fetch, now, cleanup: () => rmSync(blobDir, { recursive: true, force: true }) };
}

const liveFetch: Fetch = async (url, headers) => {
  try {
    const res = await fetch(url, { headers });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return err as Error;
  }
};

const source =
  values.origin && values.token
    ? { origin: values.origin.replace(/\/+$/, ""), token: values.token, fetch: liveFetch, now: undefined, cleanup: () => {} }
    : await sampleServer();

mkdirSync(values.out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  for (const family of ["medium", "large"] as const) {
    const { widget } = await runScript({
      family,
      fetch: source.fetch,
      now: source.now,
      keychain: new Map([["prana-bindu-widget", JSON.stringify({ origin: source.origin, token: source.token })]]),
    });
    if (!widget) throw new Error("The script did not set a widget");
    for (const mode of ["dark", "light"] as Mode[]) {
      const html = renderHtml(widget, family, mode);
      const base = join(values.out, `${family}-${mode}`);
      writeFileSync(`${base}.html`, html);
      await page.setContent(html);
      await page.locator("body").screenshot({ path: `${base}.png`, omitBackground: false });
      console.log(`${base}.png (${WIDGET_SIZES[family].width}×${WIDGET_SIZES[family].height} pt)`);
    }
  }
} finally {
  await browser.close();
  source.cleanup();
}
