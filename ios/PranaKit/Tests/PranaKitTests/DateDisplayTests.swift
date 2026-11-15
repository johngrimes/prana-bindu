// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Port of `src/web/lib/dates.test.ts`, plus extra vectors produced by running `src/web/lib/dates.ts` under Node.
@Suite("DateDisplay")
struct DateDisplayTests {
    static let settings = Settings(
        timeZone: "Australia/Brisbane", dateFormat: .dayMonthYear, firstWeekday: 2, use24HourTime: false,
        defaultDeferTime: "00:00", defaultDueTime: "17:00", defaultPlannedTime: "09:00", dueSoonSeconds: 172_800,
        theme: .system, forecastTagId: nil)
    // Sat 31 Oct 2026, 10:30 in Brisbane (UTC+10, no DST).
    static let now = instant("2026-10-31T00:30:00.000Z")

    // MARK: - toWall

    @Test("Floating dates are read as written, whatever the zone")
    func floatingAsWritten() {
        #expect(DateDisplay.toWall("2026-11-03T09:00:00.000", timeZone: "America/New_York") == WallTime(year: 2026, month: 11, day: 3, hour: 9, minute: 0))
    }

    @Test("Fixed instants are converted into the user's time zone")
    func fixedConverted() {
        #expect(DateDisplay.toWall("2026-11-02T23:00:00.000Z", timeZone: "Australia/Brisbane") == WallTime(year: 2026, month: 11, day: 3, hour: 9, minute: 0))
        // An explicit offset is also a fixed instant.
        #expect(DateDisplay.toWall("2026-11-02T23:00:00+10:00", timeZone: "America/New_York") == WallTime(year: 2026, month: 11, day: 2, hour: 8, minute: 0))
    }

    @Test("A bare day is midnight; junk is nil")
    func dayOnlyAndJunk() {
        #expect(DateDisplay.toWall("2026-11-02", timeZone: "UTC") == WallTime(year: 2026, month: 11, day: 2, hour: 0, minute: 0))
        #expect(DateDisplay.toWall("soon", timeZone: "UTC") == nil)
    }

    // MARK: - addToWall

    @Test("Month arithmetic clamps to the end of the month")
    func clampMonth() {
        let result = DateDisplay.addToWall(WallTime(year: 2026, month: 1, day: 31, hour: 9, minute: 0), 1, .month)
        #expect((result.year, result.month, result.day) == (2026, 2, 28))
    }

    @Test("Weeks roll across a year boundary")
    func weeksAcrossYear() {
        let result = DateDisplay.addToWall(WallTime(year: 2026, month: 12, day: 29, hour: 0, minute: 0), 1, .week)
        #expect((result.year, result.month, result.day) == (2027, 1, 5))
    }

    // MARK: - bumpDate

    @Test("An empty due field starts from today at the default due time")
    func bumpEmptyDue() {
        #expect(DateDisplay.bumpDate(nil, 1, .day, field: .due, settings: Self.settings, now: Self.now) == "2026-11-01T17:00:00.000")
    }

    @Test("An empty defer field uses the defer default time")
    func bumpEmptyDefer() {
        #expect(DateDisplay.bumpDate(nil, 1, .week, field: .defer, settings: Self.settings, now: Self.now) == "2026-11-07T00:00:00.000")
    }

    @Test("Bumping a fixed value works in the user's zone and returns floating")
    func bumpFixed() {
        #expect(DateDisplay.bumpDate("2026-11-02T23:00:00.000Z", 1, .month, field: .due, settings: Self.settings, now: Self.now) == "2026-12-03T09:00:00.000")
        #expect(DateDisplay.bumpDate("2026-01-31T09:00:00.000", 1, .month, field: .due, settings: Self.settings, now: Self.now) == "2026-02-28T09:00:00.000")
    }

    @Test("Today for an empty field is taken in the user's zone")
    func bumpTodayInZone() {
        // 2026-10-31T20:00Z is already Sunday 1 November in Brisbane.
        #expect(DateDisplay.bumpDate(nil, 1, .day, field: .planned, settings: Self.settings, now: instant("2026-10-31T20:00:00.000Z")) == "2026-11-02T09:00:00.000")
    }

    // MARK: - Formatting

    @Test("Honours the date format and 12/24-hour setting")
    func formats() {
        #expect(DateDisplay.formatDayOnly(year: 2026, month: 3, day: 7, dateFormat: .monthDayYear) == "03/07/2026")
        #expect(DateDisplay.formatDayOnly(year: 2026, month: 3, day: 7, dateFormat: .iso) == "2026-03-07")
        #expect(DateDisplay.formatDayOnly(year: 2026, month: 3, day: 7, dateFormat: .dayMonthYear) == "07/03/2026")
        #expect(DateDisplay.formatDayOnly(year: 2026, month: 3, day: 7, dateFormat: .yearMonthDaySlash) == "2026/03/07")
        #expect(DateDisplay.formatTime(hour: 0, minute: 5, use24HourTime: false) == "12:05 AM")
        #expect(DateDisplay.formatTime(hour: 17, minute: 0, use24HourTime: true) == "17:00")
        #expect(DateDisplay.formatTime(hour: 12, minute: 0, use24HourTime: false) == "12:00 PM")
        #expect(DateDisplay.formatTime(hour: 23, minute: 59, use24HourTime: false) == "11:59 PM")
        #expect(DateDisplay.formatTime(hour: 9, minute: 5, use24HourTime: true) == "09:05")
    }

