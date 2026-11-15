# prana-bindu

A single-user, mobile-first task manager with projects, tags, perspectives, Forecast, Review, a custom perspective editor, repeating items and search. It also has:

- a JSON **REST API** with an OpenAPI 3.1 description,
- an **MCP server** (streamable HTTP and stdio) so AI assistants can read and manage your tasks,
- a one-way **importer** for OmniFocus `.ofocus` backups,
- a native **iOS app** for iPhone and iPad, with a Forecast widget, an Add to Inbox action for Siri, a share extension and an Apple Watch app,
- a **Scriptable widget** for the iOS home screen, for people who don't install the app,
- **Mail Drop**: email a secret address to add an inbox item (needs a Fastmail account),
- **Siri capture** without the app: say "Hey Siri, add to inbox" on your iPhone or Apple Watch, through a Shortcut you build from the steps below.

One Node process serves the web app, the API (`/api/v1`), MCP (`/mcp`) and the OAuth endpoints MCP clients sign in with (`/oauth`, `/.well-known`). Data lives in SQLite; attachments go to the local filesystem or to any S3-compatible object store. Sign-in uses passkeys only.

Specification: [`docs/spec.md`](docs/spec.md). Architecture: [`docs/plan.md`](docs/plan.md).

## Quick start

Requires Node.js 22.12 or later.

```sh
npm install
npm run dev                         # API on :3000 (tsx watch) + Vite on :5173 (proxies /api, /mcp and OAuth)
npm run cli -- passkey enroll       # prints http://localhost:3000/enroll#<token>
```

In development, open the enrollment link on the Vite port instead (`http://localhost:5173/enroll#<token>`), or set `PRANA_ORIGIN=http://localhost:5173` for the API process so that passkeys are bound to the origin you browse.

### Production build

```sh
npm run build                       # dist/web (SPA) + dist/server (server + CLI)
npm start                           # = node dist/server/cli/main.js serve
```

`npm link` (or a global install) puts the `prana-bindu` command on your `PATH`.

### Docker

```sh
docker build -t prana-bindu .
docker run -d --name prana-bindu -p 3000:3000 -v prana-data:/data \
  -e PRANA_ORIGIN=https://tasks.example.com prana-bindu
docker exec prana-bindu prana-bindu passkey enroll
```

The image runs `prana-bindu serve` as a non-root user. The database (and fs-driver attachments) live in the `/data` volume. Run it behind a TLS-terminating reverse proxy: browsers only allow passkeys on `https://` origins or `http://localhost`.

### Kubernetes

A Helm chart is in [`helm/prana-bindu`](helm/prana-bindu/README.md).

## Configuration

Everything is configured with environment variables (see [`.env.example`](.env.example)). Invalid values stop the process with a list of the problems.

