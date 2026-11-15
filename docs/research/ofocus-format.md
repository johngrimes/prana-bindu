# OmniFocus `.ofocus` package format — importer specification

Status: research output for the prana-bindu one-way importer (`prana-bindu import <path-or-url>`, `POST /api/v1/import`).
Scope: unencrypted OmniFocus 4 `.ofocus` packages (zipped or unzipped), XML namespace `http://www.omnigroup.com/namespace/OmniFocus/v2`.

Evidence base:

- **Sample**: the user's backup (OmniFocus 4, `app-id="com.omnigroup.OmniFocus4"`, `app-version="188.4.0"`, `os-name="macOS"`). One base transaction (`contents.xml`, 8.27 MB), 8 capability files, 330 attachment blobs. All counts below come from scripted analysis of this sample (Python `xml.etree` + `plistlib` + `zipfile`, throwaway scripts in `/tmp`). No personal content is reproduced; every example value, ID and name in this document is invented.
- **Public sources** (cited inline as [S1]…):
  - [S1] tomzx, *ofocus-format* (v2 branch README) — reverse-engineered OF1/OF2 format, transaction naming, `op` attributes. <https://github.com/tomzx/ofocus-format/blob/2.0/README.md>
  - [S2] jyruzicka, *rubyfocus* (Ruby parser; `patch.rb`, `document.rb`, `items/*.rb`, `review_period.rb`). <https://github.com/jyruzicka/rubyfocus>
  - [S3] rosskukulinski, *omnifocus-sync-mcp* (TypeScript; `src/ofocus/database.ts`, `store.ts`, `writer.ts`). <https://github.com/rosskukulinski/omnifocus-sync-mcp>
  - [S4] jlbrooks, *omnifocus-sync* (Python; README, `build_db.py`). <https://github.com/jlbrooks/omnifocus-sync>
  - [S5] Omni Automation, *Repeating Tasks* (`Task.RepetitionRule`, `RepetitionMethod`, `RepetitionScheduleType`, `AnchorDateKey`, `catchUpAutomatically`). <https://omni-automation.com/omnifocus/task-repeat.html>
  - [S6] Omni Automation, *Perspective* (custom perspective `archivedFilterRules` / `archivedTopLevelFilterAggregation` grammar). <https://omni-automation.com/omnifocus/perspective.html>
  - [S7] Omni Automation, *Tag* (`Tag.Status` derived from `allowsNextAction` and `active`; `childrenAreMutuallyExclusive`). <https://omni-automation.com/omnifocus/tag.html>
  - [S8] Omni Automation, *Project* (`Project.Status`, `ReviewInterval {steps, unit}`, `containsSingletonActions`, `completedByChildren`, `shouldUseFloatingTimeZone`). <https://omni-automation.com/omnifocus/project.html>
  - [S9] Omni Automation, *Folder* (`Folder.Status` Active/Dropped). <https://omni-automation.com/omnifocus/folder.html>
  - [S10] Omni Automation, *Task* (`shouldUseFloatingTimeZone`, `effectiveDropDate`, `estimatedMinutes`, `sequential`, task status rules). <https://omni-automation.com/omnifocus/task.html>
  - [S11] Omni Group, *OmniFileStore EncryptionFormat.md* (encrypted sync stores; referenced by [S3]/[S4]). <https://github.com/omnigroup/OmniGroup/blob/main/Frameworks/OmniFileStore/EncryptionFormat.md>
  - [S12] Omni Automation, *Task Notifications* (`Task.Notification`: `kind` ∈ Absolute/DueRelative/DeferRelative/Unknown, `relativeFireOffset`, `repeatInterval` seconds, `isSnoozed`, `usesFloatingTimeZone`). <https://omni-automation.com/omnifocus/task-notifications.html>

Statements marked **[INFERENCE]** are not confirmed by a public source or by unambiguous sample evidence.

---

## 1. Package layout

```
OmniFocus.ofocus/
├── 00000000000000=<fromId>+<toId>.zip        base ("master") transaction — exactly one
├── <yyyyMMddHHmmss>=<parentId>+<toId>.zip     delta transactions — 0..n (sample: 0)
├── <yyyyMMddHHmmss>=<p1>+<p2>+<toId>.zip      merge transactions — 0..n (sample: 0)
├── <yyyyMMddHHmmss>=<clientId>.client          client registrations (sync stores only; sample: 0)
├── encrypted                                   encryption metadata (encrypted stores only; sample: absent)
├── *.capability                                feature markers (plist) — sample: 8
└── data/
    └── data-<sha256 hex>.zip                   attachment blobs — sample: 330
```

- Every transaction `.zip` contains exactly one entry, `contents.xml` (sample: 1 entry, deflate).
- The user-supplied archive (`OmniFocus.zip`) wraps the package as `OmniFocus.ofocus/…` and contains macOS `__MACOSX/._*` AppleDouble junk entries (sample: 341 of 682 entries). The importer must locate the package root as "the directory that contains a file matching the base-transaction regex" and ignore `__MACOSX/` and `._*` entries.
- `encrypted` present ⇒ the store is end-to-end encrypted (AES-CTR + HMAC per 64 KiB segment, keys wrapped by a passphrase-derived KEK) [S3][S4][S11]. Requirements say unencrypted input only: the importer must fail with a clear error if `encrypted` exists.
- `.client` files are plists tracking each device's synced tail (`tailIdentifiers`) [S1][S3]; irrelevant to import, ignore.

### 1.1 Capability files

Each `*.capability` is an Apple XML plist dict with keys `appStoreURL`, `dateEnabled` (date), `enablingClientIdentifier` (11-char id), `minimumRequiredVersion` (string), `name` (= file stem), `origin` (`migration` | `inference`). Observed:

