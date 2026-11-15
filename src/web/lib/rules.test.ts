import { describe, expect, it } from "vitest";
import { buildDateRule, dateCondition, moveAt, ruleKind, setEnabled, updateAt, type Rule } from "./rules";

describe("rule kinds", () => {
  it("classifies rule keys, including disabled wrappers", () => {
    expect(ruleKind({ actionAvailability: "available" })).toBe("availability");
    expect(ruleKind({ actionHasDueDate: true })).toBe("boolean");
    expect(ruleKind({ disabledRule: { actionHasAnyOfTags: ["t1"] } })).toBe("anyTags");
    expect(ruleKind({ aggregateType: "any", aggregateRules: [] })).toBe("group");
    expect(ruleKind({ someFutureRule: 1 })).toBe("unknown");
  });

  it("toggles the disabled wrapper without losing the rule", () => {
    const rule = { actionStatus: "flagged" };
    const off = setEnabled(rule, false);
    expect(off).toEqual({ disabledRule: rule });
    expect(setEnabled(off, false)).toBe(off);
    expect(setEnabled(off, true)).toEqual(rule);
  });
});

describe("date rules", () => {
  it("carries the relative amount across past/next and keeps the field", () => {
    const past = buildDateRule("due", "actionDateIsInThePast", { actionDateIsInTheNext: { relativeAfterAmount: 3, relativeComponent: "day" } });
    expect(past).toEqual({ actionDateField: "due", actionDateIsInThePast: { relativeBeforeAmount: 3, relativeComponent: "day" } });
    expect(dateCondition(past)).toBe("actionDateIsInThePast");
  });

  it("builds a between range from two date specs", () => {
    const between = buildDateRule("added", "between", {});
    expect(between).toMatchObject({ actionDateField: "added", actionDateIsAfterDateSpec: { dynamic: "today" } });
    expect(dateCondition(between)).toBe("between");
  });
});

describe("tree edits", () => {
  const rules: Rule[] = [
    { actionAvailability: "available" },
    { disabledRule: { aggregateType: "any", aggregateRules: [{ actionHasDueDate: true }, { actionStatus: "flagged" }] } },
  ];

  it("updates a rule nested inside a disabled group", () => {
    const next = updateAt(rules, [1, 0], () => ({ actionHasDeferDate: true }));
    expect(next[1]).toEqual({ disabledRule: { aggregateType: "any", aggregateRules: [{ actionHasDeferDate: true }, { actionStatus: "flagged" }] } });
    expect(rules[1]).toEqual({ disabledRule: { aggregateType: "any", aggregateRules: [{ actionHasDueDate: true }, { actionStatus: "flagged" }] } });
  });

  it("removes a rule when the updater returns null", () => {
    expect(updateAt(rules, [0], () => null)).toHaveLength(1);
  });

  it("reorders within a nested group and ignores moves past the ends", () => {
    const moved = moveAt(rules, [1, 1], -1);
    expect(moved[1]).toEqual({ disabledRule: { aggregateType: "any", aggregateRules: [{ actionStatus: "flagged" }, { actionHasDueDate: true }] } });
    expect(moveAt(rules, [0], -1)).toEqual(rules);
  });
});
