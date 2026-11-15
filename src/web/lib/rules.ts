// Perspective rule model for the editor (docs/spec.md §4.1). Rules keep OmniFocus's JSON keys so
// imported rules round-trip; unknown keys are preserved untouched.
export type Rule = Record<string, unknown>;

export const BOOLEAN_RULES: Array<{ key: string; label: string }> = [
  { key: "actionHasDueDate", label: "Has a due date" },
  { key: "actionHasDeferDate", label: "Has a defer date" },
  { key: "actionHasPlannedDate", label: "Has a planned date" },
  { key: "actionHasDuration", label: "Has a duration" },
  { key: "actionIsProject", label: "Is a project" },
  { key: "actionIsGroup", label: "Is an action group" },
  { key: "actionIsProjectOrGroup", label: "Is a project or action group" },
  { key: "actionRepeats", label: "Repeats" },
  { key: "actionIsLeaf", label: "Has no children" },
  { key: "actionIsUntagged", label: "Is untagged" },
  { key: "actionHasNoProject", label: "Has no project" },
  { key: "actionIsInSingleActionsList", label: "Is in a single actions list" },
];

export type RuleKind =
  | "group"
  | "availability"
  | "status"
  | "boolean"
  | "withinDuration"
  | "date"
  | "tagStatus"
  | "anyTags"
  | "allTags"
  | "projectStatus"
  | "focus"
  | "search"
  | "unknown";

export const RULE_KIND_LABELS: Array<{ kind: Exclude<RuleKind, "unknown">; label: string }> = [
  { kind: "availability", label: "Availability" },
  { kind: "status", label: "Status (due / flagged)" },
  { kind: "boolean", label: "Item property" },
  { kind: "withinDuration", label: "Duration at most" },
  { kind: "date", label: "Date" },
  { kind: "tagStatus", label: "Has a tag with status" },
  { kind: "anyTags", label: "Tagged with any of" },
  { kind: "allTags", label: "Tagged with all of" },
  { kind: "projectStatus", label: "Project status" },
  { kind: "focus", label: "Within projects / folders" },
  { kind: "search", label: "Matches search" },
  { kind: "group", label: "Group of rules" },
];

export const DATE_FIELDS = ["due", "defer", "planned", "completed", "dropped", "added", "changed"] as const;
export const DATE_CONDITIONS = [
  { key: "actionDateIsToday", label: "is today" },
  { key: "actionDateIsYesterday", label: "is yesterday" },
  { key: "actionDateIsTomorrow", label: "is tomorrow" },
  { key: "actionDateIsInThePast", label: "is in the past" },
  { key: "actionDateIsInTheNext", label: "is in the next" },
  { key: "actionDateIsOnDateSpec", label: "is on" },
  { key: "between", label: "is between" },
] as const;
export type DateCondition = (typeof DATE_CONDITIONS)[number]["key"];

export function isDisabled(rule: Rule): boolean {
  return "disabledRule" in rule && typeof rule.disabledRule === "object" && rule.disabledRule !== null;
}

/** The rule itself (unwrapping a `{disabledRule}` wrapper). */
export function inner(rule: Rule): Rule {
  return isDisabled(rule) ? (rule.disabledRule as Rule) : rule;
}

export function setEnabled(rule: Rule, enabled: boolean): Rule {
  if (enabled) return inner(rule);
  return isDisabled(rule) ? rule : { disabledRule: rule };
}

/** Replaces the inner rule, keeping the disabled wrapper if present. */
export function replaceInner(rule: Rule, next: Rule): Rule {
  return isDisabled(rule) ? { disabledRule: next } : next;
}

export function ruleKind(rule: Rule): RuleKind {
  const r = inner(rule);
  if ("aggregateType" in r) return "group";
  if ("actionAvailability" in r) return "availability";
  if ("actionStatus" in r) return "status";
  if ("actionWithinDuration" in r) return "withinDuration";
  if ("actionDateField" in r) return "date";
  if ("actionHasTagWithStatus" in r) return "tagStatus";
  if ("actionHasAnyOfTags" in r) return "anyTags";
  if ("actionHasAllOfTags" in r) return "allTags";
  if ("actionHasProjectWithStatus" in r) return "projectStatus";
  if ("actionWithinFocus" in r) return "focus";
  if ("actionMatchingSearch" in r) return "search";
  const keys = Object.keys(r);
  if (keys.length === 1 && BOOLEAN_RULES.some((b) => b.key === keys[0])) return "boolean";
  return "unknown";
}

