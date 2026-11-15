# prana-bindu — architecture plan

Functional requirements live in `docs/spec.md`. Research evidence lives in `docs/research/`.

## Process model

One Node 22 process (`prana-bindu serve`) serves:

| Path | What |
|---|---|
| `/api/v1/*` | REST JSON API (Hono + `@hono/zod-openapi`), OpenAPI 3.1 at `/api/v1/openapi.json` |
| `/mcp` | MCP streamable HTTP endpoint (`@modelcontextprotocol/sdk`), API token or OAuth access token |
| `/oauth/*`, `/.well-known/oauth-*` | OAuth 2.1 authorization server for MCP clients (hand-rolled on Hono; spec §10.1) |
| `/*` | Built SPA from `dist/web` with history fallback to `index.html` |

`prana-bindu mcp` runs the same MCP tool set over stdio against the local database (no HTTP, no token; local trust).

When `PRANA_MAIL_DROP_*` is configured, `serve` also runs Mail Drop (spec §14) in the same process: a JMAP client that watches one Fastmail mailbox and turns its messages into inbox items.

## Source layout

```
src/
  cli/        commander entry: serve, import, passkey enroll, token create|list|revoke, mcp
  config.ts   env parsing (zod) → typed Config
  db/         drizzle schema, migrations runner, connection factory
  domain/     pure business rules + services (the only layer that touches db tables)
  importer/   .ofocus reader → domain-neutral records → replace-all write
  storage/    BlobStore interface; S3 and filesystem drivers
  server/     Hono app: auth (passkeys, sessions, tokens), oauth (authorization server, consent API), api routes, mcp transport, static
  mcp/        MCP server factory (tools → domain services); used by HTTP and stdio
  maildrop/   Mail Drop: JMAP client, message → item mapping, the watcher run by `serve`; testkit.ts is a fake JMAP server
  shared/     zod schemas + types used by server and web (API contract)
  web/        React SPA (Vite root)
e2e/          Playwright specs
scriptable/   iOS home-screen widget for Scriptable (one self-contained script, spec §13); test/ has a mock
              Scriptable runtime for tests and an HTML renderer for `npm run widget:preview`
ios/          native iOS app, widget, extensions and watch app (spec §16; see "iOS app" below)
```

Dependency direction: `web → shared`; `server, mcp, cli → domain → db, storage`; `cli → maildrop → domain`; `importer → domain/db, storage`. Domain never imports server/mcp/web/maildrop.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `PRANA_DATA_DIR` | `./data` | SQLite file `prana.db` + filesystem blob store (fs driver) |
| `PRANA_PORT` | `3000` | HTTP port |
| `PRANA_ORIGIN` | `http://localhost:3000` | Public origin; WebAuthn RP ID = its hostname; enrollment URLs built from it |
| `PRANA_RP_NAME` | `prana-bindu` | WebAuthn RP name |
| `PRANA_BLOB_DRIVER` | `fs` | `fs` or `s3` |
| `PRANA_S3_ENDPOINT` | — | e.g. `https://s3.example.com` |
| `PRANA_S3_REGION` | — | e.g. `us-east-1` |
| `PRANA_S3_BUCKET` | — | e.g. `prana-attachments` |
| `PRANA_S3_ACCESS_KEY_ID` / `PRANA_S3_SECRET_ACCESS_KEY` | — | credentials |
| `PRANA_S3_FORCE_PATH_STYLE` | `true` | path-style addressing |
| `PRANA_BACKUP_S3_*` (same five as `PRANA_S3_*`, plus `FORCE_PATH_STYLE`) | — | `prana-bindu backup` target; all five required once any is set |
| `PRANA_BACKUP_PREFIX` | `backups/` | backup key prefix |
| `PRANA_BACKUP_RETENTION_DAYS` | `30` | prune older backups after each run; `0` keeps all |
| `PRANA_MAIL_DROP_FASTMAIL_TOKEN` | — | Fastmail API token (Mail scope); enables Mail Drop together with the mailbox |
| `PRANA_MAIL_DROP_MAILBOX` | — | name of the mailbox whose messages become inbox items |
| `PRANA_MAIL_DROP_SESSION_URL` | `https://api.fastmail.com/jmap/session` | JMAP session URL (another JMAP server, or tests) |

