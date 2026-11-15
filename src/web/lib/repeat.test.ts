import { describe, expect, it } from "vitest";
import { buildRule, parseRule, summarizeRepeat } from "./repeat";

describe("parseRule / buildRule", () => {
  it("round-trips weekly rules with weekdays in calendar order", () => {
    const form = parseRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,MO");
    expect(form).toMatchObject({ freq: "WEEKLY", interval: 2, byDay: ["FR", "MO"] });
    expect(buildRule(form)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR");
  });

  it("reads the nth weekday from either BYDAY prefix or BYSETPOS", () => {
    expect(parseRule("FREQ=MONTHLY;BYDAY=2TU")).toMatchObject({ monthlyMode: "nthWeekday", nth: 2, nthWeekday: "TU" });
    expect(parseRule("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1")).toMatchObject({ monthlyMode: "nthWeekday", nth: -1, nthWeekday: "FR" });
    expect(buildRule(parseRule("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1"))).toBe("FREQ=MONTHLY;BYDAY=-1FR");
  });

  it("keeps unknown parts such as WKST", () => {
    expect(buildRule(parseRule("FREQ=WEEKLY;WKST=SU;BYDAY=MO"))).toBe("FREQ=WEEKLY;BYDAY=MO;WKST=SU");
  });

  it("parses and builds end conditions", () => {
    expect(parseRule("FREQ=DAILY;COUNT=3").end).toEqual({ kind: "count", count: 3 });
    const until = parseRule("FREQ=DAILY;UNTIL=20261231T235959Z");
    expect(until.end).toEqual({ kind: "until", date: "2026-12-31" });
    expect(buildRule(until)).toBe("FREQ=DAILY;UNTIL=20261231T235959Z");
  });

  it("drops weekly weekdays when the frequency changes to monthly by day of month", () => {
    const form = { ...parseRule("FREQ=WEEKLY;BYDAY=MO"), freq: "MONTHLY" as const, byDay: [], monthlyMode: "dayOfMonth" as const, byMonthDay: [15] };
    expect(buildRule(form)).toBe("FREQ=MONTHLY;BYMONTHDAY=15");
  });
});

describe("summarizeRepeat", () => {
  it("describes schedule, anchor and end", () => {
    expect(
      summarizeRepeat({ rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=4", scheduleType: "fromCompletion", anchorDate: "defer", catchUpAutomatically: false }),
    ).toBe("Every 2 weeks on Monday and Friday, 4 times, after completion (defer date)");
    expect(summarizeRepeat({ rule: "FREQ=MONTHLY;BYMONTHDAY=-1", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: true })).toBe(
      "Every month on the last day, on a fixed schedule (due date), catching up automatically",
    );
  });
});
