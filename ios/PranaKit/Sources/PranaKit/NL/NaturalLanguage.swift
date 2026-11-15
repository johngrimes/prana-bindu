// Author: John Grimes

import Foundation

/// Natural-language date and duration parsing (spec §7). Port of `src/shared/nlparse.ts` and `src/web/lib/nl.ts`.
///
/// Dates are parsed relative to an injected `now` in the user's time zone and returned as floating strings
/// (`YYYY-MM-DDTHH:mm:ss.sss`); nil means "Unable to parse date". The server re-parses authoritatively.
public enum NaturalLanguage {
    /// Default times per date field, each `HH:MM`.
    public struct DefaultTimes: Sendable, Hashable {
        /// Default defer time.
        public var `defer`: String
        /// Default due time.
        public var due: String
        /// Default planned time.
        public var planned: String

        /// Creates default times.
        public init(defer: String, due: String, planned: String) {
            self.defer = `defer`
            self.due = due
            self.planned = planned
        }

        /// The default time for `field`.
        public subscript(field: DateField) -> String {
            switch field {
            case .defer: self.defer
            case .due: due
            case .planned: planned
            }
        }
    }

    /// Inputs to ``parseDate(_:options:)``.
    public struct ParseDateOptions: Sendable, Hashable {
        /// Which default time applies when the text has no time.
        public var field: DateField
        /// The reference instant.
        public var now: Date
        /// IANA time zone in which `now` is read and the result is meant.
        public var timeZone: String
        /// Default times per field.
        public var defaults: DefaultTimes
        /// Decides the order of numeric `a/b` dates.
        public var dateFormat: Settings.DateFormat

        /// Creates parse options; `field` defaults to due.
        public init(
            field: DateField = .due, now: Date, timeZone: String, defaults: DefaultTimes,
            dateFormat: Settings.DateFormat
        ) {
            self.field = field
            self.now = now
            self.timeZone = timeZone
            self.defaults = defaults
            self.dateFormat = dateFormat
        }
    }

    private static let weekdays: [String: Int] = [
        "sun": 0, "sunday": 0,
        "mon": 1, "monday": 1,
        "tue": 2, "tues": 2, "tuesday": 2,
        "wed": 3, "weds": 3, "wednesday": 3,
        "thu": 4, "thur": 4, "thurs": 4, "thursday": 4,
        "fri": 5, "friday": 5,
        "sat": 6, "saturday": 6,
    ]

    private static let months: [String: Int] = [
        "jan": 1, "january": 1,
        "feb": 2, "february": 2,
        "mar": 3, "march": 3,
        "apr": 4, "april": 4,
        "may": 5,
        "jun": 6, "june": 6,
        "jul": 7, "july": 7,
        "aug": 8, "august": 8,
        "sep": 9, "sept": 9, "september": 9,
        "oct": 10, "october": 10,
        "nov": 11, "november": 11,
        "dec": 12, "december": 12,
    ]

    private static let day = DateTime.millisecondsPerDay
    private static let hour: Int64 = 3_600_000
    /// Largest magnitude accepted for a single relative amount; keeps arithmetic far from Int64 overflow.
    private static let maxAmount = 1_000_000

    private enum DayResult {
        /// Naive midnight of a day; the time of day is added afterwards.
        case day(Int64)
        /// An exact naive time (relative hour offsets from now).
        case exact(Int64)
    }

    private static func unitOf(_ token: Substring) -> DateTime.Unit {
        switch token.first {
        case "h": .hour
        case "d": .day
        case "w": .week
        case "m": .month
        default: .year
        }
    }

    private static func inRange(_ ms: Int64) -> Bool {
        abs(ms) <= DateTime.maxMilliseconds
    }

    private static func isDigits(_ s: Substring, count: ClosedRange<Int>) -> Bool {
        count.contains(s.count) && s.allSatisfy { $0.isASCII && $0.isNumber }
    }

