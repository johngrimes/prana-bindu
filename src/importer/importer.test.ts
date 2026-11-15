import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BASE_FILE,
  buildFixture,
  FIXTURE_ZIP,
  packageFiles,
  SHA,
  transaction,
  zipPackage,
} from "../../test/fixtures/build-ofocus-fixture.js";
import { openDatabase, type DbHandle } from "../db/connection.js";
import { FsBlobStore } from "../storage/fs.js";
import { blobKey, type BlobStore } from "../storage/types.js";
import { ImportError, importOfocus } from "./index.js";

const fixture = new Uint8Array(readFileSync(FIXTURE_ZIP));

let tmp: string;
let handle: DbHandle;
let store: FsBlobStore;

const all = <T>(sql: string, ...params: unknown[]) => handle.sqlite.prepare(sql).all(...params) as T[];
const one = <T>(sql: string, ...params: unknown[]) => handle.sqlite.prepare(sql).get(...params) as T;
const run = (source: Parameters<typeof importOfocus>[0]) => importOfocus(source, { ...handle, blobStore: store });
const storeHas = (sha: string) => {
  try {
    readFileSync(join(store.root, blobKey(sha)));
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pb-importer-"));
  handle = openDatabase(":memory:");
  store = new FsBlobStore(join(tmp, "blobs"));
  return () => rmSync(tmp, { recursive: true, force: true });
});

describe("fixture", () => {
  it("is reproducible from the committed generator script", () => {
    expect(Buffer.from(buildFixture()).equals(Buffer.from(fixture))).toBe(true);
  });
});