## Auth

- Passkeys (`@simplewebauthn/server` / `browser`), single user. Tables: `passkeys`, `enrollment_tokens` (hashed, 15 min expiry, single use), `sessions` (hashed id, HttpOnly Secure SameSite=Lax cookie, 30 day sliding), `api_tokens` (sha256 hash, name, created/last-used, revocable; plaintext shown once, prefix `pb_`).
- OAuth (`src/server/oauth`): `OAuthService` over `oauth_clients`, `oauth_authorization_requests`, `oauth_grants`, `oauth_codes`, `oauth_access_tokens`, `oauth_refresh_tokens` (codes and tokens sha256-hashed; each belongs to a grant and is deleted with it). Public endpoints in `routes.ts`; the consent and Connected apps API (`/api/v1/auth/oauth`) in `consent.ts`; the SPA consent page is `/authorize`. `serve` sweeps expired rows hourly.
- `prana-bindu passkey enroll` → prints `${PRANA_ORIGIN}/enroll#<token>`.
- Web: `/login` (passkey assertion), `/enroll` (registration with token, or from Settings when logged in).
- API: session cookie (SPA, with CSRF protection via required custom header `X-Requested-With: prana-bindu` on unsafe methods) or `Authorization: Bearer pb_...`. `/mcp`: bearer only (`pb_…` or an OAuth access token; OAuth tokens are rejected elsewhere).

## Blob storage

```ts
// src/storage/types.ts
interface BlobStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  /** Presigned GET URL (s3, 5 min, with Content-Disposition) or null when the app must stream bytes itself (fs). */
  downloadUrl(key: string, filename: string, contentType: string): Promise<string | null>;
}
```

Keys: `blobs/<sha256>` (content-addressed; one object per distinct content). `GET /api/v1/attachments/:id/download` redirects (302) to `downloadUrl` when non-null, else streams `get()`.
Blob GC deletes an object only when no `attachments` row **and** no undo-journal row (`change_rows` for table `attachments`) references its sha256, so undoing an attachment delete never points to missing bytes.

## Domain runtime model

- The dataset is small (sample: ~2.5k tasks). `Domain` loads all domain rows into an in-memory **snapshot** (maps + child indexes) and computes derived state (spec §1.3) for a given `now` and settings. The snapshot is cached and invalidated after every domain mutation and on `domain.invalidate()` (called after import).
- All writes go through domain services inside one SQLite transaction per operation (`mutate(label, fn)`), which also opens a journal group. The exception is Mail Drop's `createMailDropItem`, which uses the same transaction plumbing (`transact`) without a journal group, so arriving mail never becomes the user's Undo; the item and its `mail_drop_messages` row commit together.

## Undo journal

- `createDomain` installs (idempotently, `CREATE TRIGGER IF NOT EXISTS`) AFTER INSERT/UPDATE/DELETE triggers on every table in `DOMAIN_TABLES` except `blobs`. They are generated from the drizzle table definitions and insert `json_object(...)` of OLD/NEW into `change_rows`, selecting `group_id` from `journal_state`. When `journal_state` is empty (importer, migrations) nothing is recorded.
- `mutate(label, fn)`: BEGIN → insert into `change_groups` (state `applied`) → put its id in `journal_state` → delete all `undone` groups (clears redo) → fn → clear `journal_state` → COMMIT. Groups with no rows are deleted. Prune to the newest 200 groups.
- `undo()`: take the newest `applied` group and apply its rows in reverse (insert `before` / delete / restore `before`) with `journal_state` empty, then mark it `undone`. `redo()`: take the oldest `undone` group above the newest applied, apply its rows forward, and mark it `applied`.
- The importer deletes all journal rows inside its replace-all transaction.