| name | minimumRequiredVersion | origin | Importer meaning |
|---|---|---|---|
| `delta_transactions` | OmniFocus 1 | inference | Deltas use `op="update"`/`op="delete"` (§3). |
| `external_attachments` | OmniFocus 1 | migration | Attachments live in `data/` blobs, not inline (§2.9). |
| `unknown_element_import` | OmniFocus 1 | migration | Clients must preserve/ignore unknown elements — importer must tolerate unknown elements (log, don't fail). |
| `stable_repeats` | OmniFocus 1 | migration | Completed occurrences of repeating tasks are "clones" with stable ids `<origId>.<n>` (§2.6). **[INFERENCE]** |
| `versioned_perspectives` | OmniFocus 1 | migration | Perspective plists carry versions; built-in perspective ids may be version-suffixed (`ProcessTags.v3`) in settings (§2.10). **[INFERENCE]** |
| `active_object_hidden_dates` | OmniFocus 2 | migration | `<hidden>` holds a drop *date* instead of a boolean (§2.3). **[INFERENCE]** |
| `floating_time_zones` | OmniFocus 3.5.1 | migration | Dates without `Z` are floating wall-clock times (§2.2). |
| `v4_7_features` | OmniFocus 4.7 | migration | Planned dates, repetition schedule type / anchor / catch-up, mutually-exclusive tags, etc. |

No public specification of capability files was found; meanings are inferred from names plus observed data. The importer should record the set of capabilities in its import log and **warn** (not fail) on unknown names.

---

## 2. `contents.xml`

Root: `<omnifocus xmlns="http://www.omnigroup.com/namespace/OmniFocus/v2" app-id="…" app-version="…" os-name="…" os-version="…" machine-model="…">`. (OF1 files use namespace `…/OmniFocus/v1`; v1 updates *replace* elements rather than merge [S2]. Support v2 only; reject v1 with a message.)

Top-level children are objects, each with an `id` attribute (and optionally `op`). The base file contains no `op` attributes (sample: 0).

| Element | Meaning | Sample count |
|---|---|---|
| `task` | action, action group, or project (when it has a non-empty `<project>`) | 2561 (44 projects) |
| `attachment` | file attached to a task (via note) | 500 |
| `alarm` | notification on a task | 110 |
| `task-to-tag` | task↔tag link with ordering | 79 |
| `context` | **tag** (named "context" pre-OF3) | 12 |
| `perspective` | built-in or custom perspective (plist) | 11 |
| `setting` | database-level setting (plist) | 11 |
| `folder` | project folder | 4 |

Physical order in the file is grouped by type but not guaranteed; references may be forward. Parse everything first, then resolve.

### 2.1 Generic value conventions

- **IDs**: 11 chars of `[A-Za-z0-9_-]` (e.g. `aB3dE5fG7hJ`) [S1]. Exceptions: repeat-clone task ids `<id>.<n>[.<n>…]` (§2.6), task-to-tag ids `<taskId>.<tagId>`, built-in perspective/setting ids are words (`ProcessInbox`, `DueSoonInterval`). Never detect references by regex on text — 5 task names and 1 tag name in the sample are themselves 11-char id-shaped strings.
- **References**: empty element with `idref` attribute (`<task idref="…"/>`, `<context idref="…"/>`, `<folder idref="…"/>`). An element present **without** `idref` (`<task/>`, `<context/>`, `<folder/>`) means "no reference" (top level).
- **Empty element** (`<due/>`) = null / cleared [S3]. **Absent element** = not specified (in the base: default; in a delta update: unchanged).
- **Booleans**: `true` / `false`.
- **Integers**: decimal; `rank` is signed 32-bit.
- **Text**: XML-escaped; names may contain newlines (sample: 4 task names).
- Element child order within an object is stable (schema-like) but must not be relied on.

### 2.2 Dates and time zones

Two lexical forms, both always with milliseconds in the sample:

| Form | Example | Meaning |
|---|---|---|
| Fixed (UTC) | `2025-03-04T22:00:00.000Z` | Absolute instant. |
| Floating | `2025-03-05T09:00:00.000` | Wall-clock time in whatever the user's current time zone is ("floating time zone") [S8][S10]. |

`shouldUseFloatingTimeZone` (Omni Automation) is not stored as an element; it is expressed purely by the presence/absence of `Z` on `start`/`due`/`planned` (and alarm `fire-date`) [S8][S10]. **[INFERENCE]** for the encoding; the property itself is documented.

Observed per field (tasks):

| Field | UTC (`Z`) | Floating | Empty |
|---|---|---|---|
| `added` | 2561 | 0 | 0 |
| `modified` | 2074 | 0 | (487 absent) |
| `completed` | 2272 | 0 | 273 |
| `hidden` (drop date) | 16 | 0 | 2516 |
| `start` (defer) | 99 | 453 | 1993 |
| `due` | 102 | 385 | 2058 |
| `planned` | 0 | 0 | 1657 |
| project `last-review` | 44 | 0 | 0 |
| project `next-review` | 1 | 0 | 43 |
| alarm `fire-date` | 2 | 5 | 103 |

Per-task combination: tasks never mix (both dates floating: 207; both UTC: 96; only one date set in the rest). Bookkeeping timestamps (`added`, `modified`, `completed`, `hidden`, `last-review`) are always UTC. Common floating times of day: start 00:00, 06:00; due 09:00, 07:15, 20:00 — i.e. user-chosen wall clock times. The `DefaultDueTime` setting is `"HH:MM:SS"` (sample `09:00:00`).

Importer rule: store user-facing dates as `{value, floating: bool}` — floating values kept as a local `YYYY-MM-DDTHH:MM:SS.sss` string, fixed values as UTC ISO strings. Never convert floating values with the server's TZ.

Durations: `estimated-minutes` (integer minutes; sample values 5, 15); alarm `fire-offset` (integer, negative = before; sample `-43200` — seconds ⇒ 12 h, see §2.12); setting `DueSoonInterval` (seconds; `604800` = 7 days).

### 2.3 `folder`

```xml
<folder id="fOld3rId001">
  <folder idref="parentFldr1"/>       <!-- or <folder/>; absent = top level -->
  <added>…Z</added>
  <modified>…Z</modified>
  <name>Example Folder</name>
  <note/>                             <!-- rich text, see §2.8 -->
  <rank>-2087714816</rank>
  <hidden>2020-01-01T00:00:00.000Z</hidden>  <!-- drop date | true | false | absent -->
</folder>
```

| Child | Observed (n=4) | Notes |
|---|---|---|
| `added` | 4 | UTC |
| `modified` | 4 | UTC |
| `name` | 4 | |
| `rank` | 4 | sibling order (§2.11) |
| `hidden` | 3 | 1 date, 1 `true`, 1 `false`. Any non-empty, non-`false` value ⇒ **dropped**; a date is the drop date. Folder status is Active/Dropped only [S9]. |
| `folder` | 1 | parent reference; the one observed is empty (`<folder/>`) |
| `note` | 1 | empty |

Sample hierarchy is flat (no folder has a parent). Projects reference their folder via `task/project/folder/@idref`.

### 2.4 `context` (tag)

```xml
<context id="t4gIdAbc123">
  <context idref="parentTag01"/>      <!-- or <context/>; absent = top level -->
  <added order="1">…Z</added>
  <modified>…Z</modified>
  <name>Example Tag</name>
  <note/>
  <rank>2013265920</rank>
  <hidden>true</hidden>
  <prohibits-next-action>false</prohibits-next-action>
  <location name="…" latitude="-12.345" longitude="123.456" radius="1" notificationFlags="1"/>
  <tasks-user-ordered>true</tasks-user-ordered>
</context>
```

| Child | Observed (n=12) | Meaning |
|---|---|---|
| `added` (+`@order` on 2) | 12 | |
| `name` | 12 | |
| `rank` | 12 | sibling order |
| `modified` | 10 | |
| `hidden` | 10 (8 `true`, 2 empty) | `true` ⇒ tag **Dropped** (inverse of OA `active`) [S7] |
| `prohibits-next-action` | 2 (`false`) | `true` ⇒ tag **On Hold** (inverse of OA `allowsNextAction`) [S7] |
| `location` | 4 (2 empty; 1 with `radius`+`notificationFlags` only; 1 with `latitude`,`longitude`,`radius`,`notificationFlags`) | location-based tag (OF Nearby). Attributes per [S1] also include `name`. |
| `tasks-user-ordered` | 3 (1 `true`, 2 `false`) | whether the tag's task list uses manual order (`rank-in-tag`) **[INFERENCE]** |
| `context` | 2 (both empty = top level) | parent tag |
| `note` | 2 (empty) | |

Tag status derivation [S7]: `hidden=true` → dropped; else `prohibits-next-action=true` → on hold; else active. Sample: 8 dropped, 4 active, 0 on hold. Hierarchy flat in sample. OF 4.7 "mutually exclusive children" (`childrenAreMutuallyExclusive` [S7]) has an XML element not present in the sample — element name unknown (open question); unknown elements must be logged.

### 2.5 `task` (actions, action groups, projects)

Canonical child sequence (most common shape, 1264 tasks):
`project, inbox, task, added, name, note, rank, hidden, context, start, planned, due, completed, estimated-minutes, order, flagged, completed-by-children, repetition-rule, repetition-method, repetition-schedule-type, repetition-anchor-date, catch-up-automatically, next-clone-identifier, due-date-alarm-policy, defer-date-alarm-policy, latest-time-to-start-alarm-policy, planned-date-alarm-policy, modified`. 18 distinct child sequences occur; older records omit the v4.7 fields.

| Child | Present / non-empty (of 2561) | Format / values | Meaning |
|---|---|---|---|
| `project` | 2553 / 44 non-empty | container (§2.5.1) | non-empty ⇒ this task **is a project**; empty `<project/>` ⇒ not a project [S2][S3] |
| `inbox` | 2553 | bool (`true` 471) | in the Inbox; all 471 are root tasks without a project |
| `task` | 2561 / 2046 with `idref` | ref | parent task (action group or project). Absent/empty idref ⇒ top level (inbox item or project) |
| `added` | 2561 (`@order` on 78) | UTC | creation |
| `modified` | 2074 | UTC | last modification |
| `name` | 2561 | text | title |
| `note` | 2544 / 575 non-empty | rich text §2.8 | |
| `rank` | 2561 | int32 | order among siblings (§2.11) |
| `hidden` | 2532 / 16 dated | UTC date | **drop date** (dropped) [S3] |
| `context` | 2557 / 77 with idref | ref | the task's **first** tag (redundant with `task-to-tag`, §2.7) |
| `start` | 2545 / 552 | date (fixed or floating) | **defer** date [S2][S3] |
| `planned` | 1657 / 0 | date | planned date (OF 4.7) |
| `due` | 2545 / 487 | date | due date |
| `completed` | 2545 / 2272 | UTC | completion date |
| `estimated-minutes` | 2545 / 51 | int | estimated duration (values 5×48, 15×3) |
| `order` | 2561 | `parallel` (2561) / `sequential` | child ordering; absent ⇒ `sequential` [S1][S2] |
| `flagged` | 2547 | bool (`true` 1098) | flag |
| `completed-by-children` | 2561 | bool (all `false`) | auto-complete parent when last child completes [S8][S10] |
| `repetition-rule` | 2545 / 504 | RRULE string | §2.6 |
| `repetition-method` | 2545 / 504 | `fixed` 433, `due-after-completion` 50, `start-after-completion` 21 | §2.6 |
| `repetition-schedule-type` | 1674 / 396 | `from-assigned` 373, `from-completion` 23 | §2.6 (4.7) |
| `repetition-anchor-date` | 1674 / 396 | `dateDue` 260, `dateToStart` 136 | §2.6 (4.7) |
| `catch-up-automatically` | 1657 | bool (all `false`) | §2.6 (4.7) |
| `repeat` | 10 / 6 | legacy interval `@3m`, `@1y`, `@2m`, `@1w`, `@2w` | pre-RRULE repeat; always alongside an equivalent `repetition-rule` |
| `next-clone-identifier` | 2542 | int (0 on 2520) | next suffix for repeat clones (§2.6) |
| `due-date-alarm-policy`, `defer-date-alarm-policy`, `latest-time-to-start-alarm-policy` | 2532 each | always empty | per-date notification policy; structure unknown (never populated) |
| `planned-date-alarm-policy` | 1657 | always empty | as above |

Defaults when absent (8 legacy tasks lack `project`, `inbox`, `note`, `hidden`, … entirely): not a project, not inbox, not flagged, not dropped, `order=sequential`, no tags.

Derived state (all computed by the importer/runtime, not stored by OF):

- **Kind**: project if non-empty `<project>`; else action group if any task references it as parent (sample: 104 action groups); else action. Sample depths below root: 0→515, 1→1243, 2→653, 3→122, 4→17, 5→11.
- **Completed**: `completed` non-empty. **Dropped**: `hidden` non-empty (tasks); for projects also `status=dropped`.
- **Effective** values (inherited from ancestors: drop, completion, defer, due, flag) per [S8][S10] (`effectiveDropDate`, `effectiveDueDate`, `effectiveFlagged`…). Store raw values; compute effective ones at query time. Sample has 68 incomplete, undropped tasks under a completed parent and 1 dropped task with children — these must display as effectively completed/dropped.

#### 2.5.1 Projects (`<project>` container)

```xml
<task id="pr0j3ctId01">
  <project>
    <folder idref="fOld3rId001"/>
    <singleton>true</singleton>
    <last-review>2026-01-10T22:00:00.000Z</last-review>
    <review-interval>@1w</review-interval>
    <next-review/>
    <status>active</status>
  </project>
  <inbox>false</inbox>
  <task/>                               <!-- projects are always top level -->
  …                                     <!-- all ordinary task fields apply -->
</task>
```

| Child | Observed (n=44) | Values |
|---|---|---|
| `folder` | 44 (all with idref) | containing folder; empty/absent ⇒ top level of Projects |
| `singleton` | 44 (all `true`) | `true` ⇒ **single-action list** [S1][S8] (`containsSingletonActions`) |
| `last-review` | 44 | UTC |
| `review-interval` | 44 | `@1w` 18, `@1d` 18, `~1d` 8 |
| `next-review` | 44 (43 empty) | UTC; usually empty ⇒ compute `last-review + interval` |
| `status` | 44 | `active` 29, `done` 13, `dropped` 1, `inactive` 1 (`inactive` = **On Hold**) [S1][S2][S8] |

Project type: `singleton=true` ⇒ single actions; else `order` (`parallel`/`sequential`; absent ⇒ sequential) [S1][S2][S8].
Status consistency in sample: all 13 `done` have `completed`; the 1 `dropped` has `hidden`; none of the others have either.
`review-interval` grammar: `^[@~]?(\d+)([dwmy])$` (days/weeks/months/years) [S2]; OA models it as `{steps, unit}` [S8]. The `@`/`~` prefix meaning is unknown ("use unknown" [S2]); in the legacy `<repeat>` field `@` co-occurs only with `repetition-method=fixed`. Preserve the raw string.
Projects carry ordinary task fields too (flag, dates, note, tags, repeat): sample has 1 project with a tag, 1 with a defer date.
Setting `OFMDefaultSingletonProjectPersistentIdentifier` names the project that receives auto-filed inbox items (resolves to a project in the sample).

### 2.6 Repetition

Fields on `task`: `repetition-rule` (RFC 5545 RRULE body without `RRULE:` prefix) [S2][S5], `repetition-method`, and, since OF 4.7, `repetition-schedule-type`, `repetition-anchor-date`, `catch-up-automatically` [S5]. Legacy `repeat` (`@<n><d|w|m|y>`) [S1].

Observed RRULEs (504 tasks): `FREQ=DAILY;INTERVAL=1` 176, `FREQ=WEEKLY` 96, `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO` 49, `FREQ=WEEKLY;INTERVAL=2;BYDAY=FR` 49, `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=SU` 48, `FREQ=WEEKLY;INTERVAL=2;BYDAY=SA` 40, `FREQ=WEEKLY;BYDAY=SA` 17, `FREQ=YEARLY` 7, `FREQ=MONTHLY;INTERVAL=3` 6, `FREQ=MONTHLY;INTERVAL=2` 6, `FREQ=MONTHLY` 4, `FREQ=DAILY;INTERVAL=30` 4, `FREQ=MONTHLY;BYMONTHDAY=1` 2. Parts used: `FREQ`, `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `WKST`. No `COUNT`/`UNTIL` in the sample, but OF 4.7 supports end conditions — the importer must accept any RFC 5545 RRULE (store verbatim; parse with an RRULE library).

Enum mapping (XML ↔ Omni Automation [S5]):

| XML element | XML values | OA |
|---|---|---|
| `repetition-method` | `fixed`, `due-after-completion`, `start-after-completion` | `RepetitionMethod.Fixed`, `.DueDate`, `.DeferUntilDate` |
| `repetition-schedule-type` | `from-assigned`, `from-completion` (+ empty) | `RepetitionScheduleType.Regularly`, `.FromCompletion`, `.None` |
| `repetition-anchor-date` | `dateDue`, `dateToStart` (`datePlanned` expected, unobserved) | `AnchorDateKey.DueDate`, `.DeferDate`, `.PlannedDate` |
| `catch-up-automatically` | bool | `catchUpAutomatically` ("skip occurrences in the past", regular repeats only) |

Observed combinations (method, schedule, anchor, catch-up): (`fixed`,`from-assigned`,`dateDue`,false) 240; (`fixed`,`from-assigned`,`dateToStart`,false) 116; (`fixed`,—,—,—) 60; (`due-after-completion`,—,—,—) 30; (`due-after-completion`,`from-completion`,`dateDue`,false) 20; (`start-after-completion`,—,—,—) 18; (`fixed`,`from-assigned`,`dateToStart`,absent) 17; (`start-after-completion`,`from-completion`,`dateToStart`,false) 3.

Normalisation for the 108 pre-4.7 records lacking schedule/anchor **[INFERENCE, consistent with every complete record in the sample]**:
- `fixed` → schedule `from-assigned`, anchor = `dateDue` if due set, else `dateToStart`.
- `due-after-completion` → `from-completion`, anchor `dateDue`.
- `start-after-completion` → `from-completion`, anchor `dateToStart`.
- missing `catch-up-automatically` → `false`.

Anchor/date mismatches to tolerate: 5 anchored `dateDue` with only a defer date, 1 anchored `dateDue` with no dates, 3 repeating tasks with no dates at all.

**Repeat clones.** When a repeating task is completed, OF keeps the original id for the *next* occurrence and writes the completed occurrence as a new task whose id is `<originalId>.<n>` with `n` taken from the original's `next-clone-identifier` (then incremented) **[INFERENCE from sample; `stable_repeats` capability]**. Children of a repeating group are cloned with nested suffixes (shapes seen: `X.n` 362, `X.n.n` 28, `X.n.n.n` 97 — e.g. `aB3dE5fG7hJ.12.0`). Sample: 487 clone-id tasks, 474 completed, 13 incomplete (children inside cloned groups); 345 originals still exist, 142 clones' originals no longer exist (deleted/finished series) — not an error. Clones keep the repetition fields (474 of 504 tasks with a rule are completed clones). Import clones as ordinary tasks; optionally record `repeat_origin_id` = id prefix before the first `.` when that task exists. Ids are opaque — keep the full dotted id as the external id.

### 2.7 `task-to-tag`

```xml
<task-to-tag id="aB3dE5fG7hJ.t4gIdAbc123">
  <added order="1">…Z</added>
  <task idref="aB3dE5fG7hJ"/>
  <context idref="t4gIdAbc123"/>
  <rank-in-task>06f4</rank-in-task>
  <rank-in-tag>0191</rank-in-tag>     <!-- may be empty -->
  <modified>…Z</modified>            <!-- 1 of 79 -->
</task-to-tag>
```

- `id` is always `<taskId>.<tagId>` (79/79). 77 tasks have links; 2 tasks have 2 tags; tags in use: 4.
- `rank-in-task`: 4-char lowercase hex string (79/79) — order of tags on the task; compare as strings (fractional-index style **[INFERENCE]**).
- `rank-in-tag`: 4-char hex (60) or empty (19) — manual order of the task within the tag. Empty ranks occur on tags whose `tasks-user-ordered` is false/absent and on some links in user-ordered tags.
- The task's own `<context idref>` always equals the link with the lowest `rank-in-task` (77/77, incl. both multi-tag tasks): it is the "primary" tag. Use `task-to-tag` as the source of truth; if a task has `<context idref>` but no link (none in sample), synthesise one.

### 2.8 Notes (rich text)

`<note>` (on task, folder, tag; only tasks have content in the sample: 575) holds one `<text>` with paragraph/run XML (the Omni rich-text format shared with OmniOutliner; [S1] calls it "formatted as HTML", which is inaccurate for v2).

```xml
<note>
  <text>
    <p>
      <run><lit>Plain text </lit></run>
      <run>
        <style>
          <value key="font-weight">9</value>
          <value key="link">https://example.com/</value>
        </style>
        <lit>link text</lit>
      </run>
    </p>
    <p/>                                       <!-- empty paragraph = blank line -->
    <p><run><lit><cell refid="att1d000001" name="file.pdf"/></lit></run></p>
  </text>
</note>
```

Element counts: `p` 25 889 (731 empty), `run` 37 106 (`lit` only 20 385; `style`+`lit` 16 721), `lit` 37 106 (2 empty; 12 contain `\n`; 70 contain `\t`; 500 contain a `<cell>`), `style` 16 721, `value` 45 972, `color` 9 660, `lightColor` 14, `cell` 500. Max 1 044 paragraphs in one note. `<p>` contains only `<run>`; `<run>` contains optional `<style>` then `<lit>`; no paragraph-level style elements observed.

`<value key=…>` keys (count): `font-family` 7305 (text), `font-italic` 6096 (`yes`), `paragraph-first-line-head-indent` 5837 / `paragraph-head-indent` 5837 (numbers), `font-weight` 5311 (`9` 3504, `11` 1807), `link` 4664 (URL text), `font-stroke` 3195, `font-fill` 3193, `text-background-color` 3142, `underline-color` 130 (all contain `<color>`), `underline-style` 607 (`single`), `font-fixed-pitch` 329 (`yes`), `paragraph-spacing` 254, `font-style` 67 (`Regular`/`Heavy`), `paragraph-base-writing-direction` 3, `font-name` 1, `strikethrough-style` 1 (`single`).
`<color>`: `space="srgb" catalog="#$customDynamic" name=… r g b [a]` (9 556) or `space="gg22" w=…` (grey, 104); `<lightColor>` child for dynamic light/dark colours (14).
Link schemes: `mailto` 2134, `https` 1573, `message` (Apple Mail) 448, `http` 279, `tel` 203, relative/other 21, `file` 3, other 3 (all percent-encoded URL strings).
`<cell refid=… [name=…] [width=… height=…]/>` inside a `<lit>` is an **inline attachment** referencing an `attachment` id (500/500 resolve; every attachment is referenced by exactly the note of its own task). `name` is a display filename (differs from the attachment `<name>` in 32 cases; 2 cells lack `name`).

**Conversion to plain text** (for search, API `note` field): join paragraphs with `\n`; within a paragraph concatenate `lit` text; replace each `<cell>` with `[attachment: <attachment name>]` (or U+FFFC); keep `\t`/`\n` literally.

**Conversion to Markdown** (recommended storage for prana-bindu notes):
1. Paragraph → line; empty `<p>` → blank line; join with `\n` (do not double newlines — OF paragraphs are lines, not Markdown paragraphs; emit a hard break `  \n`/`\\\n` or keep single `\n` and render with line-break-preserving Markdown).
2. Run style → inline marks, applied to the escaped run text: `font-weight ≥ 7` (9 = bold, 11 = heavy) → `**…**`; `font-italic=yes` → `*…*`; `strikethrough-style` → `~~…~~`; `font-fixed-pitch=yes` → `` `…` ``; `link` → `[text](url)` (autolink `<url>` when text equals url).
3. `<cell>` → `[name](attachment:<attachmentId>)`; the attachment importer maps it to the new attachment URL/id.
4. Escape Markdown metacharacters in literal text *only* where they would change meaning (leading `#`, `>`, `-`/`*`/`+` followed by space, `1.` list markers, backticks, `*`/`_` adjacent to word boundaries) — users' notes often contain literal list markers (`-` 228, `*` 85, `•` 37, numbered lines) that should stay literal text; simplest faithful rule is to escape leading list/heading markers and inline `*_`[]`` characters.
5. **Lossy**: fonts, sizes, colours, background colours, underline, indents, paragraph spacing, writing direction, cell width/height. If full fidelity is required later, also store the original `<text>` XML (it is small: the whole notes corpus is a fraction of 8 MB) in an `note_source` column.

### 2.9 `attachment` and `data/` blobs

```xml
<attachment id="att1d000001">
  <task idref="aB3dE5fG7hJ"/>
  <added>…Z</added>
  <name>Example.pdf</name>
  <preview-image>iVBORw0KGgo…</preview-image>   <!-- optional base64 PNG -->
  <data-identifier>data-<64 hex></data-identifier>
</attachment>
```

| Child | Observed (n=500) | Notes |
|---|---|---|
| `task` | 500 | owning task (all resolve) |
| `added` (`@order` on 3) | 500 | UTC |
| `name` | 500 | display filename; extensions: png 251, jpg 125, pdf 53, gif 21, docx 19, xlsx 15, jpeg 5, json 2, and 1 each of ods/log/m4a/doc/ipynb/har/csv/txt/pptx |
| `preview-image` | 500 / 7 non-empty | base64 PNG thumbnail (2–30 KB of base64) |
| `data-identifier` | 500 | `data-` + 64 lowercase hex = blob file stem |

Blob storage (`external_attachments` capability):
- File `data/<data-identifier>.zip` — a zip archive with **one** deflated entry whose name is the original filename (equal to `<name>` in 476/500 cases).
- The hex in the identifier is the **SHA-256 of the uncompressed entry bytes** (verified 330/330).
- Blobs are content-addressed and shared: 330 blobs serve 500 attachments (281 blobs used once, 49 used 2–12 times).
- Integrity in sample: 0 attachments with missing blob, 0 unreferenced blobs.
- Payload sizes: 100.2 MB total uncompressed, max 10.6 MB; magic-sniffed types: PNG 172, JPEG 57, PDF 50, ZIP-container (OOXML/ODF) 33, GIF 8, OLE (legacy Office) 1, other/text 9.
- Content type: none is stored. Derive from the attachment name's extension, falling back to magic-byte sniffing, then `application/octet-stream`.
- Attachments per task: 1–21 (86 tasks have one).

Import: for each distinct blob, unzip, verify SHA-256, upload once to object storage keyed by hash; create one prana-bindu attachment row per `attachment` element. Attachments may also be referenced by a perspective's `icon-attachment` (see §2.10).

### 2.10 `perspective`

```xml
<perspective id="ProcessInbox">          <!-- built-in word id, or 11-char id for custom -->
  <added order="1">…Z</added>
  <modified>…Z</modified>
  <plist version="1.0"><dict>…</dict></plist>   <!-- inline Apple XML plist body -->
  <icon-attachment/>                             <!-- custom only; empty in sample -->
</perspective>
```

Encoding: the `<plist>` element (in the OmniFocus namespace) contains a standard Apple XML plist body (`dict`, `array`, `string`, `integer`, `real`, `true`, `false`, `date`, `data`). To parse, re-serialise the children inside a `<plist>` root without namespace and feed to a plist parser.

Sample: 11 perspectives — 8 built-in (`ProcessInbox`, `ProcessProjects`, `ProcessContexts`, `ProcessDueSoon`, `ProcessFlagged`, `ProcessReview`, `ProcessCompleted`, `ProcessRecentChanges`; cf. [S1]) and 3 custom (11-char ids).

Built-in plist keys: `name` (Inbox, Projects, Contexts, Due, Flagged, Review, Completed, Changed), `uuid` (= id), `iconNameInBundle`, `viewState { viewMode: "project"|"context", viewModeState { project|context { actionCompletionFilter, actionDurationFilter, actionFlaggedFilter, collation, firstResponder, sidebarFilter, sort, sidebar{selected,expanded}, content{columns{<col>{visible}}, expanded, collapsed, selected} } }, focusedObjects, frame, search }`. These are legacy (OF1/2-era) view settings; OF4 built-ins are app-defined and not driven by these plists.

Observed enum values:
- `actionCompletionFilter`: `incomplete`, `complete`, `all`, `available`
- `actionDurationFilter`: `any`
- `actionFlaggedFilter`: `all`, `flagged`, `due`
- `collation` (grouping): `none`, `context`, `due`, `next-review`, `completed`, `modified`
- `sort`: `none`, `project`, `due`, `completed`, `modified`, `due-and-flagged`
- `sidebarFilter`: `remaining-projects`, `available-contexts`, `all-contexts`

Custom perspectives:
- 1 legacy custom perspective (OF2-style: `name`, `uuid`, `viewState`, `useSavedColumns/Expansion/Focus`; no `filterRules`) — its filtering is expressed only by the legacy viewState enums above.
- 2 OF4 custom perspectives with keys: `name`, `version` (`3.0.0.2`), `tintColor` (string `"r g b"` floats 0–1), `topLevelFilterAggregation` (`all`), `filterRules` (**JSON string**), `useCustomOrderWhenUngrouped`, `useSavedColumns`, `useSavedExpansion`, `useSavedFocus`, `viewState { viewMode, viewModeState { context { collation, sidebarFilter, sort } } }`, plus `<icon-attachment/>` element (empty).
- Example (sample shape, ids invented): `filterRules = [{"actionAvailability":"available"},{"actionWithinFocus":["fOld3rId001"]}]`.

Filter-rule grammar (JSON array of single-key objects, combined by `topLevelFilterAggregation` ∈ `all|any|none`) per [S6]:

| Rule key | Value |
|---|---|
| `actionAvailability` | `firstAvailable`, `available`, `remaining`, `completed`, `dropped` |
| `actionStatus` | `due`, `flagged` |
| `actionHasDueDate`, `actionHasDeferDate`, `actionHasDuration`, `actionIsProject`, `actionIsGroup`, `actionIsProjectOrGroup`, `actionRepeats`, `actionIsUntagged`, `actionIsLeaf`, `actionHasNoProject`, `actionIsInSingleActionsList` | `true` |
| `actionWithinDuration` | minutes: 5, 15, 30, 60 |
| `actionDateField` + one of `actionDateIsOnDateSpec{dynamic}`, `actionDateIsYesterday`, `actionDateIsToday`, `actionDateIsTomorrow`, `actionDateIsInThePast{relativeBeforeAmount,relativeComponent}`, `actionDateIsInTheNext{relativeAfterAmount,relativeComponent}`, `actionDateIsAfterDateSpec{dynamic}`+`actionDateIsBeforeDateSpec{dynamic}` | field ∈ `due`, `defer`, `completed`, `dropped`, `added`, `changed` (also `planned` in 4.7 **[INFERENCE]**); component ∈ `year`, `month`, `week`, `day`, `hour` |
| `actionHasTagWithStatus` | `remaining`, `onHold`, `dropped`, `active`, `stalled` |
| `actionHasAnyOfTags`, `actionHasAllOfTags` | array of tag ids |
| `actionHasProjectWithStatus` | `active`, `remaining`, `onHold`, `completed`, `dropped`, `stalled`, `pending` |
| `actionWithinFocus` | array of project/folder ids |
| `actionMatchingSearch` | array of phrases |
| `aggregateType` | nested group with its own `any`/`all`/`none` aggregation [S6]; the key holding the nested rule array is not shown in [S6] and absent from the sample (open question) |
| `disabledRule` | wraps a rule that is switched off **[INFERENCE — seen in OF4 UI, not in sample]** |

Unknown rule keys must be preserved verbatim (store the JSON) and flagged in the import log.

### 2.11 Ordering (`rank`)

`rank` is a signed 32-bit integer ordering siblings; ranks are only meaningful within one parent [S1]. Sample: 0 duplicate ranks among siblings across 144 task-parent groups; range −2 147 483 644 … 2 147 483 642. Ordering scopes:
- tasks: by parent task (root-level inbox items and projects each ordered by rank).
- projects and folders inside a folder: both carry `rank`; order them together **[INFERENCE]**.
- tags: by parent tag.
Import as an integer `sort_order` (or convert to a fractional-index string); tie-break by `added`, then `added@order`, then id. `added@order` (small integers on 78 of 2561 tasks) disambiguates objects created at the same instant **[INFERENCE]**.

### 2.12 `alarm`

```xml
<alarm id="aL4rmId0001">
  <added order="1">…Z</added>
  <task idref="aB3dE5fG7hJ"/>
  <kind>due-relative</kind>
  <variant/>
  <fire-date/>
  <fire-offset>-43200</fire-offset>
  <repeat-interval>0</repeat-interval>
</alarm>
```

| Child | Observed (n=110) | Values |
|---|---|---|
| `added` (`@order` on 108) | 110 | UTC |
| `task` | 110 | owning task (ids may be clone ids) |
| `kind` | 110 | `due-relative` 103, `absolute` 7 |
| `variant` | 110 (7 non-empty) | `snoozed` (all 7 absolute alarms) |
| `fire-date` | 110 (7 non-empty) | absolute fire time; floating 5, UTC 2 |
| `fire-offset` | 103 | offset from the task's due (or defer) date, negative = before; `-43200` on all 103. Unit: **seconds** in XML **[INFERENCE]** (⇒ 12 h before; NSTimeInterval convention) — Omni Automation exposes `relativeFireOffset` in *minutes* [S12], under which reading it would be 30 days; confirm against the OF for the Web UI before relying on it |
| `repeat-interval` | 110 | `0` all — seconds between repeated firings; 0 = no repeat [S12] |

1–2 alarms per task (7 tasks have 2). 108 alarms belong to completed tasks (import them anyway; they never fire). OA kinds are Absolute, DueRelative, DeferRelative, Unknown [S12]; expected XML spellings `absolute`, `due-relative`, `defer-relative` (the last unobserved **[INFERENCE]**); store `kind` verbatim. `usesFloatingTimeZone` applies only to absolute alarms [S12], matching the 5 floating `fire-date` values.

### 2.13 `setting`

```xml
<setting id="DueSoonInterval">
  <added>…Z</added><modified>…Z</modified>
  <plist version="1.0"><integer>604800</integer></plist>
</setting>
```

Value = plist root of any type. Observed ids (11): `DueSoonInterval` (integer seconds), `DefaultDueTime` (string `HH:MM:SS`), `OFMRequiredRelationshipToProcessInboxItem` (string, e.g. `project`), `OFMDefaultSingletonProjectPersistentIdentifier` (string project id), `PerspectiveOrder` (array of perspective ids, legacy), `PerspectiveOrder_v3` (array; built-ins use versioned ids `ProcessInbox.v2`, `ProcessProjects.v2`, `ProcessTags.v3`, `ProcessForecast.v2`, `ProcessFlaggedItems.v2`, `ProcessNearby.v4`, `ProcessReview.v2`, `ProcessCompleted`, `ProcessRecentChanges`, then custom ids), `ForecastFlatListCustomOrder` (dict `day-key → [task ids]`; key format `M/D/YY`), `ProcessProjectsv2` (dict, empty), `XMLVersionUpgradeLog` (array of `{client, date, newVersion, oldVersion}`), `OFMRemoteNotificationGroupID` (string), `OFMRemoteNotificationGroupIDLastRegenerationDate` (date).
Note [S3] reads settings from a `<value>` child — wrong for this format; values are under `<plist>`.

Settings worth importing: `DueSoonInterval`, `DefaultDueTime` (and `DefaultStartTime`/`DefaultPlannedTime` if present), `PerspectiveOrder_v3` (sidebar order), `OFMDefaultSingletonProjectPersistentIdentifier`, `OFMRequiredRelationshipToProcessInboxItem`. Store all others raw (JSON) for reference.

---

## 3. Transactions

### 3.1 File naming

Regex: `^(\d{14})=([A-Za-z0-9_-]+(?:\+[A-Za-z0-9_-]+)+)\.zip$` [S1][S2][S3].

- Timestamp `yyyyMMddHHmmss` in GMT; the base uses `00000000000000` [S1].
- Ids part split on `+`: last id = this transaction's id ("tail"/"to id"); preceding ids = parent transaction id(s) ("from ids") [S1][S2][S3].
- Base: `00000000000000=<A>+<B>.zip` — `<A>` is a random/compacted-history id, `<B>` the base's id (sample: one base, two 11-char ids).
- Delta: `<ts>=<B>+<C>.zip` applies on a document whose current id is `<B>` [S2 `can_patch?`].
- Merge: `<ts>=<X>+<Y>+<Z>.zip` joins two branches (parents `X`,`Y`) into `Z`; per [S1] it carries no objects itself, but treat it as a normal transaction (apply its contents if any).
- Compaction: once all clients have synced past a point, OF rewrites the base to include those deltas [S1]. Exported/backed-up packages (like the sample) are typically compacted to the base only.

### 3.2 Application algorithm

1. List transactions; exactly one base (`00000000000000=`) required. Multiple bases ⇒ error.
2. Sort deltas by file name (timestamp then ids), as [S3] does; verify the chain: each delta's parent ids must be the base id or an earlier transaction's id. Log (don't fail) on gaps; [S2] raises on mismatch, which is too strict for exported packages.
3. Unzip `contents.xml`; verify namespace v2; apply each top-level element in document order:

| `op` | Action [S1][S2][S3][S4] |
|---|---|
| (none) | create — insert; if the id already exists, replace it wholesale |
| `update` | merge into the existing object: for each child element present, set that field (empty element ⇒ null); absent children unchanged. Nested containers (`<project>`, `<note>`, `<plist>`, `<location>`) are replaced as a unit. If the object does not exist, create it from the update. (v1 namespace: replace wholesale [S2].) |
| `delete` | remove the object with that id (element body usually empty) |
| `reference` | ignore — a read-only copy of an object referenced by another element in the same transaction [S1]. May be used to resynthesise an object that is missing from the base (log it). |
| other | error |

[S2] applies all updates, then deletes, then creates per file; [S3] applies elements in document order per type. Prefer document order: it is what OF writes and avoids reordering bugs.
4. After all transactions: cascade/clean up — remove `task-to-tag`, `alarm`, `attachment` rows whose task is gone; treat tasks whose parent task no longer exists as orphans (move to inbox and log) — OF's own cascade rule for deleted parents is not documented (open question). Unreferenced `data/` blobs: skip upload.
5. Note: [S3]'s observed delta writer echoes `<added>` in partial updates; OF itself writes full snapshots in `update` elements per the [S1] example. Merge semantics handle both.

---

## 4. Recommended relational mapping (SQLite)

External OF ids are preserved as primary keys (TEXT) so notes, perspective rules and settings that embed ids keep resolving. Import is replace-all in a single SQLite transaction (write to a temp DB then atomic rename, or `BEGIN IMMEDIATE` + delete-all + insert).

### `folders`
| Column | Source | Notes |
|---|---|---|
| `id` TEXT PK | `@id` | |
| `parent_id` TEXT FK folders NULL | `folder/@idref` | |
| `name` TEXT | `name` | |
| `note` TEXT | `note` → Markdown | |
| `sort_order` INTEGER | `rank` | |
| `status` TEXT (`active`/`dropped`) | `hidden` | |
| `dropped_at` TEXT NULL | `hidden` if date | `true` without date ⇒ dropped, `dropped_at` = `modified` (lossy) |
| `created_at`, `modified_at` | `added`, `modified` | |

### `tags`
| Column | Source |
|---|---|
| `id` PK, `parent_id` FK tags, `name`, `note`, `sort_order` (`rank`) | |
| `status` (`active`/`on_hold`/`dropped`) | `hidden`, `prohibits-next-action` |
| `manual_task_order` BOOL | `tasks-user-ordered` |
| `location_json` TEXT NULL | `location` attributes (name, latitude, longitude, radius, notificationFlags) — OF for the Web has no Nearby; keep for fidelity |
| `children_mutually_exclusive` BOOL | 4.7 element (unobserved) |
| `created_at`, `modified_at` | |

### `tasks` (actions, groups and projects in one table — mirrors OF and keeps parent/child ordering uniform)
| Column | Source | Notes |
|---|---|---|
| `id` TEXT PK | `@id` | dotted clone ids kept |
| `parent_id` FK tasks NULL | `task/@idref` | |
| `is_project` BOOL | non-empty `project` | |
| `in_inbox` BOOL | `inbox` | |
| `name`, `note` (Markdown), `note_plain`, `note_source` (raw XML, optional) | | |
| `sort_order` INTEGER | `rank` | |
| `child_order` (`parallel`/`sequential`) | `order` | default sequential |
| `completed_by_children` BOOL | | |
| `flagged` BOOL | | |
| `defer_at` TEXT, `defer_floating` BOOL | `start` | |
| `planned_at`, `planned_floating` | `planned` | |
| `due_at`, `due_floating` | `due` | |
| `completed_at` | `completed` | |
| `dropped_at` | `hidden` | |
| `estimated_minutes` INTEGER | | |
| `repeat_rule` TEXT (RRULE) | `repetition-rule` | |
| `repeat_method` (`fixed`/`due_after_completion`/`defer_after_completion`) | `repetition-method` | |
| `repeat_schedule` (`regularly`/`from_completion`) | `repetition-schedule-type` (normalised §2.6) | |
| `repeat_anchor` (`due`/`defer`/`planned`) | `repetition-anchor-date` (normalised) | |
| `repeat_catch_up` BOOL | `catch-up-automatically` | |
| `repeat_legacy` TEXT | `repeat` | lossless only |
| `repeat_origin_id` TEXT NULL | id prefix | informational |
| `created_at`, `modified_at` | | |

### `projects` (1:1 extension of `tasks` where `is_project`)
| Column | Source |
|---|---|
| `task_id` PK FK tasks | |
| `folder_id` FK folders NULL | `project/folder/@idref` |
| `type` (`parallel`/`sequential`/`single_actions`) | `singleton`, `order` |
| `status` (`active`/`on_hold`/`completed`/`dropped`) | `status` (`inactive`→`on_hold`, `done`→`completed`) |
| `review_interval_steps` INTEGER, `review_interval_unit` (`day`/`week`/`month`/`year`), `review_interval_raw` | `review-interval` |
| `last_reviewed_at` | `last-review` |
| `next_review_at` | `next-review`, else computed last + interval |
| `is_default_inbox_target` BOOL | setting `OFMDefaultSingletonProjectPersistentIdentifier` |

### `task_tags`
`task_id` FK, `tag_id` FK, `rank_in_task` TEXT, `rank_in_tag` TEXT NULL, `created_at`; PK (`task_id`,`tag_id`). Drop the redundant task `<context>` after verifying it is the first link.

### `alarms`
`id` PK, `task_id` FK, `kind` (`due_relative`/`absolute`/… verbatim), `offset_seconds` NULL, `fire_at` NULL + `fire_floating`, `snoozed` BOOL (`variant=snoozed`), `repeat_interval_seconds`, `created_at`.

### `attachments` / `blobs`
- `blobs`: `sha256` PK, `size`, `content_type`, `storage_key`.
- `attachments`: `id` PK, `task_id` FK, `blob_sha256` FK, `name`, `content_type`, `preview_png` BLOB NULL, `created_at`, `note_display_name`/`width`/`height` (from `cell`, optional).

### `perspectives`
`id` PK, `builtin` BOOL, `name`, `icon` (`iconNameInBundle`), `tint_color`, `filter_aggregation`, `filter_rules_json`, `grouping` (`collation`), `sort`, `view_state_json` (raw), `version`, `sort_order` (from `PerspectiveOrder_v3`), `created_at`, `modified_at`. Built-in OF perspectives map to prana-bindu's built-in views; only custom ones need rows.

### `settings`
`key` PK, `value_json`.

### `import_runs`
`id`, `imported_at`, `source`, `app_id`, `app_version`, `base_txn`, `head_txn`, `capabilities_json`, `counts_json`, `warnings_json`.

### Lossy / unsupported items to flag

| Item | Loss |
|---|---|
| Rich-text formatting (fonts, colours, sizes, underline, indents, spacing) | Dropped in Markdown; recoverable only if `note_source` kept |
| Legacy perspective `viewState` (columns, expansion, sidebar selection, window frame) | Stored raw, not interpreted |
| Folder `hidden=true` without a date | No drop date |
| Review interval `@`/`~` prefix | Meaning unknown; raw string kept |
| Alarm policies (`*-alarm-policy`) | Always empty in sample; structure unknown |
| Tag `location` / Nearby | No Nearby in OF for the Web |
| `ForecastFlatListCustomOrder` (manual Forecast order) | Raw only; 3 of 12 ids unresolvable |
| `added@order`, `next-clone-identifier` | Not needed after import |
| Settings without prana-bindu equivalents (`OFMRemoteNotificationGroupID…`, `XMLVersionUpgradeLog`) | Raw only |
| Perspective `icon-attachment` | Empty in sample; image (if any) would need an attachment row |

---

## 5. Sample oddities (counts)

| Observation | Count | Importer handling |
|---|---|---|
| Missing references (task parent, project folder, primary context, task-to-tag task/tag, alarm task, attachment task, tag/folder parent) | 0 | still validate; orphan → log + reattach to root/inbox |
| Tasks with no `<project>`/`<inbox>`/`<note>`/… (legacy 2014–2016 records) | 8 | apply defaults (§2.5) |
| Repeat-clone ids (`id.n…`) | 487 (142 without surviving original) | import as normal tasks |
| Repeating tasks lacking schedule/anchor (pre-4.7) | 108 (+17 lacking catch-up) | normalise (§2.6) |
| Repeat anchor inconsistent with dates set | 9 | keep; anchor falls back to available date |
| Incomplete, undropped tasks under a completed parent | 68 | effective completion via ancestors |
| Dropped task with children | 1 | effective drop via ancestors |
| Projects with empty `next-review` | 43 of 44 | compute |
| Folder `hidden` mixed encodings (date / `true` / `false` / absent) | 1 / 1 / 1 / 1 | §2.3 |
| Explicit empty parent refs (`<context/>` on tags, `<folder/>` on folders) | 2 / 1 | = top level |
| Tags dropped | 8 of 12 | |
| Empty `rank-in-tag` | 19 of 79 | sort after ranked links |
| Attachment `<name>` ≠ blob entry filename | 24 | use `<name>` |
| Note `cell@name` ≠ attachment `<name>` | 32 | use `<name>` |
| Attachments sharing a blob | 219 attachments over 49 blobs | dedupe by sha256 |
| Note `lit` containing `\n` | 12 | preserve |
| Empty `lit` | 2 | skip |
| Task names containing newlines | 4 | keep (UI renders single line) |
| Names that look like ids | 5 tasks, 1 tag | don't regex-detect ids |
| Alarms on completed tasks | 108 of 110 | import, inactive |
| `PerspectiveOrder_v3` built-in ids that don't equal any `perspective` element id (versioned `ProcessInbox.v2`, `ProcessProjects.v2`, `ProcessTags.v3`, `ProcessForecast.v2`, `ProcessFlaggedItems.v2`, `ProcessNearby.v4`, `ProcessReview.v2`; Tags/Forecast/FlaggedItems/Nearby have no element at all) | 7 of 9 built-ins | map by name stem to prana-bindu built-ins |
| `ForecastFlatListCustomOrder` ids not resolving | 3 of 12 | drop |
| Custom perspectives: legacy (no filterRules) vs OF4 (filterRules JSON) | 1 / 2 | legacy: import name + derive rule from viewState enums best-effort, flag |
| `planned` dates set | 0 (element present on 1657) | supported anyway |
| `completed-by-children=true` | 0 | supported anyway |
| `order=sequential` | 0 | supported anyway |
| Non-singleton projects | 0 (all 44 are single-action lists) | supported anyway |
| Unknown elements (vs. this spec) | 0 | log any found |

---

## 6. Importer checklist

1. Accept `.zip` or directory; find package root; reject if `encrypted` present; ignore `__MACOSX`, `._*`, `.client`.
2. Read capabilities; warn on unknown.
3. Apply base + deltas (§3.2) into an in-memory object map keyed by type+id.
4. Validate references; normalise repetition, statuses, dates (floating flag), ranks.
5. Convert notes (Markdown + plain), mapping `<cell>` to attachment ids.
6. Upload distinct blobs (verify SHA-256), create attachment rows.
7. Parse perspective/setting plists; store custom perspectives' `filterRules` JSON and aggregation.
8. Write everything in one atomic replace; record an `import_runs` row with counts and warnings (counts per entity table matching §2 numbers for the sample: 2561 tasks / 44 projects / 4 folders / 12 tags / 79 task-tags / 110 alarms / 500 attachments over 330 blobs / 11 perspectives / 11 settings).

## 7. Open questions

1. Meaning of `@` vs `~` prefixes on `review-interval` (and legacy `repeat`) — no public source; sample `~` only on review intervals.
2. OF's cascade semantics for `op="delete"` on a parent task/folder/tag in deltas — whether children get their own delete elements. Sample has no deltas; needs a captured delta (e.g. from the Omni Sync Server via `OFWebResearch`'s capture or a test account).
3. XML element names for OF 4.7 features not present in the sample: mutually-exclusive tag groups, `datePlanned` anchor value, repeat end conditions (`COUNT`/`UNTIL` in RRULE vs separate elements), non-empty `*-alarm-policy` structure, other alarm `kind` values.
4. Whether folders and projects within one folder share a single rank space (assumed yes).
5. Exact semantics of `tasks-user-ordered` and empty `rank-in-tag`.
6. Whether legacy custom perspectives (viewState-only) should be imported as rule-based perspectives (best-effort translation) or skipped.
7. Unit of alarm `fire-offset` (seconds assumed ⇒ "12 h before due"; Omni Automation reports minutes). Check how OF for the Web displays one of these alarms.
8. Key name for the nested rule array inside an `aggregateType` group and the shape of disabled rules in `filterRules` — need a custom perspective using them (create one in a test account and capture the plist).
