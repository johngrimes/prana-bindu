// Builds the synthetic `.ofocus` importer fixture (invented data only).
// Regenerate with: npx tsx test/fixtures/build-ofocus-fixture.ts
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync, type Zippable } from "fflate";

export const FIXTURE_ZIP = fileURLToPath(new URL("./synthetic-ofocus.zip", import.meta.url));
export const PACKAGE_DIR = "Synthetic.ofocus";
export const BASE_FILE = "00000000000000=baseAAAAAAA+baseBBBBBBB.zip";

// fflate encodes zip entry times as local DOS date/time, so use local midnight to keep the bytes identical in every time zone.
const MTIME = new Date(2026, 0, 1);
const NS = "http://www.omnigroup.com/namespace/OmniFocus/v2";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Blob payloads. PNG and PDF are only magic-byte stubs; "corrupt" is stored under the wrong hash. */
export const BLOBS = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
  pdf: strToU8("%PDF-1.4\n% synthetic\n"),
  corruptClaimed: strToU8("what the hash promises"),
  corruptActual: strToU8("what the file holds"),
  missing: strToU8("never written to the package"),
  unreferenced: strToU8("no attachment points here"),
};
export const SHA = {
  png: sha256(BLOBS.png),
  pdf: sha256(BLOBS.pdf),
  corrupt: sha256(BLOBS.corruptClaimed),
  missing: sha256(BLOBS.missing),
  unreferenced: sha256(BLOBS.unreferenced),
};

const T = (s: string) => `${s}T00:00:00.000Z`;

export function transaction(body: string, ns = NS): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<omnifocus xmlns="${ns}" app-id="com.omnigroup.OmniFocus4" app-version="188.4.0" os-name="macOS">\n${body}\n</omnifocus>\n`;
}

const plist = (inner: string) => `<plist version="1.0">${inner}</plist>`;

const capability = (name: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>minimumRequiredVersion</key><string>OmniFocus 1</string><key>name</key><string>${name}</string><key>origin</key><string>migration</string></dict></plist>
`;

const task = (id: string, fields: string) => `<task id="${id}">${fields}</task>`;
const plainTask = (id: string, parent: string | null, name: string, rank: number, extra = "") =>
  task(
    id,
    `<project/><inbox>false</inbox>${parent ? `<task idref="${parent}"/>` : "<task/>"}<added>${T("2026-10-01")}</added>` +
      `<name>${name}</name><note/><rank>${rank}</rank><hidden/><context/><start/><planned/><due/><completed/>` +
      `<estimated-minutes/><order>parallel</order><flagged>false</flagged><completed-by-children>false</completed-by-children>` +
      `${extra}<modified>${T("2026-10-02")}</modified>`,
  );

const project = (id: string, name: string, rank: number, container: string, extra = "") =>
  task(
    id,
    `<project>${container}</project><inbox>false</inbox><task/><added>${T("2026-01-01")}</added><name>${name}</name>` +
      `<note/><rank>${rank}</rank>${extra}<modified>${T("2026-02-01")}</modified>`,
  );

const RICH_NOTE =
  "<note><text>" +
  '<p><run><lit>Ask about the </lit></run><run><style><value key="font-weight">9</value><value key="font-family">Helvetica</value></style><lit>leaking tap</lit></run>' +
  '<run><lit> and </lit></run><run><style><value key="font-italic">yes</value></style><lit>water pressure</lit></run></p>' +
  "<p/>" +
  '<p><run><style><value key="link">https://example.com/plumbing</value><value key="underline-style">single</value></style><lit>Plumbing guide</lit></run></p>' +
  "<p><run><lit>* not a list_item &amp; [maybe]</lit></run></p>" +
  '<p><run><lit><cell refid="att0000001" name="photo.png"/></lit></run></p>' +
  "</text></note>";