    @Test("Chips are labelled relative to today")
    func chips() {
        let s = Self.settings
        #expect(DateDisplay.formatDateChip("2026-10-31T17:00:00.000", settings: s, now: Self.now) == "Today 5:00 PM")
        #expect(DateDisplay.formatDateChip("2026-11-01T00:00:00.000", settings: s, now: Self.now) == "Tomorrow")
        #expect(DateDisplay.formatDateChip("2026-11-04T00:00:00.000", settings: s, now: Self.now) == "Wed")
        #expect(DateDisplay.formatDateChip("2026-12-25T00:00:00.000", settings: s, now: Self.now) == "25/12/2026")
        // Extra vectors from Node.
        #expect(DateDisplay.formatDateChip("2026-10-30T08:05:00.000", settings: s, now: Self.now) == "Yesterday 8:05 AM")
        #expect(DateDisplay.formatDateChip("2026-11-06T00:00:00.000", settings: s, now: Self.now) == "Fri")
        #expect(DateDisplay.formatDateChip("2026-11-07T00:00:00.000", settings: s, now: Self.now) == "07/11/2026")
        #expect(DateDisplay.formatDateChip("2026-11-01T13:00:00.000Z", settings: s, now: Self.now) == "Tomorrow 11:00 PM")
    }

    @Test("Full date-time and editable input text")
    func dateTimeText() {
        var us = Self.settings
        us.dateFormat = .monthDayYear
        us.use24HourTime = true
        #expect(DateDisplay.formatDateTime("2026-11-06T17:00:00.000", settings: Self.settings) == "Fri 06/11/2026 5:00 PM")
        #expect(DateDisplay.formatDateTime("2026-11-06T17:00:00.000", settings: us) == "Fri 11/06/2026 17:00")
        #expect(DateDisplay.formatDateTime(nil, settings: Self.settings) == "")
        #expect(DateDisplay.formatDateInput("2026-11-02T23:00:00.000Z", settings: Self.settings) == "03/11/2026 9:00 AM")
        #expect(DateDisplay.formatDateInput(nil, settings: Self.settings) == "")
    }

    @Test("Day key labels and names")
    func dayKeyLabels() {
        #expect(DateDisplay.formatDayKey("2026-11-02") == "Mon, Nov 2")
        #expect(DateDisplay.formatDayKey("2026-10-31") == "Sat, Oct 31")
        #expect(DateDisplay.weekdayName(-1) == "Sat")
        #expect(DateDisplay.weekdayName(7) == "Sun")
        #expect(DateDisplay.monthName(13) == "")
        #expect(DateDisplay.monthName(1) == "Jan")
    }

    // MARK: - Day keys

    @Test("Today is taken in the user's time zone")
    func todayInZone() {
        #expect(DateDisplay.todayKey(timeZone: "Australia/Brisbane", now: instant("2026-10-31T14:00:00.000Z")) == "2026-11-01")
        #expect(DateDisplay.todayKey(timeZone: "America/New_York", now: instant("2026-10-31T14:00:00.000Z")) == "2026-10-31")
    }

    @Test("Day key of a stored value")
    func dayKeyOfValue() {
        #expect(DateDisplay.dayKeyOf("2026-11-02T14:30:00.000Z", timeZone: "Australia/Brisbane") == "2026-11-03")
        #expect(DateDisplay.dayKeyOf("2026-11-02", timeZone: "Australia/Brisbane") == "2026-11-02")
    }

    @Test("withDay keeps the time when picking a day from the calendar")
    func withDayKeepsTime() {
        #expect(DateDisplay.withDay("2026-11-02T14:15:00.000", dayKey: "2026-11-20", field: .due, settings: Self.settings) == "2026-11-20T14:15:00.000")
        #expect(DateDisplay.withDay(nil, dayKey: "2026-11-20", field: .planned, settings: Self.settings) == "2026-11-20T09:00:00.000")
    }

    @Test("Start of week honours the configured first weekday")
    func startOfWeek() {
        // 2026-10-31 is a Saturday.
        #expect(DateDisplay.startOfWeekKey("2026-10-31", firstWeekday: 1) == "2026-10-25")
        #expect(DateDisplay.startOfWeekKey("2026-10-31", firstWeekday: 2) == "2026-10-26")
        #expect(DateDisplay.startOfWeekKey("2026-10-31", firstWeekday: 7) == "2026-10-31")
    }

    @Test("Default time per field")
    func defaultTimes() {
        #expect(DateDisplay.defaultTime(for: .defer, settings: Self.settings) == DateDisplay.TimeOfDay(hour: 0, minute: 0))
        #expect(DateDisplay.defaultTime(for: .due, settings: Self.settings) == DateDisplay.TimeOfDay(hour: 17, minute: 0))
        #expect(DateDisplay.parseHHMM("7:3x") == DateDisplay.TimeOfDay(hour: 7, minute: 0))
    }
}
