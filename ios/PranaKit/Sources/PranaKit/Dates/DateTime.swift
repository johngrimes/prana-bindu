// Author: John Grimes

import Foundation

/// Time-zone helpers for fixed (`…Z`) and floating (wall-clock) date values (spec §1.1). Port of
/// `src/shared/datetime.ts`.
///
/// "Naive" milliseconds encode a wall-clock time as if it were UTC (JavaScript's `Date.UTC(y, m, d, h, mi, s, ms)`),
/// which makes calendar arithmetic independent of daylight saving. Instants are Foundation `Date`s or, where exact
/// millisecond parity with the web client matters, milliseconds since the Unix epoch (`Int64`).
///
/// Time zones are IANA names. An unknown name resolves to GMT (the server validates the user's zone, so this only
/// guards against corrupt input).
public enum DateTime {
    /// Milliseconds in a calendar day.
    public static let millisecondsPerDay: Int64 = 86_400_000

    /// The largest absolute millisecond value a JavaScript `Date` can hold; results beyond it are invalid on the web.
    public static let maxMilliseconds: Int64 = 8_640_000_000_000_000

    /// Wall-clock components of naive milliseconds.
    public struct WallParts: Sendable, Hashable {
        /// Full year, e.g. 2026.
        public var year: Int
        /// Month, 1-12.
        public var month: Int
        /// Day of the month, 1-31.
        public var day: Int
        /// Hour, 0-23.
        public var hour: Int
        /// Minute, 0-59.
        public var minute: Int
        /// Second, 0-59.
        public var second: Int
        /// Millisecond, 0-999.
        public var millisecond: Int
        /// 0 = Sunday … 6 = Saturday.
        public var weekday: Int

        /// Creates wall parts from their components.
        public init(year: Int, month: Int, day: Int, hour: Int, minute: Int, second: Int, millisecond: Int, weekday: Int) {
            self.year = year
            self.month = month
            self.day = day
            self.hour = hour
            self.minute = minute
            self.second = second
            self.millisecond = millisecond
            self.weekday = weekday
        }
    }

    /// Calendar units understood by ``addToNaive(_:_:_:)``.
    public enum Unit: Sendable, Hashable, CaseIterable {
        case minute, hour, day, week, month, year
    }

    // MARK: - Instants and offsets

    /// Milliseconds since the Unix epoch of `date` (rounded to the nearest millisecond).
    public static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    /// The instant `milliseconds` after the Unix epoch.
    public static func date(milliseconds: Int64) -> Date {
        Date(timeIntervalSince1970: Double(milliseconds) / 1000)
    }

    /// True when `timeZone` is a valid IANA zone name.
    public static func isValidTimeZone(_ timeZone: String) -> Bool {
        TimeZone(identifier: timeZone) != nil
    }

    /// Resolves an IANA name to a `TimeZone`, falling back to GMT for unknown names.
    static func zone(_ identifier: String) -> TimeZone {
        TimeZone(identifier: identifier) ?? TimeZone(secondsFromGMT: 0)!
    }

    /// Offset (ms) of `timeZone` from UTC at instant `milliseconds` (positive east of Greenwich).
    public static func tzOffsetMilliseconds(milliseconds: Int64, timeZone: String) -> Int64 {
        Int64(zone(timeZone).secondsFromGMT(for: date(milliseconds: milliseconds))) * 1000
    }

    /// Offset (ms) of `timeZone` from UTC at `instant` (positive east of Greenwich).
    public static func tzOffsetMilliseconds(_ instant: Date, timeZone: String) -> Int64 {
        tzOffsetMilliseconds(milliseconds: milliseconds(instant), timeZone: timeZone)
    }

    /// Instant (epoch ms) → naive wall-clock ms in `timeZone`.
    public static func instantToNaive(milliseconds: Int64, timeZone: String) -> Int64 {
        milliseconds + tzOffsetMilliseconds(milliseconds: milliseconds, timeZone: timeZone)
    }

