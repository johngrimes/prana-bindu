// Repeat editor model: converts between an RFC 5545 RRULE body and editor fields, and summarises rules
// in plain English (docs/spec.md §3 Repeat editor).
import type { RepeatRule } from "../../shared/schemas";

export type Freq = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

export interface RepeatForm {
  freq: Freq;
  interval: number;
  /** Weekly: selected days. */
  byDay: WeekdayCode[];
  /** Monthly/yearly mode. */
  monthlyMode: "none" | "dayOfMonth" | "nthWeekday";
  byMonthDay: number[]; // 1..31, -1 = last day
  nth: number; // 1..5 or -1 (last)
  nthWeekday: WeekdayCode;
  byMonth: number[]; // 1..12 (yearly)
  end: { kind: "never" } | { kind: "count"; count: number } | { kind: "until"; date: string /* YYYY-MM-DD */ };
  /** Other RRULE parts (e.g. WKST) preserved verbatim. */
  extra: Array<[string, string]>;
}

const NTH_WEEKDAY = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/;

export function parseRule(rule: string): RepeatForm {
  const form: RepeatForm = {
    freq: "WEEKLY",
    interval: 1,
    byDay: [],
    monthlyMode: "none",
    byMonthDay: [],
    nth: 1,
    nthWeekday: "MO",
    byMonth: [],
    end: { kind: "never" },
    extra: [],
  };
  let setPos: number | null = null;
  const days: Array<{ n: number | null; day: WeekdayCode }> = [];
  for (const part of rule.replace(/^RRULE:/i, "").split(";")) {
    if (!part) continue;
    const [rawKey, value = ""] = part.split("=");
    const key = (rawKey ?? "").toUpperCase();
    switch (key) {
      case "FREQ":
        form.freq = value.toUpperCase() as Freq;
        break;
      case "INTERVAL":
        form.interval = Math.max(1, Number(value) || 1);
        break;
      case "BYDAY":
        for (const d of value.split(",")) {
          const m = NTH_WEEKDAY.exec(d.trim().toUpperCase());
          if (m) days.push({ n: m[1] ? Number(m[1]) : null, day: m[2] as WeekdayCode });
        }
        break;
      case "BYMONTHDAY":
        form.byMonthDay = value.split(",").map(Number).filter((n) => Number.isFinite(n) && n !== 0);
        break;
      case "BYSETPOS":
        setPos = Number(value);
        break;
      case "BYMONTH":
        form.byMonth = value.split(",").map(Number).filter((n) => n >= 1 && n <= 12);
        break;
      case "COUNT":
        form.end = { kind: "count", count: Math.max(1, Number(value) || 1) };
        break;
      case "UNTIL": {
        const m = /^(\d{4})(\d{2})(\d{2})/.exec(value);
        if (m) form.end = { kind: "until", date: `${m[1]}-${m[2]}-${m[3]}` };
        break;
      }
      default:
        form.extra.push([key, value]);
    }
  }
  const nthDay = days.find((d) => d.n !== null) ?? (setPos !== null && days.length === 1 ? { n: setPos, day: days[0]?.day ?? "MO" } : null);
  if ((form.freq === "MONTHLY" || form.freq === "YEARLY") && nthDay && nthDay.n !== null) {
    form.monthlyMode = "nthWeekday";
    form.nth = nthDay.n;
    form.nthWeekday = nthDay.day;
  } else {
    form.byDay = days.map((d) => d.day);
    if (setPos !== null) form.extra.push(["BYSETPOS", String(setPos)]);
  }
  if ((form.freq === "MONTHLY" || form.freq === "YEARLY") && form.monthlyMode === "none" && form.byMonthDay.length) form.monthlyMode = "dayOfMonth";
  return form;
}

