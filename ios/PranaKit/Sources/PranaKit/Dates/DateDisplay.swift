// Author: John Grimes

import Foundation

/// The three task date fields that take natural-language input and have default times (spec §1.2, §7).
public enum DateField: String, Codable, Sendable, Hashable, CaseIterable {
    case `defer`, due, planned
}

/// Wall-clock year, month, day, hour and minute (no zone).
public struct WallTime: Sendable, Hashable {
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

    /// Creates a wall time from its components.
    public init(year: Int, month: Int, day: Int, hour: Int, minute: Int) {
        self.year = year
        self.month = month
        self.day = day
        self.hour = hour
        self.minute = minute
    }
}

/// Client-side date display and arithmetic. Port of `src/web/lib/dates.ts`.
///
/// Dates are fixed (`…Z`) or floating wall times interpreted in the user's time zone (spec §1.1). The server is
/// authoritative; these helpers only render values and compute the floating strings the UI sends.
public enum DateDisplay {
    /// An hour and minute of the day.
    public struct TimeOfDay: Sendable, Hashable {
        /// Hour, 0-23.
        public var hour: Int
        /// Minute, 0-59.
        public var minute: Int

        /// Creates a time of day.
        public init(hour: Int, minute: Int) {
            self.hour = hour
            self.minute = minute
        }
    }

    /// Calendar units for wall-time arithmetic (the inspector's +1 buttons use day, week and month).
    public enum WallUnit: Sendable, Hashable, CaseIterable {
        case day, week, month, year
    }

    private static let weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// The device's current IANA time zone name (the web client's `browserTimeZone`).
    public static var deviceTimeZone: String {
        TimeZone.current.identifier
    }

    // MARK: - Wall time

    /// Wall-clock components of `instant` in `timeZone`.
    public static func instantToWall(_ instant: Date, timeZone: String) -> WallTime {
        wall(DateTime.wallParts(DateTime.instantToNaive(instant, timeZone: timeZone)))
    }

    private static func wall(_ p: DateTime.WallParts) -> WallTime {
        WallTime(year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute)
    }

    /// Wall time of a stored date value: fixed values are converted into `timeZone`; floating values (and bare
    /// `YYYY-MM-DD` days, read as midnight) are taken as written. Nil when `value` is not a date.
    public static func toWall(_ value: String, timeZone: String) -> WallTime? {
        if value.hasSuffix("Z") || value.contains(#/[+-]\d{2}:\d{2}$/#) {
            return DateTime.parseFixed(value).map {
                wall(DateTime.wallParts(DateTime.instantToNaive(milliseconds: $0, timeZone: timeZone)))
            }
        }
        if let m = value.prefixMatch(of: #/(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/#.asciiOnlyDigits()) {
            return WallTime(
                year: Int(m.1)!, month: Int(m.2)!, day: Int(m.3)!, hour: m.4.map { Int($0)! } ?? 0,
                minute: m.5.map { Int($0)! } ?? 0)
        }
        return DateTime.parseFixed(value).map {
            wall(DateTime.wallParts(DateTime.instantToNaive(milliseconds: $0, timeZone: timeZone)))
        }
    }

    /// Floating string `YYYY-MM-DDTHH:mm:00.000` of a wall time.
    public static func wallToFloating(_ w: WallTime) -> String {
        "\(wallDayKey(w))T\(DateTime.pad(w.hour)):\(DateTime.pad(w.minute)):00.000"
    }

    /// `YYYY-MM-DD` of a wall time.
    public static func wallDayKey(_ w: WallTime) -> String {
        wallDayKey(year: w.year, month: w.month, day: w.day)
    }

    /// `YYYY-MM-DD` of a calendar day.
    public static func wallDayKey(year: Int, month: Int, day: Int) -> String {
        "\(DateTime.pad(year, 4))-\(DateTime.pad(month))-\(DateTime.pad(day))"
    }

    /// `YYYY-MM-DD` of today in `timeZone`.
    public static func todayKey(timeZone: String, now: Date) -> String {
        wallDayKey(instantToWall(now, timeZone: timeZone))
    }

    /// `YYYY-MM-DD` of a stored date value in `timeZone`, or nil when it is not a date.
    public static func dayKeyOf(_ value: String, timeZone: String) -> String? {
        toWall(value, timeZone: timeZone).map(wallDayKey)
    }