describe("importOfocus on the synthetic fixture", () => {
  beforeEach(async () => {
    await run({ zip: fixture, name: "synthetic-ofocus.zip" });
  });

  it("applies base and deltas in order (update, delete, reference, create)", () => {
    const milk = one<{ name: string; flagged: number; note: string; rank: number }>(
      "select name, flagged, note, rank from tasks where id = 'inbx0000002'",
    );
    // Delta 1 renamed + flagged, delta 2 set the note; untouched fields survive the partial update.
    expect(milk).toEqual({ name: "Buy oat milk", flagged: 1, note: "2% please", rank: 1 });
    expect(one("select count(*) n from tasks where id = 'del0000001'")).toEqual({ n: 0 });
    expect(one("select name from tags where id = 'tagHome0001'")).toEqual({ name: "Home" });
    expect(one("select name, in_inbox from tasks where id = 'new0000001'")).toEqual({ name: "Created in delta", in_inbox: 1 });
    // The <project> container is replaced as a unit by an update.
    expect(one("select review_interval_raw r, review_interval_steps s from projects where task_id = 'prjNested01'")).toEqual({
      r: "@3w",
      s: 3,
    });
  });

  it("maps folders with nesting and both drop encodings", () => {
    expect(all("select id, parent_id, status, rank from folders order by rank")).toEqual([
      { id: "fldWork0001", parent_id: null, status: "active", rank: 100 },
      { id: "fldClient01", parent_id: "fldWork0001", status: "active", rank: 200 },
      { id: "fldArchive1", parent_id: null, status: "dropped", rank: 300 },
      { id: "fldOld00001", parent_id: null, status: "dropped", rank: 400 },
    ]);
  });

  it("derives tag status, hierarchy and mutual exclusivity", () => {
    expect(
      all("select id, parent_id, status, children_mutually_exclusive x, note from tags order by rank, id"),
    ).toEqual([
      { id: "tagEnHigh01", parent_id: "tagEnergy01", status: "active", x: 0, note: "" },
      { id: "tagEnLow001", parent_id: "tagEnergy01", status: "active", x: 0, note: "Low energy tasks" },
      { id: "tagHome0001", parent_id: null, status: "active", x: 0, note: "" },
      { id: "tagWait0001", parent_id: null, status: "onHold", x: 0, note: "" },
      // hidden wins over prohibits-next-action
      { id: "tagOld00001", parent_id: null, status: "dropped", x: 0, note: "" },
      { id: "tagEnergy01", parent_id: null, status: "active", x: 1, note: "" },
    ]);
  });

  it("maps projects: type, status, folder, review interval", () => {
    expect(
      all(
        "select task_id, folder_id, type, status, review_interval_steps s, review_interval_unit u, review_interval_raw raw, last_review, next_review from projects order by task_id",
      ),
    ).toEqual([
      {
        task_id: "prjDone0001",
        folder_id: "fldWork0001",
        type: "parallel",
        status: "completed",
        s: 1,
        u: "month",
        raw: "@1m",
        last_review: "2026-08-01T00:00:00.000Z",
        next_review: "2026-12-01T00:00:00.000Z",
      },
      {
        task_id: "prjDrop0001",
        folder_id: "fldArchive1",
        type: "parallel",
        status: "dropped",
        s: 1,
        u: "week",
        raw: "weekly",
        last_review: "2026-01-01T00:00:00.000Z",
        next_review: null,
      },
      {
        task_id: "prjNested01",
        folder_id: "fldClient01",
        type: "sequential",
        status: "active",
        s: 3,
        u: "week",
        raw: "@3w",
        last_review: "2026-10-01T00:00:00.000Z",
        next_review: null,
      },
      {
        task_id: "prjSingle01",
        folder_id: null,
        type: "singleActions",
        status: "onHold",
        s: 1,
        u: "day",
        raw: "~1d",
        last_review: "2026-10-15T00:00:00.000Z",
        next_review: null,
      },
    ]);
    expect(all("select id, completed, dropped, in_inbox, parent_id from tasks where id like 'prj%' order by id")).toEqual([
      { id: "prjDone0001", completed: "2026-09-01T00:00:00.000Z", dropped: null, in_inbox: 0, parent_id: null },
      { id: "prjDrop0001", completed: null, dropped: "2026-03-01T00:00:00.000Z", in_inbox: 0, parent_id: null },
      { id: "prjNested01", completed: null, dropped: null, in_inbox: 0, parent_id: null },
      { id: "prjSingle01", completed: null, dropped: null, in_inbox: 0, parent_id: null },
    ]);
  });

  it("keeps fixed and floating dates, flags, estimates and inbox placement", () => {
    expect(
      one(
        "select in_inbox, parent_id, flagged, defer_date, due_date, planned_date, estimated_minutes, added, modified, sequential from tasks where id = 'inbx0000001'",
      ),
    ).toEqual({
      in_inbox: 1,
      parent_id: null,
      flagged: 1,
      defer_date: "2026-11-02T23:00:00.000Z",
      due_date: "2026-11-03T09:00:00.000",
      planned_date: null,
      estimated_minutes: 15,
      added: "2026-10-20T01:00:00.000Z",
      modified: "2026-10-21T01:00:00.000Z",
      sequential: 0,
    });
    expect(one("select planned_date, completed_by_children, sequential from tasks where id = 'grp0000001'")).toEqual({
      planned_date: "2026-11-05T09:00:00.000",
      completed_by_children: 1,
      sequential: 0,
    });
    expect(one("select dropped from tasks where id = 'grpChild002'")).toEqual({ dropped: "2026-10-10T00:00:00.000Z" });
  });

  it("applies legacy defaults to records lacking most elements", () => {
    expect(
      one("select parent_id, in_inbox, flagged, sequential, note, modified, added from tasks where id = 'lgcy0000001'"),
    ).toEqual({
      parent_id: "prjSingle01",
      in_inbox: 0,
      flagged: 0,
      sequential: 1,
      note: "",
      modified: "2015-01-01T00:00:00.000Z",
      added: "2015-01-01T00:00:00.000Z",
    });
  });

  it("normalises repeats (pre-4.7, legacy <repeat>, 4.7) and keeps clones", () => {
    expect(
      all(
        "select id, repeat_rule r, repeat_schedule_type s, repeat_anchor a, repeat_catch_up c, next_clone_id n, completed from tasks where repeat_rule is not null order by id",
      ),
    ).toEqual([
      { id: "rpt0000001", r: "FREQ=WEEKLY;BYDAY=MO", s: "regularly", a: "due", c: 0, n: 2, completed: null },
      {
        id: "rpt0000001.1",
        r: "FREQ=WEEKLY;BYDAY=MO",
        s: "regularly",
        a: "due",
        c: 0,
        n: 0,
        completed: "2026-10-27T00:00:00.000Z",
      },
      { id: "rpt0000002", r: "FREQ=DAILY;INTERVAL=3", s: "fromCompletion", a: "defer", c: 0, n: 0, completed: null },
      { id: "rpt0000003", r: "FREQ=MONTHLY;BYMONTHDAY=1", s: "regularly", a: "planned", c: 1, n: 0, completed: null },
      { id: "rpt0000004", r: "FREQ=WEEKLY;INTERVAL=2", s: "fromCompletion", a: "due", c: 0, n: 0, completed: null },
    ]);
  });

  it("orders task-tag links, synthesises a missing primary link and drops dangling ones", () => {
    expect(all("select task_id, tag_id, rank_in_task, rank_in_tag from task_tags order by task_id, rank_in_task")).toEqual([
      { task_id: "grpChild002", tag_id: "tagWait0001", rank_in_task: 0, rank_in_tag: 0 },
      { task_id: "inbx0000001", tag_id: "tagHome0001", rank_in_task: 0, rank_in_tag: 0 },
      { task_id: "inbx0000001", tag_id: "tagWait0001", rank_in_task: 1, rank_in_tag: null },
      { task_id: "rpt0000002", tag_id: "tagEnLow001", rank_in_task: 0, rank_in_tag: null },
    ]);
  });

  it("maps alarm kinds, offsets in seconds and snooze", () => {
    expect(
      all("select id, task_id, kind, fire_date, offset_seconds, repeat_interval_seconds r, snoozed from alarms order by id"),
    ).toEqual([
      { id: "alm0000001", task_id: "inbx0000001", kind: "dueRelative", fire_date: null, offset_seconds: -3600, r: 0, snoozed: 0 },
      {
        id: "alm0000002",
        task_id: "inbx0000001",
        kind: "absolute",
        fire_date: "2026-11-03T08:00:00.000",
        offset_seconds: null,
        r: 300,
        snoozed: 1,
      },
      { id: "alm0000004", task_id: "rpt0000002", kind: "deferRelative", fire_date: null, offset_seconds: 0, r: 0, snoozed: 0 },
    ]);
  });

  it("imports attachments over deduplicated, verified blobs", () => {
    expect(all("select id, task_id, blob_sha256 sha, name, content_type, size, rank from attachments order by id")).toEqual([
      // att0000001 is placed first: it is the one referenced inline by the note.
      { id: "att0000001", task_id: "inbx0000001", sha: SHA.png, name: "diagram.png", content_type: "image/png", size: 12, rank: 0 },
      { id: "att0000002", task_id: "inbx0000001", sha: SHA.png, name: "diagram copy.png", content_type: "image/png", size: 12, rank: 1 },
      { id: "att0000003", task_id: "grpChild001", sha: SHA.pdf, name: "scan", content_type: "application/pdf", size: 21, rank: 0 },
    ]);
    expect(all("select sha256, size, storage_key from blobs order by sha256")).toEqual(
      [
        { sha256: SHA.png, size: 12, storage_key: blobKey(SHA.png) },
        { sha256: SHA.pdf, size: 21, storage_key: blobKey(SHA.pdf) },
      ].sort((a, b) => a.sha256.localeCompare(b.sha256)),
    );
    expect(storeHas(SHA.png) && storeHas(SHA.pdf)).toBe(true);
    expect(storeHas(SHA.corrupt) || storeHas(SHA.unreferenced)).toBe(false);
  });

  it("converts the rich-text note to markdown with an attachment link", () => {
    expect(one<{ note: string }>("select note from tasks where id = 'inbx0000001'").note).toBe(
      [
        "Ask about the **leaking tap** and *water pressure*",
        "",
        "[Plumbing guide](https://example.com/plumbing)",
        "\\* not a list_item & \\[maybe\\]",
        "[diagram.png](attachment:att0000001)",
      ].join("\n"),
    );
  });

  it("imports custom perspectives and places built-ins from the sidebar order", () => {
    const rows = all<Record<string, unknown>>(
      "select id, builtin, favorite, rank, color, aggregation, rules_json, presentation_json, import_extras_json from perspectives order by rank, id",
    );
    expect(rows.map((r) => [r.id, r.favorite, r.rank])).toEqual([
      ["inbox", 1, 0],
      ["forecast", 1, 65536],
      ["pspRules001", 1, 131072],
      ["review", 1, 196608],
      ["pspLegacy01", 0, 262144],
      ["projects", 0, 327680],
      ["tags", 0, 393216],
      ["flagged", 0, 458752],
      ["completed", 0, 524288],
      ["changed", 0, 589824],
      ["search", 0, 655360],
    ]);
    const rules = rows.find((r) => r.id === "pspRules001")!;
    expect(rules.color).toBe("#ff8000");
    expect(rules.aggregation).toBe("any");
    expect(JSON.parse(rules.rules_json as string)).toEqual([
      { actionAvailability: "available" },
      { actionHasAnyOfTags: ["tagWait0001"] },
      { actionFutureThing: true },
    ]);
    expect(JSON.parse(rules.presentation_json as string)).toEqual({
      layout: "flat",
      grouping: "tag",
      sorting: "due",
      sidebar: "tags",
    });
    expect(JSON.parse(rules.import_extras_json as string)).toMatchObject({ version: "3.0.0.2", useSavedFocus: false });
    const legacy = rows.find((r) => r.id === "pspLegacy01")!;
    expect(JSON.parse(legacy.rules_json as string)).toEqual([{ actionAvailability: "available" }, { actionStatus: "flagged" }]);
    expect(JSON.parse(legacy.presentation_json as string)).toMatchObject({ layout: "projects", grouping: "due" });
  });

  it("maps settings to prana-bindu keys and keeps the rest raw", () => {
    const settings = Object.fromEntries(
      all<{ key: string; value_json: string }>("select key, value_json from settings").map((r) => [r.key, JSON.parse(r.value_json)]),
    );
    expect(settings).toMatchObject({ defaultDueTime: "17:30", defaultDeferTime: "08:00", dueSoonSeconds: 172800 });
    expect(settings["of.PerspectiveOrder_v3"]).toContain("pspRules001");
    expect(settings["of.XMLVersionUpgradeLog"]).toEqual([
      { client: "client00001", date: "2024-01-01T00:00:00.000Z", newVersion: 2 },
    ]);
  });

  it("records the run with counts, capabilities and warnings including raw unknown elements", () => {
    const row = one<{ source: string; app_id: string; app_version: string; capabilities_json: string; counts_json: string; warnings_json: string }>(
      "select * from import_runs",
    );
    expect(row.source).toBe("synthetic-ofocus.zip");
    expect(row.app_id).toBe("com.omnigroup.OmniFocus4");
    expect(row.app_version).toBe("188.4.0");
    expect(JSON.parse(row.capabilities_json)).toContain("time_travel");
    expect(JSON.parse(row.counts_json)).toMatchObject({
      tasks: 16,
      projects: 4,
      folders: 4,
      tags: 6,
      taskTags: 4,
      alarms: 3,
      attachments: 3,
      blobs: 2,
      customPerspectives: 2,
      builtinPerspectives: 1,
      settings: 5,
      repeatClones: 1,
      transactions: 3,
    });
    const warnings: string[] = JSON.parse(row.warnings_json);
    const has = (re: RegExp) => expect(warnings.some((w) => re.test(w)), String(re)).toBe(true);
    has(/Unknown capability "time_travel"/);
    has(/<mystery-field>42<\/mystery-field>/);
    has(/<widget id="wdg0000001"><size>3<\/size><\/widget>/);
    has(/actionFutureThing/);
    has(/failed its SHA-256 check/);
    has(/is missing from the backup/);
    has(/Tag links to a missing task or tag were skipped: 2/);
  });
});

