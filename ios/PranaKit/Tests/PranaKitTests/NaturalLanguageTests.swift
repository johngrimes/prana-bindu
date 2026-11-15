// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Port of `src/shared/nlparse.test.ts` (parseDate, parseDuration, formatDuration), plus extra vectors produced by
/// running `src/shared/nlparse.ts` under Node.
@Suite("NaturalLanguage")
struct NaturalLanguageTests {
    // Reference: Sat 31 Oct 2026 14:20 in Australia/Brisbane (UTC+10, no DST).
    static let base = NaturalLanguage.ParseDateOptions(
        field: .due, now: instant("2026-10-31T04:20:00.000Z"), timeZone: "Australia/Brisbane",
        defaults: .init(defer: "00:00", due: "09:00", planned: "09:00"), dateFormat: .monthDayYear)

    static let table: [(String, String?)] = [
        ("today", "2026-10-31T09:00:00.000"),
        ("tod", "2026-10-31T09:00:00.000"),
        ("tomorrow", "2026-11-01T09:00:00.000"),
        ("tom", "2026-11-01T09:00:00.000"),
        ("yesterday", "2026-10-30T09:00:00.000"),
        ("now", "2026-10-31T14:20:00.000"),
        ("+1d", "2026-11-01T09:00:00.000"),
        ("1d", "2026-11-01T09:00:00.000"),
        ("-1d", "2026-10-30T09:00:00.000"),
        ("2w", "2026-11-14T09:00:00.000"),
        ("3m", "2027-01-31T09:00:00.000"),
        ("1y", "2027-10-31T09:00:00.000"),
        ("3 days", "2026-11-03T09:00:00.000"),
        ("1w 2d", "2026-11-09T09:00:00.000"),
        ("fri", "2026-11-06T09:00:00.000"),
        ("next fri", "2026-11-06T09:00:00.000"),
        ("friday", "2026-11-06T09:00:00.000"),
        ("sat", "2026-11-07T09:00:00.000"),  // strictly after today
        ("mon 9am", "2026-11-02T09:00:00.000"),
        ("5pm", "2026-10-31T17:00:00.000"),
        ("noon", "2026-10-31T12:00:00.000"),
        ("midnight", "2026-10-31T00:00:00.000"),
        ("today 3pm", "2026-10-31T15:00:00.000"),
        ("tomorrow at 8:15am", "2026-11-01T08:15:00.000"),
        ("12am", "2026-10-31T00:00:00.000"),
        ("12pm", "2026-10-31T12:00:00.000"),
        ("next week", "2026-11-07T09:00:00.000"),
        ("next month", "2026-11-30T09:00:00.000"),
        ("dec 25", "2026-12-25T09:00:00.000"),
        ("December 25th", "2026-12-25T09:00:00.000"),
        ("25 dec 2026 14:30", "2026-12-25T14:30:00.000"),
        ("12/25", "2026-12-25T09:00:00.000"),
        ("12/25/2027", "2027-12-25T09:00:00.000"),
        ("2026-12-25", "2026-12-25T09:00:00.000"),
        ("2026-12-25 7pm", "2026-12-25T19:00:00.000"),
        ("jan 3", "2027-01-03T09:00:00.000"),  // passed this year → next year
        ("in 3 days", "2026-11-03T09:00:00.000"),
        ("this weekend", "2026-10-31T09:00:00.000"),  // today is Saturday
        ("", nil),
        ("abc", nil),
        ("next", nil),
        ("2026-02-30", nil),
        ("13pm", nil),
        ("25:00", nil),
    ]

    @Test("parseDate reference table", arguments: table)
    func referenceTable(input: String, expected: String?) {
        #expect(NaturalLanguage.parseDate(input, options: Self.base) == expected)
    }

    /// Extra vectors generated from the TypeScript implementation (hour offsets, ordinals, odd inputs).
    static let extraTable: [(String, String?)] = [
        ("+3h", "2026-10-31T17:20:00.000"),
        ("in 2 hours", "2026-10-31T16:20:00.000"),
        ("1d 2h", "2026-11-01T16:20:00.000"),
        ("2h 5pm", nil),  // an hour offset cannot take a time of day
        ("tomorrow noon", "2026-11-01T12:00:00.000"),
        ("on fri", "2026-11-06T09:00:00.000"),
        ("feb 29", nil),
        ("feb 30", nil),
        ("31/12", nil),
        ("12/31", "2026-12-31T09:00:00.000"),
        ("1.2.27", "2027-01-02T09:00:00.000"),
        ("2026/12", nil),
        ("25th", nil),
        ("dec", "2026-12-01T09:00:00.000"),
        ("dec 2027", "2027-12-01T09:00:00.000"),
        ("1w -2d", "2026-11-05T09:00:00.000"),
        ("on", nil),
        ("next sat", "2026-11-07T09:00:00.000"),
        ("this weekend 10am", "2026-10-31T10:00:00.000"),
        ("  Tomorrow,  5PM ", "2026-11-01T17:00:00.000"),
        ("5 pm", "2026-10-31T17:00:00.000"),
        ("0am", nil),
        ("12:30a", "2026-10-31T00:30:00.000"),
        ("constructorx", nil),
        ("3y", "2029-10-31T09:00:00.000"),
        ("feb 29 2028", "2028-02-29T09:00:00.000"),
        ("2026-2-3", "2026-02-03T09:00:00.000"),
    ]

