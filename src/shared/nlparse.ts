// Natural-language date and duration parsing (docs/spec.md §7). Pure and browser-safe.
import { addToNaive, formatFloating, instantToNaive, wallParts } from "./datetime.js";

export type DateField = "defer" | "due" | "planned";
export type DateFormat = "MM/dd/yyyy" | "dd/MM/yyyy" | "yyyy/MM/dd" | "yyyy-MM-dd";

export interface ParseDateOptions {
  /** Which default time applies when the text has no time (default: due). */
  field?: DateField;
  now: Date;
  timeZone: string;
  /** Default times per field, "HH:MM". */
  defaults: { defer: string; due: string; planned: string };
  /** Decides the order of numeric `a/b` dates. */
  dateFormat: DateFormat;
}

const DAY_MS = 86_400_000;

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

type Unit = "hour" | "day" | "week" | "month" | "year";
const UNIT_RE = "(h|hrs?|hours?|d|days?|w|wks?|weeks?|m|mos?|months?|y|yrs?|years?)";
function unitOf(token: string): Unit {
  if (token.startsWith("h")) return "hour";
  if (token.startsWith("d")) return "day";
  if (token.startsWith("w")) return "week";
  if (token.startsWith("m")) return "month";
  return "year";
}

interface Time {
  hour: number;
  minute: number;
}

function parseHHMM(value: string): Time {
  const [h, m] = value.split(":");
  return { hour: Number(h ?? 0), minute: Number(m ?? 0) };
}

/** Extracts a time-of-day expression; returns the remaining text and the time (or null when absent). */
function extractTime(text: string): { rest: string; time: Time | null } | null {
  const named: [RegExp, Time][] = [
    [/\bnoon\b/, { hour: 12, minute: 0 }],
    [/\bmidnight\b/, { hour: 0, minute: 0 }],
  ];
  for (const [re, time] of named) {
    if (re.test(text)) return { rest: text.replace(re, " "), time };
  }
  const ampm = /(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)(?=\s|$)/.exec(text);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = Number(ampm[2] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const pm = ampm[3]!.startsWith("p");
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
    return { rest: text.replace(ampm[0], " "), time: { hour, minute } };
  }
  const h24 = /(?:^|\s)(\d{1,2}):(\d{2})(?=\s|$)/.exec(text);
  if (h24) {
    const hour = Number(h24[1]);
    const minute = Number(h24[2]);
    if (hour > 23 || minute > 59) return null;
    return { rest: text.replace(h24[0], " "), time: { hour, minute } };
  }
  return { rest: text, time: null };
}

function validDay(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > dim) return null;
  return Date.UTC(year, month - 1, day);
}

