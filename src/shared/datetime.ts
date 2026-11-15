// Time-zone helpers for fixed (`…Z`) and floating (wall-clock) date values (docs/spec.md §1.1).
// Pure and browser-safe. "Naive" milliseconds encode a wall-clock time as if it were UTC
// (Date.UTC(y, m, d, h, mi, s, ms)), which makes calendar arithmetic DST-independent.

const DAY_MS = 86_400_000;

const FLOATING_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const FIXED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when `timeZone` is a valid IANA zone name. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

// Zone transitions happen on quarter-hour boundaries, so offsets are cached per 15-minute bucket.
const BUCKET_MS = 900_000;
const offsetCache = new Map<string, Map<number, number>>();

/** Offset (ms) of `timeZone` from UTC at the instant `ms` (positive east of Greenwich). */
export function tzOffsetMs(ms: number, timeZone: string): number {
  const bucket = Math.floor(ms / BUCKET_MS);
  let zoneCache = offsetCache.get(timeZone);
  if (!zoneCache) {
    zoneCache = new Map();
    offsetCache.set(timeZone, zoneCache);
  }
  let offset = zoneCache.get(bucket);
  if (offset === undefined) {
    if (zoneCache.size > 50_000) zoneCache.clear();
    offset = computeOffset(bucket * BUCKET_MS, timeZone);
    zoneCache.set(bucket, offset);
  }
  return offset;
}

function computeOffset(wholeSecond: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(wholeSecond));
  let y = 0;
  let mo = 0;
  let d = 0;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const p of parts) {
    switch (p.type) {
      case "year":
        y = Number(p.value);
        break;
      case "month":
        mo = Number(p.value);
        break;
      case "day":
        d = Number(p.value);
        break;
      case "hour":
        h = Number(p.value);
        break;
      case "minute":
        mi = Number(p.value);
        break;
      case "second":
        s = Number(p.value);
        break;
      default:
        break;
    }
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) - wholeSecond;
}

/** Instant → naive wall-clock ms in `timeZone`. */
export function instantToNaive(ms: number, timeZone: string): number {
  return ms + tzOffsetMs(ms, timeZone);
}

/**
 * Naive wall-clock ms in `timeZone` → instant. Ambiguous wall times (DST fall-back) resolve to the earlier
 * instant; non-existent wall times (spring-forward gap) shift forward by the gap.
 */
export function naiveToInstant(naive: number, timeZone: string): number {
  const before = naive - tzOffsetMs(naive - DAY_MS, timeZone);
  const after = naive - tzOffsetMs(naive + DAY_MS, timeZone);
  const valid = [before, after].filter((c) => instantToNaive(c, timeZone) === naive);
  if (valid.length > 0) return Math.min(...valid);
  // Gap: no instant has this wall time; the pre-transition offset moves the time forward.
  return before;
}

export function wallParts(naive: number): WallParts {
  const d = new Date(naive);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    millisecond: d.getUTCMilliseconds(),
    weekday: d.getUTCDay(),
  };
}

/** True for a floating (offset-less) date-time string. */
export function isFloating(value: string): boolean {
  return FLOATING_RE.test(value);
}

/** Parses a floating date-time string to naive ms, or null. */
export function parseFloating(value: string): number | null {
  const m = FLOATING_RE.exec(value);
  if (!m) return null;
  const ms = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), ms);
}

/** Formats naive ms as a canonical floating string `YYYY-MM-DDTHH:mm:ss.sss`. */
export function formatFloating(naive: number): string {
  return new Date(naive).toISOString().slice(0, -1);
}

/** Formats an instant as a canonical fixed string. */
export function formatFixed(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Normalises a date-time string to canonical stored form: floating stays floating (with seconds+ms),
 * fixed or offset forms become `…Z`. Returns null when the string is not an ISO date-time.
 */
export function normaliseIsoDate(value: string): string | null {
  const v = value.trim();
  const naive = parseFloating(v);
  if (naive !== null) return formatFloating(naive);
  if (FIXED_RE.test(v)) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : formatFixed(ms);
  }
  return null;
}

/** Resolves a stored date value (fixed or floating) to an instant (ms). */
export function dateValueToInstant(value: string, timeZone: string): number {
  const naive = parseFloating(value);
  if (naive !== null) return naiveToInstant(naive, timeZone);
  return Date.parse(value);
}

/** Resolves a stored date value to naive wall-clock ms in `timeZone`. */
export function dateValueToNaive(value: string, timeZone: string): number {
  const naive = parseFloating(value);
  if (naive !== null) return naive;
  return instantToNaive(Date.parse(value), timeZone);
}

/** Converts naive ms back to the representation of `like` (floating stays floating; fixed is resolved in tz). */
export function naiveToDateValue(naive: number, floating: boolean, timeZone: string): string {
  return floating ? formatFloating(naive) : formatFixed(naiveToInstant(naive, timeZone));
}

/** `YYYY-MM-DD` of naive ms. */
export function dayKeyOfNaive(naive: number): string {
  return new Date(naive).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` of the local day containing instant `ms`. */
export function localDayKey(ms: number, timeZone: string): string {
  return dayKeyOfNaive(instantToNaive(ms, timeZone));
}

/** Naive ms of midnight for a `YYYY-MM-DD` day key. */
export function dayKeyToNaive(key: string): number {
  const m = DAY_RE.exec(key);
  if (!m) throw new RangeError(`Invalid day key: ${key}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function isDayKey(key: string): boolean {
  return DAY_RE.test(key);
}

/** Adds `n` calendar days to a day key. */
export function addDaysToKey(key: string, n: number): string {
  return dayKeyOfNaive(dayKeyToNaive(key) + n * DAY_MS);
}

/** Instant of local midnight starting day `key`. */
export function dayStartInstant(key: string, timeZone: string): number {
  return naiveToInstant(dayKeyToNaive(key), timeZone);
}

/** Adds calendar units to naive ms (months/years clamp the day to the month's length). */
export function addToNaive(naive: number, amount: number, unit: "minute" | "hour" | "day" | "week" | "month" | "year"): number {
  switch (unit) {
    case "minute":
      return naive + amount * 60_000;
    case "hour":
      return naive + amount * 3_600_000;
    case "day":
      return naive + amount * DAY_MS;
    case "week":
      return naive + amount * 7 * DAY_MS;
    case "month":
    case "year": {
      const p = wallParts(naive);
      const months = unit === "year" ? amount * 12 : amount;
      const total = p.year * 12 + (p.month - 1) + months;
      const year = Math.floor(total / 12);
      const month = total - year * 12;
      const dim = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      return Date.UTC(year, month, Math.min(p.day, dim), p.hour, p.minute, p.second, p.millisecond);
    }
  }
}

export const MS_PER_DAY = DAY_MS;