    @Test("parseDate extra vectors", arguments: extraTable)
    func extraVectors(input: String, expected: String?) {
        #expect(NaturalLanguage.parseDate(input, options: Self.base) == expected)
    }

    @Test("Uses the field's default time")
    func fieldDefaultTime() {
        var defer_ = Self.base
        defer_.field = .defer
        #expect(NaturalLanguage.parseDate("tomorrow", options: defer_) == "2026-11-01T00:00:00.000")
        var planned = Self.base
        planned.field = .planned
        planned.defaults.planned = "07:30"
        #expect(NaturalLanguage.parseDate("tomorrow", options: planned) == "2026-11-01T07:30:00.000")
    }

    @Test("Orders numeric dates by dateFormat")
    func numericOrder() {
        var dmy = Self.base
        dmy.dateFormat = .dayMonthYear
        #expect(NaturalLanguage.parseDate("3/4", options: dmy) == "2027-04-03T09:00:00.000")
        #expect(NaturalLanguage.parseDate("3/4", options: Self.base) == "2027-03-04T09:00:00.000")
        var ymd = Self.base
        ymd.dateFormat = .yearMonthDaySlash
        #expect(NaturalLanguage.parseDate("2026/11/05", options: ymd) == "2026-11-05T09:00:00.000")
    }

    @Test("This weekend on a weekday is the coming Saturday")
    func weekendOnWeekday() {
        var wed = Self.base
        wed.now = instant("2026-11-04T01:00:00.000Z")
        #expect(NaturalLanguage.parseDate("this weekend", options: wed) == "2026-11-07T09:00:00.000")
    }

    @Test("Resolves today in the user's time zone, not UTC")
    func todayInUserZone() {
        // 2026-10-31T20:00Z is already Nov 1 in Brisbane.
        var options = Self.base
        options.now = instant("2026-10-31T20:00:00.000Z")
        #expect(NaturalLanguage.parseDate("today", options: options) == "2026-11-01T09:00:00.000")
        options.timeZone = "America/New_York"
        #expect(NaturalLanguage.parseDate("today", options: options) == "2026-10-31T09:00:00.000")
    }

    @Test("Wall-clock arithmetic across the New York spring-forward transition")
    func newYorkSpringForward() {
        // 07:30Z on 2026-03-08 is 03:30 EDT, just after the gap.
        var options = Self.base
        options.timeZone = "America/New_York"
        options.now = instant("2026-03-08T07:30:00.000Z")
        #expect(NaturalLanguage.parseDate("now", options: options) == "2026-03-08T03:30:00.000")
        // 06:30Z is 01:30 EST; adding an hour is naive and lands on the non-existent 02:30, as on the web.
        options.now = instant("2026-03-08T06:30:00.000Z")
        #expect(NaturalLanguage.parseDate("+1h", options: options) == "2026-03-08T02:30:00.000")
    }

    // MARK: - Durations

    static let durations: [(String, Int?)] = [
        ("30", 30),
        ("30m", 30),
        ("1h", 60),
        ("1h30m", 90),
        ("1h 30m", 90),
        ("1.5h", 90),
        ("90 min", 90),
        ("2d", 2880),
        ("1w", 10080),
        ("abc", nil),
        ("", nil),
        ("5x", nil),
        // Extra vectors from Node.
        ("2.5", 3),
        ("0.5", 1),
        ("1h 30", nil),
        ("1 hour 15 mins", 75),
        ("3wks", 30240),
        ("1.25h", 75),
        ("10 minutes", 10),
    ]

    @Test("parseDuration", arguments: durations)
    func parseDuration(input: String, expected: Int?) {
        #expect(NaturalLanguage.parseDuration(input) == expected)
    }

    @Test("formatDuration")
    func formatDuration() {
        #expect(NaturalLanguage.formatDuration(90) == "1h 30m")
        #expect(NaturalLanguage.formatDuration(30) == "30m")
        #expect(NaturalLanguage.formatDuration(60) == "1h")
        #expect(NaturalLanguage.formatDuration(2880) == "48h")
        #expect(NaturalLanguage.formatDuration(0) == "0m")
        #expect(NaturalLanguage.formatDuration(125) == "2h 5m")
    }

    // MARK: - previewDate (src/web/lib/nl.ts)

    @Test("previewDate uses the settings' zone, defaults and date format")
    func preview() {
        let settings = Settings(
            timeZone: "Australia/Brisbane", dateFormat: .dayMonthYear, firstWeekday: 2, use24HourTime: false,
            defaultDeferTime: "00:00", defaultDueTime: "17:00", defaultPlannedTime: "09:00", dueSoonSeconds: 172_800,
            theme: .system, forecastTagId: nil)
        let now = instant("2026-10-31T04:20:00.000Z")
        #expect(NaturalLanguage.previewDate("tomorrow", field: .due, settings: settings, now: now) == "2026-11-01T17:00:00.000")
        #expect(NaturalLanguage.previewDate("tomorrow", field: .defer, settings: settings, now: now) == "2026-11-01T00:00:00.000")
        #expect(NaturalLanguage.previewDate("3/4", field: .planned, settings: settings, now: now) == "2027-04-03T09:00:00.000")
        #expect(NaturalLanguage.previewDate("   ", field: .due, settings: settings, now: now) == nil)
        #expect(NaturalLanguage.previewDate("whenever", field: .due, settings: settings, now: now) == nil)
    }
}
