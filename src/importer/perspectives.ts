import type { perspectives } from "../db/schema.js";
import type { BuiltinPerspectiveId } from "../domain/builtins.js";
import type { Grouping, PerspectivePresentation, Sorting } from "../shared/schemas.js";
import type { PlistValue } from "./plist.js";
import type { z } from "zod";

type PerspectiveRow = typeof perspectives.$inferInsert;
type Dict = { [key: string]: PlistValue };
type Presentation = z.infer<typeof PerspectivePresentation>;

export const RANK_STEP = 65536;

const BUILTIN_BY_STEM: Record<string, BuiltinPerspectiveId | null> = {
  ProcessInbox: "inbox",
  ProcessProjects: "projects",
  ProcessContexts: "tags",
  ProcessTags: "tags",
  ProcessForecast: "forecast",
  ProcessDueSoon: "forecast",
  ProcessFlagged: "flagged",
  ProcessFlaggedItems: "flagged",
  ProcessReview: "review",
  ProcessCompleted: "completed",
  ProcessRecentChanges: "changed",
  ProcessNearby: null,
};

/**
 * Maps an OmniFocus built-in perspective id (optionally version-suffixed, e.g. `ProcessTags.v3`) to the
 * prana-bindu built-in id. Returns `undefined` for non-built-in ids and `null` for built-ins prana-bindu lacks.
 */
export function builtinFor(ofId: string): BuiltinPerspectiveId | null | undefined {
  const stem = ofId.replace(/\.v\d+$/, "");
  return Object.hasOwn(BUILTIN_BY_STEM, stem) ? BUILTIN_BY_STEM[stem] : undefined;
}

const GROUPING: Record<string, z.infer<typeof Grouping>> = {
  none: "none",
  context: "tag",
  tag: "tag",
  tags: "tagsCombined",
  project: "project",
  folder: "folder",
  due: "due",
  start: "defer",
  defer: "defer",
  planned: "planned",
  completed: "completed",
  dropped: "dropped",
  added: "added",
  modified: "changed",
  changed: "changed",
  flagged: "flagged",
};

const SORTING: Record<string, z.infer<typeof Sorting>> = {
  none: "manual",
  manual: "manual",
  project: "manual",
  due: "due",
  "due-and-flagged": "due",
  start: "defer",
  defer: "defer",
  planned: "planned",
  completed: "completed",
  added: "added",
  modified: "changed",
  changed: "changed",
  flagged: "flagged",
  duration: "duration",
  "estimated-minutes": "duration",
  name: "name",
  title: "name",
};

/** Rule keys prana-bindu understands (docs/spec.md §4.1); anything else is kept and reported. */
const KNOWN_RULE_KEYS: Record<string, true> = Object.fromEntries(
  [
    "actionAvailability",
    "actionStatus",
    "actionHasDueDate",
    "actionHasDeferDate",
    "actionHasPlannedDate",
    "actionHasDuration",
    "actionWithinDuration",
    "actionIsProject",
    "actionIsGroup",
    "actionIsProjectOrGroup",
    "actionRepeats",
    "actionIsLeaf",
    "actionIsUntagged",
    "actionHasNoProject",
    "actionIsInSingleActionsList",
    "actionDateField",
    "actionDateIsToday",
    "actionDateIsYesterday",
    "actionDateIsTomorrow",
    "actionDateIsInThePast",
    "actionDateIsInTheNext",
    "actionDateIsOnDateSpec",
    "actionDateIsAfterDateSpec",
    "actionDateIsBeforeDateSpec",
    "actionHasTagWithStatus",
    "actionHasAnyOfTags",
    "actionHasAllOfTags",
    "actionHasProjectWithStatus",
    "actionWithinFocus",
    "actionMatchingSearch",
    "aggregateType",
    "aggregateRules",
    "disabledRule",
  ].map((k) => [k, true]),
);

const isDict = (v: PlistValue | undefined): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

function collectUnknownRuleKeys(rules: unknown[], out: Set<string>): void {
  for (const rule of rules) {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) continue;
    for (const [key, value] of Object.entries(rule)) {
      if (!Object.hasOwn(KNOWN_RULE_KEYS, key)) out.add(key);
      if (key === "aggregateRules" && Array.isArray(value)) collectUnknownRuleKeys(value, out);
      if (key === "disabledRule") collectUnknownRuleKeys([value], out);
    }
  }
}