describe("sources", () => {
  it("imports a zip file path and an unzipped .ofocus directory identically", async () => {
    const zipPath = join(tmp, "backup.zip");
    writeFileSync(zipPath, fixture);
    const fromZip = await run({ path: zipPath });

    const dir = join(tmp, "unzipped");
    for (const [name, bytes] of Object.entries(unzipSync(fixture))) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), bytes);
    }
    const fromDir = await run({ path: join(dir, "Synthetic.ofocus") });
    expect(fromDir.counts).toEqual(fromZip.counts);
    expect(fromDir.source).toBe(join(dir, "Synthetic.ofocus"));
    // The parent directory works too (package root is located inside it).
    expect((await run({ path: dir })).counts).toEqual(fromZip.counts);
  });

  describe("URLs", () => {
    let server: Server;
    let origin: string;
    beforeAll(async () => {
      server = createServer((req, res) => {
        if (req.url === "/s/share") res.writeHead(302, { location: "/files/backup.zip?sig=secret" }).end();
        else if (req.url?.startsWith("/files/backup.zip")) res.writeHead(200, { "content-type": "application/zip" }).end(fixture);
        else if (req.url === "/page") res.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
        else res.writeHead(404).end();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      server.close();
      await once(server, "close");
    });

    it("follows redirects and never records query strings", async () => {
      const result = await run({ url: `${origin}/s/share` });
      expect(result.counts.tasks).toBe(16);
      expect(result.source).toBe(`${origin}/s/share`);
    });

    it("reports HTTP failures, non-zip responses and unreachable hosts", async () => {
      await expect(run({ url: `${origin}/missing` })).rejects.toMatchObject({ code: "network", message: /HTTP 404/ });
      await expect(run({ url: `${origin}/page` })).rejects.toMatchObject({ code: "invalid_format", message: /text\/html/ });
      await expect(run({ url: "http://127.0.0.1:1/x.zip" })).rejects.toMatchObject({ code: "network" });
      await expect(run({ url: "ftp://example.com/x.zip" })).rejects.toMatchObject({ code: "invalid_format" });
    });
  });
});