| Variable | Default | Meaning |
|---|---|---|
| `PRANA_DATA_DIR` | `./data` | SQLite database `prana.db`, plus `blobs/` for the fs driver |
| `PRANA_PORT` | `3000` | HTTP port |
| `PRANA_ORIGIN` | `http://localhost:<port>` | Public origin. The WebAuthn RP ID is its hostname, and enrollment links are built from it. The session cookie is `Secure` when the origin is `https` |
| `PRANA_RP_NAME` | `prana-bindu` | WebAuthn relying-party name shown by authenticators |
| `PRANA_TIMEZONE` | server's zone | Default for the `timeZone` setting (IANA name, e.g. `Europe/London`) |
| `PRANA_BLOB_DRIVER` | `fs` | Attachment storage: `fs` or `s3` |
| `PRANA_S3_ENDPOINT` | — | S3 endpoint URL (required for `s3`) |
| `PRANA_S3_REGION` | — | Region (required for `s3`) |
| `PRANA_S3_BUCKET` | — | Bucket (required for `s3`) |
| `PRANA_S3_ACCESS_KEY_ID` / `PRANA_S3_SECRET_ACCESS_KEY` | — | Credentials (required for `s3`) |
| `PRANA_S3_FORCE_PATH_STYLE` | `true` | Path-style bucket addressing |
| `PRANA_BACKUP_S3_ENDPOINT` | — | S3 endpoint URL for `prana-bindu backup` |
| `PRANA_BACKUP_S3_REGION` | — | Backup bucket region |
| `PRANA_BACKUP_S3_BUCKET` | — | Backup bucket |
| `PRANA_BACKUP_S3_ACCESS_KEY_ID` / `PRANA_BACKUP_S3_SECRET_ACCESS_KEY` | — | Backup credentials. Once any `PRANA_BACKUP_S3_*` variable is set, all five are required |
| `PRANA_BACKUP_S3_FORCE_PATH_STYLE` | `true` | Path-style bucket addressing for backups |
| `PRANA_BACKUP_PREFIX` | `backups/` | Key prefix for backup objects |
| `PRANA_BACKUP_RETENTION_DAYS` | `30` | Delete backups older than this many days after each backup; `0` keeps all |
| `PRANA_MAIL_DROP_FASTMAIL_TOKEN` | — | Fastmail API token for [Mail Drop](#mail-drop). Mail Drop is off unless this and `PRANA_MAIL_DROP_MAILBOX` are set |
| `PRANA_MAIL_DROP_MAILBOX` | — | Name of the Fastmail mailbox whose messages become inbox items |
| `PRANA_MAIL_DROP_SESSION_URL` | `https://api.fastmail.com/jmap/session` | JMAP session URL. Change it only for another JMAP server |

## First sign-in: enrolling a passkey

There are no passwords. To register the first passkey, run this on the server:

```sh
prana-bindu passkey enroll
# https://tasks.example.com/enroll#3q2X…
```

Open the link within 15 minutes; it works once. Name the passkey and confirm it with your device. You are signed in afterwards. Add more passkeys (for example, one per device) under **Settings → Passkeys** while signed in. If you delete every passkey, run `passkey enroll` again.

Sessions last 30 days and are extended while you use the app.

## REST API

- Base URL: `<origin>/api/v1`
- OpenAPI 3.1 document: `<origin>/api/v1/openapi.json` (public)
- Errors: `{"error": {"code": "...", "message": "...", "details": ...}}`

Authenticate with an API token. Create one in **Settings → API tokens** or on the server, where the plaintext is shown only once:

```sh
prana-bindu token create "My script"    # prints pb_…
prana-bindu token list
prana-bindu token revoke <id>
```

```sh
curl -H "Authorization: Bearer pb_…" https://tasks.example.com/api/v1/tasks?inbox=true
```

Only SHA-256 hashes of tokens are stored. Browser (cookie) sessions must also send `X-Requested-With: prana-bindu` on unsafe methods (CSRF protection). Bearer requests do not need it.

## MCP server

The tools mirror the REST API: tasks, projects, folders, tags, perspectives, forecast, review, search, attachments, undo/redo and date parsing. See `docs/spec.md` §10.

**Streamable HTTP** at `<origin>/mcp`. Clients sign in with OAuth or send an API token.

**OAuth** (Claude on claude.ai, Desktop and mobile; any MCP client that supports the MCP authorization spec): add `https://tasks.example.com/mcp` as a custom connector. The client registers itself, opens prana-bindu in the browser, and you sign in with your passkey and allow it. Access tokens last an hour and are refreshed automatically; Settings → Connected apps lists the apps you allowed and disconnects them. OAuth tokens work only on `/mcp`, not on the REST API. There is nothing to configure: the issuer is `PRANA_ORIGIN`. See `docs/spec.md` §10.1.

```sh
claude mcp add --transport http prana-bindu https://tasks.example.com/mcp   # then /mcp → Authenticate
```

**API token**, for clients without OAuth support:

```sh
claude mcp add --transport http prana-bindu https://tasks.example.com/mcp \
  --header "Authorization: Bearer pb_…"
```

**stdio** runs against the local database with no token (local trust):

```sh
claude mcp add prana-bindu --env PRANA_DATA_DIR=/path/to/data -- prana-bindu mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "prana-bindu": {
      "command": "node",
      "args": ["/path/to/prana-bindu/dist/server/cli/main.js", "mcp"],
      "env": { "PRANA_DATA_DIR": "/path/to/data" }
    }
  }
}
```

With the `s3` blob driver, give the stdio server the same `PRANA_BLOB_DRIVER` and `PRANA_S3_*` variables so that it can read attachment content.

## iOS app

Prana (in [`ios/`](ios)) is a native SwiftUI app for iPhone and iPad with the same features as the web app: every perspective, the outline and inspector, Review, the perspective editor, Quick Entry and Settings. It uses iOS controls and gestures (swipe a row to complete, flag or delete it, long-press for its menu), and an iPad with a hardware keyboard has the web app's keyboard shortcuts. It also includes:

- a **Forecast widget** (medium and large) that works like the [Scriptable widget](#scriptable-widget),
- an **Add to Inbox** action for Siri and the Shortcuts app ("Add to Prana inbox"), which adds what you say, word for word, as an inbox item,
- a **share extension**: share text, a web page, photos or files to Prana to make an inbox item, with the files as attachments,
- an **Apple Watch app**: one screen to dictate or scribble an inbox item, and the same Add to Inbox action.

`prana://` links open the app at the same places as the web app's paths, for example `prana://forecast?day=TODAY` or `prana://inbox?quickEntry=1`. Details: `docs/spec.md` §16.

To sign in, create an API token in **Settings → API tokens** in the web app, then enter your server's address and the token in the app. The app checks them with the server and stores them in the iOS Keychain, where the widget, the share extension and Siri also read them. The app sends them to the Watch app when you sign in or out. If the server rejects the token, the app returns to the sign-in screen with "Token rejected". The app's Settings lists, renames and deletes passkeys, but **Add a passkey** opens the server's Settings page in Safari, because registering a passkey needs a browser session.

The app only works while it can reach the server, and keeps its data in memory. As in the web app, changes show at once and are sent in the background. A change the server rejects, or that can't be sent within about 5 seconds, is undone with a message (`docs/spec.md` §2).

To build and run it, you need Xcode 26 or later (the app needs iOS 26 and watchOS 26):

1. Open `ios/Prana.xcodeproj`, choose the **Prana** scheme and an iPhone or iPad simulator, and run. Simulator builds need no signing team. The **PranaWatch** scheme runs the Watch app in a watchOS simulator.
2. To run on a device, create `ios/Config/Local.xcconfig` (it is gitignored, and `ios/Config/Base.xcconfig` includes it) with your team:

   ```
   DEVELOPMENT_TEAM = ABCDE12345
   ```

   On a device, the App Group and the shared Keychain group, through which the widget, the share extension and Siri use the app's sign-in, need a signing team. Siri and the Shortcuts app also run the Add to Inbox action only in a signed build. If the bundle identifiers (`au.id.grimes.prana-bindu` and its `.widget`, `.share` and `.watchkitapp` extensions) belong to another team, also set `PRANA_BUNDLE_ID` and `PRANA_APP_GROUP` in that file.

The Watch app is embedded in the iPhone app and installs with it. The [Scriptable widget](#scriptable-widget) and the [Siri Shortcut](#siri-and-apple-watch) below remain available for people who don't install the app.

## Scriptable widget

[`scriptable/prana-bindu-forecast.js`](scriptable/prana-bindu-forecast.js) is an iOS home-screen widget for [Scriptable](https://scriptable.app). It shows a strip of Past, Today, the next four days and Future, with item counts and one dot per due item (red overdue, yellow due soon, grey otherwise), followed by Today's items: 2 in the medium size, 8 in large. Tapping a column opens that day in Forecast, tapping an item opens Today, and the "+" button opens Quick Entry (`/forecast?quickEntry=1`). Details: `docs/spec.md` §13.

The [iOS app](#ios-app) has its own Forecast widget, which needs no Scriptable.

To install the Scriptable widget:

1. Create an API token in **Settings → API tokens**.
2. Install Scriptable. Copy the script into Scriptable's iCloud Drive folder (`iCloud Drive/Scriptable/`), or create a new script named `prana-bindu-forecast` in the app and paste the file's contents into it.
3. Run the script in Scriptable. Enter your server's address (for example `https://tasks.example.com`) and the token. The script checks them and stores them in the iOS Keychain, not in the script file. Then choose **Preview medium** to see the widget.
4. On the home screen, add a medium or large Scriptable widget, long-press it, choose **Edit Widget**, and set **Script** to `prana-bindu-forecast`.

Run the script in Scriptable again to preview, change the server or token, or remove the settings. The widget refreshes about every 15 minutes (iOS decides when exactly). When the server can't be reached, it shows the last forecast it fetched, with the time it was updated.

## Mail Drop

Anything sent to a secret email address becomes an inbox item. prana-bindu watches one mailbox of a Fastmail account through Fastmail's JMAP API, so the address is a Fastmail alias whose mail a rule files into that mailbox. Details: `docs/spec.md` §14.

Each message becomes one item at the end of the inbox:

- **Name**: the subject, without `Re:`/`Fw:`/`Fwd:` prefixes and security labels such as `[SEC=OFFICIAL]`. Without a subject, the first line of the body.
- **Note**: the text body. HTML-only mail is converted to text.
- **Attachments**: the message's attachments and inline photos, but not images embedded in the HTML such as signature logos.

The message then moves to Fastmail's Trash, marked read. Items from Mail Drop don't take the place of your last change in Undo.

To set it up in Fastmail:

1. Create a folder for Mail Drop, for example `Mail Drop`. Choose a folder of its own: every message in it becomes an item. prana-bindu refuses Inbox, Archive, Trash and the other special folders.
2. Under **Settings → Aliases**, add an alias that is hard to guess, for example `tasks-7fk2q9@yourdomain`. Anyone who knows it can add items to your inbox.
3. Under **Settings → Filters & Rules**, add a rule for mail sent to that alias that moves it to the Mail Drop folder.
4. Under **Settings → Privacy & Security → Manage API tokens**, create a token with **Email** access. Leave **read-only** unticked, because Mail Drop moves processed messages to Trash.
5. Set `PRANA_MAIL_DROP_FASTMAIL_TOKEN` to the token and `PRANA_MAIL_DROP_MAILBOX` to the folder's name, then restart `prana-bindu serve`. The log shows `Mail Drop: watching mailbox "Mail Drop"`.

New mail arrives within seconds through JMAP push; a full check also runs at startup and every 5 minutes. Problems (a rejected token, a missing folder, a failed download) are logged as `Mail Drop: …` lines, and the server keeps running. A message that fails stays in the folder and is retried. If the alias leaks, replace it in Fastmail; prana-bindu needs no change.

## Siri and Apple Watch

An Apple Shortcut named **Add to inbox** adds inbox items by voice on iPhone and Apple Watch. It needs no server configuration. Siri asks what to add, and the Shortcut sends your answer, word for word, as a new inbox item (`POST /api/v1/tasks`). Details: `docs/spec.md` §15. The [iOS app](#ios-app) has the same action built in, so you only need this Shortcut without the app.

> **You:** Hey Siri, add to inbox\
> **Siri:** What do you want to add?\
> **You:** Call the plumber about the leak\
> **Siri:** Added "Call the plumber about the leak" to your inbox.

The item is named exactly what you said: dates and tags in it aren't interpreted. Process it later, as you would any inbox item. Siri can't take the item in the same sentence ("add X to inbox"), because custom Shortcuts don't take spoken parameters. If the server rejects the request, Siri reads out its reason, for example `Couldn't add "Buy milk": The bearer token is invalid or revoked`. If the server can't be reached, Shortcuts shows its own connection error. Nothing is saved for later, so say it again when you're back online.

The Shortcut has to be built by hand. iOS only imports Shortcut files that a Mac has signed.

1. In prana-bindu, create an API token named `Siri` in **Settings → API tokens** and copy it (it's only shown once).
2. In the Shortcuts app on your iPhone, tap **+** to make a new shortcut and name it `Add to inbox`. Then add these actions in order. Text in `[brackets]` is a variable: tap the field, then choose the variable from the bar above the keyboard.
   1. **Ask for Input**: type *Text*, prompt `What do you want to add?`.
   2. **If**: `[Provided Input]` *does not have any value*. Before **Otherwise**, add **Stop This Shortcut**. Leave **Otherwise** empty.
   3. **Get Contents of URL**: URL `https://tasks.example.com/api/v1/tasks` (your server's address). Tap the arrow to show more options and set:
      - **Method**: `POST`.
      - **Headers**: add `Authorization` with the value `Bearer pb_…` (the word `Bearer`, a space, then the token).
      - **Request Body**: *JSON*. Add a *Text* field with key `name` and value `[Provided Input]`.
   4. **Get Dictionary Value**: get *Value* for key `id` in `[Contents of URL]`.
   5. **If**: `[Dictionary Value]` *has any value*.
      - Before **Otherwise**, **Show Result**: `Added "[Provided Input]" to your inbox.`
      - Under **Otherwise**: **Get Dictionary Value**, *Value* for key `error.message` in `[Contents of URL]`, then **Show Result**: `Couldn't add "[Provided Input]": [Dictionary Value]` (the second Dictionary Value, the error message).
3. Run the shortcut once from the Shortcuts app and add a test item. When iOS asks whether the shortcut may connect to your server, choose **Always Allow**, so that Siri doesn't stop to ask.
4. For Apple Watch: in the shortcut's editor, open **Details** (the **ⓘ** button) and turn on **Show on Apple Watch**.

Then say "Hey Siri, add to inbox" on either device. On the Watch you can also run it from the Shortcuts app or a complication, and answer by dictation or Scribble. The Watch sends the request itself, over the iPhone, Wi-Fi or mobile data.

If Siri adds the item to an Apple Reminders list called Inbox instead, rename the Shortcut to something Reminders doesn't answer, such as `Add to Prana`, and say that. The token is stored in the Shortcut and syncs through iCloud with your other Shortcuts. If a device is lost, revoke the `Siri` token in **Settings → API tokens**, create a new one and paste it into the Shortcut's header.

## Importing from OmniFocus

```sh
prana-bindu import ~/Backups/OmniFocus.zip          # zip containing a .ofocus package
prana-bindu import ~/Backups/OmniFocus.ofocus       # unzipped package directory
prana-bindu import https://example.com/OmniFocus.zip
```

The import **replaces all task data** (tasks, projects, folders, tags, perspectives, settings, attachments and undo history) in one transaction. Passkeys, sessions and API tokens are kept. It prints entity counts and any warnings. Encrypted packages are rejected. The same import is available as `POST /api/v1/import` (multipart `file`, or JSON `{"url": "..."}`).

## Attachment storage

By default, attachments are stored under `PRANA_DATA_DIR/blobs/` and streamed by the server. To use S3-compatible object storage instead:

```sh
PRANA_BLOB_DRIVER=s3
PRANA_S3_ENDPOINT=https://s3.example.com
PRANA_S3_REGION=us-east-1
PRANA_S3_BUCKET=prana-attachments
PRANA_S3_ACCESS_KEY_ID=…
PRANA_S3_SECRET_ACCESS_KEY=…
```

Downloads redirect to presigned URLs that are valid for 5 minutes. Objects are content-addressed (`blobs/<sha256>`), so identical files are stored once. The bucket can stay private.

## Backups

`prana-bindu backup` uploads a gzipped, consistent snapshot of the database (taken with SQLite's `VACUUM INTO` over a read-only connection, so the server can keep running) to `<PRANA_BACKUP_PREFIX>prana-<UTC timestamp>.db.gz` in an S3-compatible bucket. It then deletes backups under the prefix that are older than `PRANA_BACKUP_RETENTION_DAYS`. It never runs migrations or writes to the database. Attachments are not included.

```sh
PRANA_BACKUP_S3_ENDPOINT=https://s3.example.com
PRANA_BACKUP_S3_REGION=us-east-1
PRANA_BACKUP_S3_BUCKET=prana-backups
PRANA_BACKUP_S3_ACCESS_KEY_ID=…
PRANA_BACKUP_S3_SECRET_ACCESS_KEY=…
prana-bindu backup
# Backed up /data/prana.db (3358720 bytes) to s3://prana-backups/backups/prana-20261031T075711Z.db.gz (986524 bytes gzipped)
```

To restore, stop the server, decompress a backup over `prana.db` and delete `prana.db-wal` and `prana.db-shm`. The Helm chart can run the backup on a schedule; see its [README](helm/prana-bindu/README.md#daily-database-backups).

## Development

```sh
npm run lint
npm run typecheck
npm test                  # Vitest unit + API integration tests (in-memory SQLite)
npm run build && npm run test:e2e    # Playwright (WebAuthn virtual authenticator)
npm run widget:preview    # renders the Scriptable widget to test-results/widget/*.png
```

Optional live tests:

- **S3 driver**: set `PRANA_S3_ENDPOINT`, `PRANA_S3_REGION`, `PRANA_S3_BUCKET`, `PRANA_S3_ACCESS_KEY_ID` and `PRANA_S3_SECRET_ACCESS_KEY`, then run `npx vitest run src/storage/s3.test.ts`. The test puts, fetches (including through a presigned URL) and deletes a temporary object.
- **Real backup import**: `PRANA_SAMPLE_OFOCUS=/path/to/OmniFocus.zip npm test`.
- **Database backup**: set `PRANA_BACKUP_S3_ENDPOINT`, `PRANA_BACKUP_S3_REGION`, `PRANA_BACKUP_S3_BUCKET`, `PRANA_BACKUP_S3_ACCESS_KEY_ID` and `PRANA_BACKUP_S3_SECRET_ACCESS_KEY`, then run `npx vitest run src/backup`. The test backs up a temporary database under a random `test/` prefix, checks the upload restores and that only expired backups are pruned, then deletes the prefix.

The schema lives in `src/db/schema.ts`. After changing it, run `npm run db:generate` to generate migrations in `drizzle/`. Migrations are applied when the server starts.

The Scriptable widget's tests (`scriptable/prana-bindu-forecast.test.ts`) run the script against a mock of the Scriptable API (`scriptable/test/scriptable.ts`) whose requests go to an in-memory server. `npm run widget:preview` renders the same widget tree as HTML and takes screenshots (medium and large, light and dark), using sample data or, with `-- --origin https://tasks.example.com --token pb_…`, your server. The HTML only approximates WidgetKit's layout, so check changes on a device as well.

The iOS home-screen icon `src/web/public/apple-touch-icon.png` (180×180, opaque) is rendered from `src/web/icons/apple-touch-icon.svg`. After changing the SVG, regenerate it with:

```sh
npx playwright screenshot --viewport-size=180,180 "file://$PWD/src/web/icons/apple-touch-icon.svg" src/web/public/apple-touch-icon.png
```

The iOS app's logic lives in the PranaKit Swift package (`ios/PranaKit`), whose tests (Swift Testing) run on macOS:

```sh
cd ios/PranaKit && swift test
```

The UI tests (`ios/PranaUITests`) drive the app in the iOS simulator against a real server. Build the server, start it with the synthetic fixture and a token (as the `ios` CI job does), then pass both to the test runner. Without them, the UI tests are skipped.

```sh
npm run build
export PRANA_DATA_DIR=/tmp/pb-ui PRANA_PORT=3999
node dist/server/cli/main.js import test/fixtures/synthetic-ofocus.zip
node dist/server/cli/main.js token create ui-tests    # prints pb_…
node dist/server/cli/main.js serve &
TEST_RUNNER_PRANA_UITEST_ORIGIN=http://localhost:3999 TEST_RUNNER_PRANA_UITEST_TOKEN=pb_… \
  xcodebuild test -project ios/Prana.xcodeproj -scheme Prana -destination 'platform=iOS Simulator,name=iPhone 17'
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, build, e2e, and a Docker build that starts the image and probes it. Its `ios` job, on macOS, runs the PranaKit tests, builds the app and runs the UI tests against a server started from the build, and builds the Watch app.

On every push to `main`, the `docker` job pushes the image to `ghcr.io/johngrimes/prana-bindu:sha-<commit>`. Once the tests pass, the `chart` job pushes the Helm chart with that image as its default to `oci://ghcr.io/johngrimes/charts/prana-bindu`, versioned `<Chart.yaml version>-main.<run number>`, so a GitOps tool can follow the newest version.

## License

Copyright 2026 John Grimes. Licensed under the [Apache License, Version 2.0](LICENSE); see also [`NOTICE`](NOTICE).

OmniFocus is a trademark of The Omni Group. prana-bindu is an independent project and is not affiliated with, endorsed by or sponsored by The Omni Group.
