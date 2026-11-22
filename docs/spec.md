# prana-bindu — functional specification

prana-bindu is a single-user, mobile-first web task manager with projects, tags, perspectives, Forecast, Review, a perspective editor, repeat editing and task search. It also provides a REST API, an MCP server, a one-way importer for OmniFocus `.ofocus` backups, and a native iOS app (§16).

Sources: `docs/research/ofocus-format.md` (cited as **F§n**). Architecture, contracts and env config: `docs/plan.md`.

Out of scope: sync between servers, location/Nearby, notification delivery, and UI languages other than English.

---

## 1. Domain model

All ids are strings. New ids are 11 random characters from `[A-Za-z0-9_-]`. Imported ids are preserved, including dotted repeat-clone ids such as `abc.12`.

### 1.1 Dates

User-facing dates (defer, planned, due, next review, absolute alarm) are strings in one of two forms (F§2.2):
- **Fixed**: ISO-8601 UTC instant with `Z`, e.g. `2026-11-02T23:00:00.000Z`.
- **Floating**: local wall-clock time without an offset, e.g. `2026-11-03T09:00:00.000`. It is interpreted in the user's time zone (setting `timeZone`, an IANA name).

New dates entered through the web UI are floating. The API and MCP accept either form; an input with an explicit offset (e.g. `+10:00`) is normalised to fixed UTC. Bookkeeping timestamps (`added`, `modified`, `completed`, `dropped`, `lastReview`) are always fixed UTC. Floating dates are never converted using the server's time zone.

### 1.2 Entities

