import { describe, expect, it } from "vitest";
import { dateValueToInstant, naiveToInstant, normaliseIsoDate } from "./datetime.js";
import { formatDuration, parseDate, parseDuration, type ParseDateOptions } from "./nlparse.js";

// Reference: Sat 31 Oct 2026 14:20 in Australia/Brisbane (UTC+10, no DST).
const base: ParseDateOptions = {
  now: new Date("2026-10-31T04:20:00.000Z"),
  timeZone: "Australia/Brisbane",
  defaults: { defer: "00:00", due: "09:00", planned: "09:00" },
  dateFormat: "MM/dd/yyyy",
  field: "due",
};

describe("parseDate", () => {
  const table: [string, string | null][] = [
    ["today", "2026-10-31T09:00:00.000"],
    ["tod", "2026-10-31T09:00:00.000"],
    ["tomorrow", "2026-11-01T09:00:00.000"],
    ["tom", "2026-11-01T09:00:00.000"],
    ["yesterday", "2026-10-30T09:00:00.000"],
    ["now", "2026-10-31T14:20:00.000"],
    ["+1d", "2026-11-01T09:00:00.000"],
    ["1d", "2026-11-01T09:00:00.000"],
    ["-1d", "2026-10-30T09:00:00.000"],
    ["2w", "2026-11-14T09:00:00.000"],
    ["3m", "2027-01-31T09:00:00.000"],
    ["1y", "2027-10-31T09:00:00.000"],
    ["3 days", "2026-11-03T09:00:00.000"],
    ["1w 2d", "2026-11-09T09:00:00.000"],
    ["fri", "2026-11-06T09:00:00.000"],
    ["next fri", "2026-11-06T09:00:00.000"],
    ["friday", "2026-11-06T09:00:00.000"],
    ["sat", "2026-11-07T09:00:00.000"], // strictly after today
    ["mon 9am", "2026-11-02T09:00:00.000"],
    ["5pm", "2026-10-31T17:00:00.000"],
    ["noon", "2026-10-31T12:00:00.000"],
    ["midnight", "2026-10-31T00:00:00.000"],
    ["today 3pm", "2026-10-31T15:00:00.000"],
    ["tomorrow at 8:15am", "2026-11-01T08:15:00.000"],
    ["12am", "2026-10-31T00:00:00.000"],
    ["12pm", "2026-10-31T12:00:00.000"],
    ["next week", "2026-11-07T09:00:00.000"],
    ["next month", "2026-11-30T09:00:00.000"],
    ["dec 25", "2026-12-25T09:00:00.000"],
    ["December 25th", "2026-12-25T09:00:00.000"],
    ["25 dec 2026 14:30", "2026-12-25T14:30:00.000"],
    ["12/25", "2026-12-25T09:00:00.000"],
    ["12/25/2027", "2027-12-25T09:00:00.000"],
    ["2026-12-25", "2026-12-25T09:00:00.000"],
    ["2026-12-25 7pm", "2026-12-25T19:00:00.000"],
    ["jan 3", "2027-01-03T09:00:00.000"], // passed this year → next year
    ["in 3 days", "2026-11-03T09:00:00.000"],
    ["this weekend", "2026-10-31T09:00:00.000"], // today is Saturday
    ["", null],
    ["abc", null],
    ["next", null],
    ["2026-02-30", null],
    ["13pm", null],
    ["25:00", null],
  ];
  it.each(table)("%s", (input, expected) => {
    expect(parseDate(input, base)).toBe(expected);
  });

  it("uses the field's default time", () => {
    expect(parseDate("tomorrow", { ...base, field: "defer" })).toBe("2026-11-01T00:00:00.000");
    expect(parseDate("tomorrow", { ...base, field: "planned", defaults: { ...base.defaults, planned: "07:30" } })).toBe(
      "2026-11-01T07:30:00.000",
    );
  });

  it("orders numeric dates by dateFormat", () => {
    expect(parseDate("3/4", { ...base, dateFormat: "dd/MM/yyyy" })).toBe("2027-04-03T09:00:00.000");
    expect(parseDate("3/4", base)).toBe("2027-03-04T09:00:00.000");
    expect(parseDate("2026/11/05", { ...base, dateFormat: "yyyy/MM/dd" })).toBe("2026-11-05T09:00:00.000");
  });

  it("this weekend on a weekday is the coming Saturday", () => {
    const wed = { ...base, now: new Date("2026-11-04T01:00:00.000Z") };
    expect(parseDate("this weekend", wed)).toBe("2026-11-07T09:00:00.000");
  });

  it("resolves today in the user's time zone, not UTC", () => {
    // 2026-10-31T20:00Z is already Nov 1 in Brisbane.
    expect(parseDate("today", { ...base, now: new Date("2026-10-31T20:00:00.000Z") })).toBe("2026-11-01T09:00:00.000");
    expect(parseDate("today", { ...base, now: new Date("2026-10-31T20:00:00.000Z"), timeZone: "America/New_York" })).toBe(
      "2026-10-31T09:00:00.000",
    );
  });
});

describe("parseDuration / formatDuration", () => {
  const table: [string, number | null][] = [
    ["30", 30],
    ["30m", 30],
    ["1h", 60],
    ["1h30m", 90],
    ["1h 30m", 90],
    ["1.5h", 90],
    ["90 min", 90],
    ["2d", 2880],
    ["1w", 10080],
    ["abc", null],
    ["", null],
    ["5x", null],
  ];
  it.each(table)("%s", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it("formats", () => {
    expect(formatDuration(90)).toBe("1h 30m");
    expect(formatDuration(30)).toBe("30m");
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(2880)).toBe("48h");
    expect(formatDuration(0)).toBe("0m");
  });
});

describe("datetime", () => {
  it("resolves floating times across DST transitions", () => {
    // Sydney DST starts 2026-10-04 02:00 → 03:00 (+10 → +11).
    expect(new Date(dateValueToInstant("2026-10-03T09:00:00.000", "Australia/Sydney")).toISOString()).toBe(
      "2026-10-02T23:00:00.000Z",
    );
    expect(new Date(dateValueToInstant("2026-10-05T09:00:00.000", "Australia/Sydney")).toISOString()).toBe(
      "2026-10-04T22:00:00.000Z",
    );
    // Non-existent 02:30 shifts forward to 03:30 (+11).
    expect(new Date(naiveToInstant(Date.UTC(2026, 9, 4, 2, 30), "Australia/Sydney")).toISOString()).toBe(
      "2026-10-03T16:30:00.000Z",
    );
    // Ambiguous New York 01:30 on fall-back resolves to the earlier (EDT) instant.
    expect(new Date(naiveToInstant(Date.UTC(2026, 10, 1, 1, 30), "America/New_York")).toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("normalises ISO input", () => {
    expect(normaliseIsoDate("2026-11-03T09:00")).toBe("2026-11-03T09:00:00.000");
    expect(normaliseIsoDate("2026-11-03T09:00:00+10:00")).toBe("2026-11-02T23:00:00.000Z");
    expect(normaliseIsoDate("2026-11-02T23:00:00Z")).toBe("2026-11-02T23:00:00.000Z");
    expect(normaliseIsoDate("tomorrow")).toBeNull();
  });
});
