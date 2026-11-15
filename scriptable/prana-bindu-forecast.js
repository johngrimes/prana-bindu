// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: calendar-alt;

/*
 * prana-bindu Forecast widget for Scriptable (https://scriptable.app), medium and large sizes.
 *
 * A strip of Past, Today, the next four days and Future with item counts and one dot per due item, then Today's items.
 * Run the script in the Scriptable app first: it asks for your server and an API token (Settings → API tokens in
 * prana-bindu) and keeps them in the iOS Keychain. See "Scriptable widget" in the prana-bindu README.
 */

const KEYCHAIN_KEY = "prana-bindu-widget";
const CACHE_FILE = "prana-bindu-widget-cache.json";
/** Today plus the next four days; the API adds the Past and Future columns. */
const DAYS = 5;
const ROWS = { medium: 2, large: 8 };
const MAX_DOTS = 4;
const REFRESH_MINUTES = 15;
const REQUEST_TIMEOUT_SECONDS = 15;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const dynamic = (light, dark, alpha = 1) => Color.dynamic(new Color(light, alpha), new Color(dark, alpha));
const COLORS = {
  background: dynamic("#FFFFFF", "#1C1C1E"),
  text: dynamic("#000000", "#FFFFFF"),
  secondary: dynamic("#6C6C70", "#8E8E93"),
  faint: dynamic("#C7C7CC", "#48484A"),
  highlight: dynamic("#E5E5EA", "#3A3A3C"),
  red: dynamic("#FF3B30", "#FF453A"),
  redSoft: dynamic("#FF3B30", "#FF453A", 0.22),
  yellow: dynamic("#FFCC00", "#FFD60A"),
  yellowSoft: dynamic("#FFCC00", "#FFD60A", 0.22),
  yellowText: dynamic("#946200", "#FFD60A"),
  grey: dynamic("#8E8E93", "#8E8E93"),
  orange: dynamic("#FF9500", "#FF9F0A"),
  accent: dynamic("#007AFF", "#0A84FF"),
  white: dynamic("#FFFFFF", "#FFFFFF"),
};
/** Drawn images can't follow the appearance, so the flag corner uses one orange that suits both. */
const FLAG_CORNER_COLOR = new Color("#FF9F0A");
const DOT_COLORS = { overdue: COLORS.red, dueSoon: COLORS.yellow, due: COLORS.grey };
const SEVERITY = { overdue: 0, dueSoon: 1, due: 2 };

// --- Dates (mirrors src/web/lib/dates.ts so the chips read as in the web app) -------------------------------------

const pad = (n, width = 2) => String(n).padStart(width, "0");

function instantToWall(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
}

/** Wall time of a stored date value: fixed values (…Z or with an offset) in `timeZone`, floating values as written. */
function toWall(value, timeZone) {
  if (/(Z|[+-]\d{2}:\d{2})$/.test(value)) return instantToWall(new Date(value), timeZone);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
  if (!m) return instantToWall(new Date(value), timeZone);
  return { year: +m[1], month: +m[2], day: +m[3], hour: m[4] ? +m[4] : 0, minute: m[5] ? +m[5] : 0 };
}