## Composition seams (exact exports)

| Module | Export | Owner |
|---|---|---|
| `src/config.ts` | `loadConfig(env = process.env): Config` | Platform |
| `src/db/connection.ts` | `openDatabase(file: string \| ":memory:"): { sqlite: Database.Database; db: AppDb }` — WAL, foreign_keys off, runs `drizzle/` migrations; `type AppDb = BetterSQLite3Database<typeof schema>` | Platform |
| `src/storage/index.ts` | `createBlobStore(config): BlobStore`; `FsBlobStore`, `S3BlobStore` | Platform |
| `src/domain/index.ts` | `createDomain({ db, sqlite, blobStore, now?: () => Date, defaultTimeZone?: string }): Domain` (class with service methods; throws `DomainError(code, message, details?)` with `.status`); `Domain#invalidate()`. The snapshot also reloads when `PRAGMA data_version` shows another connection committed. | Core |
| `src/domain/builtins.ts` | `builtinPerspectiveRows(nowIso): perspectives rows` — default built-in perspective rows (seeded on first use; used by the importer) | Core |
| `src/shared/nlparse.ts` | `parseDate(text, {field, now, timeZone, defaults, dateFormat}): string \| null` (floating), `parseDuration(text): number \| null`, `formatDuration(min)` — pure, used by server and web | Core |
| `src/shared/datetime.ts` | Pure time-zone helpers for fixed/floating dates (`dateValueToInstant`, `naiveToInstant`, `localDayKey`, `normaliseIsoDate`, …) | Core |
| `src/server/api/routes.ts` | `createApiRoutes({ domain, blobStore, runImport }): OpenAPIHono` (all `/api/v1` resources except auth; paths relative to `/api/v1`) | Core |
| `src/mcp/server.ts` | `createMcpServer({ domain, blobStore }): McpServer` | Core |
| `src/mcp/http.ts` | `handleMcpRequest(c: Context, deps): Promise<Response>` (stateless streamable HTTP) | Core |
| `src/mcp/stdio.ts` | `runMcpStdio(deps): Promise<void>` | Core |
| `src/maildrop/index.ts` | `new MailDrop({ domain, config: MailDropConfig, fetch?, log?, pollIntervalMs?, reconnectDelayMs?, pushSilenceTimeoutMs? })` with `start()`, `stop()`, `check()` | Mail Drop |
| `src/domain/index.ts` | `Domain#createMailDropItem({ source: {accountId, emailId}, name, note, attachments }): Promise<Task \| null>` (null when that message was processed before; no undo group), `Domain#isMailDropProcessed(source)` | Core |
| `src/importer/index.ts` | `importOfocus(source: { path: string } \| { url: string } \| { zip: Uint8Array; name: string }, deps: { db, sqlite, blobStore }): Promise<ImportRun>` | Importer |
| `src/server/auth/*` | `createAuthRoutes(deps): OpenAPIHono` (mounted at `/api/v1/auth`), `requireAuth` middleware (session or bearer; sets `c.var.auth = {kind: 'session'\|'token'}`), `requireBearer` | Platform |
| `src/server/app.ts` | `createApp(deps): Hono` — mounts auth + api routes under one `OpenAPIHono` at `/api/v1`, `openapi.json` (doc31), `/mcp` behind `requireBearer`, SPA static + history fallback | Platform |
| `src/server/idempotency.ts` | `Idempotency-Key` middleware on `/api/v1` (after auth, skips `/auth/*`): replays the first answer (< 500) for the same method + path + key for 10 minutes, at most 1000 kept | Platform |
| `src/cli/main.ts` | commander: `serve`, `import <src>`, `passkey enroll`, `token create <name>` / `list` / `revoke <id>`, `mcp` | Platform |
| `src/web/**`, `e2e/**`, `playwright.config.ts` | SPA and e2e | Web |
| `src/web/lib/writes.ts` | `write(spec)`: the web client's serial write queue (spec §2 "Instant writes") — previews, retries, rollback of later writes, undo snapshots, upload lane; `configureWrites` wires it to the query cache in `src/web/api/queries.ts` | Web |
| `src/web/lib/optimistic.ts` | `Change` (pending task field, outline row, list item, settings and attachment changes), the preview functions that lay them over server data, and `invertChanges` (undo snapshots) | Web |
| `src/web/lib/outlineOps.ts` | Row-change previews of outline operations and moves, mirroring the server's rules | Web |