export function defaultRule(kind: Exclude<RuleKind, "unknown">): Rule {
  switch (kind) {
    case "group":
      return { aggregateType: "any", aggregateRules: [] };
    case "availability":
      return { actionAvailability: "available" };
    case "status":
      return { actionStatus: "flagged" };
    case "boolean":
      return { actionHasDueDate: true };
    case "withinDuration":
      return { actionWithinDuration: 30 };
    case "date":
      return { actionDateField: "due", actionDateIsToday: true };
    case "tagStatus":
      return { actionHasTagWithStatus: "active" };
    case "anyTags":
      return { actionHasAnyOfTags: [] };
    case "allTags":
      return { actionHasAllOfTags: [] };
    case "projectStatus":
      return { actionHasProjectWithStatus: "active" };
    case "focus":
      return { actionWithinFocus: [] };
    case "search":
      return { actionMatchingSearch: [] };
  }
}

export function dateCondition(rule: Rule): DateCondition {
  const r = inner(rule);
  if ("actionDateIsAfterDateSpec" in r || "actionDateIsBeforeDateSpec" in r) return "between";
  for (const c of DATE_CONDITIONS) if (c.key in r) return c.key;
  return "actionDateIsToday";
}

/** Builds a date rule for `field` + `condition`, carrying over compatible parameters. */
export function buildDateRule(field: string, condition: DateCondition, previous: Rule): Rule {
  const amount = (previous.actionDateIsInThePast as { relativeBeforeAmount?: number } | undefined)?.relativeBeforeAmount ??
    (previous.actionDateIsInTheNext as { relativeAfterAmount?: number } | undefined)?.relativeAfterAmount ??
    1;
  const component =
    (previous.actionDateIsInThePast as { relativeComponent?: string } | undefined)?.relativeComponent ??
    (previous.actionDateIsInTheNext as { relativeComponent?: string } | undefined)?.relativeComponent ??
    "week";
  const base: Rule = { actionDateField: field };
  switch (condition) {
    case "actionDateIsInThePast":
      return { ...base, actionDateIsInThePast: { relativeBeforeAmount: amount, relativeComponent: component } };
    case "actionDateIsInTheNext":
      return { ...base, actionDateIsInTheNext: { relativeAfterAmount: amount, relativeComponent: component } };
    case "actionDateIsOnDateSpec":
      return { ...base, actionDateIsOnDateSpec: { dynamic: (previous.actionDateIsOnDateSpec as { dynamic?: string } | undefined)?.dynamic ?? "today" } };
    case "between":
      return {
        ...base,
        actionDateIsAfterDateSpec: { dynamic: (previous.actionDateIsAfterDateSpec as { dynamic?: string } | undefined)?.dynamic ?? "today" },
        actionDateIsBeforeDateSpec: { dynamic: (previous.actionDateIsBeforeDateSpec as { dynamic?: string } | undefined)?.dynamic ?? "next week" },
      };
    default:
      return { ...base, [condition]: true };
  }
}

/** Immutable update of the rule at `path` (indexes through nested `aggregateRules`). */
export function updateAt(rules: Rule[], path: number[], fn: (rule: Rule) => Rule | null): Rule[] {
  const [head, ...rest] = path;
  if (head === undefined) return rules;
  const out: Rule[] = [];
  rules.forEach((rule, i) => {
    if (i !== head) {
      out.push(rule);
      return;
    }
    if (rest.length === 0) {
      const next = fn(rule);
      if (next) out.push(next);
      return;
    }
    const r = inner(rule);
    const children = Array.isArray(r.aggregateRules) ? (r.aggregateRules as Rule[]) : [];
    out.push(replaceInner(rule, { ...r, aggregateRules: updateAt(children, rest, fn) }));
  });
  return out;
}

export function moveAt(rules: Rule[], path: number[], delta: -1 | 1): Rule[] {
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1] ?? 0;
  const reorder = (list: Rule[]) => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return list;
    const copy = [...list];
    const [item] = copy.splice(index, 1);
    if (item) copy.splice(target, 0, item);
    return copy;
  };
  if (parentPath.length === 0) return reorder(rules);
  return updateAt(rules, parentPath, (group) => {
    const r = inner(group);
    return replaceInner(group, { ...r, aggregateRules: reorder(Array.isArray(r.aggregateRules) ? (r.aggregateRules as Rule[]) : []) });
  });
}
