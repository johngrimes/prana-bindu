// Author: John Grimes

import Foundation

/// Choices and texts of the settings page (spec §6). Port of the pure parts of `src/web/pages/SettingsPage.tsx`.
public enum SettingsOptions {
    /// Due-soon thresholds in seconds; 0 ("Today") means due by the end of today.
    public static let dueSoon: [RuleOption<Int>] = [
        RuleOption(0, "Today"), RuleOption(86_400, "24 hours"), RuleOption(172_800, "2 days"),
        RuleOption(259_200, "3 days"), RuleOption(345_600, "4 days"), RuleOption(432_000, "5 days"),
        RuleOption(518_400, "6 days"), RuleOption(604_800, "1 week"),
    ]

    /// First-weekday choices, 1 = Sunday … 7 = Saturday.
    public static let weekdays: [RuleOption<Int>] = [
        "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
    ].enumerated().map { RuleOption($0.offset + 1, $0.element) }

    /// Date format choices, labelled by their pattern.
    public static let dateFormats: [Settings.DateFormat] = Settings.DateFormat.allCases

    /// The confirmation text of Restore Defaults.
    public static let restoreDefaultsMessage =
        "Date format, week start, time format, default times, due soon, theme and forecast tag return to their defaults. The time zone is kept."

    /// IANA time zone names, sorted; `current` is put first when the system does not know it, so the picker can
    /// always show the stored value.
    public static func timeZones(including current: String) -> [String] {
        let known = TimeZone.knownTimeZoneIdentifiers.sorted()
        return known.contains(current) ? known : [current] + known
    }

    /// This device's IANA time zone.
    public static var deviceTimeZone: String { TimeZone.current.identifier }

    /// "HH:MM" for a time of day.
    public static func hhmm(hour: Int, minute: Int) -> String {
        "\(DateTime.pad(hour)):\(DateTime.pad(minute))"
    }

    /// "HH:MM" of a date in the device calendar (a time picker's value).
    public static func hhmm(from date: Date) -> String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return hhmm(hour: parts.hour ?? 0, minute: parts.minute ?? 0)
    }

    /// Today at the "HH:MM" time in the device calendar (a time picker's value).
    public static func date(fromHHMM text: String) -> Date {
        let time = DateDisplay.parseHHMM(text)
        return Calendar.current.date(bySettingHour: time.hour, minute: time.minute, second: 0, of: Date()) ?? Date()
    }

    /// "Created … · last used …" (or "never used") under a passkey.
    public static func subtitle(of passkey: Passkey, settings: Settings) -> String {
        "Created \(DateDisplay.formatDateTime(passkey.createdAt, settings: settings)) · \(lastUsed(passkey.lastUsedAt, settings))"
    }

    /// "<prefix>… · created … · last used …" (or "never used") under an API token.
    public static func subtitle(of token: ApiToken, settings: Settings) -> String {
        "\(token.prefix)… · created \(DateDisplay.formatDateTime(token.createdAt, settings: settings)) · \(lastUsed(token.lastUsedAt, settings))"
    }

    /// The warning shown before deleting the last passkey.
    public static func lastPasskeyWarning(name: String) -> String {
        "After deleting “\(name)” no passkey can sign in. You will need a new enrollment link from the CLI (prana-bindu passkey enroll) to sign in again."
    }

    /// The web settings page, where a passkey can be added (registration needs a browser session).
    public static func passkeySetupURL(origin: URL) -> URL {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) ?? URLComponents()
        components.path = "/settings"
        components.query = nil
        return components.url ?? origin.appending(path: "settings")
    }

    private static func lastUsed(_ value: String?, _ settings: Settings) -> String {
        guard let value else { return "never used" }
        return "last used \(DateDisplay.formatDateTime(value, settings: settings))"
    }
}
