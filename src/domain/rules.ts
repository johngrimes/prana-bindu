// Custom perspective rule evaluator (docs/spec.md §4.1). Rules use OmniFocus' JSON keys so imported
// perspectives round-trip; unknown rules evaluate as true.
import {
  addDaysToKey,
  addToNaive,
  dayKeyOfNaive,
  dayStartInstant,
  instantToNaive,
  isDayKey,
  localDayKey,
  normaliseIsoDate,
  dateValueToInstant,
} from "../shared/datetime.js";
import { parseDate } from "../shared/nlparse.js";
import type { Settings } from "../shared/schemas.js";
import type { Derived, TaskState } from "./derive.js";
import type { Snapshot, TaskRow } from "./snapshot.js";

export type Aggregation = "all" | "any" | "none";
type Rule = Record<string, unknown>;
type Component = "hour" | "day" | "week" | "month" | "year";

export interface RuleContext {
  snap: Snapshot;
  d: Derived;
  settings: Settings;
}

const BOOLEAN_RULES: Record<string, (row: TaskRow, s: TaskState, ctx: RuleContext) => boolean> = {
  actionHasDueDate: (_r, s) => s.dueMs !== null,
  actionHasDeferDate: (_r, s) => s.deferMs !== null,
  actionHasPlannedDate: (_r, s) => s.plannedMs !== null,
  actionHasDuration: (r) => r.estimatedMinutes !== null && r.estimatedMinutes > 0,
  actionIsProject: (r, _s, c) => c.snap.isProject(r.id),
  actionIsGroup: (r, _s, c) => !c.snap.isProject(r.id) && c.snap.childrenOf(r.id).length > 0,
  actionIsProjectOrGroup: (r, _s, c) => c.snap.isProject(r.id) || c.snap.childrenOf(r.id).length > 0,
  actionRepeats: (r) => r.repeatRule !== null,
  actionIsLeaf: (r, _s, c) => c.snap.childrenOf(r.id).length === 0,
  actionIsUntagged: (r, _s, c) => (c.snap.taskTags.get(r.id) ?? []).length === 0,
  actionHasNoProject: (_r, s) => s.projectId === null,
  actionIsInSingleActionsList: (r, s, c) =>
    s.projectId !== null && s.projectId !== r.id && c.snap.projects.get(s.projectId)?.type === "singleActions",
};

export const KNOWN_RULE_KEYS = new Set([
  ...Object.keys(BOOLEAN_RULES),
  "actionAvailability",
  "actionStatus",
  "actionWithinDuration",
  "actionDateField",
  "actionHasTagWithStatus",
  "actionHasAnyOfTags",
  "actionHasAllOfTags",
  "actionHasProjectWithStatus",
  "actionWithinFocus",
  "actionMatchingSearch",
  "aggregateType",
  "disabledRule",
]);

const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : [];

/** Evaluates a rule list against one task. An empty (or all-disabled) list matches. */
export function evaluateRules(rules: readonly Rule[], aggregation: Aggregation, row: TaskRow, ctx: RuleContext): boolean {
  const active = rules.filter((r) => !("disabledRule" in r));
  if (active.length === 0) return true;
  switch (aggregation) {
    case "all":
      return active.every((r) => evaluateRule(r, row, ctx));
    case "any":
      return active.some((r) => evaluateRule(r, row, ctx));
    case "none":
      return !active.some((r) => evaluateRule(r, row, ctx));
  }
}

function aggregationOf(v: unknown): Aggregation {
  return v === "any" || v === "none" ? v : "all";
}

export function evaluateRule(rule: Rule, row: TaskRow, ctx: RuleContext): boolean {
  const s = ctx.d.tasks.get(row.id);
  if (!s) return false;
  if ("aggregateType" in rule) {
    const children = Array.isArray(rule.aggregateRules) ? (rule.aggregateRules as Rule[]) : [];
    return evaluateRules(children, aggregationOf(rule.aggregateType), row, ctx);
  }
  if ("actionDateField" in rule) return evaluateDateRule(rule, row, s, ctx);
  for (const [key, value] of Object.entries(rule)) {
    const bool = BOOLEAN_RULES[key];
    if (bool) return bool(row, s, ctx) === (value !== false);
    switch (key) {
      case "actionAvailability":
        switch (value) {
          case "firstAvailable":
            return s.firstAvailable;
          case "available":
            return s.available;
          case "remaining":
            return s.remaining;
          case "completed":
            return s.effectiveCompleted;
          case "dropped":
            return s.effectiveDropped;
          default:
            return true;
        }
      case "actionStatus":
        if (value === "due") return s.overdue || s.dueSoon;
        if (value === "flagged") return s.effectiveFlagged;
        return true;
      case "actionWithinDuration":
        return typeof value === "number" && row.estimatedMinutes !== null && row.estimatedMinutes <= value;
      case "actionHasTagWithStatus":
        return (ctx.snap.taskTags.get(row.id) ?? []).some((l) => {
          const ts = ctx.d.tags.get(l.tagId);
          if (!ts) return false;
          switch (value) {
            case "remaining":
              return ts.effectiveStatus !== "dropped";
            case "stalled":
              return ts.stalled;
            default:
              return ts.effectiveStatus === value;
          }
        });
      case "actionHasAnyOfTags": {
        const want = asArray(value);
        return ctx.snap.tagIdsOf(row.id).some((t) => want.includes(t));
      }
      case "actionHasAllOfTags": {
        const have = new Set(ctx.snap.tagIdsOf(row.id));
        return asArray(value).every((t) => have.has(t));
      }
      case "actionHasProjectWithStatus": {
        if (s.projectId === null) return false;
        const ps = ctx.d.projects.get(s.projectId);
        if (!ps) return false;
        switch (value) {
          case "remaining":
            return ps.effectiveStatus === "active" || ps.effectiveStatus === "onHold";
          case "stalled":
            return ps.stalled;
          case "pending":
            return ps.pending;
          default:
            return ps.effectiveStatus === value;
        }
      }
      case "actionWithinFocus": {
        const ids = asArray(value);
        if (ids.includes(row.id)) return true;
        if (s.projectId === null) return false;
        if (ids.includes(s.projectId)) return true;
        return (ctx.d.projects.get(s.projectId)?.folderIds ?? []).some((f) => ids.includes(f));
      }
      case "actionMatchingSearch": {
        const hay = `${row.name}\n${row.note}`.toLowerCase();
        return asArray(value).every((term) => hay.includes(term.toLowerCase()));
      }
      default:
        break;
    }
  }
  // Unknown rule: preserved and treated as matching.
  return true;
}