    /// Instant → naive wall-clock ms in `timeZone`.
    public static func instantToNaive(_ instant: Date, timeZone: String) -> Int64 {
        instantToNaive(milliseconds: milliseconds(instant), timeZone: timeZone)
    }

    /// Naive wall-clock ms in `timeZone` → instant (epoch ms). Ambiguous wall times (DST fall-back) resolve to the
    /// earlier instant; non-existent wall times (spring-forward gap) shift forward by the gap.
    public static func naiveToInstant(_ naive: Int64, timeZone: String) -> Int64 {
        let before = naive - tzOffsetMilliseconds(milliseconds: naive - millisecondsPerDay, timeZone: timeZone)
        let after = naive - tzOffsetMilliseconds(milliseconds: naive + millisecondsPerDay, timeZone: timeZone)
        let valid = [before, after].filter { instantToNaive(milliseconds: $0, timeZone: timeZone) == naive }
        // Gap: no instant has this wall time; the pre-transition offset moves the time forward.
        return valid.min() ?? before
    }

    // MARK: - Civil calendar arithmetic

    /// Equivalent of JavaScript's `Date.UTC` with a 1-based month: out-of-range components roll over.
    public static func utcMilliseconds(
        year: Int, month: Int, day: Int, hour: Int = 0, minute: Int = 0, second: Int = 0, millisecond: Int = 0
    ) -> Int64 {
        let monthIndex = month - 1
        let y = year + floorDiv(monthIndex, 12)
        let m = floorMod(monthIndex, 12) + 1
        let days = Int64(daysFromCivil(year: y, month: m, day: 1)) + Int64(day - 1)
        return days * millisecondsPerDay + Int64(hour) * 3_600_000 + Int64(minute) * 60_000 + Int64(second) * 1000
            + Int64(millisecond)
    }

    /// Wall-clock components of naive ms.
    public static func wallParts(_ naive: Int64) -> WallParts {
        let days = floorDiv(naive, millisecondsPerDay)
        let msOfDay = Int(naive - days * millisecondsPerDay)
        let (year, month, day) = civilFromDays(days)
        return WallParts(
            year: year, month: month, day: day, hour: msOfDay / 3_600_000, minute: msOfDay / 60_000 % 60,
            second: msOfDay / 1000 % 60, millisecond: msOfDay % 1000, weekday: Int(floorMod(days + 4, 7)))
    }

    /// Number of days in `month` (1-12) of `year`.
    public static func daysInMonth(year: Int, month: Int) -> Int {
        switch month {
        case 2: return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 ? 29 : 28
        case 4, 6, 9, 11: return 30
        default: return 31
        }
    }

