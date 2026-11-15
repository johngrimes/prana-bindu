// Repeat advancement (docs/spec.md §1.4 "Repeat on completion"). All RRULE arithmetic runs on naive
// wall-clock times in the user's zone so a 09:00 repeat stays at 09:00 across DST changes.
import { createRequire } from "node:module";
import type * as RRuleModule from "rrule";
import type { Options } from "rrule";
import { dateValueToNaive, instantToNaive, isFloating, naiveToDateValue } from "../shared/datetime.js";
import { DomainError } from "./errors.js";

// rrule ships CommonJS without an `exports` map; load it through require for reliable named access.
const { RRule } = createRequire(import.meta.url)("rrule") as typeof RRuleModule;

export type AnchorField = "due" | "defer" | "planned";

export interface RepeatSpec {
  rule: string;
  scheduleType: "regularly" | "fromCompletion";
  anchorDate: AnchorField;
  catchUpAutomatically: boolean;
}

export interface RepeatDates {
  deferDate: string | null;
  plannedDate: string | null;
  dueDate: string | null;
}

export interface Advance {
  dates: RepeatDates;
  /** Rule after advancement (COUNT is decremented). */
  rule: string;
}

const FIELD_KEY: Record<AnchorField, keyof RepeatDates> = {
  due: "dueDate",
  defer: "deferDate",
  planned: "plannedDate",
};

/** Parses and validates an RRULE body (without "RRULE:"). Throws a validation DomainError. */
export function parseRule(rule: string): Partial<Options> {
  const body = rule.replace(/^RRULE:/i, "").trim();
  let options: Partial<Options>;
  try {
    options = RRule.parseString(body);
  } catch (e) {
    throw new DomainError("validation_error", `Invalid repeat rule: ${(e as Error).message}`);
  }
  if (options.freq === undefined) throw new DomainError("validation_error", "Repeat rule needs FREQ");
  return options;
}

/** `UNTIL` as naive wall-clock ms: a `…Z` UNTIL is an instant, otherwise it is already wall-clock. */
function untilNaive(rule: string, until: Date, timeZone: string): number {
  return /UNTIL=\d{8}(T\d{6})?Z/i.test(rule) ? instantToNaive(until.getTime(), timeZone) : until.getTime();
}

/**
 * Computes the next occurrence's dates for a repeating task completed (or skipped) at `completedAt`.
 * Returns null when the series is exhausted (COUNT used up or past UNTIL).
 */
export function advanceRepeat(
  spec: RepeatSpec,
  dates: RepeatDates,
  opts: { completedAt: number; now: number; timeZone: string },
): Advance | null {
  const { timeZone } = opts;
  const parsed = parseRule(spec.rule);
  const count = parsed.count ?? null;
  if (count !== null && count <= 1) return null;
  const nextRule = count !== null ? spec.rule.replace(/COUNT=\d+/i, `COUNT=${count - 1}`) : spec.rule;

  const anchorValue =
    dates[FIELD_KEY[spec.anchorDate]] ?? dates.dueDate ?? dates.deferDate ?? dates.plannedDate ?? null;
  const anchorNaive = anchorValue === null ? null : dateValueToNaive(anchorValue, timeZone);

  const options: Partial<Options> = { ...parsed, count: null, tzid: null };
  const until = parsed.until ? untilNaive(spec.rule, parsed.until, timeZone) : null;
  options.until = until === null ? null : new Date(until);

  let next: number | null;
  if (spec.scheduleType === "fromCompletion") {
    const completionNaive = instantToNaive(opts.completedAt, timeZone);
    let start = completionNaive;
    if (anchorNaive !== null) {
      // Completion day at the anchor's time of day.
      const dayStart = Math.floor(completionNaive / 86_400_000) * 86_400_000;
      start = dayStart + (((anchorNaive % 86_400_000) + 86_400_000) % 86_400_000);
    }
    const rr = new RRule({ ...options, dtstart: new Date(start) });
    next = rr.after(new Date(start), false)?.getTime() ?? null;
  } else {
    const start = anchorNaive ?? instantToNaive(opts.completedAt, timeZone);
    const rr = new RRule({ ...options, dtstart: new Date(start) });
    const from = spec.catchUpAutomatically ? Math.max(start, instantToNaive(opts.now, timeZone)) : start;
    next = rr.after(new Date(from), false)?.getTime() ?? null;
  }
  if (next === null) return null;
  if (anchorNaive === null) return { dates: { ...dates }, rule: nextRule };

  const delta = next - anchorNaive;
  const shift = (v: string | null): string | null => {
    if (v === null) return null;
    return naiveToDateValue(dateValueToNaive(v, timeZone) + delta, isFloating(v), timeZone);
  };
  return {
    dates: { deferDate: shift(dates.deferDate), plannedDate: shift(dates.plannedDate), dueDate: shift(dates.dueDate) },
    rule: nextRule,
  };
}