const BASE = transaction(
  [
    // Settings (F§2.13)
    `<setting id="DefaultDueTime"><added>${T("2024-01-01")}</added><modified>${T("2024-01-01")}</modified>${plist("<string>17:30:00</string>")}</setting>`,
    `<setting id="DefaultStartTime"><added>${T("2024-01-01")}</added>${plist("<string>08:00:00</string>")}</setting>`,
    `<setting id="DueSoonInterval"><added>${T("2024-01-01")}</added>${plist("<integer>172800</integer>")}</setting>`,
    `<setting id="PerspectiveOrder_v3"><added>${T("2024-01-01")}</added>${plist(
      "<array><string>ProcessInbox.v2</string><string>ProcessForecast.v2</string><string>pspRules001</string><string>ProcessNearby.v4</string><string>ProcessReview.v2</string></array>",
    )}</setting>`,
    `<setting id="XMLVersionUpgradeLog"><added>${T("2024-01-01")}</added>${plist(
      "<array><dict><key>client</key><string>client00001</string><key>date</key><date>2024-01-01T00:00:00Z</date><key>newVersion</key><integer>2</integer></dict></array>",
    )}</setting>`,

    // Folders (F§2.3): nested, and both drop encodings
    `<folder id="fldWork0001"><folder/><added>${T("2024-01-01")}</added><modified>${T("2024-01-02")}</modified><name>Work</name><note/><rank>100</rank><hidden>false</hidden></folder>`,
    `<folder id="fldClient01"><folder idref="fldWork0001"/><added>${T("2024-01-01")}</added><name>Clients</name><rank>200</rank></folder>`,
    `<folder id="fldArchive1"><added>${T("2024-01-01")}</added><modified>${T("2024-03-02")}</modified><name>Archive</name><rank>300</rank><hidden>${T("2024-03-01")}</hidden></folder>`,
    `<folder id="fldOld00001"><added>${T("2024-01-01")}</added><modified>${T("2024-04-02")}</modified><name>Old</name><rank>400</rank><hidden>true</hidden></folder>`,

    // Tags (F§2.4)
    `<context id="tagHome0001"><context/><added order="1">${T("2024-01-01")}</added><name>Home</name><rank>10</rank><hidden/><location name="Home" latitude="-27.4" longitude="153.0" radius="100" notificationFlags="1"/><tasks-user-ordered>true</tasks-user-ordered></context>`,
    `<context id="tagWait0001"><added>${T("2024-01-01")}</added><name>Waiting</name><rank>20</rank><prohibits-next-action>true</prohibits-next-action></context>`,
    `<context id="tagOld00001"><added>${T("2024-01-01")}</added><name>Someday</name><rank>30</rank><hidden>true</hidden><prohibits-next-action>true</prohibits-next-action></context>`,
    `<context id="tagEnergy01"><added>${T("2024-01-01")}</added><name>Energy</name><rank>40</rank><children-are-mutually-exclusive>true</children-are-mutually-exclusive></context>`,
    `<context id="tagEnHigh01"><context idref="tagEnergy01"/><added>${T("2024-01-01")}</added><name>High</name><rank>1</rank></context>`,
    `<context id="tagEnLow001"><context idref="tagEnergy01"/><added>${T("2024-01-01")}</added><name>Low</name><rank>2</rank><note><text><p><run><lit>Low energy tasks</lit></run></p></text></note></context>`,

    // Projects (F§2.5.1)
    project(
      "prjNested01",
      "Website Redesign",
      5,
      `<folder idref="fldClient01"/><singleton>false</singleton><last-review>${T("2026-10-01")}</last-review><review-interval>@2w</review-interval><next-review/><status>active</status>`,
      "<order>sequential</order><flagged>false</flagged>",
    ),
    project(
      "prjSingle01",
      "Errands",
      6,
      `<folder/><singleton>true</singleton><last-review>${T("2026-10-15")}</last-review><review-interval>~1d</review-interval><next-review/><status>inactive</status>`,
      "<order>parallel</order>",
    ),
    project(
      "prjDone0001",
      "Launch",
      7,
      `<folder idref="fldWork0001"/><singleton>false</singleton><last-review>${T("2026-08-01")}</last-review><review-interval>@1m</review-interval><next-review>${T("2026-12-01")}</next-review><status>done</status>`,
      `<completed>${T("2026-09-01")}</completed><order>parallel</order>`,
    ),
    project(
      "prjDrop0001",
      "Abandoned",
      8,
      `<folder idref="fldArchive1"/><singleton>false</singleton><last-review>${T("2026-01-01")}</last-review><review-interval>weekly</review-interval><status>dropped</status>`,
      `<hidden>${T("2026-03-01")}</hidden><order>parallel</order>`,
    ),

    // Inbox (fixed defer + floating due, rich note, tags, estimate, flag)
    task(
      "inbx0000001",
      `<project/><inbox>true</inbox><task/><added order="1">2026-10-20T01:00:00.000Z</added><name>Call the plumber</name>${RICH_NOTE}` +
        `<rank>0</rank><hidden/><context idref="tagHome0001"/><start>2026-11-02T23:00:00.000Z</start><planned/><due>2026-11-03T09:00:00.000</due>` +
        `<completed/><estimated-minutes>15</estimated-minutes><order>parallel</order><flagged>true</flagged><completed-by-children>false</completed-by-children>` +
        `<repetition-rule/><repetition-method/><next-clone-identifier>0</next-clone-identifier><due-date-alarm-policy/><modified>2026-10-21T01:00:00.000Z</modified>`,
    ),
    task(
      "inbx0000002",
      `<project/><inbox>true</inbox><task/><added>2026-10-20T02:00:00.000Z</added><name>Buy milk</name><note/><rank>1</rank><flagged>false</flagged><order>parallel</order>`,
    ),

    // Action group in the nested project, with an unknown element and a dropped child
    plainTask("grp0000001", "prjNested01", "Design", 1, "").replace(
      "<planned/>",
      "<planned>2026-11-05T09:00:00.000</planned>",
    ).replace("<completed-by-children>false", "<completed-by-children>true"),
    plainTask("grpChild001", "grp0000001", "Sketch layout", 1),
    plainTask("grpChild002", "grp0000001", "Pick colours", 2, "<mystery-field>42</mystery-field>").replace(
      "<hidden/>",
      `<hidden>${T("2026-10-10")}</hidden>`,
    ),

    // Repeats (F§2.6): pre-4.7 fixed + clone, start-after-completion, 4.7 planned anchor, legacy <repeat>
    plainTask(
      "rpt0000001",
      "prjSingle01",
      "Take out bins",
      1,
      "<repetition-rule>FREQ=WEEKLY;BYDAY=MO</repetition-rule><repetition-method>fixed</repetition-method><next-clone-identifier>2</next-clone-identifier>",
    ).replace("<due/>", "<due>2026-11-02T09:00:00.000</due>"),
    plainTask(
      "rpt0000001.1",
      "prjSingle01",
      "Take out bins",
      1,
      "<repetition-rule>FREQ=WEEKLY;BYDAY=MO</repetition-rule><repetition-method>fixed</repetition-method><next-clone-identifier>0</next-clone-identifier>",
    )
      .replace("<due/>", "<due>2026-10-26T09:00:00.000</due>")
      .replace("<completed/>", `<completed>${T("2026-10-27")}</completed>`),
    plainTask(
      "rpt0000002",
      "prjSingle01",
      "Water plants",
      2,
      "<repetition-rule>FREQ=DAILY;INTERVAL=3</repetition-rule><repetition-method>start-after-completion</repetition-method>",
    )
      .replace("<start/>", "<start>2026-11-01T06:00:00.000</start>")
      .replace("<context/>", '<context idref="tagEnLow001"/>'),
    plainTask(
      "rpt0000003",
      "prjSingle01",
      "Pay rent",
      3,
      "<repetition-rule>FREQ=MONTHLY;BYMONTHDAY=1</repetition-rule><repetition-method>fixed</repetition-method>" +
        "<repetition-schedule-type>from-assigned</repetition-schedule-type><repetition-anchor-date>datePlanned</repetition-anchor-date>" +
        "<catch-up-automatically>true</catch-up-automatically>",
    ).replace("<planned/>", "<planned>2026-12-01T09:00:00.000</planned>"),
    plainTask(
      "rpt0000004",
      "prjSingle01",
      "Clean filter",
      4,
      "<repeat>@2w</repeat><repetition-method>due-after-completion</repetition-method>",
    ),
    // Legacy record lacking most elements (defaults: sequential, unflagged, not inbox)
    task("lgcy0000001", `<task idref="prjSingle01"/><added>${T("2015-01-01")}</added><name>Old style task</name><rank>9</rank>`),
    plainTask("del0000001", "prjSingle01", "Deleted later", 10),

    // Task–tag links (F§2.7); rpt0000002's primary tag has no link (synthesised); one link points at a missing tag
    `<task-to-tag id="inbx0000001.tagHome0001"><added>${T("2026-10-20")}</added><task idref="inbx0000001"/><context idref="tagHome0001"/><rank-in-task>0100</rank-in-task><rank-in-tag>0010</rank-in-tag></task-to-tag>`,
    `<task-to-tag id="inbx0000001.tagWait0001"><added>${T("2026-10-20")}</added><task idref="inbx0000001"/><context idref="tagWait0001"/><rank-in-task>0200</rank-in-task><rank-in-tag/></task-to-tag>`,
    `<task-to-tag id="grpChild002.tagWait0001"><added>${T("2026-10-20")}</added><task idref="grpChild002"/><context idref="tagWait0001"/><rank-in-task>0100</rank-in-task><rank-in-tag>0005</rank-in-tag></task-to-tag>`,
    `<task-to-tag id="del0000001.tagHome0001"><added>${T("2026-10-20")}</added><task idref="del0000001"/><context idref="tagHome0001"/><rank-in-task>0100</rank-in-task><rank-in-tag>0001</rank-in-tag></task-to-tag>`,
    `<task-to-tag id="rpt0000003.tagGone00001"><added>${T("2026-10-20")}</added><task idref="rpt0000003"/><context idref="tagGone00001"/><rank-in-task>0100</rank-in-task><rank-in-tag/></task-to-tag>`,

    // Alarms (F§2.12)
    `<alarm id="alm0000001"><added order="1">${T("2026-10-20")}</added><task idref="inbx0000001"/><kind>due-relative</kind><variant/><fire-date/><fire-offset>-3600</fire-offset><repeat-interval>0</repeat-interval></alarm>`,
    `<alarm id="alm0000002"><added>${T("2026-10-20")}</added><task idref="inbx0000001"/><kind>absolute</kind><variant>snoozed</variant><fire-date>2026-11-03T08:00:00.000</fire-date><repeat-interval>300</repeat-interval></alarm>`,
    `<alarm id="alm0000003"><added>${T("2026-10-20")}</added><task idref="del0000001"/><kind>due-relative</kind><fire-offset>0</fire-offset><repeat-interval>0</repeat-interval></alarm>`,
    `<alarm id="alm0000004"><added>${T("2026-10-20")}</added><task idref="rpt0000002"/><kind>defer-relative</kind><fire-offset>0</fire-offset><repeat-interval>0</repeat-interval></alarm>`,

    // Attachments (F§2.9): shared blob, extensionless (sniffed) name, corrupt blob, missing blob
    `<attachment id="att0000001"><task idref="inbx0000001"/><added>${T("2026-10-20")}</added><name>diagram.png</name><preview-image/><data-identifier>data-${SHA.png}</data-identifier></attachment>`,
    `<attachment id="att0000002"><task idref="inbx0000001"/><added>${T("2026-10-19")}</added><name>diagram copy.png</name><data-identifier>data-${SHA.png}</data-identifier></attachment>`,
    `<attachment id="att0000003"><task idref="grpChild001"/><added>${T("2026-10-20")}</added><name>scan</name><data-identifier>data-${SHA.pdf}</data-identifier></attachment>`,
    `<attachment id="att0000004"><task idref="grpChild001"/><added>${T("2026-10-20")}</added><name>broken.txt</name><data-identifier>data-${SHA.corrupt}</data-identifier></attachment>`,
    `<attachment id="att0000005"><task idref="grpChild001"/><added>${T("2026-10-20")}</added><name>gone.txt</name><data-identifier>data-${SHA.missing}</data-identifier></attachment>`,

    // Perspectives (F§2.10): one built-in, one OF4 rule-based, one legacy
    `<perspective id="ProcessInbox"><added>${T("2024-01-01")}</added>${plist(
      "<dict><key>name</key><string>Inbox</string><key>uuid</key><string>ProcessInbox</string><key>viewState</key><dict><key>viewMode</key><string>project</string></dict></dict>",
    )}</perspective>`,
    `<perspective id="pspRules001"><added>${T("2025-01-01")}</added><modified>${T("2025-02-01")}</modified>${plist(
      "<dict><key>name</key><string>Waiting Review</string><key>version</key><string>3.0.0.2</string>" +
        "<key>tintColor</key><string>1 0.5 0</string><key>topLevelFilterAggregation</key><string>any</string>" +
        "<key>filterRules</key><string>[{&quot;actionAvailability&quot;:&quot;available&quot;},{&quot;actionHasAnyOfTags&quot;:[&quot;tagWait0001&quot;]},{&quot;actionFutureThing&quot;:true}]</string>" +
        "<key>useSavedFocus</key><false/>" +
        "<key>viewState</key><dict><key>viewMode</key><string>context</string><key>viewModeState</key><dict><key>context</key><dict>" +
        "<key>collation</key><string>context</string><key>sort</key><string>due</string><key>sidebarFilter</key><string>available-contexts</string>" +
        "</dict></dict></dict></dict>",
    )}<icon-attachment/></perspective>`,
    `<perspective id="pspLegacy01"><added>${T("2016-01-01")}</added>${plist(
      "<dict><key>name</key><string>Flagged Legacy</string><key>viewState</key><dict><key>viewMode</key><string>project</string>" +
        "<key>viewModeState</key><dict><key>project</key><dict><key>actionCompletionFilter</key><string>available</string>" +
        "<key>actionFlaggedFilter</key><string>flagged</string><key>collation</key><string>due</string><key>sort</key><string>none</string>" +
        "</dict></dict></dict></dict>",
    )}</perspective>`,

    // Unknown top-level element (kept verbatim in warnings)
    `<widget id="wdg0000001"><size>3</size></widget>`,
  ].join("\n"),
);

