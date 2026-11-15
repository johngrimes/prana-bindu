// Author: John Grimes

import Foundation

/// An RRULE `FREQ` value. String-backed so rules with frequencies the editor does not offer still round-trip.
public struct RepeatFrequency: RawRepresentable, Hashable, Sendable {
    /// The RRULE token, e.g. `WEEKLY`.
    public var rawValue: String

    /// Wraps an RRULE `FREQ` token.
    public init(rawValue: String) { self.rawValue = rawValue }

    /// `FREQ=MINUTELY`.
    public static let minutely = RepeatFrequency(rawValue: "MINUTELY")
    /// `FREQ=HOURLY`.
    public static let hourly = RepeatFrequency(rawValue: "HOURLY")
    /// `FREQ=DAILY`.
    public static let daily = RepeatFrequency(rawValue: "DAILY")
    /// `FREQ=WEEKLY`.
    public static let weekly = RepeatFrequency(rawValue: "WEEKLY")
    /// `FREQ=MONTHLY`.
    public static let monthly = RepeatFrequency(rawValue: "MONTHLY")
    /// `FREQ=YEARLY`.
    public static let yearly = RepeatFrequency(rawValue: "YEARLY")

    /// The frequencies the repeat editor offers, shortest first (`FREQS` in the web's `RepeatEditor.tsx`).
    public static let editable: [RepeatFrequency] = [.daily, .weekly, .monthly, .yearly]

    /// The units the editor lists for a rule with `current`: the editable ones, plus the rule's own when it is not
    /// one of them (e.g. `HOURLY` from an import), so it shows and round-trips.
    public static func options(for current: RepeatFrequency) -> [RepeatFrequency] {
        editable.contains(current) ? editable : editable + [current]
    }

    /// Singular and plural unit names used in summaries, e.g. ("week", "weeks"); ("time", "times") when unknown.
    public var unitNames: (one: String, many: String) {
        switch rawValue {
        case "MINUTELY": ("minute", "minutes")
        case "HOURLY": ("hour", "hours")
        case "DAILY": ("day", "days")
        case "WEEKLY": ("week", "weeks")
        case "MONTHLY": ("month", "months")
        case "YEARLY": ("year", "years")
        default: ("time", "times")
        }
    }

    /// Whether the rule picks days within a month (monthly and yearly rules).
    var isMonthlyOrYearly: Bool { self == .monthly || self == .yearly }
}

/// An RRULE weekday code, in calendar order starting on Sunday (`WEEKDAY_CODES` in the web app).
public enum RepeatWeekday: String, CaseIterable, Hashable, Sendable {
    case sunday = "SU"
    case monday = "MO"
    case tuesday = "TU"
    case wednesday = "WE"
    case thursday = "TH"
    case friday = "FR"
    case saturday = "SA"

    /// The English day name, e.g. "Monday".
    public var name: String {
        switch self {
        case .sunday: "Sunday"
        case .monday: "Monday"
        case .tuesday: "Tuesday"
        case .wednesday: "Wednesday"
        case .thursday: "Thursday"
        case .friday: "Friday"
        case .saturday: "Saturday"
        }
    }
}

/// Editor fields for an RFC 5545 RRULE body (spec §3 Repeat editor). Port of `RepeatForm` in
/// `src/web/lib/repeat.ts`: `init(rule:)` is `parseRule` and `rule` is `buildRule`.
public struct RepeatForm: Hashable, Sendable {
    /// How monthly and yearly rules choose their days.
    public enum MonthlyMode: String, Hashable, Sendable {
        /// No day constraint.
        case none
        /// Specific days of the month (`BYMONTHDAY`).
        case dayOfMonth
        /// The nth weekday of the month (`BYDAY=2TU` or `BYDAY=TU;BYSETPOS=2`).
        case nthWeekday
    }

    /// When the repetition stops.
    public enum End: Hashable, Sendable {
        /// Never stops.
        case never
        /// Stops after this many occurrences (`COUNT`).
        case count(Int)
        /// Stops at the end of this day, `YYYY-MM-DD` (`UNTIL`).
        case until(String)
    }

    /// The repetition unit.
    public var freq: RepeatFrequency = .weekly
    /// Every N units; at least 1.
    public var interval: Int = 1
    /// Weekly: selected days, in the order given.
    public var byDay: [RepeatWeekday] = []
    /// Monthly/yearly mode.
    public var monthlyMode: MonthlyMode = .none
    /// Days of the month, 1...31, with -1 meaning the last day.
    public var byMonthDay: [Int] = []
    /// The nth weekday: 1...5, or -1 for the last.
    public var nth: Int = 1
    /// The weekday for `nthWeekday` mode.
    public var nthWeekday: RepeatWeekday = .monday
    /// Yearly: months 1...12.
    public var byMonth: [Int] = []
    /// When the repetition stops.
    public var end: End = .never
    /// Other RRULE parts (e.g. `WKST`) preserved verbatim, in order.
    public var extra: [Part] = []