    /// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
    static func daysFromCivil(year: Int, month: Int, day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = floorDiv(y, 400)
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    /// Proleptic Gregorian date of a day count since 1970-01-01.
    static func civilFromDays(_ days: Int64) -> (year: Int, month: Int, day: Int) {
        let z = Int(days) + 719_468
        let era = floorDiv(z, 146_097)
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = doy - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        return (yoe + era * 400 + (month <= 2 ? 1 : 0), month, day)
    }

    static func floorDiv<T: BinaryInteger>(_ a: T, _ b: T) -> T {
        let q = a / b
        return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
    }

    static func floorMod<T: BinaryInteger>(_ a: T, _ b: T) -> T {
        a - floorDiv(a, b) * b
    }

    static func pad(_ n: Int, _ width: Int = 2) -> String {
        let s = String(n)
        return s.count >= width ? s : String(repeating: "0", count: width - s.count) + s
    }

    // MARK: - Floating and fixed strings

    /// True for a floating (offset-less) date-time string.
    public static func isFloating(_ value: String) -> Bool {
        parseFloating(value) != nil
    }

    /// Parses a floating date-time string (`YYYY-MM-DDTHH:mm[:ss[.sss]]`) to naive ms, or nil. Out-of-range days
    /// roll over like `Date.UTC`.
    public static func parseFloating(_ value: String) -> Int64? {
        let re = #/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/#.asciiOnlyDigits()
        guard let m = value.wholeMatch(of: re) else { return nil }
        let ms = m.7.map { Int($0.padding(toLength: 3, withPad: "0", startingAt: 0))! } ?? 0
        return utcMilliseconds(
            year: Int(m.1)!, month: Int(m.2)!, day: Int(m.3)!, hour: Int(m.4)!, minute: Int(m.5)!,
            second: m.6.map { Int($0)! } ?? 0, millisecond: ms)
    }

    /// Parses a fixed ISO date-time with `Z` or an offset (`±HH:MM` / `±HHMM`) to epoch ms, or nil. Validation
    /// follows JavaScript's `Date.parse`: days 1-31 roll over within the month, hour 24 only at exactly midnight.
    public static func parseFixed(_ value: String) -> Int64? {
        let re = #/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))$/#
            .asciiOnlyDigits()
        guard let m = value.wholeMatch(of: re) else { return nil }
        let (month, day, hour, minute) = (Int(m.2)!, Int(m.3)!, Int(m.4)!, Int(m.5)!)
        let second = m.6.map { Int($0)! } ?? 0
        let ms = m.7.map { Int($0.padding(toLength: 3, withPad: "0", startingAt: 0))! } ?? 0
        guard (1...12).contains(month), (1...31).contains(day), minute <= 59, second <= 59,
            hour < 24 || (hour == 24 && minute == 0 && second == 0 && ms == 0)
        else { return nil }
        var offset: Int64 = 0
        if m.8 == nil, let sign = m.9, let oh = m.10.flatMap({ Int($0) }), let om = m.11.flatMap({ Int($0) }) {
            guard oh <= 23, om <= 59 else { return nil }
            offset = Int64(oh * 3_600_000 + om * 60_000) * (sign == "-" ? -1 : 1)
        }
        return utcMilliseconds(
            year: Int(m.1)!, month: month, day: day, hour: hour, minute: minute, second: second, millisecond: ms)
            - offset
    }

    /// Formats a JavaScript-style ISO string body without the trailing `Z` (`YYYY-MM-DDTHH:mm:ss.sss`).
    static func isoBody(_ ms: Int64) -> String {
        let p = wallParts(ms)
        let year = (0...9999).contains(p.year) ? pad(p.year, 4) : (p.year < 0 ? "-" : "+") + pad(abs(p.year), 6)
        return "\(year)-\(pad(p.month))-\(pad(p.day))T\(pad(p.hour)):\(pad(p.minute)):\(pad(p.second)).\(pad(p.millisecond, 3))"
    }

    /// Formats naive ms as a canonical floating string `YYYY-MM-DDTHH:mm:ss.sss`.
    public static func formatFloating(_ naive: Int64) -> String {
        isoBody(naive)
    }

    /// Formats an instant (epoch ms) as a canonical fixed string `YYYY-MM-DDTHH:mm:ss.sssZ`.
    public static func formatFixed(milliseconds: Int64) -> String {
        isoBody(milliseconds) + "Z"
    }

    /// Formats an instant as a canonical fixed string `YYYY-MM-DDTHH:mm:ss.sssZ`.
    public static func formatFixed(_ instant: Date) -> String {
        formatFixed(milliseconds: milliseconds(instant))
    }

    /// Normalises a date-time string to canonical stored form: floating stays floating (with seconds and
    /// milliseconds); fixed or offset forms become `…Z`. Returns nil when the string is not an ISO date-time.
    public static func normaliseIsoDate(_ value: String) -> String? {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let naive = parseFloating(v) { return formatFloating(naive) }
        return parseFixed(v).map { formatFixed(milliseconds: $0) }
    }

    // MARK: - Stored date values

    /// Resolves a stored date value (fixed or floating) to an instant (epoch ms), or nil when it is neither.
    public static func dateValueToMilliseconds(_ value: String, timeZone: String) -> Int64? {
        if let naive = parseFloating(value) { return naiveToInstant(naive, timeZone: timeZone) }
        return parseFixed(value)
    }

    /// Resolves a stored date value (fixed or floating) to an instant, or nil when it is neither.
    public static func dateValueToInstant(_ value: String, timeZone: String) -> Date? {
        dateValueToMilliseconds(value, timeZone: timeZone).map { date(milliseconds: $0) }
    }

    /// Resolves a stored date value to naive wall-clock ms in `timeZone`, or nil when it is not a date value.
    public static func dateValueToNaive(_ value: String, timeZone: String) -> Int64? {
        if let naive = parseFloating(value) { return naive }
        return parseFixed(value).map { instantToNaive(milliseconds: $0, timeZone: timeZone) }
    }

    /// Converts naive ms back to a stored representation: floating stays floating; fixed is resolved in `timeZone`.
    public static func naiveToDateValue(_ naive: Int64, floating: Bool, timeZone: String) -> String {
        floating ? formatFloating(naive) : formatFixed(milliseconds: naiveToInstant(naive, timeZone: timeZone))
    }

    // MARK: - Day keys

    /// `YYYY-MM-DD` of naive ms.
    public static func dayKeyOfNaive(_ naive: Int64) -> String {
        String(isoBody(naive).prefix(10))
    }

    /// `YYYY-MM-DD` of the local day containing `instant` in `timeZone`.
    public static func localDayKey(_ instant: Date, timeZone: String) -> String {
        dayKeyOfNaive(instantToNaive(instant, timeZone: timeZone))
    }

    /// Naive ms of midnight for a `YYYY-MM-DD` day key, or nil when `key` is not a day key.
    public static func dayKeyToNaive(_ key: String) -> Int64? {
        guard let m = key.wholeMatch(of: #/(\d{4})-(\d{2})-(\d{2})/#.asciiOnlyDigits()) else { return nil }
        return utcMilliseconds(year: Int(m.1)!, month: Int(m.2)!, day: Int(m.3)!)
    }

    /// True when `key` has the form `YYYY-MM-DD`.
    public static func isDayKey(_ key: String) -> Bool {
        dayKeyToNaive(key) != nil
    }

    /// Year, month and day of a day key, read leniently like the web client (missing parts become 1970-01-01).
    static func keyParts(_ key: String) -> (year: Int, month: Int, day: Int) {
        let parts = key.split(separator: "-", omittingEmptySubsequences: false).map { Int($0) }
        func part(_ i: Int, _ fallback: Int) -> Int { i < parts.count ? parts[i] ?? fallback : fallback }
        return (part(0, 1970), part(1, 1), part(2, 1))
    }

    /// Adds `days` calendar days to a day key.
    public static func addDaysToKey(_ key: String, _ days: Int) -> String {
        let p = keyParts(key)
        return dayKeyOfNaive(utcMilliseconds(year: p.year, month: p.month, day: p.day + days))
    }

    /// Instant of local midnight starting day `key` in `timeZone`, or nil when `key` is not a day key.
    public static func dayStartInstant(_ key: String, timeZone: String) -> Date? {
        dayKeyToNaive(key).map { date(milliseconds: naiveToInstant($0, timeZone: timeZone)) }
    }

    /// Adds calendar units to naive ms (months and years clamp the day to the month's length).
    public static func addToNaive(_ naive: Int64, _ amount: Int, _ unit: Unit) -> Int64 {
        switch unit {
        case .minute: return naive + Int64(amount) * 60_000
        case .hour: return naive + Int64(amount) * 3_600_000
        case .day: return naive + Int64(amount) * millisecondsPerDay
        case .week: return naive + Int64(amount) * 7 * millisecondsPerDay
        case .month, .year:
            let p = wallParts(naive)
            let total = p.year * 12 + (p.month - 1) + (unit == .year ? amount * 12 : amount)
            let year = floorDiv(total, 12)
            let month = total - year * 12 + 1
            return utcMilliseconds(
                year: year, month: month, day: min(p.day, daysInMonth(year: year, month: month)), hour: p.hour,
                minute: p.minute, second: p.second, millisecond: p.millisecond)
        }
    }
}