`runImport` passed to `createApiRoutes` = `(source) => importOfocus(source, deps).then(run => (domain.invalidate(), run))`.

## REST conventions

- Lists are `{items: [...]}` in display order (folders and tags in tree order; nest by `parentId`). `GET /tasks` returns `{items, nextCursor}` (default `limit` 500, `availability` default `remaining`).
- Creates return `201` with the entity; deletes return `204`; complete/drop/move/outline/batch/cleanup return `{changed: Task[]}`; undo/redo return `History` (`409` when there is nothing to undo/redo).
- Error codes: `validation_error` 400, `not_found` 404, `conflict` 409, `payload_too_large` 413, `parse_error` / `invalid_operation` 422.
- Extra endpoints beyond §9: `GET /folders/:id`, `GET /tags/:id`, `POST /settings/reset` (Restore Defaults), `GET /import/last` → `{run: ImportRun | null}`.
- Multi-selection (each call is one undo group, all-or-nothing): `POST /tasks/complete {ids, completed}`, `POST /tasks/drop {ids, dropped, scope?}`, `POST /tasks/batch {ids, patch}`, `POST /tasks/move {ids, parentId?|projectId?|inbox?, position}` (outline order kept; position applies to the first), `POST /tasks/tags {ids, add?, remove?}` → `{changed}`; `POST /projects/batch {ids, patch: ProjectPatch}` → `{items: Project[]}`.
- `POST /tasks/:id/discard` → 204: if the newest change group is exactly this task's creation it is reverted and erased (no undo/redo trace); otherwise a normal journaled delete.
- Creates take an optional client `id` and `POST /tasks/outline` (`group`) an optional `groupId`; a used id → 409 `conflict`. Unsafe requests may send `Idempotency-Key` and get `X-Undo-Steps`, `X-Undo-Step` and `X-Undo-Previous` back; `History` carries `undoId`/`redoId` (spec §9; `Domain#countUndoSteps` counts the journal groups a request kept, via `AsyncLocalStorage`).
- `POST /tasks/status {ids, status: active|completed|dropped, scope?}` → `{changed}` sets each item to that state in one group (active clears both timestamps; completed/dropped are mutually exclusive). `POST /tasks/complete {completed:false}` also clears a drop.
- `POST /delete {taskIds?, projectIds?, folderIds?, tagIds?}` → 204, one group; unknown ids → 404 before any change; items inside selected containers are skipped. Duplicate ids are ignored by every multi-item endpoint.
- Perspective contents accept `project`, `folder`, `tag` (`untagged`), `day` and `q` query parameters. Per-perspective view options are not journaled (UI state); every other mutation is one undo group.

## Testing

- Vitest for unit/integration tests (`*.test.ts` next to the code). API tests use `app.request()` against `openDatabase(":memory:")` and an in-memory/temp-dir `FsBlobStore`.
- Playwright e2e (`e2e/`) starts the built server on a temp data dir with `PRANA_ORIGIN=http://localhost:<port>`, enrolls a passkey through a CDP WebAuthn virtual authenticator using the CLI enrollment link, and drives the major flows at mobile (390×844) and desktop viewports.
- The importer has a committed synthetic fixture under `test/fixtures/` (no personal data). The real sample backup (`/tmp/pb-import/OmniFocus.zip`) is used only in a local, opt-in test (`PRANA_SAMPLE_OFOCUS=/path`).

## iOS app