/** `"r g b [a]"` floats 0–1 → `#rrggbb`. */
export function tintToHex(tint: PlistValue | undefined): string | null {
  if (typeof tint !== "string") return null;
  const parts = tint.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  return `#${parts
    .slice(0, 3)
    .map((n) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function presentationOf(viewState: PlistValue | undefined): Presentation {
  const vs = isDict(viewState) ? viewState : {};
  const mode = vs.viewMode === "context" ? "context" : "project";
  const modeStates = isDict(vs.viewModeState) ? vs.viewModeState : {};
  const state = isDict(modeStates[mode]) ? (modeStates[mode] as Dict) : {};
  const collation = typeof state.collation === "string" ? state.collation : "none";
  const sort = typeof state.sort === "string" ? state.sort : "none";
  const sidebarFilter = typeof state.sidebarFilter === "string" ? state.sidebarFilter : "";
  const sidebar = /context|tag/.test(sidebarFilter)
    ? "tags"
    : /project|folder/.test(sidebarFilter)
      ? "projects"
      : mode === "context"
        ? "tags"
        : "projects";
  return {
    layout: mode === "context" ? "flat" : "projects",
    grouping: GROUPING[collation] ?? "none",
    sorting: SORTING[sort] ?? "manual",
    sidebar,
  };
}

/** Best-effort rules for OF1/2-era custom perspectives that only carry legacy viewState filters. */
function legacyRules(viewState: PlistValue | undefined): Record<string, unknown>[] {
  const vs = isDict(viewState) ? viewState : {};
  const modeStates = isDict(vs.viewModeState) ? vs.viewModeState : {};
  const mode = vs.viewMode === "context" ? "context" : "project";
  const state = isDict(modeStates[mode]) ? (modeStates[mode] as Dict) : {};
  const rules: Record<string, unknown>[] = [];
  const availability: Record<string, string> = {
    incomplete: "remaining",
    remaining: "remaining",
    complete: "completed",
    completed: "completed",
    available: "available",
    "first-available": "firstAvailable",
  };
  const completion = typeof state.actionCompletionFilter === "string" ? availability[state.actionCompletionFilter] : undefined;
  if (completion) rules.push({ actionAvailability: completion });
  if (state.actionFlaggedFilter === "flagged") rules.push({ actionStatus: "flagged" });
  if (state.actionFlaggedFilter === "due") rules.push({ actionStatus: "due" });
  return rules;
}

const CONSUMED_KEYS = ["name", "filterRules", "topLevelFilterAggregation", "tintColor"];

export interface CustomPerspectiveInput {
  id: string;
  plist: PlistValue;
  added: string;
  modified: string;
  /** Raw `icon-attachment` element XML when non-empty. */
  iconAttachment: string | null;
}

/** Maps one OF4 or legacy custom perspective plist to a perspectives row (rank/favorite set by the caller). */
export function customPerspectiveRow(input: CustomPerspectiveInput, warn: (msg: string) => void): PerspectiveRow {
  const plist = isDict(input.plist) ? input.plist : {};
  const name = typeof plist.name === "string" && plist.name.trim() ? plist.name : "Untitled Perspective";
  let rules: unknown[] = [];
  const raw = plist.filterRules;
  if (raw !== undefined) {
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
    }
    if (Array.isArray(parsed)) rules = parsed;
    else warn(`Perspective "${name}" has unreadable filter rules; imported without rules.`);
  } else {
    rules = legacyRules(plist.viewState);
    warn(`Perspective "${name}" uses the legacy OmniFocus 2 format; its rules were derived best-effort from its view state.`);
  }
  const unknown = new Set<string>();
  collectUnknownRuleKeys(rules, unknown);
  if (unknown.size > 0) {
    warn(`Perspective "${name}" has unsupported rule types kept as-is: ${[...unknown].sort().join(", ")}.`);
  }
  const agg = plist.topLevelFilterAggregation;
  const extras: Dict = {};
  for (const [k, v] of Object.entries(plist)) if (!CONSUMED_KEYS.includes(k)) extras[k] = v;
  if (input.iconAttachment) extras.iconAttachment = input.iconAttachment;
  return {
    id: input.id,
    builtin: false,
    name,
    icon: "list",
    color: tintToHex(plist.tintColor),
    favorite: false,
    rank: 0,
    aggregation: agg === "any" || agg === "none" ? agg : "all",
    rulesJson: JSON.stringify(rules),
    presentationJson: JSON.stringify(presentationOf(plist.viewState)),
    viewOptionsJson: "{}",
    importExtrasJson: Object.keys(extras).length > 0 ? JSON.stringify(extras) : null,
    added: input.added,
    modified: input.modified,
  };
}
