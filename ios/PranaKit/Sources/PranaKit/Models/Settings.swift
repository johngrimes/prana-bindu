// Author: John Grimes

import Foundation

/// User settings (`GET /api/v1/settings`, spec §1.2). Mirrors `Settings` in `src/shared/schemas.ts`.
public struct Settings: Codable, Sendable, Hashable {
    /// How dates are written and read in the UI (spec §1.2, §7).
    public enum DateFormat: String, Codable, Sendable, CaseIterable {
        case monthDayYear = "MM/dd/yyyy"
        case dayMonthYear = "dd/MM/yyyy"
        case yearMonthDaySlash = "yyyy/MM/dd"
        case iso = "yyyy-MM-dd"
    }

    /// Light/dark appearance.
    public enum Theme: String, Codable, Sendable, CaseIterable {
        case system, light, dark
    }

    /// IANA time zone name in which floating dates are interpreted.
    public var timeZone: String
    public var dateFormat: DateFormat
    /// 1 = Sunday … 7 = Saturday.
    public var firstWeekday: Int
    public var use24HourTime: Bool
    /// "HH:MM".
    public var defaultDeferTime: String
    /// "HH:MM".
    public var defaultDueTime: String
    /// "HH:MM".
    public var defaultPlannedTime: String
    /// Due-soon threshold in seconds; 0 means "due by the end of today".
    public var dueSoonSeconds: Int
    public var theme: Theme
    /// Tag whose items Forecast's Today also shows, or nil.
    public var forecastTagId: String?

    public init(
        timeZone: String, dateFormat: DateFormat, firstWeekday: Int, use24HourTime: Bool, defaultDeferTime: String,
        defaultDueTime: String, defaultPlannedTime: String, dueSoonSeconds: Int, theme: Theme, forecastTagId: String?
    ) {
        self.timeZone = timeZone
        self.dateFormat = dateFormat
        self.firstWeekday = firstWeekday
        self.use24HourTime = use24HourTime
        self.defaultDeferTime = defaultDeferTime
        self.defaultDueTime = defaultDueTime
        self.defaultPlannedTime = defaultPlannedTime
        self.dueSoonSeconds = dueSoonSeconds
        self.theme = theme
        self.forecastTagId = forecastTagId
    }

    /// The server's defaults (spec §1.2), in the given time zone.
    public static func defaults(timeZone: String) -> Settings {
        Settings(
            timeZone: timeZone, dateFormat: .monthDayYear, firstWeekday: 1, use24HourTime: false,
            defaultDeferTime: "00:00", defaultDueTime: "17:00", defaultPlannedTime: "09:00", dueSoonSeconds: 172_800,
            theme: .system, forecastTagId: nil)
    }
}
