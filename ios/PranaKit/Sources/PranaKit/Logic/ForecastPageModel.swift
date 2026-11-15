// Author: John Grimes

import Foundation

/// The Forecast page's calendar, day strip and sections (spec §4 Forecast). Port of `src/web/pages/ForecastPage.tsx`.
public enum ForecastPageModel {
    /// A strip button's two lines.
    public struct Label: Hashable, Sendable {
        public var top: String
        public var bottom: String

        /// Creates a label.
        public init(top: String, bottom: String) {
            self.top = top
            self.bottom = bottom
        }
    }

    /// The sidebar calendar's 35 days: five weeks from the first calendar day the server sent, or from the start of
    /// the current week (honouring `firstWeekday`, 1 = Sunday).
    public static func calendarCells(_ forecast: ForecastResponse, firstWeekday: Int) -> [String] {
        let start = forecast.calendar.first?.date ?? DateDisplay.startOfWeekKey(forecast.today, firstWeekday: firstWeekday)
        return (0..<35).map { DateTime.addDaysToKey(start, $0) }
    }

    /// Two-letter weekday column headers starting on `firstWeekday`.
    public static func weekdayHeaders(firstWeekday: Int) -> [String] {
        (0..<7).map { String(DateDisplay.weekdayName(firstWeekday - 1 + $0).prefix(2)) }
    }

    /// Whether a calendar day lies before today (shown disabled).
    public static func isPast(_ date: String, today: String) -> Bool { date < today }

    /// The day of the month of a `YYYY-MM-DD` key (calendar cells).
    public static func dayOfMonth(_ key: String) -> Int { DateTime.keyParts(key).day }

    /// The strip label: Past, Today, Future, or the weekday over the day of the month.
    public static func label(_ day: ForecastDay, today: String) -> Label {
        if day.key == "PAST" { return Label(top: "Past", bottom: "") }
        if day.key == "FUTURE" { return Label(top: "Future", bottom: "") }
        if day.key == "TODAY" || day.date == today { return Label(top: "Today", bottom: "") }
        let p = DateTime.keyParts(day.date ?? day.key)
        return Label(top: DateDisplay.weekdayName(DateDisplay.weekdayOf(year: p.year, month: p.month, day: p.day)), bottom: String(p.day))
    }

    /// The `?day=` value a strip button selects: `TODAY` for today, else the date or the key.
    public static func selectionKey(_ day: ForecastDay, today: String) -> String {
        day.key == "TODAY" || day.date == today ? "TODAY" : (day.date ?? day.key)
    }

    /// Whether `selected` is a date outside the loaded days (it is then loaded on its own).
    public static func isOutside(_ forecast: ForecastResponse, selected: String?) -> Bool {
        guard let selected, isDateKey(selected) else { return false }
        return !forecast.days.contains { $0.key == selected || $0.date == selected }
    }

    /// The outline sections: Past, Today, each day, Future; just one when `selected` picks it. A day outside the
    /// loaded range comes from `single` (nothing until it has loaded).
    public static func groups(_ forecast: ForecastResponse, single: ForecastResponse?, selected: String?) -> [OutlineGroup] {
        let outside = isOutside(forecast, selected: selected)
        let source: [ForecastDay] = outside ? (single?.days.filter { $0.date == selected } ?? []) : forecast.days
        return source
            .filter { d in
                guard let selected, !outside else { return true }
                return d.key == selected || d.date == selected || (selected == "TODAY" && d.date == forecast.today)
            }
            .map { d in
                let title: String =
                    if d.key == "PAST" { "Past" } else if d.key == "FUTURE" { "Future" } else if d.key == "TODAY" || d.date == forecast.today {
                        "Today — \(DateDisplay.formatDayKey(d.date ?? forecast.today))"
                    } else if let date = d.date { DateDisplay.formatDayKey(date) } else { d.title }
                return OutlineGroup(key: d.key, title: title, kind: .date, rows: d.rows)
            }
    }

    /// Whether `text` is a `YYYY-MM-DD` key.
    public static func isDateKey(_ text: String) -> Bool {
        text.wholeMatch(of: /\d{4}-\d{2}-\d{2}/) != nil
    }
}