describe("rejections", () => {
  const expectImportError = async (promise: Promise<unknown>, code: string, message: RegExp) => {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ImportError);
    expect(err).toMatchObject({ code, message: expect.stringMatching(message) });
  };

  it("rejects encrypted packages", async () => {
    const files = { ...packageFiles(), encrypted: strToU8("<plist/>") };
    await expectImportError(run({ zip: zipPackage(files), name: "enc.zip" }), "encrypted", /encrypted/);
  });

  it("rejects the OmniFocus 1 namespace", async () => {
    const files = packageFiles();
    files[BASE_FILE] = zipSync({
      "contents.xml": strToU8(transaction("", "http://www.omnigroup.com/namespace/OmniFocus/v1")),
    });
    await expectImportError(run({ zip: zipPackage(files), name: "v1.zip" }), "unsupported_version", /OmniFocus 1/);
  });

  it("rejects non-zip data, zips without a package and missing paths", async () => {
    await expectImportError(run({ zip: strToU8("hello"), name: "x.zip" }), "invalid_format", /not a zip/);
    await expectImportError(
      run({ zip: zipSync({ "notes/readme.txt": strToU8("hi") }), name: "other.zip" }),
      "invalid_format",
      /not an OmniFocus backup/,
    );
    await expectImportError(run({ path: join(tmp, "nope.zip") }), "not_found", /does not exist/);
  });

  it("rejects malformed XML and unknown operations", async () => {
    const files = packageFiles();
    files["20261101000000=deltaDDDDDD+deltaEEEEEE.zip"] = zipSync({ "contents.xml": strToU8("<omnifocus") });
    await expectImportError(run({ zip: zipPackage(files), name: "bad.zip" }), "corrupt", /not well-formed/);
    files["20261101000000=deltaDDDDDD+deltaEEEEEE.zip"] = zipSync({
      "contents.xml": strToU8(transaction('<task id="x" op="merge"/>')),
    });
    await expectImportError(run({ zip: zipPackage(files), name: "bad.zip" }), "invalid_format", /op="merge"/);
  });
});