The native client (spec §16) lives in `ios/`. It is a REST client of `/api/v1` with a bearer token and shares no code with the TypeScript tree; the web app's pure logic is ported to Swift, with its test vectors, so that both clients behave the same. Swift 6 language mode with complete strict concurrency; iOS and watchOS 26 minimum.

```
ios/
  Prana.xcodeproj  Xcode project with folder-synchronised groups (PBXFileSystemSynchronizedRootGroup): a file added to
                   a target's folder is built without editing project.pbxproj. Shared schemes Prana and PranaWatch
  Config/          Base.xcconfig (shared build settings, PRANA_BUNDLE_ID, PRANA_APP_GROUP; ends with
                   `#include? "Local.xcconfig"`, the gitignored per-developer DEVELOPMENT_TEAM), and every target's
                   Info.plist and entitlements
  SharedResources/ asset catalogue with the app icon
  PranaKit/        local Swift package (iOS, macOS and watchOS 26) with everything that isn't a view; `swift test`
                   runs on macOS
  Prana/           the iOS app (SwiftUI): App (entry, sign-in, keyboard commands), Shell, Outline, Inspector,
                   Perspectives (pages, sidebars, view options), Editor (perspective editor), Settings, QuickEntry,
                   Intents (Add to Inbox App Intent, watch and widget sync)
  PranaWidget/     WidgetKit Forecast widget
  PranaShare/      share extension
  PranaWatch/      watchOS app and its Add to Inbox intent
  PranaUITests/    XCUITests against a real server