**Task** (also used for an action group or a project's root task, F§2.5):
`id, name, note (markdown text), parentId (task id | null), projectId (derived: owning project id | null), inInbox (bool), rank (int), flagged, deferDate, plannedDate, dueDate, estimatedMinutes (int|null), completed (ts|null), dropped (ts|null), added, modified, sequential (bool, for children ordering), completedByChildren (bool), repeat (RepeatRule|null), assignedProjectId (inbox item's chosen project before Clean Up | null), tagIds (ordered), attachmentIds, alarmIds`.

**Project** = a Task with a project record (F§2.5.1):
`folderId | null, type: parallel | sequential | singleActions, status: active | onHold | completed | dropped, reviewInterval {steps:int≥1, unit: day|week|month|year}, lastReview (ts), nextReview (date|null)`. The project's `completed`/`dropped` timestamps live on its task. Status `completed` ⇔ `completed` is set; `dropped` ⇔ `dropped` is set.

**Folder**: `id, name, note, parentId (folder|null), rank, status: active | dropped, added, modified`. Folders nest arbitrarily. Folders and projects inside one folder share a single rank ordering (F§2.11).

**Tag**: `id, name, note, parentId (tag|null), rank, status: active | onHold | dropped, childrenMutuallyExclusive (bool), added, modified`. A task's tags are ordered. Untagged tasks form the synthetic "Untagged" group.

**RepeatRule** (F§2.6): `rule` (an RFC 5545 RRULE body without the `RRULE:` prefix: FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYSETPOS, WKST, COUNT, UNTIL), `scheduleType: regularly | fromCompletion`, `anchorDate: due | defer | planned`, `catchUpAutomatically: bool`. The legacy OmniFocus `method` maps as follows: fixed → regularly; due-after-completion → fromCompletion + due; start-after-completion → fromCompletion + defer.

**Alarm** (F§2.12): `id, taskId, kind: absolute | dueRelative | deferRelative | plannedRelative, fireDate (for absolute), offsetSeconds (relative; negative = before)`. Alarms are imported and shown read-only. There is no delivery.

**Attachment**: `id, taskId, name, size, contentType, sha256, added`. Bytes are kept in the blob store.

**Perspective**: built-in perspectives are Inbox, Projects, Tags, Forecast, Flagged, Review, Completed, Changed, and Search (prana-bindu). Custom: `id, name, icon (from a fixed set), color (#rrggbb), favorite, rank, rules (§4.1), aggregation: all|any|none, grouping, sorting, layout: projects|flat, sidebar: projects|tags|none`. Built-ins also have a `favorite` flag and a rank in the perspectives bar.

**Settings**: `timeZone, dateFormat (MM/dd/yyyy | dd/MM/yyyy | yyyy/MM/dd | yyyy-MM-dd), firstWeekday (1=Sun..7=Sat), use24HourTime, defaultDeferTime, defaultDueTime, defaultPlannedTime ("HH:MM"), dueSoonSeconds (86400 | 172800 | … | 604800; there is also a 'today' option = 0 meaning due by end of today), theme (system|light|dark), forecastTagId (tag|null)`, plus per-perspective view options (§4). Defaults: defer 00:00, due 17:00, planned 09:00, due soon 2 days, week starts on Sunday, `MM/dd/yyyy`, 12-hour time. The importer overrides the defaults with the backup's settings where they exist (`DefaultDueTime`, `DueSoonInterval`, …).

### 1.3 Derived state (F§2.5)

All values are computed at query time from raw fields and `now` in the user's time zone:

- **effectiveFlagged** = own flag OR any ancestor (task or project) flagged.
- **effectiveDeferDate / effectivePlannedDate / effectiveDueDate**: the latest defer date and the earliest due date along the ancestor chain, including self. Planned is inherited from the nearest ancestor that has one.
- **effectiveCompleted / effectiveDropped**: self or any ancestor completed/dropped. An incomplete task under a completed parent is effectively completed (F§5).
- **Project effective status**: dropped if the project is dropped or any ancestor folder is dropped. Otherwise it is the project's own status.
- **Tag effective status**: dropped if it or any ancestor is dropped; otherwise onHold if it or any ancestor is on hold; otherwise active.
- **remaining** = not effectively completed and not effectively dropped.
- **deferred** = effectiveDeferDate > now.
- **blocked** = remaining AND any of:
  - it has remaining children (it is an action group or a project root);
  - deferred;
  - its project is on hold (or dropped);
  - any of its tags is effectively onHold or dropped;
  - it sits inside a sequential parent and is not the first remaining child of that parent;
  - its parent is blocked for any reason other than "has children".
  - Single-action-list children are never sequential-blocked.
- **available** = remaining and not blocked.
- **firstAvailable (`next`)**: the first available action in each project / action-group traversal order. In a single-actions list every available action counts as first available. Inbox items are never `next`.
- **overdue** = remaining and effectiveDueDate < now.
- **dueSoon** = remaining, not overdue, and effectiveDueDate ≤ now + dueSoonSeconds. When the setting is "today", the threshold is the end of today.
- **status** (one value, priority order): `completed`, `dropped`, `overdue`, `dueSoon`, `blocked`, `next`, `available`.
- **Project stalled**: active, with no available actions but with remaining actions. **Project pending**: active and deferred.

### 1.4 Behaviour rules

- **Complete**: sets `completed = now`. Completing a parent completes nothing else, but its children become effectively completed. If `completedByChildren` is true on the parent and the last remaining child is completed, the parent is completed with the same timestamp, recursively. Un-completing clears `completed`.
- **Drop / undrop** works the same way with `dropped`. A project's status changes keep `completed`/`dropped` consistent.
- **Delete** removes the item and all descendants, plus their tag links, alarms and attachments (blobs are deleted when no attachment still references them).
- **Repeat on completion** (F§2.6): completing a repeating task:
  1. Creates a completed clone of the task and its subtree, with ids `<id>.<n>` where `n` comes from the original's clone counter, and dates as they were. Clones keep tags and notes.
  2. Advances the original. The anchor date moves to the next occurrence:
     - `regularly`: the next RRULE occurrence strictly after the current anchor date. If `catchUpAutomatically` is set, it is the first occurrence after now.
     - `fromCompletion`: the next occurrence computed from the completion time, keeping the anchor's time of day.
     - The other dates (defer, due, planned) keep their offsets from the anchor.
  3. Uncompletes the subtree of the original.
  4. If the rule's COUNT is exhausted or UNTIL has passed, there is no next occurrence: the task simply completes.
  5. Dropping a repeating task offers two choices, "Skip this occurrence" (the clone is dropped and the original advances) and "Drop completely" (no repeat).
- **Inbox**: a new item with no project is an inbox item. Setting the Project field on an inbox item sets `assignedProjectId`. **Clean Up** moves inbox items that have an assigned project or at least one tag out of the inbox; an item with an assigned project goes to the end of that project. Clean Up also removes completed or dropped and no-longer-matching rows from the current view (client).
- **Mutually exclusive tags**: adding a tag whose parent has `childrenMutuallyExclusive` removes the task's other tags under that parent.
- **Review**: lists projects with remaining status (active or on hold) whose `nextReview` ≤ end of today, grouped by next-review date. **Mark Reviewed** sets `lastReview = now` and `nextReview = today + interval` (a date only, as floating start of day). Changing the interval recomputes `nextReview` from `lastReview`. New projects get `lastReview = now`, an interval of 1 week, and `nextReview = today + 1 week`.
- **Undo/redo**: every mutating operation (from the web, API or MCP) is journaled as one change group. Undo restores the before-image of the last group, and redo re-applies it. The redo stack is cleared by any new mutation, and the journal keeps the last 200 groups. Importing clears the journal.
- **Ordering**: rank is a signed int32. Sibling order is ascending. Inserts take the midpoint between neighbours, and siblings are renumbered when there is no gap left.

---

## 2. Web app — shell (mobile-first)

Layout breakpoints:
- **< 768 px** (primary): a single column. A bottom tab bar shows favourite perspectives plus "More" (all perspectives, settings). The content outline is full width. The inspector is a full-screen sheet. The sidebar (folders/projects, tags, forecast calendar) is a slide-over drawer opened from the header. The header shows Clean Up, Search, View options and a "More" menu (New item, Undo, Redo, Reorder, app menu). Quick Entry is a floating "+" button that opens a sheet. Swipe right on a row completes it; swipe left reveals Flag / Delete.
- **≥ 768 px**: a perspectives rail, sidebar, outline and inspector side by side (inspector toggleable).
- Light and dark themes follow the `theme` setting. The app uses its own icons and visual design.
- Header actions: Perspectives menu, Toggle sidebar, View options, Clean Up, Quick Entry, New item, Undo, Redo, Search, Inspector toggle, and an app menu (Reorder, Settings, Help = keyboard shortcuts sheet, Sign out). Reorder appears on pages with an outline.
- Routes: `/login`, `/enroll`, `/inbox`, `/projects` (`?project=`, `?folder=`), `/tags` (`?tag=`), `/forecast` (`?day=YYYY-MM-DD|PAST|TODAY|FUTURE`), `/flagged`, `/review` (`?project=`), `/completed`, `/changed`, `/search?q=`, `/perspectives/:id`, `/perspectives/:id/edit`, `/settings`. `/` redirects to the first favourite perspective (default Inbox). `?quickEntry=1` on any route opens Quick Entry and is then removed from the URL (other parameters are kept), so a reload does not reopen it.
- Keyboard shortcuts are inactive while focus is in an input, textarea or contenteditable. Shift-? shows the shortcut sheet.

  | Key | Action |
  |---|---|
  | S | refresh |
  | Shift-S | toggle sidebar |
  | V | view options |
  | P | perspectives menu |
  | O | Quick Open |
  | C | Quick Entry |
  | N | new item in current location |
  | K | Clean Up |
  | Z / Cmd(Ctrl)-Z | undo |
  | Shift-Z / Cmd-Shift-Z | redo |
  | Shift-I | toggle inspector |
  | ↑ / ↓ | move selection |
  | ← / → | collapse / expand |
  | Enter | new item after selection |
  | Shift-Enter | new item above (outline); commit edit (in a text field) |
  | Cmd-Enter, E, Tab | edit title |
  | ' | edit note; Alt-' toggles note visibility |
  | ] / [ | indent / outdent |
  | } / { | add child / add outdented |
  | G / U | group / ungroup |
  | Shift-↑↓←→ | move up / down / out / in |
  | Backspace / Delete | delete selected item |

- Empty states: "No items", "No projects", "No remaining projects", "No available projects".
- Errors from the API appear as non-blocking toasts. A 401 redirects to `/login`.
- **Instant writes.** Every change made in the web app shows at once, and the write is sent in the background, so the UI never waits for the server. This covers tasks, projects, folders, tags, perspectives, settings, view options, Mark Reviewed, Clean Up, undo/redo and attachments. Sign-in, passkeys, API tokens and sign out still wait for the server.
  - New items get their id in the browser (§9), so a new row, sidebar entry or perspective can be edited, selected or opened straight away.
  - Writes are sent one at a time, in the order they were made. A network error or 5xx is retried for about 5 s (each write carries an `Idempotency-Key`, so a retry applies once). After a 2 s retry, the header shows "Saving…".
  - A rejected write (4xx), or one whose retries run out, is undone together with every write queued after it, and one toast says so ("Couldn't save: … 2 later changes were undone.").
  - The change itself shows at once; knock-on effects (counts, a sibling becoming available, items entering or leaving other perspectives, view-option filtering) arrive with the refresh that follows.
  - Undo and redo show at once for changes made in this tab, from a snapshot of what was on screen. Undoing a change made elsewhere (MCP, another device, before a reload) shows when the server answers.
  - An upload shows in the inspector at once, marked "Uploading…". Uploads run beside other writes, so they never hold those up.
  - Leaving or reloading the page with unsent writes asks first.

## 3. Outline & inspector

**Row**: status circle (states: available, blocked, next, overdue red, dueSoon orange, flagged, repeating, completed check, dropped), title, project column (outside Projects), tag pills (removable), due chip (red if overdue, orange if due soon), defer chip when deferred, note indicator, attachment indicator, flag toggle, and a "•••" menu (New action, Delete; project and tag rows have Delete Project / Delete Tag).
- Clicking the circle toggles completion. Completed rows stay struck through until Clean Up or navigation.
- Rows that Clean Up will remove from the view are greyed out (still editable): kept rows the view no longer matches (completed, dropped or edited away) and, in the inbox, items with a project or a tag (with their subtrees).
- Action groups and projects have a disclosure triangle. The disclosure column is only reserved when some row in the outline has children.
- Inherited flags and dates render as "implied" (outline flag icon, italic dates).

**Editing**: inline title editing; Enter adds a sibling below; Shift-Enter adds one above; `}` adds a child; `{` adds an outdented item; `]`/`[` indent/outdent; G groups (wraps the selection in a new group); U ungroups. Reorganising: Shift+←/→ outdent/indent and Alt+Shift+↑/↓ move up/down (Shift+↑/↓ is taken by selection). Backspace/Delete deletes the selection with an undoable toast. A new row left with an empty title on Escape or blur is discarded. Multi-select works with Shift-click / Cmd-click and Shift+↑/↓. Drag and drop works within the outline (reorder, re-parent) and onto sidebar projects and tags (move, or add the tag). With a mouse, any part of a row drags it.

**Reorder mode**: rows show no drag grips by default. Reorder (in the phone "More" menu and the desktop app menu) shows a grip at the trailing edge of every action row; on touch, a drag from the grip starts at once, and a tap on it does nothing. While reordering, the header shows Done (on phones in place of Clean Up, Search and View options) and the menu item reads Done Reordering. Done, Escape (when nothing is selected) or navigating to another view ends reorder mode.

**Inspector**, for a task, action group or inbox item:
- Title.
- Status (Active / Completed / Dropped).
- Flag.
- Type (Parallel / Sequential) for groups.
- Complete with last action.
- Project field (smart match with "Create …").
- Tags (pills + smart-match add with "Create …").
- Dates: Duration, Defer, Planned and Due, each with natural-language input (§7), a calendar picker and +1 day / +1 week / +1 month buttons. On an empty field these start from today at the default time. On phones and touch devices the calendar button is the native date-time picker (date only for Next review), committed when the picker closes.
- Read-only Completed, Dropped, Added and Changed.
- Repeat editor: none / every N units with FREQ-specific options (weekdays for weekly; day-of-month or nth weekday for monthly; months for yearly), schedule type, anchor date, catch-up, and end (never / after N / on date). A human-readable summary is shown.
- Notifications (read-only list).
- Note (multiline markdown text, plain rendering).
- Attachments (list with name and size, download, delete, upload via picker or drag-drop; images show a thumbnail).
- Edits show in the inspector and the outline at once, before the server confirms them; a failed edit reverts with an error toast.

For a **project**, the inspector adds:
- Status buttons Active / On Hold / Completed / Dropped.
- Type Parallel / Sequential / Single Actions.
- Folder.
- Review: interval (steps + unit), last reviewed, next review (editable), Mark Reviewed.

The **folder** inspector has Title, Status (Active/Dropped), Note, Added, Changed. The **tag** inspector has Title, Status (Active/On Hold/Dropped), Mutually Exclusive children toggle, Note, Added, Changed.

The inspector edits several selected items at once: changing a field applies it to all of them, and mixed values show as "Multiple values".

## 4. Perspectives

The **view options** popover (V) is saved per perspective on the server:
- **Filter**: First Available / Available / Remaining / Everything. Inbox omits First Available, and Inbox's Available means "not blocked or deferred".
- Inbox: default Remaining, flat.
- **Projects**: sidebar folder tree (type icons; on-hold dimmed with a badge; dropped hidden unless the filter is Everything; selecting a folder or project filters the content). Content has one section per project titled "Folder : Project". Options: Show Inbox, Show folders in outline. The "+" menu offers New Parallel Project, New Sequential Project, New Single Action List, New Folder. Folders and projects can be renamed and dragged to re-order or re-parent in the sidebar.
- **Tags**: sidebar tag tree + "Untagged". Content is grouped by tag (empty tags omitted); a task with several tags appears under each. Option "Sort by due date and flagged". The "+" menu offers New Tag. Tags can be dragged to re-order or nest.
- **Forecast**:
  - Sidebar calendar: Past (overdue count), 5 weeks from the start of the current week (honours `firstWeekday`) with per-day counts, and Future.
  - Header strip: Past, Today, the next 6 days, Future.
  - Sections: Past, Today, then each day, then Future. `?day=` selects one section.
  - Options: include planned (default on), defer, notification-date and on-hold items. Today includes flagged items and items tagged with `forecastTagId`. Structure is Flexible or Organized, with Preserve hierarchy and Keep Sorted.
  - Badge counts show due items only.
  - Items appear on the day of their (effective) due date, plus planned, defer and notification dates when those options are enabled. Today repeats Past items.
- **Flagged**: effective-flagged items; default filter Available. Group by Ungrouped, Tag, Tags (Combined), Project, Due, Planned, Defer, Completed, Dropped, Added or Changed date.
- **Review** (§1.4): the sidebar lists the projects due for review, flat, oldest next review first. The outline shows one project at a time (`/review?project=`), editable exactly as in Projects (Remaining filter). There are no view options.
  - On opening, the first unreviewed project is shown. Clicking a sidebar entry opens that project.
  - Review bar above the project: projects left to review ("3 of 7 left"), last reviewed date, a "Review every …" button whose popover edits the interval and next review date, and Previous / Next / Mark Reviewed. On phones, Previous / Next / Mark Reviewed are pinned to the bottom of the screen, and the list is in the sidebar drawer.
  - **Mark Reviewed** (bar, inspector, ⌘⇧R) opens the next unreviewed project below, wrapping round to skipped ones. When every listed project is reviewed, the outline shows "All projects reviewed"; with none due at all it shows "No projects to review". ⌘[ / ⌘] go to the previous / next project.
  - The list is frozen while you stay in Review: reviewed projects stay listed with a check, and projects that stop being due for any other reason (completed, dropped, on hold, next review moved out) stay too. Projects that become due are appended. Clean Up, or leaving Review, rebuilds the list from the projects now due. A project counts as reviewed when its `lastReview` has changed since it joined the list, so undoing Mark Reviewed un-checks it.
- **Completed** and **Changed**: completed (or modified) items in date buckets — Today, Yesterday, within the last week, month, 3 months, 6 months, year, more than a year ago. Empty buckets are omitted.
- **Search**: the header search field (and `/` key) does a case-insensitive search over task names and notes, plus project, folder and tag names. Results are grouped by kind, respect a filter option (default Remaining), and highlight matches.
- **Quick Open (O)**: fuzzy subsequence match over perspectives, folders, projects and tags, ranked by prefix match first.
- **Quick Entry (C)**: Title, Project (smart match / create), Tags, Due (natural language, parsed in the browser before save, so a fast save cannot lose the due date and an unparseable date keeps the sheet open), Note, Flag; Save / Cancel. Save closes the sheet at once. The item goes to the Inbox unless a project is chosen, in which case it goes to the start of that project.
- **Custom perspectives** (F§2.10): the editor has a name, icon, colour and favourite. Rules form a tree:
  - top-level aggregation all/any/none;
  - nested groups;
  - each rule can be enabled or disabled.
  The rule types are listed in §4.1. Further editor options:
  - layout: Projects hierarchy or Flat (Individual Actions);
  - grouping (none, Tag, Tags combined, Project, Folder, Due/Defer/Planned/Completed/Dropped/Added/Changed date, Flagged);
  - sorting (manual, Due, Defer, Planned, Completed, Added, Changed, Flagged, Duration, Name);
  - sidebar (Projects / Tags / none).
  Perspectives can be duplicated, deleted and reordered, and the favourite star toggles them in the perspectives bar.

### 4.1 Rule grammar

Rules are stored as JSON with the same keys OmniFocus uses, so imported rules round-trip:
- `actionAvailability`: firstAvailable | available | remaining | completed | dropped
- `actionStatus`: due | flagged
- `actionHasDueDate`, `actionHasDeferDate`, `actionHasPlannedDate`, `actionHasDuration`
- `actionWithinDuration` (minutes)
- `actionIsProject`, `actionIsGroup`, `actionIsProjectOrGroup`, `actionRepeats`, `actionIsLeaf`, `actionIsUntagged`, `actionHasNoProject`, `actionIsInSingleActionsList`
- `actionDateField` (due | defer | planned | completed | dropped | added | changed) combined with one of:
  - `actionDateIsToday` / `actionDateIsYesterday` / `actionDateIsTomorrow`;
  - `actionDateIsInThePast` or `actionDateIsInTheNext`, each with `{amount, component: hour|day|week|month|year}`;
  - `actionDateIsOnDateSpec`;
  - a between range.
- `actionHasTagWithStatus`: remaining | onHold | dropped | active | stalled
- `actionHasAnyOfTags`, `actionHasAllOfTags`
- `actionHasProjectWithStatus`: active | remaining | onHold | completed | dropped | stalled | pending
- `actionWithinFocus`: project/folder ids
- `actionMatchingSearch`: terms, all of which must match name or note
- Nested groups: `{aggregateType, aggregateRules: [...]}`
- Disabled rules: `{disabledRule: {...}}`

Imported rules with unknown keys are preserved, shown as "Unsupported rule (kept)", and evaluate as true. When the perspective has no rules at all, it matches all remaining actions.

## 6. Settings page

- Settings from §1.2, plus Restore Defaults.
- **Passkeys**: list (name, created, last used), add a passkey (WebAuthn registration while logged in), rename, delete. The last passkey can be deleted only with confirmation, and a warning says that a new enrollment link will then be needed from the CLI.
- **API tokens**: list (name, prefix, created, last used), create (the plaintext is shown once with a copy button), revoke.
- **Connected apps**: the MCP clients approved through OAuth (§10.1), newest first, each with its self-declared name, when it was connected and when it last used the MCP server, and Disconnect, which revokes its access at once. Without any: a hint to add `<origin>/mcp` as a connector.
- **Import**: a read-only panel showing the last import run (time, source, counts, warnings). Running an import is CLI/API only.

## 7. Natural-language parsing

Dates are parsed relative to now in the user's time zone. When no time is given, the field's default time applies.

Accepted forms:
- `today`/`tod`, `tomorrow`/`tom`, `yesterday`, `now`
- `+1d`, `1d`, `-1d`, `2w`, `3m`, `1y`, `3 days`, `1w 2d`
- weekday names and abbreviations (`fri`, `next fri` → the next such day after today)
- `mon 9am`, `5pm`, `noon`, `midnight`, `today 3pm`
- `next week` (+7 days), `next month` (+1 month)
- `dec 25`, `25 dec 2026 14:30`, `12/25` (order per `dateFormat`), `2026-12-25`
- `in 3 days`, `this weekend` (Saturday)

Anything else is an error ("Unable to parse date").

Durations: `30`, `30m`, `1h`, `1h30m`, `1.5h`, `90 min`, `2d` (= 2880 minutes), `1w`. They are stored as minutes and displayed as `1h 30m`. The parser is shared by the server (API/MCP accept natural-language strings via `POST /api/v1/parse`) and the web client.

## 8. Auth

As `docs/plan.md` §Auth. Every page except `/login` and `/enroll` requires a session. The enrollment link is valid for 15 minutes, works once, and registers a passkey named by the user. Login uses a discoverable credential (usernameless). Sessions last 30 days, sliding. Sign out destroys the session.

## 9. REST API (`/api/v1`)

All bodies are JSON, validated with zod, and documented in OpenAPI 3.1 at `/api/v1/openapi.json` (public). Errors are `{error: {code, message, details?}}` with status codes 400/401/403/404/409/413/422. Responses embed derived state (§1.3). Mutations return the updated entity, or `{changed: [...]}` for multi-entity operations.

- **Client ids.** `POST /tasks`, `/projects`, `/folders`, `/tags` and `/perspectives` accept an optional `id` (`[A-Za-z0-9_-]`, 8–64 characters); without one the server picks it. `POST /tasks/outline` with `op: group` accepts `groupId` for the new group. An id already in use is a 409 `conflict`. (A project's id is its root task's id, so it must not be any task's id.)
- **Idempotency.** An unsafe request may carry an `Idempotency-Key` header (1–200 characters). A repeat of the same method, path and key within 10 minutes gets the first answer replayed without running again; one that arrives while the first is still running waits for it. Answers of 500 or above are not kept.
- **Undo steps.** Every unsafe answer outside `/auth` carries `X-Undo-Steps`: how many undo steps the request added. It is 1 for a change, 0 when nothing changed (e.g. a Clean Up with nothing to file away), and -1 when a discard erased the creation step. When it recorded a step, `X-Undo-Step` gives that step's id and `X-Undo-Previous` the step Undo reaches after it (0 for none); `GET /history` (and the answers of undo and redo) report `undoId` and `redoId`, the steps Undo and Redo would act on. The web app uses these to keep its own undo history in line with the server's, and to tell when a change made elsewhere comes between its own (§2).

| Resource | Endpoints |
|---|---|
| Tasks | `GET /tasks` (filters: `perspective`, `inbox`, `projectId`, `tagId`, `folderId`, `flagged`, `status`, `availability=next\|available\|remaining\|all`, `q`, `dueBefore`, `dueAfter`, `limit`, `cursor`), `GET /tasks/:id` (with `children`), `POST /tasks` (`{name, note?, parentId?, projectId?, inbox?, position?: {before\|after: id} \| "start" \| "end", flagged?, deferDate?, plannedDate?, dueDate?, estimatedMinutes?, tagIds?, repeat?, sequential?, completedByChildren?}`), `PATCH /tasks/:id`, `DELETE /tasks/:id`, `POST /tasks/:id/complete` (`{completed: bool}`), `POST /tasks/:id/drop` (`{dropped: bool, scope?: occurrence\|series}`), `POST /tasks/:id/move` (`{parentId?\|projectId?\|inbox?, position}`), `POST /tasks/:id/tags` (`{tagId}`), `DELETE /tasks/:id/tags/:tagId`, `POST /tasks/outline` (`{op: indent\|outdent\|group\|ungroup\|moveUp\|moveDown, ids}`), `POST /tasks/batch` (`{ids, patch}`) |
| Projects | `GET /projects` (`status`, `folderId`), `GET /projects/:id`, `POST /projects` (`{name, type, folderId?, position?, ...task fields}`), `PATCH /projects/:id` (incl. `status`, `type`, `folderId`, `reviewInterval`, `nextReview`), `DELETE /projects/:id`, `POST /projects/:id/review` (mark reviewed) |
| Folders | `GET /folders` (tree), `POST /folders`, `PATCH /folders/:id`, `DELETE /folders/:id` (deletes contained projects), `POST /folders/:id/move` |
| Tags | `GET /tags` (tree with counts), `POST /tags`, `PATCH /tags/:id`, `DELETE /tags/:id`, `POST /tags/:id/move` |
| Perspectives | `GET /perspectives`, `GET /perspectives/:id`, `POST /perspectives`, `PATCH /perspectives/:id`, `DELETE /perspectives/:id`, `GET /perspectives/:id/contents` (evaluated outline: groups → rows, honours view options; for `review`, `?project=` returns that project's outline instead of the due list), `PUT /perspectives/:id/view-options` |
| Forecast | `GET /forecast?from=&days=` (day buckets with counts + items), `GET /review` |
| Search | `GET /search?q=&availability=`, `GET /quick-open?q=` |
| Attachments | `GET /tasks/:id/attachments`, `POST /tasks/:id/attachments` (multipart, ≤ 100 MB), `GET /attachments/:id` (metadata), `GET /attachments/:id/download` (302 to a presigned URL, or streamed for the fs driver), `DELETE /attachments/:id` |
| Undo | `POST /undo`, `POST /redo`, `GET /history` (`{canUndo, canRedo, undoLabel, redoLabel}`) |
| Cleanup | `POST /cleanup` |
| Settings | `GET /settings`, `PATCH /settings` |
| Parse | `POST /parse` (`{kind: date\|duration, field?: defer\|due\|planned, text}` → `{value}` or 422) |
| Import | `POST /import` (multipart `file` = `.zip` of a `.ofocus` package, or JSON `{url}`) → import run summary; replaces all data |
| Auth | `GET /auth/session`, `POST /auth/login/options`, `POST /auth/login/verify`, `POST /auth/logout`, `POST /auth/enroll/options` (`{token}` or session), `POST /auth/enroll/verify`, `GET/PATCH/DELETE /auth/passkeys[/:id]`, `GET/POST/DELETE /auth/tokens[/:id]`, `GET /auth/oauth/requests/:id`, `POST /auth/oauth/requests/:id/approve\|deny` (session only, → `{redirectTo}`), `GET /auth/oauth/grants`, `DELETE /auth/oauth/grants/:id` (§10.1) |

Token-authenticated requests are rate-unlimited (single user). Unsafe session-cookie requests require the `X-Requested-With: prana-bindu` header. Bearer requests do not.

## 10. MCP server

Transports: streamable HTTP at `/mcp` (stateless JSON-response mode), and stdio via `prana-bindu mcp`. Being stateless, `/mcp` serves only `POST`; an authenticated `GET` (SSE listener) or `DELETE` gets 405 with `Allow: POST`. `/mcp` needs `Authorization: Bearer` with either an API token (`pb_…`) or an OAuth access token (§10.1), never the session cookie; a request whose `Origin` header is not the app origin gets 403 (DNS-rebinding guard). The server name is `prana-bindu`. Tools have zod input schemas and return structured JSON (`structuredContent`) plus a short text summary. Tools mirror §9:

`list_tasks, get_task, create_task, update_task, complete_task, drop_task, delete_task, move_task, add_tag_to_task, remove_tag_from_task, list_projects, get_project, create_project, update_project, delete_project, mark_project_reviewed, list_folders, create_folder, update_folder, delete_folder, list_tags, create_tag, update_tag, delete_tag, list_perspectives, get_perspective_contents (inbox|projects|tags|forecast|flagged|review|completed|changed|<custom id>), get_forecast, get_review_queue, search, list_attachments, get_attachment (metadata; content as text when the content type is text/* or JSON and ≤ 1 MB), undo, redo, parse_date`.

Date inputs accept natural language (§7) as well as ISO strings. There is no import tool.

### 10.1 OAuth

MCP clients that cannot be given a token by hand (Claude custom connectors on claude.ai, Claude Desktop and mobile) connect with OAuth 2.1, following the MCP authorization spec. prana-bindu is both the authorization server and the protected resource. The issuer is `PRANA_ORIGIN`; the resource is `<origin>/mcp`. There is no new configuration.

- **Discovery**: a 401 from `/mcp` carries `WWW-Authenticate: Bearer realm="prana-bindu", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"` (plus `error="invalid_token"` when a token was presented and rejected). `/.well-known/oauth-protected-resource[/mcp]` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414) are public.
- **Registration** (`POST /oauth/register`, RFC 7591): anyone may register a public client (`token_endpoint_auth_method: none`) with 1–10 redirect URIs, each `https:` or `http:` on localhost/127.0.0.1/[::1], without a fragment, at most 2048 characters; `client_name` is optional (at most 100 characters, default "Unnamed client"). Request bodies over 32 KiB get 413.
- **Authorization** (`GET /oauth/authorize`): an unknown `client_id` or unregistered `redirect_uri` gets a plain 400 and no redirect. Otherwise errors redirect back with `error`, `state` and `iss`. `response_type=code` and a PKCE `S256` challenge are required; `resource`, if sent, must be `<origin>/mcp`; `scope`, if sent, must be `prana` (the only scope: the whole database). A valid request is stored for 10 minutes and the browser goes to the consent page `/authorize?request=<id>`.
- **Consent** (`/authorize`): signed-out visitors sign in with a passkey first and return to the page. It shows the client's self-declared name, the redirect host, what the app can do (read and change everything through MCP) and a warning that the name is chosen by the app, with Allow and Deny. Only a browser session can decide (an API token gets 403). Each request is decided once; an expired or used one shows "Request expired". Allow creates a grant and a single-use code (60 seconds) and returns the browser to the client with `code`, `state` and `iss`; Deny returns `error=access_denied`.
- **Tokens** (`POST /oauth/token`, form or JSON): `authorization_code` checks the code, client, redirect URI and PKCE verifier; `refresh_token` rotates. Both return an opaque access token (1 hour) and refresh token (30 days from issue), `scope: prana`, with `Cache-Control: no-store`. A reused code or a reused rotated refresh token revokes the whole grant. Errors use `{error, error_description}` with 400.
- **Revocation** (`POST /oauth/revoke`, RFC 7009): always 200; a token presented by the client that owns it revokes its grant.
- **Scope of tokens**: OAuth access tokens work on `/mcp` only, never on `/api/v1`. Codes and tokens are stored as SHA-256 hashes.
- **Cleanup**: `serve` deletes expired codes and tokens and unusable grants at startup and hourly, plus clients without grants that never got one within a day or whose last grant was 30 days ago.

## 11. Importer

`prana-bindu import <path|url>` and `POST /api/v1/import`. Input is a `.zip` containing a `.ofocus` package, or an unzipped `.ofocus` directory (CLI only). The importer implements `docs/research/ofocus-format.md` §6 in full:
- locate the package root and ignore `__MACOSX` and `._*` entries;
- reject encrypted packages and the v1 namespace;
- apply the base transaction and then all deltas in order, honouring `op=update|delete|reference`;
- map every entity per F§4: tasks, projects, folders, tags, task-tag links with order, alarms, attachments (blobs uploaded once per sha256), custom perspectives with rules, and settings;
- convert rich-text notes to markdown;
- normalise pre-4.7 repeat fields;
- preserve raw unknown elements in the import warnings.

The import is replace-all and atomic. The whole package is parsed and validated, and blobs are uploaded, before any database change. All domain tables (tasks, projects, folders, tags, links, alarms, attachments, blobs, custom perspectives, settings, journal) are then replaced in one SQLite transaction. Auth tables (passkeys, sessions, tokens, OAuth clients and grants) are untouched, and a failure leaves the previous data intact. Afterwards, blobs no longer referenced are deleted. An `import_runs` row records the time, source, app version, counts and warnings. Importing the sample backup must succeed with counts equal to F§2 (2561 tasks incl. clones, 44 projects, 4 folders, 12 tags, 79 task-tag links, 110 alarms, 500 attachments over 330 blobs, custom perspectives).

## 12. Non-functional

- With the sample backup imported, the API answers in < 300 ms p95 for perspective contents on a laptop.
- The SPA is usable at 360 px wide; touch targets are ≥ 44 px.
- No secrets are logged. Tokens (including OAuth codes and tokens) and enrollment secrets are stored as SHA-256 hashes, and passkey challenges are single-use and expire after 5 minutes.
- Tests: unit tests for derived-state rules, repeat advancement, the NL parser, the rule evaluator and the importer (with a small synthetic fixture `.ofocus` committed under `test/fixtures`). API integration tests run on an in-memory database. Playwright e2e tests cover the major flows, using a WebAuthn virtual authenticator for passkeys.
- Docker: a single image runs `prana-bindu serve`, with `/data` as a volume. CI runs lint, typecheck, unit/integration tests, e2e, the Docker build and the iOS app's tests (§16).

## 13. Scriptable widget

`scriptable/prana-bindu-forecast.js` is a self-contained [Scriptable](https://scriptable.app) script for an iOS home-screen widget. It needs no server changes beyond `?quickEntry=1` (§2).
- **Sizes**: medium and large. Other sizes show "Use the medium or large widget size."
- **Data**: `GET /api/v1/forecast?days=5` and `GET /api/v1/settings` with a bearer token, every 15 minutes (iOS decides the exact time).
- **Strip**: Past, Today, the next four weekday names, Future. The number is the column's `count`, exactly as in the web app's Forecast (Today includes Past), dimmed at zero. Under it, one dot per item due in that column (at most 4, most urgent first): red overdue, yellow due soon, grey otherwise. Planned-only items count but have no dot. Today is always highlighted.
- **Rows**: Today's items in API order, 2 in medium and 8 in large. A status circle as in the web app's rows (§3; square for projects; where iOS lacks the dashed or dotted SF Symbol, a plain ring), an orange corner when flagged, the name (dimmed when not available; projects only when deferred, since a project with remaining actions is always blocked), and the due chip in the web app's wording: red background when overdue, yellow when due soon. "No items" when Today is empty.
- **Taps**: a column opens `/forecast?day=<key>`; rows and the background open `/forecast?day=TODAY`; the "+" button opens `/forecast?quickEntry=1`.
- **Setup**: run in the Scriptable app, the script asks for the origin (no default) and an API token, checks them with `GET /settings`, and stores them in the iOS Keychain. Afterwards it offers Preview medium / Preview large / Change server or token (a blank token keeps the current one, for the same server only) / Remove settings (also deletes the cache).
- **Failures**: each successful response is cached on the device (the computed strip and rows, never the token). On a network failure or non-2xx answer, the cached forecast is shown with "Updated <time>" (with the day when it is not today) in place of one row. Without a cache for that origin: "Can't reach <host>", which opens the server when tapped. A 401 shows "Token rejected" and ignores the cache; without settings, the widget says to run the script in Scriptable. Tapping either of those opens the script. Every widget, including these messages, asks iOS to refresh after 15 minutes.
- **Colours** follow the system appearance.

## 14. Mail Drop

Emailing a secret address creates an inbox item. prana-bindu reads one mailbox of a Fastmail account over JMAP (RFC 8620/8621). The secret address is a Fastmail alias, and a Fastmail rule files the alias's mail into that mailbox; both are set up in Fastmail, not in prana-bindu.

- **Configuration**: `PRANA_MAIL_DROP_FASTMAIL_TOKEN` (a Fastmail API token with the Mail scope) and `PRANA_MAIL_DROP_MAILBOX` (the mailbox's name). Mail Drop is off unless they are set; once either (or `PRANA_MAIL_DROP_SESSION_URL`, the JMAP session URL, default `https://api.fastmail.com/jmap/session`) is set, both are required. Only `serve` runs it.
- **Mailbox**: exactly one mailbox must have the configured name, and it must have no role (Inbox, Archive, Trash and the other special mailboxes are refused, so a typo cannot turn all mail into items and delete it). The account must have a Trash mailbox. Every message in the mailbox is processed; there is no sender check.
- **Item**: added at the end of the inbox.
  - Name: the subject, without Australian Government protective markings (`[SEC=…]`, `[DLM=…]`) anywhere and without leading `Re:`, `Fw:` and `Fwd:` prefixes (any case, repeated, also counted as in `Re[2]:`), with whitespace collapsed. When that leaves nothing, the first non-empty line of the note; when the note is empty too, "(No subject)".
  - Note: the message's text body (JMAP `textBody`): plain-text parts as they are and HTML parts converted to text (links as `text [url]`, no line wrapping, runs of blank lines collapsed to one), joined, with line endings normalised and surrounding whitespace trimmed.
  - Attachments, named as in the message ("Forwarded message.eml" for an unnamed attached message, otherwise "attachment"): first the image, audio and video parts of the text body (RFC 8621 lists media inlined in a multipart/mixed, such as a photo sent from iPhone Mail, in `textBody`/`htmlBody` rather than `attachments`), then every part in JMAP `attachments` except images that the HTML body embeds by Content-ID (`cid:`), such as signature logos. Attachments are limited to 100 MB each, as uploads are; a message with a larger one (by its reported size, before anything is downloaded) fails.
  - The item is not recorded in the undo history: it is not a change the user made, so Undo keeps reverting their own last change.
- **After processing**: the message is moved to Trash and marked read. Each processed message (account id + email id) is recorded in the same transaction as its item, so a message whose move to Trash failed is moved by the next check without creating a second item, and a message that reappears in the mailbox is moved to Trash again without a new item.
- **Timing**: a check runs whenever the JMAP push channel (EventSource, `types=Email`, 60-second pings) opens or fails to connect (so also at startup), whenever it reports an email change, and every 5 minutes. Checks never overlap; a trigger during a check runs one more check afterwards. Messages are processed oldest first (`receivedAt`), 50 per request.
- **Failures** go to the server log and never stop the server. A message that fails (for example, an attachment download) stays in the mailbox and is retried by the next check; later messages are still processed. When the push channel fails, or is silent for three ping intervals (including while waiting for its response), it reconnects after 5 seconds, doubling up to 5 minutes; the 5-minute check runs regardless. A rejected token is logged with a hint to check `PRANA_MAIL_DROP_FASTMAIL_TOKEN`.
- **Logging**: "Mail Drop: watching mailbox …" at startup, `Mail Drop: added "<name>"` (with the attachment count) for each item, and one line per failure. The token is never logged.

## 15. Siri capture

An Apple Shortcut named "Add to inbox", which the user builds from the steps in the README, adds inbox items by voice on iPhone and Apple Watch. It uses the REST API (§9) with no server changes. No Shortcut file is shipped, because iOS imports only Shortcut files that a Mac has signed.
- **Trigger**: "Hey Siri, add to inbox" (the Shortcut's name) on iPhone or Apple Watch, or the Shortcuts app or a complication. Siri asks "What do you want to add?". The item can't be given in the trigger sentence, because custom Shortcuts don't take spoken parameters.
- **Item**: the answer, verbatim, becomes the name of a new item at the end of the inbox. Dates, tags and flags in it are not parsed. An empty answer stops the Shortcut without a request. The item is an ordinary "Add Action" change, so Undo can revert it.
- **Request**: `POST <origin>/api/v1/tasks` with `Authorization: Bearer <token>` (a token named `Siri` by convention) and the JSON body `{"name": "<answer>"}`. Bearer requests need no CSRF header (§9).
- **Feedback**: when the response has an `id` (201), Siri says `Added "<answer>" to your inbox.`. Otherwise it says `Couldn't add "<answer>": <error.message>`, for example "The bearer token is invalid or revoked" for a revoked token; a response without an error message (such as a proxy's error page) leaves the reason empty. When the server can't be reached, Shortcuts reports its own connection error. Nothing is queued for a retry.
- **Apple Watch**: the Shortcut runs on the Watch when "Show on Apple Watch" is on, and sends the request from the Watch.

## 16. iOS app

Prana is a native SwiftUI client for iPhone and iPad (iOS 26 or later) in `ios/`, with a Forecast widget, an "Add to Inbox" App Intent, a share extension and a watchOS app. It has the web app's behaviour and texts for §1–§7 (shell, outline, inspector, perspectives and their editor, Quick Entry, settings, natural-language parsing), and talks to the server only through the REST API (§9), so the server needs no changes. This section lists what differs from the web app or is added to it. Architecture: `docs/plan.md` §iOS app.
- **Identity**: display name "Prana". Bundle ids `au.id.grimes.prana-bindu` (app), `….widget`, `….share` and `….watchkitapp`; App Group `group.au.id.grimes.prana-bindu`; URL scheme `prana`.
- **Sign-in**: by API token, not passkey, so there are no `/login` and `/enroll` screens. The user enters the server's origin (no default; `https://` is assumed when no scheme is typed) and an API token from Settings → API tokens. The app checks them with `GET /api/v1/settings` and saves them in the Keychain, in an access group shared with the widget and the share extension. Every request sends `Authorization: Bearer <token>`. A 401 on any request deletes the saved credentials and shows the sign-in screen with "Token rejected". Sign out (More, the app menu or Settings) waits for unsent writes behind a "Signing out…" overlay, then deletes the credentials.
- **Data and writes**: online only. Server data is cached in memory only. Writes are instant writes as in §2: client ids, one serial queue in gesture order, `Idempotency-Key`, retries after 0.5, 1.5 and 3 s, "Saving…" as the header's subtitle after 2 s, rollback of a failed write and every later one with one toast, and a refresh once the queue drains. Undo and redo follow §2 and §9 (`X-Undo-Steps`, `X-Undo-Step`, `X-Undo-Previous`, `undoId`/`redoId`): instant for this device's own steps, server-driven otherwise. Sign-in, passkeys and API tokens wait for the server. Nothing asks before the app is left with unsent writes.
- **Settings** (§6): the page also shows the server's origin and Sign Out. Passkeys can be listed, renamed and deleted, but "Add a passkey" opens `<origin>/settings` in an in-app Safari sheet, because registration needs a browser session (§8); the list reloads when the sheet closes. Revoking an API token asks for confirmation.
- **Layouts** follow the horizontal size class rather than the 768 px breakpoint.
  - Compact width (iPhone): the phone layout of §2. The tab bar shows the favourite perspectives in rank order, then the current perspective when it is not a favourite, at most four in all, then More; a perspective without a tab opens inside More. More lists every perspective with a favourite star (saved instantly), New perspective, Settings, Keyboard shortcuts and Sign out. The sidebar is a drawer from the left, the inspector a full-screen cover with Done, and Quick Entry a floating "+", hidden while the keyboard is up. The header has the sidebar button, Clean Up, Search, View options and a More menu (New item, Undo, Redo, Reorder or Done Reordering, Settings, Keyboard shortcuts, Sign out). Tapping a row selects it and opens the inspector.
  - Regular width (iPad): a split view with the perspectives rail (favourites, All perspectives, Settings), a sidebar column that can be hidden, the page, and the inspector column, with the header actions of §2. Below 1100 pt of window width (e.g. portrait) the rail is collapsed: a header button shows it, and picking a perspective puts it away again. The inspector starts open only when the window is at least 1100 pt wide.
  - The last route is restored on the next launch (except the editor of an unsaved new perspective); a link that opened the app takes precedence.
- **Attachments** (§3): besides Photos and Files, files and images dragged from another app (Files or Photos beside Prana in Split View, Slide Over or another window) onto the inspector's "Drop files here" zone at the end of the attachments are uploaded with their own names (each at most 100 MB); dragged text, links and outline rows are not files and are refused. The zone is a UIKit drop target, because SwiftUI drop targets inside the inspector's list only receive drags that start in Prana.
- **Row gestures** (replacing parts of §3):
  - Swipe right on an action row completes it (or marks it incomplete); swipe left reveals Flag/Unflag and Delete.
  - A long press opens the row's menu: Complete, Flag, New Action, Indent, Outdent, Move Up, Move Down, Group, Ungroup (rows with children) and Delete (Delete Project / Delete Folder / Delete Tag). In compact width this replaces the "•••" button, as the web app hides it on phones; in regular width the "•••" button shows the same menu.
  - The title is edited inline. Return adds a sibling below; Tab and Shift-Tab indent and outdent; a toolbar above the software keyboard has Outdent, Indent, Move Up, Move Down and Done.
  - Multi-select: a "Select" button puts the outline in edit mode, with a bottom bar of Complete, Flag, Outdent, Indent, Group, Inspect and Delete.
  - Reorder mode (§3) uses the system list's move mode: handles at the trailing edge of action rows, and a dropped row goes before the row below it, which can also re-parent it. Moves stay within one group, and there is no target for dropping a row inside another. While reordering, a long press starts a move instead of opening the menu.
  - Sidebar drops (§3), in regular width outside reorder and Select mode: an action row (with the rest of the selection, when it is selected) is dragged with a long press onto the sidebar's Inbox or a project, which moves it there, or onto a tag, which adds the tag ("Tag added"). In compact width, the inspector's Project and Tags fields do the same.
  - Sidebar: rename is in a row's context menu (not a double-click). Projects, folders and tags are reordered and nested with a Reorder button, which puts the sidebar list in edit mode, or with a "Move to" context menu that lists the folders (or tags).
- **Quick Entry**: as in §4. It opens from the floating "+" (compact), the header (regular), C on a hardware keyboard, and any link with `?quickEntry=1`, including the widget's "+". The due date is parsed on the device (§7) before saving.
- **Keyboard shortcuts** with a hardware keyboard (iPad): the global set of §2 (C, N, O, P, V, K, S = refresh, /, Z and ⌘Z, ⇧Z and ⌘⇧Z, ⇧S, ⇧I, and Shift-? for the shortcuts sheet), the outline keys of §3, and ⌘[ / ⌘] / ⌘⇧R on the Review page (previous project, next project, Mark Reviewed). Single-key shortcuts pause while a sheet is open; ⌘ shortcuts always work. The shortcuts sheet has the web app's Global, Outline and Review sections.
- **Deep links**: `prana://<path>?<query>` takes the web app's paths and query parameters (§2 Routes) without `/login` and `/enroll`, for example `prana://forecast?day=TODAY`, `prana://projects?project=<id>`, `prana://search?q=milk` and `prana://perspectives/<id>/edit`. `prana://` with no path opens the home page (the first favourite perspective, default Inbox). `?quickEntry=1` on any link opens Quick Entry over that page. Unknown paths are ignored.
- **Forecast widget**: WidgetKit, behaving as the Scriptable widget (§13) in sizes, data, strip, rows, colours and the 15-minute refresh, with these differences:
  - It uses the app's sign-in and has no setup of its own. Signed out, it says "Sign in to Prana".
  - Taps open the app: a column opens `prana://forecast?day=<key>`, rows and the background `prana://forecast?day=TODAY`, and "+" `prana://forecast?quickEntry=1`. "Can't reach <host>" opens the server's origin, which the app passes to the browser (§13); the other messages open the app at Today.
  - The last good forecast (the computed strip and rows and the display settings, never the token) is cached in the App Group container for the signed-in origin; signing out deletes it. A 401 shows "Token rejected. Open Prana to sign in again." and ignores the cache. Without a cache: "Can't reach <host>. <reason>". Requests give up after 15 s.
  - The app reloads the widget when it starts, when it signs in or out, and whenever its write queue drains.
- **"Add to Inbox" App Intent**: Siri and Shortcuts capture as in §15, without a hand-built Shortcut or a token in it.
  - Trigger phrases name the app: "Add to Prana inbox", "Add to my Prana inbox", "Add an item to Prana", "Capture in Prana". In the Shortcuts app it is an action ("Add <Item> to the inbox"). It runs without opening the app.
  - Siri asks "What do you want to add?". The answer, verbatim, becomes the name of a new item at the end of the inbox (`POST /tasks` with `{"name": …}`, the saved credentials); nothing is parsed or queued for a retry.
  - Siri answers `Added "<answer>" to your inbox.` or `Couldn't add "<answer>": <reason>`, where the reason is the server's `error.message` (empty without one) or the connection error. Signed out: "Open Prana and sign in first.". An empty answer: "Nothing to add."
- **Share extension**: accepts text, one web link, and up to 10 images and 10 files. The "Add to Inbox" sheet has editable Name and Note fields and lists the files under Attachments. The name is the page title, else the first non-empty line of the text, else the link, else the file names; the note is the rest of the text (with the first line when the title named the item) and the link. Post creates the item at the end of the inbox (`POST /tasks`, nothing parsed), then uploads the files to it as attachments, in order. An error before the item exists shows in the sheet and Post can be tried again; when an upload fails after the item exists, the sheet shows the error with only Done, so a second item can't be created. Signed out, the sheet says "Sign in to Prana" and "Open Prana and sign in to add shared items to your inbox."
- **Watch app**: installed with the iPhone app. One screen, titled "Prana": a text field ("Add to inbox", for dictation, Scribble or typing) and Add. It shows "Added", or `Couldn't add "<text>": <reason>`, or "Open Prana on your iPhone to sign in." The watch also has the "Add to Inbox" App Intent (phrases as above, without "Capture in Prana"). The item is added as by the intent, with requests sent from the watch itself.
  - Credentials come from the phone through WatchConnectivity: the phone app sends its application context (origin and token, or a signed-out marker, with a timestamp so an unchanged context is still delivered) when it starts and whenever it signs in or out. The watch saves the credentials in its own Keychain, or deletes them on sign-out.