export function buildRule(form: RepeatForm): string {
  const parts: string[] = [`FREQ=${form.freq}`];
  if (form.interval > 1) parts.push(`INTERVAL=${form.interval}`);
  if (form.freq === "WEEKLY" && form.byDay.length) {
    const ordered = WEEKDAY_CODES.filter((d) => form.byDay.includes(d));
    parts.push(`BYDAY=${ordered.join(",")}`);
  }
  if (form.freq === "MONTHLY" || form.freq === "YEARLY") {
    if (form.freq === "YEARLY" && form.byMonth.length) parts.push(`BYMONTH=${[...form.byMonth].sort((a, b) => a - b).join(",")}`);
    if (form.monthlyMode === "dayOfMonth" && form.byMonthDay.length) parts.push(`BYMONTHDAY=${form.byMonthDay.join(",")}`);
    if (form.monthlyMode === "nthWeekday") parts.push(`BYDAY=${form.nth}${form.nthWeekday}`);
  }
  for (const [k, v] of form.extra) {
    if (k === "BYSETPOS" && form.monthlyMode === "nthWeekday") continue;
    parts.push(`${k}=${v}`);
  }
  if (form.end.kind === "count") parts.push(`COUNT=${form.end.count}`);
  if (form.end.kind === "until") parts.push(`UNTIL=${form.end.date.replaceAll("-", "")}T235959Z`);
  return parts.join(";");
}

const UNIT: Record<Freq, [string, string]> = {
  MINUTELY: ["minute", "minutes"],
  HOURLY: ["hour", "hours"],
  DAILY: ["day", "days"],
  WEEKLY: ["week", "weeks"],
  MONTHLY: ["month", "months"],
  YEARLY: ["year", "years"],
};
const DAY_NAMES: Record<WeekdayCode, string> = {
  SU: "Sunday",
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
};
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function ordinal(n: number): string {
  if (n === -1) return "last";
  const words: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth" };
  return words[n] ?? `${n}th`;
}

function dayOfMonthText(n: number): string {
  if (n === -1) return "the last day";
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `the ${n}${suffix}`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Plain-English summary, e.g. "Every 2 weeks on Monday and Friday, from completion, based on due date". */
export function summarizeRepeat(repeat: RepeatRule): string {
  const f = parseRule(repeat.rule);
  const [one, many] = UNIT[f.freq] ?? ["time", "times"];
  let text = f.interval === 1 ? `Every ${one}` : `Every ${f.interval} ${many}`;
  if (f.freq === "WEEKLY" && f.byDay.length) text += ` on ${list(WEEKDAY_CODES.filter((d) => f.byDay.includes(d)).map((d) => DAY_NAMES[d]))}`;
  if (f.freq === "YEARLY" && f.byMonth.length) text += ` in ${list(f.byMonth.map((m) => MONTH_NAMES[m - 1] ?? ""))}`;
  if ((f.freq === "MONTHLY" || f.freq === "YEARLY") && f.monthlyMode === "dayOfMonth") text += ` on ${list(f.byMonthDay.map(dayOfMonthText))}`;
  if ((f.freq === "MONTHLY" || f.freq === "YEARLY") && f.monthlyMode === "nthWeekday") text += ` on the ${ordinal(f.nth)} ${DAY_NAMES[f.nthWeekday]}`;
  if (f.end.kind === "count") text += `, ${f.end.count} ${f.end.count === 1 ? "time" : "times"}`;
  if (f.end.kind === "until") text += `, until ${f.end.date}`;
  const anchor = repeat.anchorDate === "defer" ? "defer date" : repeat.anchorDate === "planned" ? "planned date" : "due date";
  text += repeat.scheduleType === "fromCompletion" ? `, after completion (${anchor})` : `, on a fixed schedule (${anchor})`;
  if (repeat.catchUpAutomatically && repeat.scheduleType === "regularly") text += ", catching up automatically";
  return text;
}

export function defaultRepeat(): RepeatRule {
  return { rule: "FREQ=WEEKLY", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: false };
}