```

Targets: `Prana` (iOS app; embeds `PranaWidget` and `PranaShare` as app extensions and `PranaWatch` as its watch app), `PranaWidget`, `PranaShare`, `PranaWatch` and `PranaUITests`. All of them link `PranaKit`. The `Prana` scheme builds the app with its extensions and watch app and tests `PranaUITests`; the `PranaWatch` scheme builds the watch app alone.

Signing: simulator builds need no team (`CODE_SIGN_IDENTITY` is `-`). The app, widget and share extension share the App Group `$(PRANA_APP_GROUP)` (widget cache) and the Keychain access group `$(AppIdentifierPrefix)$(PRANA_BUNDLE_ID)` (credentials); the watch app has its own Keychain group. The groups reach the code through the Info.plist keys `AppGroupIdentifier` and `KeychainAccessGroup`. When the build has no usable group (unsigned builds, tests), `KeychainCredentialStore` uses the default group and the widget cache falls back to the caches directory.

### PranaKit

| Folder | Contents |
|---|---|
| `Models/` | `Codable` mirrors of `src/shared/schemas.ts` with the same JSON field names (the task type is `TaskItem`, as Swift has `Task`). Date values stay the strings the server sends, fixed or floating. Server enums are `OpenEnum` structs and open JSON (perspective rules) is `JSONValue`, so unknown values decode and round-trip. `Route` and `DeepLink` (`prana://` links, mirroring the web routes). |
| `API/` | `APIClient` (origin + token; `send` returns the decoded value and `UndoHeaders` from `X-Undo-Steps`, `X-Undo-Step`, `X-Undo-Previous`; throws `APIError`: `server`, `unauthorized`, `transport`, `decoding`) and `Endpoints`, one constructor per REST operation the app uses, including multipart uploads. |
| `Credentials/` | `Credentials` (origin, token), the `CredentialStore` protocol, `KeychainCredentialStore` (one generic-password item in the shared access group) and `InMemoryCredentialStore` for tests. |
| `Store/` | `AppStore` (`@MainActor @Observable`): `base` (last server data, a `CacheState`), the `WriteQueue`, and `state` = `base` with every pending write's `[Change]` laid over it (port of `src/web/lib/optimistic.ts`); views read `state` only. `WriteQueue` ports `src/web/lib/writes.ts`: a serial main lane in gesture order and an upload lane, an `Idempotency-Key` per write, retries of transport errors and 5xx after 0.5, 1.5 and 3 s, "Saving…" after 2 s, rollback of a failed write and every later one with one toast, and a refresh after the queue drains that releases the previews of landed writes. Undo reconciliation: each journaled write records an `UndoStep` (snapshots of the state before and after); undo and redo apply this device's step at once while no step made elsewhere lies between it and the server's newest step (`undoId`, followed back through each own step's `X-Undo-Previous`); otherwise the device forgets its own steps and calls the server's undo or redo. A 401 deletes the credentials and signs out. Typed mutation methods (`AppStore+Mutations`, `+Outline`, `+Inspector`), `OutlineRows`, `Drafts` (client ids) and `AccountSettings` (passkeys and tokens, which wait for the server). |
| `Dates/` | `DateTime` (port of `src/shared/datetime.ts`: fixed and floating values, IANA zones) and `DateDisplay` (the web app's date and chip formatting). |
| `NL/` | `NaturalLanguage`, the port of `src/shared/nlparse.ts` and `src/web/lib/nl.ts` (spec §7). |
| `Logic/` | Pure ports of the web app's logic: outline operations, display and key mapping (`OutlineOps*`), repeat editing and summaries, perspective rules and the editor draft, fuzzy matching and smart match, the review model, sidebar trees and moves, the Forecast page, view options, the inspector model, Quick Entry, settings options, shell navigation and the keyboard shortcut table. |
| `Forecast/` | The widget's model (strip, rows, chips) and loader with its per-origin cache (port of `scriptable/prana-bindu-forecast.js`). |
| `Capture/` | `InboxCapture` and `CaptureDraft` (Add to Inbox for Siri, the share extension and the watch), `ItemProviderFile` (files from drag and drop and the share sheet), `CredentialSync` (the WatchConnectivity context that carries the credentials to the watch) and `AppGroup`. |

### Testing

- PranaKit: Swift Testing (`import Testing`) in `ios/PranaKit/Tests/PranaKitTests`, run with `swift test` on macOS. Ports of the TypeScript test vectors (`nlparse.test.ts` including its date-time block, `outlineOps`, `outlineModel`, `reviewModel`, the Scriptable widget's) keep the two clients in step; JSON fixtures recorded from a real server are in `Fixtures/`. The API client and the store are tested through a stub `URLProtocol`, with no network.
- `PranaUITests`: a few XCUITest flows per area (shell, outline, Quick Entry, review, settings, extensions) against a real server. The test runner reads `PRANA_UITEST_ORIGIN` and `PRANA_UITEST_TOKEN` (passed to `xcodebuild` as `TEST_RUNNER_PRANA_UITEST_ORIGIN` and `TEST_RUNNER_PRANA_UITEST_TOKEN`) and gives them to the app as launch environment, so each run starts signed in; without them the tests are skipped. Debug builds have launch hooks for what a simulator test can't drive: `PRANA_UITEST_ADD_TO_INBOX` runs the App Intent's body (an unsigned build can't run App Shortcuts), `PRANA_UITEST_TEXT`/`PRANA_UITEST_SUBMIT` fill in and submit the watch app's field, and `PRANA_UITEST_DRAG_FILE` shows a chip that drags that file as Files does (a test can't put Files beside the app).
- CI: the `ios` job in `.github/workflows/ci.yml` runs on `macos-26` with Xcode 26. It builds the server, runs `swift test`, starts the built server on a temporary data directory with `test/fixtures/synthetic-ofocus.zip` imported and a token from `token create`, runs `xcodebuild test` on the `Prana` scheme in an iPhone simulator, then the iPad-only UI tests (`KeyboardUITests`, `SidebarDropUITests`, `PadShellUITests`, `AttachmentDropUITests`: hardware keyboard, sidebar drops, the portrait split view, a file dropped on the inspector's attachments) in an iPad Pro 11-inch simulator, and builds the `PranaWatch` scheme for the watchOS simulator. On failure it uploads both result bundles and the server log.