    /// Calendar arithmetic on wall time (floating values carry no offset, so there are no DST concerns). Months and
    /// years clamp the day to the month's length.
    public static func addToWall(_ w: WallTime, _ amount: Int, _ unit: WallUnit) -> WallTime {
        switch unit {
        case .day, .week:
            let naive = DateTime.utcMilliseconds(year: w.year, month: w.month, day: w.day + amount * (unit == .week ? 7 : 1))
            let p = DateTime.wallParts(naive)
            return WallTime(year: p.year, month: p.month, day: p.day, hour: w.hour, minute: w.minute)
        case .month, .year:
            let total = w.year * 12 + (w.month - 1) + amount * (unit == .year ? 12 : 1)
            let year = DateTime.floorDiv(total, 12)
            let month = DateTime.floorMod(total, 12) + 1
            return WallTime(
                year: year, month: month, day: min(w.day, DateTime.daysInMonth(year: year, month: month)), hour: w.hour,
                minute: w.minute)
        }
    }

    // MARK: - Default times

    /// Parses `HH:MM` leniently (non-numeric parts become 0).
    public static func parseHHMM(_ text: String) -> TimeOfDay {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        return TimeOfDay(
            hour: parts.first.flatMap { Int($0) } ?? 0, minute: parts.count > 1 ? Int(parts[1]) ?? 0 : 0)
    }

    /// The default time of day for `field` from the user's settings.
    public static func defaultTime(for field: DateField, settings: Settings) -> TimeOfDay {
        switch field {
        case .defer: parseHHMM(settings.defaultDeferTime)
        case .due: parseHHMM(settings.defaultDueTime)
        case .planned: parseHHMM(settings.defaultPlannedTime)
        }
    }

    /// The inspector's +1 day / week / month buttons: adds to the current value or, when the field is empty (or not
    /// a date), starts from today at the field's default time. Returns a floating date string.
    public static func bumpDate(
        _ value: String?, _ amount: Int, _ unit: WallUnit, field: DateField, settings: Settings, now: Date
    ) -> String {
        let base: WallTime
        if let value, !value.isEmpty, let w = toWall(value, timeZone: settings.timeZone) {
            base = w
        } else {
            var today = instantToWall(now, timeZone: settings.timeZone)
            let time = defaultTime(for: field, settings: settings)
            today.hour = time.hour
            today.minute = time.minute
            base = today
        }
        return wallToFloating(addToWall(base, amount, unit))
    }

    /// Replaces the calendar day of a date, keeping its time (or the field's default time when empty).
    public static func withDay(_ value: String?, dayKey: String, field: DateField, settings: Settings) -> String {
        let p = DateTime.keyParts(dayKey)
        let time: TimeOfDay =
            if let value, !value.isEmpty, let w = toWall(value, timeZone: settings.timeZone) {
                TimeOfDay(hour: w.hour, minute: w.minute)
            } else {
                defaultTime(for: field, settings: settings)
            }
        return wallToFloating(WallTime(year: p.year, month: p.month, day: p.day, hour: time.hour, minute: time.minute))
    }

    // MARK: - Formatting

    /// A calendar day in the user's `dateFormat`, e.g. `25/12/2026`.
    public static func formatDayOnly(year: Int, month: Int, day: Int, dateFormat: Settings.DateFormat) -> String {
        let (yyyy, mm, dd) = (DateTime.pad(year, 4), DateTime.pad(month), DateTime.pad(day))
        switch dateFormat {
        case .dayMonthYear: return "\(dd)/\(mm)/\(yyyy)"
        case .yearMonthDaySlash: return "\(yyyy)/\(mm)/\(dd)"
        case .iso: return "\(yyyy)-\(mm)-\(dd)"
        case .monthDayYear: return "\(mm)/\(dd)/\(yyyy)"
        }
    }

    /// The calendar day of `w` in the user's `dateFormat`.
    public static func formatDayOnly(_ w: WallTime, dateFormat: Settings.DateFormat) -> String {
        formatDayOnly(year: w.year, month: w.month, day: w.day, dateFormat: dateFormat)
    }

    /// A time of day, `17:00` (24-hour) or `5:00 PM` (12-hour).
    public static func formatTime(hour: Int, minute: Int, use24HourTime: Bool) -> String {
        if use24HourTime { return "\(DateTime.pad(hour)):\(DateTime.pad(minute))" }
        let suffix = hour < 12 ? "AM" : "PM"
        let h = hour % 12 == 0 ? 12 : hour % 12
        return "\(h):\(DateTime.pad(minute)) \(suffix)"
    }