const dayKeyOf = (w) => `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;

function keyToUtc(key) {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatDayOnly(w, dateFormat) {
  const [yyyy, mm, dd] = [pad(w.year, 4), pad(w.month), pad(w.day)];
  switch (dateFormat) {
    case "dd/MM/yyyy":
      return `${dd}/${mm}/${yyyy}`;
    case "yyyy/MM/dd":
      return `${yyyy}/${mm}/${dd}`;
    case "yyyy-MM-dd":
      return `${yyyy}-${mm}-${dd}`;
    default:
      return `${mm}/${dd}/${yyyy}`;
  }
}

function formatTime(w, use24HourTime) {
  if (use24HourTime) return `${pad(w.hour)}:${pad(w.minute)}`;
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return `${h}:${pad(w.minute)} ${w.hour < 12 ? "AM" : "PM"}`;
}

/** "Today", "Tomorrow", "Yesterday", a weekday within the coming week, else the date; plus the time unless midnight. */
function chipLabel(value, settings, todayKey) {
  const w = toWall(value, settings.timeZone);
  const diff = Math.round((keyToUtc(dayKeyOf(w)) - keyToUtc(todayKey)) / 86400000);
  let day;
  if (diff === 0) day = "Today";
  else if (diff === 1) day = "Tomorrow";
  else if (diff === -1) day = "Yesterday";
  else if (diff > 1 && diff < 7) day = WEEKDAYS[new Date(keyToUtc(dayKeyOf(w))).getUTCDay()];
  else day = formatDayOnly(w, settings.dateFormat);
  if (w.hour === 0 && w.minute === 0) return day;
  return `${day} ${formatTime(w, settings.use24HourTime)}`;
}

// --- Model: what to draw, computed from GET /forecast and GET /settings ------------------------------------------

/** Status circle state, with the web app's precedence (src/web/components/outline/StatusCircle.tsx). */
function circleState(task) {
  if (task.overdue) return "overdue";
  if (task.dueSoon) return "dueSoon";
  if (task.effectiveFlagged) return "flagged";
  if (task.blocked) return "blocked";
  if (task.repeat) return "repeating";
  if (task.firstAvailable) return "next";
  return "available";
}

const rowTask = (row) => row.task ?? row.project?.task ?? null;

function columnTitle(day) {
  if (day.key === "PAST") return "Past";
  if (day.key === "TODAY") return "Today";
  if (day.key === "FUTURE") return "Future";
  return WEEKDAYS[new Date(keyToUtc(day.date)).getUTCDay()];
}

/** One dot per item that is due in this column (not merely planned there), most urgent first. */
function dueDots(day, timeZone, today, lastDay) {
  const inColumn = (key) => {
    if (day.key === "PAST") return key < today;
    if (day.key === "TODAY") return key <= today;
    if (day.key === "FUTURE") return key > lastDay;
    return key === day.date;
  };
  return day.rows
    .map(rowTask)
    .filter((t) => t && t.effectiveDueDate && inColumn(dayKeyOf(toWall(t.effectiveDueDate, timeZone))))
    .map((t) => (t.overdue ? "overdue" : t.dueSoon ? "dueSoon" : "due"))
    .sort((a, b) => SEVERITY[a] - SEVERITY[b])
    .slice(0, MAX_DOTS);
}

function buildModel(forecast, settings) {
  const today = forecast.today;
  const realDays = forecast.days.filter((d) => d.date);
  const lastDay = realDays.length ? realDays[realDays.length - 1].date : today;
  const columns = forecast.days.map((day) => ({
    key: day.key,
    title: columnTitle(day),
    count: day.count,
    dots: dueDots(day, settings.timeZone, today, lastDay),
  }));
  const todayRows = forecast.days.find((d) => d.key === "TODAY")?.rows ?? [];
  const rows = todayRows
    .filter((r) => rowTask(r))
    .slice(0, Math.max(ROWS.medium, ROWS.large))
    .map((r) => {
      const t = rowTask(r);
      return {
        name: t.name,
        project: r.kind === "project",
        circle: circleState(t),
        flagged: t.effectiveFlagged,
        // A project with remaining actions is always "blocked", so projects dim only when deferred (as in the web app).
        dimmed: r.kind === "project" ? t.deferred : !t.available,
        chip: t.effectiveDueDate
          ? { text: chipLabel(t.effectiveDueDate, settings, today), tone: t.overdue ? "overdue" : t.dueSoon ? "dueSoon" : null }
          : null,
      };
    });
  return { columns, rows };
}

// --- Settings (Keychain), cache and network ----------------------------------------------------------------------

function readSettings() {
  if (!Keychain.contains(KEYCHAIN_KEY)) return null;
  try {
    const s = JSON.parse(Keychain.get(KEYCHAIN_KEY));
    return s && s.origin && s.token ? s : null;
  } catch {
    return null;
  }
}

const hostOf = (origin) => origin.replace(/^https?:\/\//i, "");
const cachePath = () => FileManager.local().joinPath(FileManager.local().documentsDirectory(), CACHE_FILE);

function readCache(origin) {
  const fm = FileManager.local();
  if (!fm.fileExists(cachePath())) return null;
  try {
    const cache = JSON.parse(fm.readString(cachePath()));
    return cache.origin === origin ? cache : null;
  } catch {
    return null;
  }
}

async function getJSON(server, path) {
  const req = new Request(`${server.origin}/api/v1${path}`);
  req.headers = { Authorization: `Bearer ${server.token}`, Accept: "application/json" };
  req.timeoutInterval = REQUEST_TIMEOUT_SECONDS;
  const body = await req.loadString();
  const status = req.response.statusCode;
  if (status === 401) {
    const err = new Error("Token rejected");
    err.unauthorized = true;
    throw err;
  }
  if (status < 200 || status >= 300) throw new Error(`The server answered HTTP ${status}.`);
  try {
    return JSON.parse(body);
  } catch {
    // For example a captive portal's login page.
    throw new Error("The server's answer wasn't JSON.");
  }
}

/**
 * Fetches the forecast and caches what the widget draws. On failure, falls back to the cache unless the token was
 * rejected. Returns { cache, stale } or { error, message }.
 */
async function load(server, now) {
  try {
    const [forecast, settings] = await Promise.all([getJSON(server, `/forecast?days=${DAYS}`), getJSON(server, "/settings")]);
    const { timeZone, dateFormat, use24HourTime } = settings;
    const cache = {
      origin: server.origin,
      fetchedAt: now.toISOString(),
      settings: { timeZone, dateFormat, use24HourTime },
      model: buildModel(forecast, settings),
    };
    FileManager.local().writeString(cachePath(), JSON.stringify(cache));
    return { cache, stale: false };
  } catch (err) {
    if (err.unauthorized) return { error: "unauthorized" };
    const cache = readCache(server.origin);
    if (cache) return { cache, stale: true };
    return { error: "unreachable", message: err.message };
  }
}

function updatedNote(cache, now) {
  const { settings } = cache;
  const fetched = instantToWall(new Date(cache.fetchedAt), settings.timeZone);
  const today = dayKeyOf(instantToWall(now, settings.timeZone));
  if (dayKeyOf(fetched) === today) return `Updated ${formatTime(fetched, settings.use24HourTime)}`;
  return `Updated ${chipLabel(cache.fetchedAt, settings, today)}`;
}

// --- Drawing -----------------------------------------------------------------------------------------------------

function centred(parent, add) {
  const row = parent.addStack();
  row.layoutHorizontally();
  row.addSpacer();
  add(row);
  row.addSpacer();
  return row;
}

let flagCorner = null;
function flagCornerImage() {
  if (flagCorner) return flagCorner;
  const ctx = new DrawContext();
  ctx.size = new Size(40, 40);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const path = new Path();
  path.move(new Point(0, 0));
  path.addLine(new Point(17, 0));
  path.addLine(new Point(0, 17));
  path.closeSubpath();
  ctx.setFillColor(FLAG_CORNER_COLOR);
  ctx.addPath(path);
  ctx.fillPath();
  flagCorner = ctx.getImage();
  return flagCorner;
}

const RINGS = {
  overdue: { border: COLORS.red, fill: COLORS.redSoft },
  dueSoon: { border: COLORS.yellow, fill: COLORS.yellowSoft },
  flagged: { border: COLORS.orange },
  next: { border: COLORS.text },
  available: { border: COLORS.secondary },
};
/** Projects get square status shapes, as in the web app. */
const SYMBOLS = {
  task: { blocked: "circle.dashed", repeating: "circle.dotted" },
  project: { blocked: "square.dashed", repeating: "square.dotted" },
};

function addStatusCircle(parent, row) {
  const cell = parent.addStack();
  cell.size = new Size(20, 20);
  cell.layoutHorizontally();
  cell.centerAlignContent();
  if (row.flagged) cell.backgroundImage = flagCornerImage();
  cell.addSpacer();
  // SFSymbol.named returns null on iOS versions without the symbol (circle.dotted needs iOS 15, square.dotted iOS 16);
  // draw a plain ring then.
  const name = SYMBOLS[row.project ? "project" : "task"][row.circle];
  const symbol = name ? SFSymbol.named(name) : null;
  if (symbol) {
    const img = cell.addImage(symbol.image);
    img.imageSize = new Size(17, 17);
    img.tintColor = COLORS.secondary;
  } else {
    const ring = RINGS[row.circle] ?? RINGS.available;
    const r = cell.addStack();
    r.size = new Size(15, 15);
    r.cornerRadius = row.project ? 4 : 7.5;
    r.borderWidth = 1.75;
    r.borderColor = ring.border;
    if (ring.fill) r.backgroundColor = ring.fill;
  }
  cell.addSpacer();
}

function addColumn(strip, column, origin) {
  const col = strip.addStack();
  col.layoutVertically();
  col.url = `${origin}/forecast?day=${column.key}`;
  col.setPadding(4, 0, 4, 0);
  col.spacing = 1;
  col.cornerRadius = 10;
  if (column.key === "TODAY") col.backgroundColor = COLORS.highlight;

  centred(col, (r) => {
    const t = r.addText(column.title);
    t.font = Font.mediumSystemFont(13);
    t.textColor = COLORS.secondary;
    t.lineLimit = 1;
    t.minimumScaleFactor = 0.7; // "Future" on the narrowest phones
  });
  centred(col, (r) => {
    const t = r.addText(String(column.count));
    t.font = Font.mediumRoundedSystemFont(24);
    t.textColor = column.count === 0 ? COLORS.faint : COLORS.text;
    t.lineLimit = 1;
    t.minimumScaleFactor = 0.7;
  });
  centred(col, (r) => {
    const dots = r.addStack();
    dots.size = new Size(0, 8);
    dots.spacing = 1;
    for (const kind of column.dots) {
      const d = dots.addText("●");
      d.font = Font.systemFont(7);
      d.textColor = DOT_COLORS[kind];
    }
  });
}

function addRow(list, row, url) {
  const r = list.addStack();
  r.layoutHorizontally();
  r.centerAlignContent();
  r.spacing = 6;
  r.url = url;
  addStatusCircle(r, row);
  const name = r.addText(row.name);
  name.font = Font.systemFont(15);
  name.textColor = row.dimmed ? COLORS.secondary : COLORS.text;
  name.lineLimit = 1;
  r.addSpacer();
  if (row.chip) {
    const chip = r.addStack();
    chip.setPadding(1, 4, 1, 4);
    chip.cornerRadius = 4;
    const tone = row.chip.tone;
    if (tone === "overdue") chip.backgroundColor = COLORS.redSoft;
    if (tone === "dueSoon") chip.backgroundColor = COLORS.yellowSoft;
    const t = chip.addText(row.chip.text);
    t.font = Font.systemFont(12);
    t.textColor = tone === "overdue" ? COLORS.red : tone === "dueSoon" ? COLORS.yellowText : COLORS.secondary;
    t.lineLimit = 1;
    t.minimumScaleFactor = 0.75; // shrink long dates rather than truncate them
  }
}

function addQuickEntryButton(parent, origin) {
  const button = parent.addStack();
  button.size = new Size(30, 30);
  button.cornerRadius = 15;
  button.backgroundColor = COLORS.accent;
  button.url = `${origin}/forecast?quickEntry=1`;
  button.layoutHorizontally();
  button.centerAlignContent();
  button.addSpacer();
  const plus = button.addImage(SFSymbol.named("plus").image);
  plus.imageSize = new Size(14, 14);
  plus.tintColor = COLORS.white;
  button.addSpacer();
}

function newWidget() {
  const w = new ListWidget();
  w.backgroundColor = COLORS.background;
  return w;
}

function messageWidget(text, url) {
  const w = newWidget();
  w.setPadding(14, 16, 14, 16);
  const title = w.addText("prana-bindu");
  title.font = Font.semiboldSystemFont(14);
  title.textColor = COLORS.text;
  w.addSpacer(4);
  const body = w.addText(text);
  body.font = Font.systemFont(13);
  body.textColor = COLORS.secondary;
  if (url) w.url = url;
  return w;
}

function forecastWidget(family, origin, cache, stale, now) {
  const todayUrl = `${origin}/forecast?day=TODAY`;
  const w = newWidget();
  w.setPadding(10, 12, 10, 12);
  w.url = todayUrl;

  const strip = w.addStack();
  strip.layoutHorizontally();
  strip.spacing = 2;
  for (const column of cache.model.columns) addColumn(strip, column, origin);

  w.addSpacer(6);
  const bottom = w.addStack();
  bottom.layoutHorizontally();
  bottom.bottomAlignContent();
  bottom.spacing = 6;
  const list = bottom.addStack();
  list.layoutVertically();
  list.spacing = 3;
  // The "Updated" note takes the place of one row.
  const rows = cache.model.rows.slice(0, ROWS[family] - (stale ? 1 : 0));
  for (const row of rows) addRow(list, row, todayUrl);
  if (cache.model.rows.length === 0) {
    const empty = list.addText("No items");
    empty.font = Font.systemFont(15);
    empty.textColor = COLORS.secondary;
  }
  // The list fills the remaining height, so the note and the "+" button sit at the bottom.
  list.addSpacer();
  if (stale) {
    const note = list.addText(updatedNote(cache, now));
    note.font = Font.systemFont(10);
    note.textColor = COLORS.secondary;
  }
  addQuickEntryButton(bottom, origin);
  return w;
}

async function buildWidget(family, server) {
  const now = new Date();
  const result = await load(server, now);
  if (result.error === "unauthorized") {
    return messageWidget("Token rejected. Run this script in Scriptable to enter a new one.", URLScheme.forRunningScript());
  }
  if (result.error) return messageWidget(`Can't reach ${hostOf(server.origin)}. ${result.message}`, server.origin);
  return forecastWidget(family, server.origin, result.cache, result.stale, now);
}