const DELTA_1 = transaction(
  [
    `<task id="inbx0000002" op="update"><name>Buy oat milk</name><flagged>true</flagged></task>`,
    `<task id="del0000001" op="delete"/>`,
    `<context id="tagHome0001" op="reference"><name>Home (reference copy)</name></context>`,
    `<task id="new0000001"><project/><inbox>true</inbox><task/><added>2026-10-30T12:00:00.000Z</added><name>Created in delta</name><rank>5</rank></task>`,
    `<task id="prjNested01" op="update"><project><folder idref="fldClient01"/><singleton>false</singleton><last-review>${T("2026-10-01")}</last-review><review-interval>@3w</review-interval><next-review/><status>active</status></project></task>`,
  ].join("\n"),
);

const DELTA_2 = transaction(
  `<task id="inbx0000002" op="update"><note><text><p><run><lit>2% please</lit></run></p></text></note></task>`,
);

const zipOne = (name: string, bytes: Uint8Array): Uint8Array => zipSync({ [name]: [bytes, { mtime: MTIME }] });

/** All package files (relative to the package root), without junk. */
export function packageFiles(): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {
    [BASE_FILE]: zipOne("contents.xml", strToU8(BASE)),
    "20261030120000=baseBBBBBBB+deltaCCCCCC.zip": zipOne("contents.xml", strToU8(DELTA_1)),
    "20261031090000=deltaCCCCCC+deltaDDDDDD.zip": zipOne("contents.xml", strToU8(DELTA_2)),
    "20261031090500=clientEEEEE.client": strToU8(capability("client")),
    [`data/data-${SHA.png}.zip`]: zipOne("diagram.png", BLOBS.png),
    [`data/data-${SHA.pdf}.zip`]: zipOne("scan.pdf", BLOBS.pdf),
    [`data/data-${SHA.corrupt}.zip`]: zipOne("broken.txt", BLOBS.corruptActual),
    [`data/data-${SHA.unreferenced}.zip`]: zipOne("spare.txt", BLOBS.unreferenced),
  };
  for (const cap of ["delta_transactions", "external_attachments", "floating_time_zones", "stable_repeats", "v4_7_features", "time_travel"]) {
    files[`${cap}.capability`] = strToU8(capability(cap));
  }
  return files;
}

/** Zips package files under `<PACKAGE_DIR>/` plus macOS `__MACOSX` / `._*` junk, deterministically. */
export function zipPackage(files: Record<string, Uint8Array>, dir = PACKAGE_DIR): Uint8Array {
  const entries: Zippable = {};
  const junk = strToU8("\0\u0005\u0016\u0007 AppleDouble junk");
  for (const [name, bytes] of Object.entries(files)) entries[`${dir}/${name}`] = [bytes, { mtime: MTIME }];
  entries[`__MACOSX/${dir}/._${BASE_FILE}`] = [junk, { mtime: MTIME }];
  entries[`__MACOSX/._${dir}`] = [junk, { mtime: MTIME }];
  entries[`${dir}/._${BASE_FILE}`] = [junk, { mtime: MTIME }];
  return zipSync(entries);
}

export const buildFixture = (): Uint8Array => zipPackage(packageFiles());

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(FIXTURE_ZIP, buildFixture());
  console.log(`wrote ${FIXTURE_ZIP}`);
}
