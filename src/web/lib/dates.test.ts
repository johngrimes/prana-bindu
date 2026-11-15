import { describe, expect, it } from "vitest";
import type { Settings } from "../../shared/schemas";
import { addToWall, bumpDate, formatDateChip, formatDayOnly, formatTime, startOfWeekKey, toWall, withDay } from "./dates";

const settings: Settings = {
  timeZone: "Australia/Brisbane",
  dateFormat: "dd/MM/yyyy",
  firstWeekday: 2,
  use24HourTime: false,
  defaultDeferTime: "00:00",
  defaultDueTime: "17:00",
  defaultPlannedTime: "09:00",
  dueSoonSeconds: 172800,
  theme: "system",
  forecastTagId: null,
};
// Sat 31 Oct 2026, 10:30 in Brisbane (UTC+10, no DST).
const now = new Date("2026-10-31T00:30:00.000Z");

describe("toWall", () => {
  it("reads floating dates as written, ignoring the browser zone", () => {
    expect(toWall("2026-11-03T09:00:00.000", "America/New_York")).toEqual({ year: 2026, month: 11, day: 3, hour: 9, minute: 0 });
  });

  it("converts fixed instants into the user's time zone", () => {
    expect(toWall("2026-11-02T23:00:00.000Z", "Australia/Brisbane")).toEqual({ year: 2026, month: 11, day: 3, hour: 9, minute: 0 });
  });
});

describe("addToWall", () => {
  it("clamps month arithmetic to the end of the month", () => {
    expect(addToWall({ year: 2026, month: 1, day: 31, hour: 9, minute: 0 }, 1, "month")).toMatchObject({ year: 2026, month: 2, day: 28 });
  });

  it("rolls weeks across a year boundary", () => {
    expect(addToWall({ year: 2026, month: 12, day: 29, hour: 0, minute: 0 }, 1, "week")).toMatchObject({ year: 2027, month: 1, day: 5 });
  });
});

describe("bumpDate (+1 buttons)", () => {
  it("starts an empty due field from today at the default due time", () => {
    expect(bumpDate(null, 1, "day", "due", settings, now)).toBe("2026-11-01T17:00:00.000");
  });

  it("uses the defer default time for an empty defer field", () => {
    expect(bumpDate(null, 1, "week", "defer", settings, now)).toBe("2026-11-07T00:00:00.000");
  });

  it("adds to an existing fixed value in the user's zone and returns floating", () => {
    expect(bumpDate("2026-11-02T23:00:00.000Z", 1, "month", "due", settings)).toBe("2026-12-03T09:00:00.000");
  });
});

describe("formatting", () => {
  it("honours the date format and 12/24-hour setting", () => {
    expect(formatDayOnly({ year: 2026, month: 3, day: 7 }, "MM/dd/yyyy")).toBe("03/07/2026");
    expect(formatDayOnly({ year: 2026, month: 3, day: 7 }, "yyyy-MM-dd")).toBe("2026-03-07");
    expect(formatTime({ hour: 0, minute: 5 }, false)).toBe("12:05 AM");
    expect(formatTime({ hour: 17, minute: 0 }, true)).toBe("17:00");
  });

  it("labels chips relative to today", () => {
    expect(formatDateChip("2026-10-31T17:00:00.000", settings, now)).toBe("Today 5:00 PM");
    expect(formatDateChip("2026-11-01T00:00:00.000", settings, now)).toBe("Tomorrow");
    expect(formatDateChip("2026-11-04T00:00:00.000", settings, now)).toBe("Wed");
    expect(formatDateChip("2026-12-25T00:00:00.000", settings, now)).toBe("25/12/2026");
  });
});

describe("withDay / startOfWeekKey", () => {
  it("keeps the time when picking a day from the calendar", () => {
    expect(withDay("2026-11-02T14:15:00.000", "2026-11-20", "due", settings)).toBe("2026-11-20T14:15:00.000");
    expect(withDay(null, "2026-11-20", "planned", settings)).toBe("2026-11-20T09:00:00.000");
  });

  it("finds the start of the week for the configured first weekday", () => {
    // 2026-10-31 is a Saturday.
    expect(startOfWeekKey("2026-10-31", 1)).toBe("2026-10-25");
    expect(startOfWeekKey("2026-10-31", 2)).toBe("2026-10-26");
    expect(startOfWeekKey("2026-10-31", 7)).toBe("2026-10-31");
  });
});