    /// Extracts a time-of-day expression. Returns the remaining text and the time (nil when absent), or nil when
    /// the time is malformed (e.g. `13pm`, `25:00`).
    private static func extractTime(_ text: String) -> (rest: String, time: DateDisplay.TimeOfDay?)? {
        if text.contains(#/\bnoon\b/#.wordBoundaryKind(.simple)) {
            return (text.replacing(#/\bnoon\b/#.wordBoundaryKind(.simple), with: " ", maxReplacements: 1), .init(hour: 12, minute: 0))
        }
        if text.contains(#/\bmidnight\b/#.wordBoundaryKind(.simple)) {
            return (text.replacing(#/\bmidnight\b/#.wordBoundaryKind(.simple), with: " ", maxReplacements: 1), .init(hour: 0, minute: 0))
        }
        if let m = text.firstMatch(of: #/(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)(?=\s|$)/#.asciiOnlyDigits()) {
            var hour = Int(m.1)!
            let minute = m.2.map { Int($0)! } ?? 0
            guard (1...12).contains(hour), minute <= 59 else { return nil }
            let pm = m.3.hasPrefix("p")
            if hour == 12 { hour = pm ? 12 : 0 } else if pm { hour += 12 }
            var rest = text
            rest.replaceSubrange(m.range, with: " ")
            return (rest, .init(hour: hour, minute: minute))
        }
        if let m = text.firstMatch(of: #/(?:^|\s)(\d{1,2}):(\d{2})(?=\s|$)/#.asciiOnlyDigits()) {
            let hour = Int(m.1)!
            let minute = Int(m.2)!
            guard hour <= 23, minute <= 59 else { return nil }
            var rest = text
            rest.replaceSubrange(m.range, with: " ")
            return (rest, .init(hour: hour, minute: minute))
        }
        return (text, nil)
    }

    /// Naive midnight of a valid calendar day, or nil.
    private static func validDay(year: Int, month: Int, day: Int) -> Int64? {
        guard (1...12).contains(month), day >= 1, day <= DateTime.daysInMonth(year: year, month: month) else {
            return nil
        }
        return DateTime.utcMilliseconds(year: year, month: month, day: day)
    }

    /// A month/day without a year resolves to its next occurrence on or after today.
    private static func resolveMonthDay(year: Int?, month: Int, day: Int, todayNaive: Int64, currentYear: Int) -> DayResult? {
        if let year {
            return validDay(year: year, month: month, day: day).map(DayResult.day)
        }
        let thisYear = validDay(year: currentYear, month: month, day: day)
        if let thisYear, thisYear >= todayNaive { return .day(thisYear) }
        if let next = validDay(year: currentYear + 1, month: month, day: day) { return .day(next) }
        return thisYear.map(DayResult.day)
    }

    /// Resolves a date expression (without time) to naive midnight, or an exact time for hour offsets from now.
    private static func parseDayExpression(
        _ text: String, todayNaive: Int64, nowNaive: Int64, dateFormat: Settings.DateFormat
    ) -> DayResult? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacing(#/^(on|at)\s+/#, with: "", maxReplacements: 1)
            .replacing(#/\s+(at)$/#, with: "", maxReplacements: 1)
        switch s {
        case "", "today", "tod": return .day(todayNaive)
        case "tomorrow", "tom": return .day(todayNaive + day)
        case "yesterday": return .day(todayNaive - day)
        case "next week": return .day(todayNaive + 7 * day)
        case "next month": return .day(DateTime.addToNaive(todayNaive, 1, .month))
        case "next year": return .day(DateTime.addToNaive(todayNaive, 1, .year))
        case "this weekend", "weekend":
            let wd = DateTime.wallParts(todayNaive).weekday
            return .day(todayNaive + Int64((6 - wd + 7) % 7) * day)
        default: break
        }

        // Relative offsets: "+1d", "-1d", "2w", "3 days", "1w 2d", "in 3 days".
        s = s.replacing(#/^in\s+/#, with: "", maxReplacements: 1)
        let relWhole = #/^(?:\s*[+-]?\s*\d+\s*(?:h|hrs?|hours?|d|days?|w|wks?|weeks?|m|mos?|months?|y|yrs?|years?)(?![a-z]))+\s*$/#
            .asciiOnlyDigits()
        if s.wholeMatch(of: relWhole) != nil {
            let part = #/([+-])?\s*(\d+)\s*(h|hrs?|hours?|d|days?|w|wks?|weeks?|m|mos?|months?|y|yrs?|years?)(?![a-z])/#
                .asciiOnlyDigits()
            var dayNaive = todayNaive
            var hours: Int64 = 0
            var sign = 1
            for m in s.matches(of: part) {
                if let signText = m.1 { sign = signText == "-" ? -1 : 1 }
                guard let magnitude = Int(m.2), magnitude <= maxAmount else { return nil }
                let amount = sign * magnitude
                let u = unitOf(m.3)
                if u == .hour {
                    hours += Int64(amount)
                } else {
                    dayNaive = DateTime.addToNaive(dayNaive, amount, u)
                }
                guard inRange(dayNaive), inRange(hours * hour) else { return nil }
            }
            if hours != 0 { return .exact(nowNaive + (dayNaive - todayNaive) + hours * hour) }
            return .day(dayNaive)
        }

        // Weekdays: "fri", "next fri" → the next such day strictly after today.
        if let m = s.wholeMatch(of: #/(?:next\s+|this\s+)?([a-z]+)/#), let target = weekdays[String(m.1)] {
            let wd = DateTime.wallParts(todayNaive).weekday
            let delta = (target - wd + 7) % 7 == 0 ? 7 : (target - wd + 7) % 7
            return .day(todayNaive + Int64(delta) * day)
        }

        let currentYear = DateTime.wallParts(todayNaive).year

        // ISO "2026-12-25".
        if let m = s.wholeMatch(of: #/(\d{4})-(\d{1,2})-(\d{1,2})/#.asciiOnlyDigits()) {
            return validDay(year: Int(m.1)!, month: Int(m.2)!, day: Int(m.3)!).map(DayResult.day)
        }

        // Numeric "12/25", "12/25/2026", "2026/12/25" (order per dateFormat).
        if let m = s.wholeMatch(of: #/(\d{1,4})[\/.](\d{1,2})(?:[\/.](\d{1,4}))?/#.asciiOnlyDigits()) {
            let a = Int(m.1)!
            let b = Int(m.2)!
            let c = m.3.map { Int($0)! }
            var year: Int?
            let month: Int
            let dayOfMonth: Int
            if m.1.count == 4 {
                guard let c else { return nil }
                (year, month, dayOfMonth) = (a, b, c)
            } else if dateFormat == .dayMonthYear {
                (dayOfMonth, month, year) = (a, b, c)
            } else {
                (month, dayOfMonth, year) = (a, b, c)
            }
            if let y = year, y < 100 { year = y + 2000 }
            return resolveMonthDay(year: year, month: month, day: dayOfMonth, todayNaive: todayNaive, currentYear: currentYear)
        }

        // Month names: "dec 25", "25 dec", "december 25th 2026", "25 dec 2026".
        let tokens = s.replacing(#/(\d+)(st|nd|rd|th)\b/#.asciiOnlyDigits().wordBoundaryKind(.simple)) { $0.1 }
            .split(separator: " ")
        var month: Int?
        var dayOfMonth: Int?
        var year: Int?
        for t in tokens {
            if let mo = months[String(t)], month == nil {
                month = mo
            } else if isDigits(t, count: 1...2), dayOfMonth == nil {
                dayOfMonth = Int(t)
            } else if isDigits(t, count: 4...4), year == nil {
                year = Int(t)
            } else {
                return nil
            }
        }
        guard let month else { return nil }
        return resolveMonthDay(year: year, month: month, day: dayOfMonth ?? 1, todayNaive: todayNaive, currentYear: currentYear)
    }

    /// Parses a natural-language date relative to `options.now` in `options.timeZone`.
    ///
    /// Returns a floating date-time string (`YYYY-MM-DDTHH:mm:ss.sss`), or nil ("Unable to parse date").
    public static func parseDate(_ text: String, options: ParseDateOptions) -> String? {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .replacing(",", with: " ")
            .replacing(#/\s+/#, with: " ")
        if s.isEmpty { return nil }
        let instantNaive = DateTime.instantToNaive(options.now, timeZone: options.timeZone)
        let nowNaive = DateTime.floorDiv(instantNaive, 60_000) * 60_000
        let todayNaive = DateTime.floorDiv(nowNaive, day) * day
        if s == "now" { return DateTime.formatFloating(nowNaive) }

        guard let (rest, time) = extractTime(s) else { return nil }
        let restTrim = rest.replacing(#/\s+/#, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        if restTrim.isEmpty && time == nil { return nil }
        guard let result = parseDayExpression(restTrim, todayNaive: todayNaive, nowNaive: nowNaive, dateFormat: options.dateFormat)
        else { return nil }
        let naive: Int64
        switch result {
        case .exact(let exact):
            if time != nil { return nil }
            naive = exact
        case .day(let dayNaive):
            let t = time ?? DateDisplay.parseHHMM(options.defaults[options.field])
            naive = dayNaive + Int64(t.hour) * hour + Int64(t.minute) * 60_000
        }
        return inRange(naive) ? DateTime.formatFloating(naive) : nil
    }

    /// Parses a duration (`30`, `30m`, `1h30m`, `1.5h`, `90 min`, `2d`, `1w`) to whole minutes, or nil.
    public static func parseDuration(_ text: String) -> Int? {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if s.isEmpty { return nil }
        if s.wholeMatch(of: #/\d+(?:\.\d+)?/#.asciiOnlyDigits()) != nil { return roundMinutes(Double(s)!) }
        let whole = #/^(?:\s*\d+(?:\.\d+)?\s*(?:m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)(?![a-z]))+\s*$/#
            .asciiOnlyDigits()
        guard s.wholeMatch(of: whole) != nil else { return nil }
        var total = 0.0
        for m in s.matches(of: #/(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)(?![a-z])/#.asciiOnlyDigits()) {
            let factor: Double =
                switch m.2.first {
                case "w": 10080
                case "d": 1440
                case "h": 60
                default: 1
                }
            total += Double(m.1)! * factor
        }
        return roundMinutes(total)
    }

    /// `Math.round` of a non-negative minute count; nil when it cannot be represented.
    private static func roundMinutes(_ value: Double) -> Int? {
        let rounded = (value + 0.5).rounded(.down)
        return rounded.isFinite && rounded < 1e15 ? Int(rounded) : nil
    }

    /// Formats minutes as `1h 30m` (hours are not rolled up into days).
    public static func formatDuration(_ minutes: Int) -> String {
        let h = minutes / 60
        let m = minutes % 60
        if h == 0 { return "\(m)m" }
        return m == 0 ? "\(h)h" : "\(h)h \(m)m"
    }

    /// Instant client-side preview of a natural-language date for `field` using the user's settings (the server
    /// re-parses authoritatively). Nil for blank text or text that does not parse.
    public static func previewDate(_ text: String, field: DateField, settings: Settings, now: Date) -> String? {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        return parseDate(
            text,
            options: ParseDateOptions(
                field: field, now: now, timeZone: settings.timeZone,
                defaults: DefaultTimes(
                    defer: settings.defaultDeferTime, due: settings.defaultDueTime, planned: settings.defaultPlannedTime),
                dateFormat: settings.dateFormat))
    }
}
