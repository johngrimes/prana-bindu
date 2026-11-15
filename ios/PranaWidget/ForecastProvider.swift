// Author: John Grimes

import PranaKit
import WidgetKit

/// One drawing of the widget.
struct ForecastEntry: TimelineEntry {
    let date: Date
    let state: ForecastWidgetState
}

/// Loads the forecast with the app's saved credentials and asks iOS to refresh after 15 minutes, whatever the
/// outcome (spec §13 "Failures").
struct ForecastProvider: TimelineProvider {
    func placeholder(in context: Context) -> ForecastEntry {
        ForecastEntry(date: .now, state: .forecast(.sample, stale: false))
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (ForecastEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        let family = context.family
        Task { completion(await Self.entry(for: family)) }
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<ForecastEntry>) -> Void) {
        let family = context.family
        Task {
            let entry = await Self.entry(for: family)
            completion(Timeline(entries: [entry], policy: .after(ForecastWidgetLoader.nextRefresh(after: entry.date))))
        }
    }

    /// Loads the forecast; sizes other than medium and large fetch nothing.
    private static func entry(for family: WidgetFamily) async -> ForecastEntry {
        let now = Date.now
        guard family == .systemMedium || family == .systemLarge else {
            return ForecastEntry(date: now, state: .signedOut)
        }
        let loader = ForecastWidgetLoader(cacheStore: .shared())
        return ForecastEntry(date: now, state: await loader.load(credentials: KeychainCredentialStore().load(), now: now))
    }
}

extension ForecastWidgetCache {
    /// The widget gallery's sample: a typical Saturday.
    static let sample = ForecastWidgetCache(
        origin: URL(string: "https://tasks.example.org")!, fetchedAt: .now,
        settings: .init(timeZone: TimeZone.current.identifier, dateFormat: .dayMonthYear, use24HourTime: false),
        model: ForecastWidgetModel(
            columns: [
                ForecastWidgetColumn(key: "PAST", title: "Past", count: 2, dots: [.overdue, .overdue]),
                ForecastWidgetColumn(key: "TODAY", title: "Today", count: 3, dots: [.overdue, .overdue, .dueSoon]),
                ForecastWidgetColumn(key: "D1", title: "Sun", count: 1, dots: [.dueSoon]),
                ForecastWidgetColumn(key: "D2", title: "Mon", count: 1, dots: [.dueSoon]),
                ForecastWidgetColumn(key: "D3", title: "Tue", count: 1, dots: []),
                ForecastWidgetColumn(key: "D4", title: "Wed", count: 0, dots: []),
                ForecastWidgetColumn(key: "FUTURE", title: "Future", count: 1, dots: [.due]),
            ],
            rows: [
                ForecastWidgetRow(
                    name: "Do the line trimming", isProject: false, circle: .overdue, isFlagged: true, isDimmed: false,
                    chip: ForecastWidgetChip(text: "29/10/2026 9:00 AM", tone: .overdue)),
                ForecastWidgetRow(
                    name: "Mow the lawn", isProject: false, circle: .overdue, isFlagged: false, isDimmed: true,
                    chip: ForecastWidgetChip(text: "Yesterday 9:00 AM", tone: .overdue)),
                ForecastWidgetRow(
                    name: "Pay rent", isProject: false, circle: .dueSoon, isFlagged: false, isDimmed: false,
                    chip: ForecastWidgetChip(text: "Today 5:00 PM", tone: .dueSoon)),
            ]))
}