function dateFieldMs(field: unknown, row: TaskRow, s: TaskState, ctx: RuleContext): number | null {
  const fixed = (v: string | null): number | null => (v === null ? null : dateValueToInstant(v, ctx.settings.timeZone));
  switch (field) {
    case "due":
      return s.dueMs;
    case "defer":
      return s.deferMs;
    case "planned":
      return s.plannedMs;
    case "completed":
      return fixed(row.completed);
    case "dropped":
      return fixed(row.dropped);
    case "added":
      return fixed(row.added);
    case "changed":
      return fixed(row.modified);
    default:
      return null;
  }
}

/** Resolves a date spec (`"YYYY-MM-DD"`, ISO date-time, natural language, or `{dynamic|date: …}`) to a day key. */
function specDayKey(spec: unknown, ctx: RuleContext): string | null {
  let text: unknown = spec;
  if (spec && typeof spec === "object") {
    const o = spec as Record<string, unknown>;
    text = o.dynamic ?? o.date ?? o.value;
  }
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (isDayKey(t)) return t;
  const iso = normaliseIsoDate(t);
  const tz = ctx.settings.timeZone;
  if (iso) return localDayKey(dateValueToInstant(iso, tz), tz);
  const parsed = parseDate(t, {
    now: new Date(ctx.d.now),
    timeZone: tz,
    defaults: {
      defer: ctx.settings.defaultDeferTime,
      due: ctx.settings.defaultDueTime,
      planned: ctx.settings.defaultPlannedTime,
    },
    dateFormat: ctx.settings.dateFormat,
  });
  return parsed === null ? null : parsed.slice(0, 10);
}

function relative(v: unknown, amountKey: string): { amount: number; component: Component } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const amount = Number(o[amountKey] ?? o.amount);
  const component = (o.relativeComponent ?? o.component) as Component;
  if (!Number.isFinite(amount) || !["hour", "day", "week", "month", "year"].includes(component)) return null;
  return { amount, component };
}

function evaluateDateRule(rule: Rule, row: TaskRow, s: TaskState, ctx: RuleContext): boolean {
  const ms = dateFieldMs(rule.actionDateField, row, s, ctx);
  if (ms === null) return false;
  const tz = ctx.settings.timeZone;
  const { now, todayKey } = ctx.d;
  const key = localDayKey(ms, tz);
  if (rule.actionDateIsToday) return key === todayKey;
  if (rule.actionDateIsYesterday) return key === addDaysToKey(todayKey, -1);
  if (rule.actionDateIsTomorrow) return key === addDaysToKey(todayKey, 1);
  if ("actionDateIsInThePast" in rule) {
    const r = relative(rule.actionDateIsInThePast, "relativeBeforeAmount");
    if (!r) return true;
    if (r.component === "hour") return ms <= now && ms >= now - r.amount * 3_600_000;
    const startKey = dayKeyOfNaive(addToNaive(instantToNaive(now, tz), -r.amount, r.component));
    return ms <= now && ms >= dayStartInstant(startKey, tz);
  }
  if ("actionDateIsInTheNext" in rule) {
    const r = relative(rule.actionDateIsInTheNext, "relativeAfterAmount");
    if (!r) return true;
    if (r.component === "hour") return ms >= now && ms <= now + r.amount * 3_600_000;
    const endKey = dayKeyOfNaive(addToNaive(instantToNaive(now, tz), r.amount, r.component));
    return ms >= now && ms < dayStartInstant(addDaysToKey(endKey, 1), tz);
  }
  if ("actionDateIsOnDateSpec" in rule) {
    const spec = specDayKey(rule.actionDateIsOnDateSpec, ctx);
    return spec === null ? true : key === spec;
  }
  if ("actionDateIsAfterDateSpec" in rule || "actionDateIsBeforeDateSpec" in rule) {
    const after = "actionDateIsAfterDateSpec" in rule ? specDayKey(rule.actionDateIsAfterDateSpec, ctx) : null;
    const before = "actionDateIsBeforeDateSpec" in rule ? specDayKey(rule.actionDateIsBeforeDateSpec, ctx) : null;
    return (after === null || key >= after) && (before === null || key <= before);
  }
  // Field without a predicate: the date is set.
  return true;
}
