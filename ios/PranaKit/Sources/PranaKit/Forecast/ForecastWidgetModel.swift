// Author: John Grimes

import Foundation

/// The widget sizes the Forecast widget draws (spec §13 "Sizes").
public enum ForecastWidgetFamily: String, Codable, Sendable, CaseIterable {
    case medium, large

    /// How many of Today's items fit: 2 in medium, 8 in large.
    public var rowLimit: Int {
        switch self {
        case .medium: 2
        case .large: 8
        }
    }
}

/// How urgent a due item is: the colour of its strip dot and of its row's chip.
public enum ForecastWidgetTone: String, Codable, Sendable, Hashable {
    /// Red.
    case overdue
    /// Yellow.
    case dueSoon
    /// Grey (dots only; a chip without urgency has no background).
    case due

    /// Most urgent first.
    var severity: Int {
        switch self {
        case .overdue: 0
        case .dueSoon: 1
        case .due: 2
        }
    }
}

/// The state a row's status circle shows, with the web app's precedence (`StatusCircle.tsx`).
public enum ForecastWidgetCircle: String, Codable, Sendable, Hashable {
    case overdue, dueSoon, flagged, blocked, repeating, next, available

    /// The circle state of `task`: overdue, due soon, flagged, blocked, repeating, first available, else available.
    public init(_ task: TaskItem) {
        self =
            if task.overdue { .overdue }
            else if task.dueSoon { .dueSoon }
            else if task.effectiveFlagged { .flagged }
            else if task.blocked { .blocked }
            else if task.repeat != nil { .repeating }
            else if task.firstAvailable { .next }
            else { .available }
    }
}

/// One column of the strip: Past, Today, a weekday or Future.
public struct ForecastWidgetColumn: Codable, Sendable, Hashable, Identifiable {
    /// `PAST`, `TODAY`, `YYYY-MM-DD` or `FUTURE`.
    public var key: String
    /// "Past", "Today", a short weekday name or "Future".
    public var title: String
    /// The API's count for the column (Today includes Past, as in the web app's Forecast).
    public var count: Int
    /// One dot per item due in this column, most urgent first, at most four.
    public var dots: [ForecastWidgetTone]

    /// The column key.
    public var id: String { key }
    /// Zero counts are drawn faint.
    public var isDimmed: Bool { count == 0 }
    /// Today is always highlighted.
    public var isHighlighted: Bool { key == "TODAY" }
    /// Tapping the column opens this day of the app's Forecast.
    public var url: URL { ForecastWidgetLinks.day(key) }

    /// Creates a column.
    public init(key: String, title: String, count: Int, dots: [ForecastWidgetTone]) {
        self.key = key
        self.title = title
        self.count = count
        self.dots = dots
    }
}

/// A due chip: the web app's wording, red when overdue, yellow when due soon, plain otherwise.
public struct ForecastWidgetChip: Codable, Sendable, Hashable {
    public var text: String
    /// `.overdue`, `.dueSoon` or nil (never `.due`).
    public var tone: ForecastWidgetTone?

    /// Creates a chip.
    public init(text: String, tone: ForecastWidgetTone?) {
        self.text = text
        self.tone = tone
    }
}

/// One of Today's items.
public struct ForecastWidgetRow: Codable, Sendable, Hashable {
    public var name: String
    /// Projects get square status shapes.
    public var isProject: Bool
    public var circle: ForecastWidgetCircle
    /// Drawn as an orange corner.
    public var isFlagged: Bool
    /// The name is dimmed when the item is not available (projects only when deferred).
    public var isDimmed: Bool
    public var chip: ForecastWidgetChip?

    /// Creates a row.
    public init(name: String, isProject: Bool, circle: ForecastWidgetCircle, isFlagged: Bool, isDimmed: Bool, chip: ForecastWidgetChip?) {
        self.name = name
        self.isProject = isProject
        self.circle = circle
        self.isFlagged = isFlagged
        self.isDimmed = isDimmed
        self.chip = chip
    }

    /// The SF Symbol for blocked (dashed) and repeating (dotted) states; nil means a plain ring drawn in the circle's
    /// colours.
    public var symbolName: String? {
        let shape = isProject ? "square" : "circle"
        switch circle {
        case .blocked: return "\(shape).dashed"
        case .repeating: return "\(shape).dotted"
        default: return nil
        }
    }
}

