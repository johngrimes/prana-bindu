// End-to-end tests for the Scriptable widget: the script runs against a mock Scriptable runtime (test/scriptable.ts)
// whose network calls go to a real in-memory prana-bindu server.
import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "../src/domain/testkit.js";
import { createApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth/service.js";
import type { Forecast, Settings } from "../src/shared/schemas.js";
import { formatDateChip } from "../src/web/lib/dates.js";
import {
  RUN_SCRIPT_URL,
  WidgetImage,
  WidgetStack,
  WidgetText,
  runScript,
  stacksWithUrl,
  textContent,
  texts,
  walk,
  type AlertAnswer,
  type Fetch,
  type ListWidget,
  type RunOptions,
  type ShownAlert,
} from "./test/scriptable.js";
import { seedTypicalDay } from "./test/fixture.js";

const ORIGIN = "https://tasks.example.com";
const KEY = "prana-bindu-widget";
const CACHE = "/scriptable/documents/prana-bindu-widget-cache.json";
// iOS system colours (dark appearance) used by the widget.
const RED = "#FF453A";
const YELLOW = "#FFD60A";
const GREY = "#8E8E93";
const ORANGE = "#FF9F0A";

interface Server {
  env: TestEnv;
  token: string;
  fetch: Fetch;
  get<T>(path: string): Promise<T>;
  /** Fetch that fails like an unreachable server. */
  offline: Fetch;
}

function server(): Server {
  const env = createTestEnv();
  const config = { origin: ORIGIN, rpId: "tasks.example.com", rpName: "prana-bindu" };
  const app = createApp({
    config,
    db: env.db,
    domain: env.domain,
    blobStore: env.blobStore,
    runImport: () => Promise.reject(new Error("not used")),
    now: () => env.clock.now,
  });
  const token = new AuthService(env.db, config, () => env.clock.now).createApiToken("widget").plaintext;
  const fetch: Fetch = async (url, headers) => {
    if (!url.startsWith(ORIGIN)) return new Error(`unexpected host: ${url}`);
    const res = await app.request(url.slice(ORIGIN.length), { headers });
    return { status: res.status, body: await res.text() };
  };
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${ORIGIN}/api/v1${path}`, { Authorization: `Bearer ${token}` });
    if (r instanceof Error) throw r;
    return JSON.parse(r.body) as T;
  };
  const offline: Fetch = async () => new Error("The Internet connection appears to be offline.");
  return { env, token, fetch, get, offline };
}

function configured(s: Server, origin = ORIGIN): Map<string, string> {
  return new Map([[KEY, JSON.stringify({ origin, token: s.token })]]);
}

async function widgetFor(s: Server, family: RunOptions["family"], extra: Partial<RunOptions> = {}) {
  const result = await runScript({ family, fetch: s.fetch, keychain: configured(s), now: s.env.clock.now, ...extra });
  expect(result.widget).not.toBeNull();
  return { ...result, widget: result.widget! };
}

const columnUrl = (key: string) => `${ORIGIN}/forecast?day=${key}`;

function column(widget: ListWidget, key: string): WidgetStack {
  const found = stacksWithUrl(widget, columnUrl(key)).filter((st) => texts(st).length >= 2 && !rowNames(widget).includes(texts(st)[0]!.text));
  expect(found, key).toHaveLength(1);
  return found[0]!;
}

function columnParts(col: WidgetStack) {
  const [title, count, ...rest] = texts(col);
  return { title: title!, count: count!, dots: rest.filter((t) => t.text === "●") };
}

/** Task rows: the innermost stacks that are tap targets and contain a status circle cell. */
function rows(widget: ListWidget): WidgetStack[] {
  const out: WidgetStack[] = [];
  walk(widget, (n) => {
    if (n instanceof WidgetStack && n.url && n.children[0] instanceof WidgetStack && texts(n).length >= 1 && n.layout === "horizontal") {
      const first = n.children[0];
      if (first.size.width > 0 && first.size.width === first.size.height) out.push(n);
    }
  });
  return out;
}

function rowNames(widget: ListWidget): string[] {
  return rows(widget).map((r) => texts(r)[0]!.text);
}

function rowFor(widget: ListWidget, name: string) {
  const row = rows(widget).find((r) => texts(r)[0]!.text === name);
  expect(row, name).toBeDefined();
  const cell = row!.children[0] as WidgetStack;
  const [nameText, chip] = texts(row!);
  let ring: WidgetStack | undefined;
  let symbol: string | undefined;
  walk(cell, (n) => {
    if (n instanceof WidgetStack && n !== cell && n.borderWidth > 0) ring = n;
    if (n instanceof WidgetImage) symbol = n.image.symbol;
  });
  const chipStack = chip ? findParent(row!, chip) : undefined;
  return { row: row!, cell, name: nameText!, chip, chipStack, ring, symbol };
}

function findParent(root: WidgetStack, child: WidgetText): WidgetStack | undefined {
  let parent: WidgetStack | undefined;
  walk(root, (n) => {
    if (n instanceof WidgetStack && n.children.includes(child)) parent = n;
  });
  return parent;
}

const dark = (c: { in(m: "dark"): { hex: string } } | undefined) => c?.in("dark").hex;

describe("Forecast widget", () => {
  it("medium: strip of Past, Today, the next four days and Future, with the API's counts, due dots and tap targets", async () => {
    const s = server();
    seedTypicalDay(s.env.domain);
    const { widget, requests } = await widgetFor(s, "medium");
    const forecast = await s.get<Forecast>("/forecast?days=5");

    for (const r of requests) expect(r.headers.Authorization).toBe(`Bearer ${s.token}`);
    expect(requests.map((r) => r.url).sort()).toEqual([`${ORIGIN}/api/v1/forecast?days=5`, `${ORIGIN}/api/v1/settings`]);

    const keys = ["PAST", "TODAY", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "FUTURE"];
    expect(forecast.days.map((d) => d.key)).toEqual(keys);
    const cols = keys.map((k) => columnParts(column(widget, k)));
    expect(cols.map((c) => c.title.text)).toEqual(["Past", "Today", "Sun", "Mon", "Tue", "Wed", "Future"]);
    expect(cols.map((c) => c.count.text)).toEqual(forecast.days.map((d) => String(d.count)));
    expect(cols.map((c) => c.count.text)).toEqual(["2", "3", "1", "1", "1", "0", "1"]);

    // One dot per due item, most urgent first. Water plants (Tue) is only planned, so it has no dot.
    const dotColours = cols.map((c) => c.dots.map((t) => dark(t.textColor)));
    expect(dotColours).toEqual([[RED, RED], [RED, RED, YELLOW], [YELLOW], [YELLOW], [], [], [GREY]]);

    // Zero is dimmed.
    const wed = cols[5]!.count;
    expect(dark(wed.textColor)).not.toBe(dark(cols[0]!.count.textColor));

    // Today is the highlighted column.
    const highlighted = keys.filter((k) => column(widget, k).backgroundColor);
    expect(highlighted).toEqual(["TODAY"]);

    // Taps: background and rows go to Today, "+" to Quick Entry.
    expect(widget.url).toBe(columnUrl("TODAY"));
    const plus = stacksWithUrl(widget, `${ORIGIN}/forecast?quickEntry=1`);
    expect(plus).toHaveLength(1);
    expect(textContent(plus[0]!)).toEqual([]);
    for (const r of rows(widget)) expect(r.url).toBe(columnUrl("TODAY"));
  });

  it("medium lists Today's first two items in API order; large lists up to eight", async () => {
    const s = server();
    seedTypicalDay(s.env.domain);
    s.env.domain.setViewOptions("forecast", { forecast: { todayIncludesFlagged: true } });
    for (let i = 1; i <= 8; i++) s.env.domain.createTask({ name: `Flagged ${i}`, flagged: true });
    const forecast = await s.get<Forecast>("/forecast?days=5");
    const today = forecast.days.find((d) => d.key === "TODAY")!.rows.map((r) => r.task!.name);

    const medium = await widgetFor(s, "medium");
    expect(rowNames(medium.widget)).toEqual(today.slice(0, 2));
    expect(rowNames(medium.widget)).toEqual(["Do the line trimming", "Mow the lawn"]);

    const large = await widgetFor(s, "large");
    expect(today.length).toBeGreaterThan(8);
    expect(rowNames(large.widget)).toEqual(today.slice(0, 8));
  });

  it("rows: status circle, flag corner, dimmed unavailable names and due chips worded as in the web app", async () => {
    const s = server();
    seedTypicalDay(s.env.domain);
    s.env.domain.setViewOptions("forecast", { forecast: { todayIncludesFlagged: true } });
    s.env.domain.createTask({
      name: "Stretch",
      flagged: false,
      dueDate: "2026-10-31T00:00:00.000",
      repeat: { rule: "FREQ=DAILY", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: false },
    });
    const later = s.env.domain.createProject({ name: "Later", type: "sequential" });
    s.env.domain.createTask({ name: "First step", projectId: later.id, flagged: true });
    s.env.domain.createTask({ name: "Second step", projectId: later.id, flagged: true });
    const settings = await s.get<Settings>("/settings");
    const { widget } = await widgetFor(s, "large");
    const forecast = await s.get<Forecast>("/forecast?days=5");
    const todayTasks = forecast.days.find((d) => d.key === "TODAY")!.rows.map((r) => r.task!);
    expect(rowNames(widget)).toEqual(todayTasks.slice(0, 8).map((t) => t.name));

    // Chip text matches the web app's formatDateChip for every listed task with a due date; none without one.
    for (const t of todayTasks.slice(0, 8)) {
      const { chip } = rowFor(widget, t.name);
      if (t.effectiveDueDate) expect(chip?.text, t.name).toBe(formatDateChip(t.effectiveDueDate, settings, s.env.clock.now));
      else expect(chip, t.name).toBeUndefined();
    }

    const trimming = rowFor(widget, "Do the line trimming");
    expect(trimming.chip!.text).toBe("10/29/2026 9:00 AM");
    expect(dark(trimming.ring!.borderColor)).toBe(RED);
    expect(dark(trimming.chipStack!.backgroundColor)).toBe(RED);
    expect(trimming.cell.backgroundImage?.ops[0]?.color.in("dark").hex).toBe(ORANGE); // flag corner

    const mow = rowFor(widget, "Mow the lawn"); // overdue but blocked
    expect(mow.cell.backgroundImage).toBeUndefined();
    expect(dark(mow.name.textColor)).not.toBe(dark(trimming.name.textColor));
    expect(dark(mow.ring!.borderColor)).toBe(RED);

    const rent = rowFor(widget, "Pay rent");
    expect(rent.chip!.text).toBe("Today 5:00 PM");
    expect(dark(rent.ring!.borderColor)).toBe(YELLOW);
    expect(dark(rent.chipStack!.backgroundColor)).toBe(YELLOW);

    const stretch = rowFor(widget, "Stretch"); // due today at midnight: overdue, so the red ring wins over the repeat dots
    expect(dark(stretch.ring!.borderColor)).toBe(RED);
    expect(stretch.symbol).toBeUndefined();
    expect(stretch.chip!.text).toBe("Today");

    const second = rowFor(widget, "Second step"); // flagged takes precedence over blocked in the ring
    expect(dark(second.ring!.borderColor)).toBe(ORANGE);
    expect(second.cell.backgroundImage).toBeDefined();
    expect(dark(second.name.textColor)).toBe(dark(mow.name.textColor));
  });

  it("draws blocked and repeating circles with dashed and dotted symbols, square for projects", async () => {
    const s = server();
    s.env.domain.updateSettings({ dateFormat: "dd/MM/yyyy", use24HourTime: true });
    const tag = s.env.domain.createTag({ name: "Today" });
    s.env.domain.updateSettings({ forecastTagId: tag.id });
    const p = s.env.domain.createProject({ name: "Garden project", type: "sequential", tagIds: [tag.id] });
    s.env.domain.createTask({ name: "Step 1", projectId: p.id, tagIds: [tag.id] });
    s.env.domain.createTask({ name: "Step 2", projectId: p.id, tagIds: [tag.id] });
    s.env.domain.createTask({
      name: "Routine",
      tagIds: [tag.id],
      deferDate: "2026-10-01T00:00:00.000",
      repeat: { rule: "FREQ=DAILY", scheduleType: "regularly", anchorDate: "defer", catchUpAutomatically: false },
    });
    s.env.domain.createTask({ name: "Report", dueDate: "2026-12-24T09:30:00.000", tagIds: [tag.id] });
    const { widget } = await widgetFor(s, "large");
    expect(rowFor(widget, "Step 2").symbol).toBe("circle.dashed");
    expect(rowFor(widget, "Routine").symbol).toBe("circle.dotted");
    expect(rowFor(widget, "Step 1").symbol).toBeUndefined();
    expect(rowFor(widget, "Report").chip!.text).toBe("24/12/2026 09:30");
    expect(rowFor(widget, "Report").chipStack!.backgroundColor).toBeUndefined();

    // A project with remaining actions is blocked: a dashed square, and (as in the web app) its name is not dimmed.
    const project = rowFor(widget, "Garden project");
    expect(project.symbol).toBe("square.dashed");
    expect(dark(project.name.textColor)).toBe(dark(rowFor(widget, "Report").name.textColor));
    expect(dark(rowFor(widget, "Step 2").name.textColor)).not.toBe(dark(project.name.textColor));

    // Where SFSymbol.named returns null (the dotted symbols need iOS 15 or 16), a plain ring, square-cornered for projects.
    const old = await widgetFor(s, "large", { missingSymbols: ["circle.dashed", "square.dashed"] });
    expect(rowFor(old.widget, "Step 2").symbol).toBeUndefined();
    expect(rowFor(old.widget, "Step 2").ring!.cornerRadius).toBe(7.5);
    expect(rowFor(old.widget, "Garden project").ring!.cornerRadius).toBe(4);
  });

  it("caps dots at four and keeps Today highlighted with 'No items' when Today is empty", async () => {
    const s = server();
    for (let i = 0; i < 6; i++) s.env.domain.createTask({ name: `Overdue ${i}`, dueDate: "2026-10-20T09:00:00.000" });
    let { widget } = await widgetFor(s, "medium");
    expect(columnParts(column(widget, "PAST")).count.text).toBe("6");
    expect(columnParts(column(widget, "PAST")).dots.map((d) => dark(d.textColor))).toEqual([RED, RED, RED, RED]);

    const empty = server();
    empty.env.domain.createTask({ name: "Next week", dueDate: "2026-11-09T09:00:00.000" });
    ({ widget } = await widgetFor(empty, "medium"));
    expect(column(widget, "TODAY").backgroundColor).toBeDefined();
    expect(columnParts(column(widget, "TODAY")).count.text).toBe("0");
    expect(rows(widget)).toEqual([]);
    expect(textContent(widget)).toContain("No items");
  });

  it("asks iOS to refresh after 15 minutes and caches each successful response", async () => {
    const s = server();
    seedTypicalDay(s.env.domain);
    const { widget, files } = await widgetFor(s, "medium");
    expect(widget.refreshAfterDate?.getTime()).toBe(s.env.clock.now.getTime() + 15 * 60_000);
    const cache = JSON.parse(files.get(CACHE)!);
    expect(cache.origin).toBe(ORIGIN);
    expect(cache.fetchedAt).toBe(s.env.clock.now.toISOString());
    expect(cache.settings).toEqual({ timeZone: "Australia/Brisbane", dateFormat: "MM/dd/yyyy", use24HourTime: false });
    expect(JSON.stringify(cache)).not.toContain(s.token);
  });

  it("offline: shows the cached forecast with an 'Updated' note, dropping a row in medium", async () => {
    const s = server();
    seedTypicalDay(s.env.domain);
    const first = await widgetFor(s, "medium");
    const files = first.files;
    const fetchedAt = s.env.clock.now;

    s.env.clock.advance(45 * 60_000); // 15:05
    const stale = await widgetFor(s, "medium", { fetch: s.offline, files, now: s.env.clock.now });
    expect(textContent(stale.widget)).toContain("Updated 2:20 PM");
    expect(rowNames(stale.widget)).toEqual(["Do the line trimming"]);
    expect(columnParts(column(stale.widget, "TODAY")).count.text).toBe("3");

    const large = await widgetFor(s, "large", { fetch: s.offline, files, now: s.env.clock.now });
    expect(rowNames(large.widget)).toEqual(["Do the line trimming", "Mow the lawn", "Pay rent"]);
    expect(textContent(large.widget)).toContain("Updated 2:20 PM");

    // A server error is treated the same way.
    const failing: Fetch = async () => ({ status: 503, body: "Service Unavailable" });
    const errored = await widgetFor(s, "medium", { fetch: failing, files, now: s.env.clock.now });
    expect(textContent(errored.widget)).toContain("Updated 2:20 PM");

    // From another day, the note says which day.
    const nextDay = new Date(fetchedAt.getTime() + 24 * 3600_000);
    const old = await widgetFor(s, "medium", { fetch: s.offline, files, now: nextDay });
    expect(textContent(old.widget)).toContain("Updated Yesterday 2:20 PM");
  });

  it("offline without a usable cache: an error naming the server", async () => {
    const s = server();
    seedTypicalDay(s.env.domain);
    const none = await widgetFor(s, "medium", { fetch: s.offline });
    expect(textContent(none.widget).join(" ")).toContain("Can't reach tasks.example.com");
    expect(rows(none.widget)).toEqual([]);
    expect(none.widget.url).toBe(ORIGIN);
    expect(none.widget.refreshAfterDate?.getTime()).toBe(s.env.clock.now.getTime() + 15 * 60_000);

    // A captive portal answers 200 with a login page.
    const portal: Fetch = async () => ({ status: 200, body: "<html>Sign in to Wi-Fi</html>" });
    const captive = await widgetFor(s, "medium", { fetch: portal });
    expect(textContent(captive.widget).join(" ")).toContain("Can't reach tasks.example.com. The server's answer wasn't JSON.");

    // A cache written for another server is ignored.
    const { files } = await widgetFor(s, "medium");
    const moved = await widgetFor(s, "medium", { fetch: s.offline, files, keychain: configured(s, "https://other.example.com") });
    expect(textContent(moved.widget).join(" ")).toContain("Can't reach other.example.com");
  });

  it("a rejected token says so, ignores the cache and opens the script on tap", async () => {
    const s = server();
    seedTypicalDay(s.env.domain);
    const { files } = await widgetFor(s, "medium");
    const keychain = new Map([[KEY, JSON.stringify({ origin: ORIGIN, token: "pb_revoked" })]]);
    const { widget } = await widgetFor(s, "medium", { files, keychain });
    expect(textContent(widget).join(" ")).toMatch(/Token rejected/);
    expect(rows(widget)).toEqual([]);
    expect(widget.url).toBe(RUN_SCRIPT_URL);
    expect(widget.refreshAfterDate).toBeDefined();
  });

  it("without settings, asks to be run in Scriptable and makes no requests", async () => {
    const s = server();
    const { widget, requests } = await widgetFor(s, "medium", { keychain: new Map() });
    expect(textContent(widget).join(" ")).toMatch(/Run this script in Scriptable/);
    expect(widget.url).toBe(RUN_SCRIPT_URL);
    expect(requests).toEqual([]);
  });

  it.each(["small", "extraLarge", "accessoryRectangular"] as const)("%s size: asks for medium or large without fetching", async (family) => {
    const s = server();
    const { widget, requests } = await widgetFor(s, family);
    expect(textContent(widget).join(" ")).toMatch(/medium or large/);
    expect(requests).toEqual([]);
  });
});

describe("Running in the Scriptable app", () => {
  function answers(...list: (AlertAnswer | ((a: ShownAlert) => AlertAnswer))[]) {
    let i = 0;
    return (alert: ShownAlert): AlertAnswer => {
      const next = list[i++];
      if (!next) throw new Error(`No answer for alert ${i}: ${alert.title}`);
      return typeof next === "function" ? next(alert) : next;
    };
  }

  it("first run: asks for the server and token, rejects a bad token, saves a good one to the Keychain, then previews", async () => {
    const s = server();
    seedTypicalDay(s.env.domain);
    const result = await runScript({
      fetch: s.fetch,
      now: s.env.clock.now,
      answer: answers(
        (a) => {
          expect(a.fields.map((f) => [f.text, f.secure])).toEqual([["", false], ["", true]]);
          return { action: 0, fields: [`${ORIGIN}/ `, "pb_wrong"] };
        },
        (a) => {
          expect(a.title).toBe("Token rejected");
          return { action: 0 };
        },
        (a) => {
          expect(a.fields[0]!.text).toBe(ORIGIN); // keeps what was typed, normalised
          return { action: 0, fields: [ORIGIN, s.token] };
        },
        (a) => {
          expect(a.actions).toEqual(["Preview medium", "Preview large", "Change server or token", "Remove settings"]);
          return { action: 0 };
        },
      ),
    });
    expect(JSON.parse(result.keychain.get(KEY)!)).toEqual({ origin: ORIGIN, token: s.token });
    expect(result.widget?.presented).toBe("medium");
    expect(rowNames(result.widget!)).toEqual(["Do the line trimming", "Mow the lawn"]);
    expect(result.completed).toBe(true);
    for (const v of result.files.values()) expect(v).not.toContain(s.token);
  });

  it("rejects an origin that isn't http(s) and an unreachable server, then lets you cancel", async () => {
    const s = server();
    const result = await runScript({
      fetch: s.offline,
      answer: answers(
        { action: 0, fields: ["tasks.example.com", s.token] },
        (a) => {
          expect(a.title).toBe("Invalid server URL");
          return { action: 0 };
        },
        { action: 0, fields: [ORIGIN, s.token] },
        (a) => {
          expect(a.title).toBe("Can't reach tasks.example.com");
          expect(a.message).toContain("offline");
          return { action: 0 };
        },
        { action: -1 },
      ),
    });
    expect(result.keychain.size).toBe(0);
    expect(result.widget).toBeNull();
  });

  it("changing settings with a blank token keeps the current token; Remove settings clears the Keychain and cache", async () => {
    const s = server();
    seedTypicalDay(s.env.domain);
    const { files } = await widgetFor(s, "medium");
    const keychain = configured(s);
    await runScript({
      fetch: s.fetch,
      keychain,
      files,
      answer: answers(
        (a) => {
          expect(a.message).toContain(ORIGIN);
          return { action: 2 };
        },
        (a) => {
          expect(a.fields[1]!.placeholder).toMatch(/blank to keep/);
          return { action: 0, fields: [`${ORIGIN}/`, ""] };
        },
        { action: 1 },
      ),
    });
    expect(JSON.parse(keychain.get(KEY)!)).toEqual({ origin: ORIGIN, token: s.token });

    const removed = await runScript({ fetch: s.fetch, keychain, files, answer: answers({ action: 3 }) });
    expect(removed.keychain.has(KEY)).toBe(false);
    expect(removed.files.has(CACHE)).toBe(false);
  });

  it("a new server needs a new token: a blank token is only kept for the same server", async () => {
    const s = server();
    const keychain = configured(s);
    const result = await runScript({
      fetch: s.fetch,
      keychain,
      answer: answers(
        { action: 2 },
        { action: 0, fields: ["https://other.example.com", ""] },
        (a) => {
          expect(a.title).toBe("Token required");
          return { action: 0 };
        },
        { action: -1 },
        { action: -1 },
      ),
    });
    expect(result.requests).toEqual([]);
    expect(JSON.parse(keychain.get(KEY)!)).toEqual({ origin: ORIGIN, token: s.token });
  });
});