    /// An RRULE `KEY=value` part the editor does not model.
    public struct Part: Hashable, Sendable {
        /// The upper-cased key, e.g. `WKST`.
        public var key: String
        /// The value as written, e.g. `SU`.
        public var value: String

        /// Creates a part.
        public init(key: String, value: String) {
            self.key = key
            self.value = value
        }
    }

    /// Editor defaults: weekly, every week, never ending.
    public init() {}

    /// Parses an RRULE body (an optional `RRULE:` prefix is ignored). Unparseable parts fall back to defaults.
    public init(rule: String) {
        var setPos: Int?
        var rawSetPos: String?
        var days: [(n: Int?, day: RepeatWeekday)] = []
        var body = Substring(rule)
        if body.prefix(6).uppercased() == "RRULE:" { body = body.dropFirst(6) }
        for part in body.split(separator: ";", omittingEmptySubsequences: true) {
            let pieces = part.split(separator: "=", omittingEmptySubsequences: false)
            let key = String(pieces[0]).uppercased()
            let value = pieces.count > 1 ? String(pieces[1]) : ""
            switch key {
            case "FREQ":
                freq = RepeatFrequency(rawValue: value.uppercased())
            case "INTERVAL":
                interval = max(1, Self.integer(value) ?? 1)
            case "BYDAY":
                for token in value.split(separator: ",", omittingEmptySubsequences: false) {
                    if let parsed = Self.parseWeekday(token.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()) {
                        days.append(parsed)
                    }
                }
            case "BYMONTHDAY":
                byMonthDay = Self.integers(value).filter { $0 != 0 }
            case "BYSETPOS":
                setPos = Self.integer(value)
                rawSetPos = value
            case "BYMONTH":
                byMonth = Self.integers(value).filter { (1...12).contains($0) }
            case "COUNT":
                end = .count(max(1, Self.integer(value) ?? 1))
            case "UNTIL":
                let digits = value.prefix(8)
                if digits.count == 8, digits.allSatisfy({ $0.isASCII && $0.isNumber }) {
                    let chars = Array(digits)
                    end = .until("\(String(chars[0..<4]))-\(String(chars[4..<6]))-\(String(chars[6..<8]))")
                }
            default:
                extra.append(Part(key: key, value: value))
            }
        }
        var nthDay: (n: Int, day: RepeatWeekday)?
        if let prefixed = days.first(where: { $0.n != nil }), let n = prefixed.n {
            nthDay = (n, prefixed.day)
        } else if let setPos, days.count == 1 {
            nthDay = (setPos, days[0].day)
        }
        if freq.isMonthlyOrYearly, let nthDay {
            monthlyMode = .nthWeekday
            nth = nthDay.n
            nthWeekday = nthDay.day
        } else {
            byDay = days.map(\.day)
            if let setPos {
                extra.append(Part(key: "BYSETPOS", value: String(setPos)))
            } else if let rawSetPos {
                // Not a number: keep it verbatim rather than losing it.
                extra.append(Part(key: "BYSETPOS", value: rawSetPos))
            }
        }
        if freq.isMonthlyOrYearly, monthlyMode == .none, !byMonthDay.isEmpty { monthlyMode = .dayOfMonth }
    }

    /// The RRULE body for these fields, with parts in a stable order and weekdays in calendar order.
    public var rule: String {
        var parts = ["FREQ=\(freq.rawValue)"]
        if interval > 1 { parts.append("INTERVAL=\(interval)") }
        if freq == .weekly, !byDay.isEmpty {
            let ordered = RepeatWeekday.allCases.filter { byDay.contains($0) }
            parts.append("BYDAY=\(ordered.map(\.rawValue).joined(separator: ","))")
        }
        if freq.isMonthlyOrYearly {
            if freq == .yearly, !byMonth.isEmpty {
                parts.append("BYMONTH=\(byMonth.sorted().map(String.init).joined(separator: ","))")
            }
            if monthlyMode == .dayOfMonth, !byMonthDay.isEmpty {
                parts.append("BYMONTHDAY=\(byMonthDay.map(String.init).joined(separator: ","))")
            }
            if monthlyMode == .nthWeekday { parts.append("BYDAY=\(nth)\(nthWeekday.rawValue)") }
        }
        for part in extra where !(part.key == "BYSETPOS" && monthlyMode == .nthWeekday) {
            parts.append("\(part.key)=\(part.value)")
        }
        switch end {
        case .never: break
        case .count(let count): parts.append("COUNT=\(count)")
        case .until(let date): parts.append("UNTIL=\(date.replacingOccurrences(of: "-", with: ""))T235959Z")
        }
        return parts.joined(separator: ";")
    }

