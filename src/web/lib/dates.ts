// Client-side date display and arithmetic. Dates are fixed (`…Z`) or floating wall times interpreted in
// the user's time zone (docs/spec.md §1.1). The server is authoritative; these helpers only render and
// compute values the UI sends as floating strings.
import type { Settings } from "../../shared/schemas";

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

type DateSettings = Pick<Settings, "timeZone" | "dateFormat" | "use24HourTime">;

const FLOATING = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** Wall-clock components of an instant in `timeZone`. */
export function instantToWall(instant: Date, timeZone: string): WallTime {
  const parts: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
  };
}

/** Wall time of a stored date value (fixed → converted into `timeZone`; floating → as written). */
export function toWall(value: string, timeZone: string): WallTime {
  if (value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value)) return instantToWall(new Date(value), timeZone);
  const m = FLOATING.exec(value);
  if (!m) return instantToWall(new Date(value), timeZone);
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] ? Number(m[4]) : 0,
    minute: m[5] ? Number(m[5]) : 0,
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function wallToFloating(w: WallTime): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:00.000`;
}

export function wallDayKey(w: Pick<WallTime, "year" | "month" | "day">): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** `YYYY-MM-DD` of today in the user's time zone. */
export function todayKey(timeZone: string, now = new Date()): string {
  return wallDayKey(instantToWall(now, timeZone));
}

export function dayKeyOf(value: string, timeZone: string): string {
  return wallDayKey(toWall(value, timeZone));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Calendar arithmetic on wall time (no DST concerns: floating values carry no offset). */
export function addToWall(w: WallTime, amount: number, unit: "day" | "week" | "month" | "year"): WallTime {
  if (unit === "day" || unit === "week") {
    const d = new Date(Date.UTC(w.year, w.month - 1, w.day + amount * (unit === "week" ? 7 : 1)));
    return { ...w, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }
  const totalMonths = w.year * 12 + (w.month - 1) + amount * (unit === "year" ? 12 : 1);
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  return { ...w, year, month, day: Math.min(w.day, daysInMonth(year, month)) };
}

export function parseHHMM(text: string): { hour: number; minute: number } {
  const [h, m] = text.split(":");
  return { hour: Number(h) || 0, minute: Number(m) || 0 };
}

export type DateField = "defer" | "due" | "planned";

export function defaultTimeFor(field: DateField, settings: Pick<Settings, "defaultDeferTime" | "defaultDueTime" | "defaultPlannedTime">) {
  return parseHHMM(field === "defer" ? settings.defaultDeferTime : field === "due" ? settings.defaultDueTime : settings.defaultPlannedTime);
}

/**
 * The +1 day / week / month inspector buttons: add to the current value, or — when the field is empty —
 * start from today at the field's default time. Returns a floating date string.
 */
export function bumpDate(
  value: string | null,
  amount: number,
  unit: "day" | "week" | "month",
  field: DateField,
  settings: Settings,
  now = new Date(),
): string {
  let base: WallTime;
  if (value) {
    base = toWall(value, settings.timeZone);
  } else {
    const today = instantToWall(now, settings.timeZone);
    base = { ...today, ...defaultTimeFor(field, settings) };
  }
  return wallToFloating(addToWall(base, amount, unit));
}

/** Replace the calendar day of a date (keeping its time, or the default time when empty). */
export function withDay(value: string | null, dayKey: string, field: DateField, settings: Settings): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const time = value ? toWall(value, settings.timeZone) : defaultTimeFor(field, settings);
  return wallToFloating({ year: y ?? 1970, month: m ?? 1, day: d ?? 1, hour: time.hour, minute: time.minute });
}

export function formatDayOnly(w: Pick<WallTime, "year" | "month" | "day">, dateFormat: Settings["dateFormat"]): string {
  const yyyy = pad(w.year, 4);
  const mm = pad(w.month);
  const dd = pad(w.day);
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

export function formatTime(w: Pick<WallTime, "hour" | "minute">, use24HourTime: boolean): string {
  if (use24HourTime) return `${pad(w.hour)}:${pad(w.minute)}`;
  const suffix = w.hour < 12 ? "AM" : "PM";
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return `${h}:${pad(w.minute)} ${suffix}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function weekdayOf(w: Pick<WallTime, "year" | "month" | "day">): number {
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

export function weekdayName(index: number): string {
  return WEEKDAYS[((index % 7) + 7) % 7] ?? "";
}

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? "";
}

/** Full date + time, e.g. "Fri 11/06/2026 5:00 PM" (inspector read-only fields). */
export function formatDateTime(value: string | null | undefined, settings: DateSettings): string {
  if (!value) return "";
  const w = toWall(value, settings.timeZone);
  return `${weekdayName(weekdayOf(w))} ${formatDayOnly(w, settings.dateFormat)} ${formatTime(w, settings.use24HourTime)}`;
}

/** Editable text representation of a date for the inspector's NL field. */
export function formatDateInput(value: string | null | undefined, settings: DateSettings): string {
  if (!value) return "";
  const w = toWall(value, settings.timeZone);
  return `${formatDayOnly(w, settings.dateFormat)} ${formatTime(w, settings.use24HourTime)}`;
}

function dayDiff(a: string, b: string): number {
  const toUtc = (k: string) => {
    const [y, m, d] = k.split("-").map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

/**
 * Compact chip label: "Today", "Tomorrow", "Yesterday", weekday within the coming week, else the date.
 * Adds the time unless it is midnight.
 */
export function formatDateChip(value: string, settings: DateSettings, now = new Date()): string {
  const w = toWall(value, settings.timeZone);
  const diff = dayDiff(wallDayKey(w), todayKey(settings.timeZone, now));
  let day: string;
  if (diff === 0) day = "Today";
  else if (diff === 1) day = "Tomorrow";
  else if (diff === -1) day = "Yesterday";
  else if (diff > 1 && diff < 7) day = weekdayName(weekdayOf(w));
  else day = formatDayOnly(w, settings.dateFormat);
  if (w.hour === 0 && w.minute === 0) return day;
  return `${day} ${formatTime(w, settings.use24HourTime)}`;
}

/** Calendar-day label for a `YYYY-MM-DD` key, e.g. "Mon, Nov 2". */
export function formatDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const w = { year: y ?? 1970, month: m ?? 1, day: d ?? 1 };
  return `${weekdayName(weekdayOf(w))}, ${monthName(w.month)} ${w.day}`;
}

export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return wallDayKey(addToWall({ year: y ?? 1970, month: m ?? 1, day: d ?? 1, hour: 0, minute: 0 }, days, "day"));
}

/** Start of the week containing `key`, honouring `firstWeekday` (1 = Sunday … 7 = Saturday). */
export function startOfWeekKey(key: string, firstWeekday: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const wd = weekdayOf({ year: y ?? 1970, month: m ?? 1, day: d ?? 1 });
  const offset = (wd - (firstWeekday - 1) + 7) % 7;
  return addDaysToKey(key, -offset);
}

/** The user's browser time zone. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