/// What the Forecast widget draws, computed from `GET /forecast?days=5` and `GET /settings` (port of `buildModel` in
/// `scriptable/prana-bindu-forecast.js`).
public struct ForecastWidgetModel: Codable, Sendable, Hashable {
    /// Shown in place of rows when Today is empty.
    public static let emptyText = "No items"
    /// The forecast the widget requests: Today plus the next four days (the API adds Past and Future).
    public static let days = 5
    /// At most this many dots per column.
    static let maxDots = 4

    public var columns: [ForecastWidgetColumn]
    /// Today's items in API order, as many as the large size shows.
    public var rows: [ForecastWidgetRow]

    /// Creates a model directly (previews).
    public init(columns: [ForecastWidgetColumn], rows: [ForecastWidgetRow]) {
        self.columns = columns
        self.rows = rows
    }

    /// Computes the strip and Today's rows; `now` dates the chips.
    public init(forecast: ForecastResponse, settings: Settings, now: Date) {
        let today = forecast.today
        let lastDay = forecast.days.compactMap(\.date).last ?? today
        columns = forecast.days.map { day in
            ForecastWidgetColumn(
                key: day.key, title: Self.title(of: day), count: day.count,
                dots: Self.dots(day, timeZone: settings.timeZone, today: today, lastDay: lastDay))
        }
        let todayRows = forecast.days.first { $0.key == "TODAY" }?.rows ?? []
        rows = todayRows.compactMap { row -> ForecastWidgetRow? in
            guard let task = Self.task(of: row) else { return nil }
            let isProject = row.kind == .project
            return ForecastWidgetRow(
                name: task.name, isProject: isProject, circle: ForecastWidgetCircle(task), isFlagged: task.effectiveFlagged,
                // A project with remaining actions is always blocked, so projects dim only when deferred.
                isDimmed: isProject ? task.deferred : !task.available,
                chip: task.effectiveDueDate.map {
                    ForecastWidgetChip(
                        text: DateDisplay.formatDateChip($0, settings: settings, now: now),
                        tone: task.overdue ? .overdue : task.dueSoon ? .dueSoon : nil)
                })
        }
        .prefix(ForecastWidgetFamily.large.rowLimit)
        .map { $0 }
    }

    /// The rows a widget of `family` lists; a stale widget gives one row's place to the "Updated" note.
    public func rows(for family: ForecastWidgetFamily, stale: Bool) -> [ForecastWidgetRow] {
        Array(rows.prefix(family.rowLimit - (stale ? 1 : 0)))
    }

    private static func task(of row: OutlineRow) -> TaskItem? { row.task ?? row.project?.task }

    private static func title(of day: ForecastDay) -> String {
        switch day.key {
        case "PAST": return "Past"
        case "TODAY": return "Today"
        case "FUTURE": return "Future"
        default:
            let parts = (day.date ?? day.key).split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return day.title }
            return DateDisplay.weekdayName(DateDisplay.weekdayOf(year: parts[0], month: parts[1], day: parts[2]))
        }
    }

    /// One dot per item that is due in this column (not merely planned there), most urgent first.
    private static func dots(_ day: ForecastDay, timeZone: String, today: String, lastDay: String) -> [ForecastWidgetTone] {
        let inColumn: (String) -> Bool =
            switch day.key {
            case "PAST": { $0 < today }
            case "TODAY": { $0 <= today }
            case "FUTURE": { $0 > lastDay }
            default: { $0 == day.date }
            }
        let tones = day.rows.compactMap { row -> ForecastWidgetTone? in
            guard let task = task(of: row), let due = task.effectiveDueDate,
                let key = DateDisplay.dayKeyOf(due, timeZone: timeZone), inColumn(key)
            else { return nil }
            return task.overdue ? .overdue : task.dueSoon ? .dueSoon : .due
        }
        // A stable sort keeps API order within a severity, as JavaScript's sort does.
        return Array(tones.enumerated().sorted { ($0.element.severity, $0.offset) < ($1.element.severity, $1.offset) }.map(\.element).prefix(maxDots))
    }
}

/// The `prana://` links the widget opens (spec §13 "Taps").
public enum ForecastWidgetLinks {
    /// Rows and the background: Today in the app's Forecast.
    public static let today = day("TODAY")
    /// The "+" button: Quick Entry over the Forecast.
    public static let quickEntry = URL(string: "prana://forecast?quickEntry=1")!

    /// A column: that day of the app's Forecast.
    public static func day(_ key: String) -> URL {
        var components = URLComponents()
        components.scheme = "prana"
        components.host = "forecast"
        components.queryItems = [URLQueryItem(name: "day", value: key)]
        return components.url!
    }
}