describe("replace-all", () => {
  it("replaces domain data and the journal, keeps auth tables, GCs old blobs and keeps built-in view options", async () => {
    const { sqlite } = handle;
    const oldSha = "0".repeat(64);
    await store.put(blobKey(oldSha), strToU8("old"), "text/plain");
    const now = "2026-01-01T00:00:00.000Z";
    sqlite.exec(`
      insert into tasks (id, rank, name, added, modified) values ('oldTask0001', 0, 'Old', '${now}', '${now}');
      insert into blobs values ('${oldSha}', 3, 'text/plain', 'blobs/${oldSha}');
      insert into attachments (id, task_id, blob_sha256, name, content_type, size, added) values ('oldAtt00001', 'oldTask0001', '${oldSha}', 'a.txt', 'text/plain', 3, '${now}');
      insert into perspectives (id, builtin, name, rank, view_options_json, added, modified) values ('inbox', 1, 'Inbox', 0, '{"filter":"all"}', '${now}', '${now}');
      insert into perspectives (id, name, rank, added, modified) values ('oldPersp001', 'Old', 5, '${now}', '${now}');
      insert into settings values ('theme', '"dark"');
      insert into change_groups (label, created_at) values ('edit', '${now}');
      insert into change_rows (group_id, table_name, row_key_json) values (1, 'tasks', '{}');
      insert into journal_state values (1);
      insert into sessions values ('h', '${now}', '${now}', '${now}');
      insert into api_tokens (id, name, token_hash, prefix, created_at) values ('t', 'cli', 'hash', 'pb_x', '${now}');
    `);
    await run({ zip: fixture, name: "fixture.zip" });

    const count = (t: string) => Number(sqlite.prepare(`select count(*) from ${t}`).pluck().get());
    expect(count("tasks where id = 'oldTask0001'")).toBe(0);
    expect(count("perspectives where id = 'oldPersp001'")).toBe(0);
    expect(count("settings where key = 'theme'")).toBe(0);
    expect(count("change_groups") + count("change_rows") + count("journal_state")).toBe(0);
    expect(count("sessions") + count("api_tokens")).toBe(2);
    expect(storeHas(oldSha)).toBe(false);
    expect(one("select view_options_json v, favorite from perspectives where id = 'inbox'")).toEqual({
      v: '{"filter":"all"}',
      favorite: 1,
    });
    expect(count("perspectives where builtin = 1")).toBe(9);
  });

  it("leaves previous data and blobs intact when the import fails", async () => {
    await run({ zip: fixture, name: "fixture.zip" });
    const before = handle.sqlite.prepare("select count(*) from tasks").pluck().get();
    const files = packageFiles();
    files["20261101000000=deltaDDDDDD+deltaEEEEEE.zip"] = zipSync({ "contents.xml": strToU8("<omnifocus") });
    await expect(run({ zip: zipPackage(files), name: "bad.zip" })).rejects.toBeInstanceOf(ImportError);
    expect(handle.sqlite.prepare("select count(*) from tasks").pluck().get()).toBe(before);
    expect(storeHas(SHA.png)).toBe(true);
    expect(handle.sqlite.prepare("select count(*) from import_runs").pluck().get()).toBe(1);
  });

  it("removes every newly uploaded blob when an upload fails partway, after in-flight uploads settle", async () => {
    // 30 extra blobs so uploads overlap at the concurrency limit; the 5th put fails while others are in flight.
    const files = packageFiles();
    const attachments: string[] = [];
    for (let i = 0; i < 30; i++) {
      const bytes = strToU8(`extra blob ${i}`);
      const sha = createHash("sha256").update(bytes).digest("hex");
      files[`data/data-${sha}.zip`] = zipSync({ [`extra${i}.txt`]: bytes });
      attachments.push(
        `<attachment id="attExtra${String(i).padStart(3, "0")}"><task idref="inbx0000001"/><added>2026-10-20T00:00:00.000Z</added><name>extra${i}.txt</name><data-identifier>data-${sha}</data-identifier></attachment>`,
      );
    }
    files["20261101000000=deltaDDDDDD+deltaEEEEEE.zip"] = zipSync({
      "contents.xml": strToU8(transaction(attachments.join("\n"))),
    });

    let calls = 0;
    const failing: BlobStore = {
      put: async (key, body, type) => {
        const n = ++calls;
        await delay(n % 3 === 0 ? 30 : 5);
        if (n === 5) throw new Error("storage unavailable");
        await store.put(key, body, type);
      },
      get: (key) => store.get(key),
      delete: (key) => store.delete(key),
      downloadUrl: () => store.downloadUrl(),
    };
    await expect(importOfocus({ zip: zipPackage(files), name: "x.zip" }, { ...handle, blobStore: failing })).rejects.toThrow(
      "storage unavailable",
    );
    expect(calls).toBeGreaterThan(5);
    let stored: string[] = [];
    try {
      stored = readdirSync(join(store.root, "blobs"));
    } catch {
      // directory never created
    }
    expect(stored).toEqual([]);
    expect(handle.sqlite.prepare("select count(*) from tasks").pluck().get()).toBe(0);
  });
});