    /// Parses `[+-]?digit? weekday`, e.g. `MO`, `2TU`, `-1FR`.
    private static func parseWeekday(_ token: String) -> (n: Int?, day: RepeatWeekday)? {
        guard token.count >= 2, let day = RepeatWeekday(rawValue: String(token.suffix(2))) else { return nil }
        let prefix = token.dropLast(2)
        if prefix.isEmpty { return (nil, day) }
        var digits = prefix
        if let sign = digits.first, sign == "+" || sign == "-" { digits = digits.dropFirst() }
        guard digits.count == 1, let digit = digits.first, digit.isASCII, digit.isNumber, let n = Int(prefix) else {
            return nil
        }
        return (n, day)
    }

    /// An integer from an RRULE value, tolerating surrounding whitespace and a leading `+`.
    private static func integer(_ value: some StringProtocol) -> Int? {
        Int(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Comma-separated integers, skipping values that are not integers.
    private static func integers(_ value: String) -> [Int] {
        value.split(separator: ",", omittingEmptySubsequences: false).compactMap { integer($0) }
    }
}

extension RepeatRule {
    /// The rule a new repetition starts with: weekly, on a fixed schedule, from the due date.
    public static let defaultRepeat = RepeatRule(
        rule: "FREQ=WEEKLY", scheduleType: .regularly, anchorDate: .due, catchUpAutomatically: false)
}

/// The ordinal word for an nth weekday: "first"..."fifth", "last" for -1, otherwise "<n>th".
public func repeatOrdinal(_ n: Int) -> String {
    switch n {
    case -1: "last"
    case 1: "first"
    case 2: "second"
    case 3: "third"
    case 4: "fourth"
    case 5: "fifth"
    default: "\(n)th"
    }
}

private let monthNames = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
    "December",
]

private func dayOfMonthText(_ n: Int) -> String {
    if n == -1 { return "the last day" }
    let suffix =
        n % 10 == 1 && n != 11 ? "st" : n % 10 == 2 && n != 12 ? "nd" : n % 10 == 3 && n != 13 ? "rd" : "th"
    return "the \(n)\(suffix)"
}

/// Joins items as "a, b and c".
private func englishList(_ items: [String]) -> String {
    guard items.count > 1, let last = items.last else { return items.joined() }
    return "\(items.dropLast().joined(separator: ", ")) and \(last)"
}

/// Plain-English summary of a repetition, e.g. "Every 2 weeks on Monday and Friday, 4 times, after completion
/// (defer date)". Port of `summarizeRepeat` in `src/web/lib/repeat.ts`; `UNTIL` dates are shown as `YYYY-MM-DD`
/// exactly as on the web.
public func summarizeRepeat(_ repeatRule: RepeatRule) -> String {
    let form = RepeatForm(rule: repeatRule.rule)
    let units = form.freq.unitNames
    var text = form.interval == 1 ? "Every \(units.one)" : "Every \(form.interval) \(units.many)"
    if form.freq == .weekly, !form.byDay.isEmpty {
        text += " on \(englishList(RepeatWeekday.allCases.filter { form.byDay.contains($0) }.map(\.name)))"
    }
    if form.freq == .yearly, !form.byMonth.isEmpty {
        text += " in \(englishList(form.byMonth.map { monthNames.indices.contains($0 - 1) ? monthNames[$0 - 1] : "" }))"
    }
    if form.freq.isMonthlyOrYearly, form.monthlyMode == .dayOfMonth {
        text += " on \(englishList(form.byMonthDay.map(dayOfMonthText)))"
    }
    if form.freq.isMonthlyOrYearly, form.monthlyMode == .nthWeekday {
        text += " on the \(repeatOrdinal(form.nth)) \(form.nthWeekday.name)"
    }
    switch form.end {
    case .never: break
    case .count(let count): text += ", \(count) \(count == 1 ? "time" : "times")"
    case .until(let date): text += ", until \(date)"
    }
    let anchor =
        switch repeatRule.anchorDate {
        case .defer: "defer date"
        case .planned: "planned date"
        case .due: "due date"
        }
    text +=
        repeatRule.scheduleType == .fromCompletion ? ", after completion (\(anchor))" : ", on a fixed schedule (\(anchor))"
    if repeatRule.catchUpAutomatically, repeatRule.scheduleType == .regularly { text += ", catching up automatically" }
    return text
}