async function widgetForFamily(family) {
  let w;
  if (family !== "medium" && family !== "large") w = messageWidget("Use the medium or large widget size.");
  else {
    const server = readSettings();
    w = server
      ? await buildWidget(family, server)
      : messageWidget("Run this script in Scriptable to connect it to your server.", URLScheme.forRunningScript());
  }
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60000);
  return w;
}

// --- In the Scriptable app: settings and previews ------------------------------------------------------------------

async function notify(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction("OK");
  await a.presentAlert();
}

/** Asks for the server and token until they work (then saves them) or the user cancels. */
async function promptSettings(current) {
  let origin = current?.origin ?? "";
  for (;;) {
    const a = new Alert();
    a.title = "Connect to prana-bindu";
    a.message = "Create an API token in prana-bindu under Settings → API tokens.";
    a.addTextField("https://tasks.example.com", origin);
    a.addSecureTextField(current ? "Token (leave blank to keep the current one for this server)" : "Token (pb_…)", "");
    a.addAction("Save");
    a.addCancelAction("Cancel");
    if ((await a.presentAlert()) === -1) return null;

    origin = a.textFieldValue(0).trim().replace(/\/+$/, "");
    const sameServer = current && origin === current.origin;
    const token = a.textFieldValue(1).trim() || (sameServer ? current.token : "");
    if (!/^https?:\/\/[^/\s?#]+$/i.test(origin)) {
      await notify("Invalid server URL", "Enter the address you open prana-bindu at, such as https://tasks.example.com.");
      continue;
    }
    if (!token) {
      await notify("Token required", current && !sameServer ? "A different server needs its own API token." : "Paste an API token from prana-bindu.");
      continue;
    }
    try {
      await getJSON({ origin, token }, "/settings");
    } catch (err) {
      if (err.unauthorized) await notify("Token rejected", `${hostOf(origin)} did not accept that token.`);
      else await notify(`Can't reach ${hostOf(origin)}`, err.message);
      continue;
    }
    const server = { origin, token };
    Keychain.set(KEYCHAIN_KEY, JSON.stringify(server));
    return server;
  }
}

async function runInApp() {
  let server = readSettings() ?? (await promptSettings(null));
  while (server) {
    const menu = new Alert();
    menu.title = "prana-bindu Forecast";
    menu.message = `Connected to ${server.origin}.`;
    menu.addAction("Preview medium");
    menu.addAction("Preview large");
    menu.addAction("Change server or token");
    menu.addDestructiveAction("Remove settings");
    menu.addCancelAction("Done");
    const choice = await menu.presentAlert();
    if (choice === 0) return (await buildWidget("medium", server)).presentMedium();
    if (choice === 1) return (await buildWidget("large", server)).presentLarge();
    if (choice === 2) {
      server = (await promptSettings(server)) ?? server;
      continue;
    }
    if (choice === 3) {
      Keychain.remove(KEYCHAIN_KEY);
      if (FileManager.local().fileExists(cachePath())) FileManager.local().remove(cachePath());
    }
    return;
  }
}

if (config.runsInWidget) Script.setWidget(await widgetForFamily(config.widgetFamily));
else await runInApp();
Script.complete();