    /// The time of day of `w`, `17:00` (24-hour) or `5:00 PM` (12-hour).
    public static func formatTime(_ w: WallTime, use24HourTime: Bool) -> String {
        formatTime(hour: w.hour, minute: w.minute, use24HourTime: use24HourTime)
    }

    /// Day of the week of a calendar day, 0 = Sunday … 6 = Saturday.
    public static func weekdayOf(year: Int, month: Int, day: Int) -> Int {
        DateTime.wallParts(DateTime.utcMilliseconds(year: year, month: month, day: day)).weekday
    }

    /// Short English weekday name (`Sun` … `Sat`); the index wraps modulo 7.
    public static func weekdayName(_ index: Int) -> String {
        weekdayNames[DateTime.floorMod(index, 7)]
    }

    /// Short English month name (`Jan` … `Dec`) for a 1-based month, or "" when out of range.
    public static func monthName(_ month: Int) -> String {
        (1...12).contains(month) ? monthNames[month - 1] : ""
    }

    /// Full date and time, e.g. `Fri 11/06/2026 5:00 PM` (inspector read-only fields). "" for nil or non-dates.
    public static func formatDateTime(_ value: String?, settings: Settings) -> String {
        guard let value, !value.isEmpty, let w = toWall(value, timeZone: settings.timeZone) else { return "" }
        let weekday = weekdayName(weekdayOf(year: w.year, month: w.month, day: w.day))
        return "\(weekday) \(formatDayOnly(w, dateFormat: settings.dateFormat)) \(formatTime(w, use24HourTime: settings.use24HourTime))"
    }

    /// Editable text of a date for the inspector's natural-language field, e.g. `11/06/2026 5:00 PM`. "" for nil or
    /// non-dates.
    public static func formatDateInput(_ value: String?, settings: Settings) -> String {
        guard let value, !value.isEmpty, let w = toWall(value, timeZone: settings.timeZone) else { return "" }
        return "\(formatDayOnly(w, dateFormat: settings.dateFormat)) \(formatTime(w, use24HourTime: settings.use24HourTime))"
    }

    /// Whole calendar days from day key `b` to day key `a`.
    private static func dayDiff(_ a: String, _ b: String) -> Int {
        let pa = DateTime.keyParts(a)
        let pb = DateTime.keyParts(b)
        let diff = DateTime.utcMilliseconds(year: pa.year, month: pa.month, day: pa.day)
            - DateTime.utcMilliseconds(year: pb.year, month: pb.month, day: pb.day)
        return Int(diff / DateTime.millisecondsPerDay)
    }

    /// Compact chip label: `Today`, `Tomorrow`, `Yesterday`, the weekday within the coming week, else the date; adds
    /// the time unless it is midnight. Returns `value` unchanged when it is not a date.
    public static func formatDateChip(_ value: String, settings: Settings, now: Date) -> String {
        guard let w = toWall(value, timeZone: settings.timeZone) else { return value }
        let diff = dayDiff(wallDayKey(w), todayKey(timeZone: settings.timeZone, now: now))
        let day: String =
            switch diff {
            case 0: "Today"
            case 1: "Tomorrow"
            case -1: "Yesterday"
            case 2..<7: weekdayName(weekdayOf(year: w.year, month: w.month, day: w.day))
            default: formatDayOnly(w, dateFormat: settings.dateFormat)
            }
        if w.hour == 0 && w.minute == 0 { return day }
        return "\(day) \(formatTime(w, use24HourTime: settings.use24HourTime))"
    }

    /// Calendar-day label for a `YYYY-MM-DD` key, e.g. `Mon, Nov 2`.
    public static func formatDayKey(_ key: String) -> String {
        let p = DateTime.keyParts(key)
        return "\(weekdayName(weekdayOf(year: p.year, month: p.month, day: p.day))), \(monthName(p.month)) \(p.day)"
    }

    /// Start of the week containing `key`, honouring `firstWeekday` (1 = Sunday … 7 = Saturday).
    public static func startOfWeekKey(_ key: String, firstWeekday: Int) -> String {
        let p = DateTime.keyParts(key)
        let weekday = weekdayOf(year: p.year, month: p.month, day: p.day)
        let offset = DateTime.floorMod(weekday - (firstWeekday - 1), 7)
        return DateTime.addDaysToKey(key, -offset)
    }
}