/** Resolves a date expression (without time) to naive midnight ms; `exact` is set for `now`-relative hour offsets. */
function parseDayExpression(
  text: string,
  todayNaive: number,
  nowNaive: number,
  dateFormat: DateFormat,
): { day: number } | { exact: number } | null {
  let s = text.trim().replace(/^(on|at)\s+/, "").replace(/\s+(at)$/, "");
  if (s === "") return { day: todayNaive };
  if (s === "today" || s === "tod") return { day: todayNaive };
  if (s === "tomorrow" || s === "tom") return { day: todayNaive + DAY_MS };
  if (s === "yesterday") return { day: todayNaive - DAY_MS };
  if (s === "next week") return { day: todayNaive + 7 * DAY_MS };
  if (s === "next month") return { day: addToNaive(todayNaive, 1, "month") };
  if (s === "next year") return { day: addToNaive(todayNaive, 1, "year") };
  if (s === "this weekend" || s === "weekend") {
    const wd = wallParts(todayNaive).weekday;
    return { day: todayNaive + ((6 - wd + 7) % 7) * DAY_MS };
  }

  // Relative offsets: "+1d", "-1d", "2w", "3 days", "1w 2d", "in 3 days".
  s = s.replace(/^in\s+/, "");
  const relRe = new RegExp(`^(?:\\s*([+-])?\\s*(\\d+)\\s*${UNIT_RE}(?![a-z]))+\\s*$`);
  if (relRe.test(s)) {
    const partRe = new RegExp(`([+-])?\\s*(\\d+)\\s*${UNIT_RE}(?![a-z])`, "g");
    let day = todayNaive;
    let hours = 0;
    let sign = 1;
    for (const m of s.matchAll(partRe)) {
      if (m[1]) sign = m[1] === "-" ? -1 : 1;
      const amount = sign * Number(m[2]);
      const unit = unitOf(m[3]!);
      if (unit === "hour") hours += amount;
      else day = addToNaive(day, amount, unit);
    }
    if (hours !== 0) return { exact: nowNaive + (day - todayNaive) + hours * 3_600_000 };
    return { day };
  }

  // Weekdays: "fri", "next fri" → next such day strictly after today.
  const wdMatch = /^(?:next\s+|this\s+)?([a-z]+)$/.exec(s);
  if (wdMatch && WEEKDAYS[wdMatch[1]!] !== undefined) {
    const target = WEEKDAYS[wdMatch[1]!]!;
    const wd = wallParts(todayNaive).weekday;
    const delta = ((target - wd + 7) % 7) || 7;
    return { day: todayNaive + delta * DAY_MS };
  }

  const today = wallParts(todayNaive);

  // ISO "2026-12-25".
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) {
    const day = validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return day === null ? null : { day };
  }

  // Numeric "12/25", "12/25/2026", "2026/12/25" (order per dateFormat).
  const num = /^(\d{1,4})[/.](\d{1,2})(?:[/.](\d{1,4}))?$/.exec(s);
  if (num) {
    const a = Number(num[1]);
    const b = Number(num[2]);
    const c = num[3] === undefined ? null : Number(num[3]);
    let year: number | null;
    let month: number;
    let dayOfMonth: number;
    if (num[1]!.length === 4) {
      if (c === null) return null;
      [year, month, dayOfMonth] = [a, b, c];
    } else if (dateFormat === "dd/MM/yyyy") {
      [dayOfMonth, month, year] = [a, b, c];
    } else {
      [month, dayOfMonth, year] = [a, b, c];
    }
    if (year !== null && year < 100) year += 2000;
    return resolveMonthDay(year, month, dayOfMonth, todayNaive, today.year);
  }

  // Month names: "dec 25", "25 dec", "december 25th 2026", "25 dec 2026".
  const tokens = s.replace(/(\d+)(st|nd|rd|th)\b/g, "$1").split(/\s+/);
  let month: number | null = null;
  let dayOfMonth: number | null = null;
  let year: number | null = null;
  for (const t of tokens) {
    if (MONTHS[t] !== undefined && month === null) month = MONTHS[t]!;
    else if (/^\d{1,2}$/.test(t) && dayOfMonth === null) dayOfMonth = Number(t);
    else if (/^\d{4}$/.test(t) && year === null) year = Number(t);
    else return null;
  }
  if (month === null) return null;
  return resolveMonthDay(year, month, dayOfMonth ?? 1, todayNaive, today.year);
}

/** A month/day without a year resolves to its next occurrence on or after today. */
function resolveMonthDay(
  year: number | null,
  month: number,
  day: number,
  todayNaive: number,
  currentYear: number,
): { day: number } | null {
  if (year !== null) {
    const d = validDay(year, month, day);
    return d === null ? null : { day: d };
  }
  const thisYear = validDay(currentYear, month, day);
  if (thisYear !== null && thisYear >= todayNaive) return { day: thisYear };
  const next = validDay(currentYear + 1, month, day);
  return next === null ? (thisYear === null ? null : { day: thisYear }) : { day: next };
}

/**
 * Parses a natural-language date relative to `now` in the user's time zone.
 * Returns a floating date-time string (`YYYY-MM-DDTHH:mm:ss.sss`) or null ("Unable to parse date").
 */
export function parseDate(text: string, options: ParseDateOptions): string | null {
  const s = text.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (s === "") return null;
  const nowNaive = Math.floor(instantToNaive(options.now.getTime(), options.timeZone) / 60_000) * 60_000;
  const todayNaive = Math.floor(nowNaive / DAY_MS) * DAY_MS;
  if (s === "now") return formatFloating(nowNaive);

  const extracted = extractTime(s);
  if (!extracted) return null;
  const { rest, time } = extracted;
  const restTrim = rest.replace(/\s+/g, " ").trim();
  if (restTrim === "" && time === null) return null;
  const day = parseDayExpression(restTrim, todayNaive, nowNaive, options.dateFormat);
  if (!day) return null;
  if ("exact" in day) {
    if (time !== null) return null;
    return formatFloating(day.exact);
  }
  const t = time ?? parseHHMM(options.defaults[options.field ?? "due"]);
  return formatFloating(day.day + t.hour * 3_600_000 + t.minute * 60_000);
}

/** Parses a duration ("30", "30m", "1h30m", "1.5h", "90 min", "2d", "1w") to whole minutes, or null. */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (s === "") return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s));
  const unit = "(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)";
  if (!new RegExp(`^(?:\\s*\\d+(?:\\.\\d+)?\\s*${unit}(?![a-z]))+\\s*$`).test(s)) return null;
  let total = 0;
  for (const m of s.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}(?![a-z])`, "g"))) {
    const amount = Number(m[1]);
    const u = m[2]!;
    const factor = u.startsWith("w") ? 10080 : u.startsWith("d") ? 1440 : u.startsWith("h") ? 60 : 1;
    total += amount * factor;
  }
  return Math.round(total);
}

/** Formats minutes as "1h 30m" (hours are not rolled up into days). */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
