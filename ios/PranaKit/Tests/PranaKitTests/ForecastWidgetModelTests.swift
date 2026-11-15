// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// A forecast scenario dumped from the real server (and the web app's `formatDateChip`) with the test clock of
/// `scriptable/prana-bindu-forecast.test.ts`: Sat 31 Oct 2026 14:20 in Brisbane.
struct WidgetScenario: Decodable {
    var now: String
    var forecast: ForecastResponse
    var settings: Settings
    /// The web app's chip text for each of Today's tasks with a due date, by name.
    var chips: [String: String]

    static func load(_ name: String) throws -> WidgetScenario {
        try APIClient.decoder.decode(WidgetScenario.self, from: fixture("widget_\(name)"))
    }

    var nowDate: Date { ISO8601DateFormatter.withFractionalSeconds.date(from: now)! }

    var model: ForecastWidgetModel { ForecastWidgetModel(forecast: forecast, settings: settings, now: nowDate) }
}

extension ISO8601DateFormatter {
    nonisolated(unsafe) static let withFractionalSeconds: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

/// Ports the model assertions of `scriptable/prana-bindu-forecast.test.ts` (spec §13): the strip, the rows and the
/// row limits per widget size.
struct ForecastWidgetModelTests {
    @Test func stripHasPastTodayFourWeekdaysAndFutureWithApiCountsAndDueDots() throws {
        // Arrange
        let scenario = try WidgetScenario.load("typical")
        // Act
        let columns = scenario.model.columns
        // Assert
        #expect(columns.map(\.key) == ["PAST", "TODAY", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "FUTURE"])
        #expect(columns.map(\.title) == ["Past", "Today", "Sun", "Mon", "Tue", "Wed", "Future"])
        #expect(columns.map(\.count) == scenario.forecast.days.map(\.count))
        #expect(columns.map(\.count) == [2, 3, 1, 1, 1, 0, 1])
        // One dot per due item, most urgent first; Water plants (Tue) is only planned, so it has no dot.
        #expect(
            columns.map(\.dots) == [
                [.overdue, .overdue], [.overdue, .overdue, .dueSoon], [.dueSoon], [.dueSoon], [], [], [.due],
            ])
        // Zero is dimmed; Today is the highlighted column.
        #expect(columns.map(\.isDimmed) == [false, false, false, false, false, true, false])
        #expect(columns.filter(\.isHighlighted).map(\.key) == ["TODAY"])
    }

    @Test func columnsRowsAndPlusButtonOpenTheAppsForecast() throws {
        let column = try #require(try WidgetScenario.load("typical").model.columns.first)
        #expect(column.url.absoluteString == "prana://forecast?day=PAST")
        #expect(ForecastWidgetLinks.today.absoluteString == "prana://forecast?day=TODAY")
        #expect(ForecastWidgetLinks.quickEntry.absoluteString == "prana://forecast?quickEntry=1")
        #expect(DeepLink(url: ForecastWidgetLinks.quickEntry)?.quickEntry == true)
        #expect(DeepLink(url: ForecastWidgetLinks.today)?.route == .forecast(day: "TODAY"))
    }

    @Test func mediumListsTodaysFirstTwoItemsInApiOrderAndLargeUpToEight() throws {
        // Arrange
        let scenario = try WidgetScenario.load("flagged")
        let today = try #require(scenario.forecast.days.first { $0.key == "TODAY" }).rows.compactMap(\.task?.name)
        let model = scenario.model
        // Act
        let medium = model.rows(for: .medium, stale: false).map(\.name)
        let large = model.rows(for: .large, stale: false).map(\.name)
        // Assert
        #expect(medium == ["Do the line trimming", "Mow the lawn"])
        #expect(today.count > 8)
        #expect(large == Array(today.prefix(8)))
    }

    @Test func rowsCarryStatusCircleFlagDimmingAndChipsWordedAsInTheWebApp() throws {
        // Arrange
        let scenario = try WidgetScenario.load("rows")
        let rows = scenario.model.rows(for: .large, stale: false)
        let byName = Dictionary(uniqueKeysWithValues: rows.map { ($0.name, $0) })
        let todayTasks = try #require(scenario.forecast.days.first { $0.key == "TODAY" }).rows.compactMap(\.task)
        #expect(rows.map(\.name) == todayTasks.prefix(8).map(\.name))

        // Chip text matches the web app's formatDateChip for every listed task with a due date; none without one.
        for task in todayTasks.prefix(8) {
            #expect(byName[task.name]?.chip?.text == scenario.chips[task.name], "\(task.name)")
        }

        let trimming = try #require(byName["Do the line trimming"])
        #expect(trimming.chip == ForecastWidgetChip(text: "10/29/2026 9:00 AM", tone: .overdue))
        #expect(trimming.circle == .overdue)
        #expect(trimming.isFlagged)
        #expect(!trimming.isDimmed)

        let mow = try #require(byName["Mow the lawn"])  // overdue but blocked
        #expect(!mow.isFlagged)
        #expect(mow.isDimmed)
        #expect(mow.circle == .overdue)

        let rent = try #require(byName["Pay rent"])
        #expect(rent.chip == ForecastWidgetChip(text: "Today 5:00 PM", tone: .dueSoon))
        #expect(rent.circle == .dueSoon)

        // Due today at midnight: overdue, so the red ring wins over the repeat dots.
        let stretch = try #require(byName["Stretch"])
        #expect(stretch.circle == .overdue)
        #expect(stretch.symbolName == nil)
        #expect(stretch.chip?.text == "Today")

        // Flagged takes precedence over blocked in the ring.
        let second = try #require(byName["Second step"])
        #expect(second.circle == .flagged)
        #expect(second.isFlagged)
        #expect(second.isDimmed)
    }

    @Test func blockedAndRepeatingUseDashedAndDottedSymbolsSquareForProjects() throws {
        // Arrange
        let rows = try WidgetScenario.load("symbols").model.rows(for: .large, stale: false)
        let byName = Dictionary(uniqueKeysWithValues: rows.map { ($0.name, $0) })
        // Assert
        #expect(byName["Step 2"]?.symbolName == "circle.dashed")
        #expect(byName["Routine"]?.symbolName == "circle.dotted")
        #expect(byName["Step 1"]?.symbolName == nil)
        #expect(byName["Report"]?.chip == ForecastWidgetChip(text: "24/12/2026 09:30", tone: nil))
        // A project with remaining actions is blocked: a dashed square, and its name is not dimmed.
        let project = try #require(byName["Garden project"])
        #expect(project.isProject)
        #expect(project.symbolName == "square.dashed")
        #expect(!project.isDimmed)
        #expect(byName["Step 2"]?.isDimmed == true)
    }

    @Test func capsDotsAtFour() throws {
        let past = try #require(try WidgetScenario.load("overdue").model.columns.first)
        #expect(past.count == 6)
        #expect(past.dots == [.overdue, .overdue, .overdue, .overdue])
    }

    @Test func emptyTodayStaysHighlightedWithNoRows() throws {
        let model = try WidgetScenario.load("empty").model
        let today = try #require(model.columns.first { $0.key == "TODAY" })
        #expect(today.isHighlighted)
        #expect(today.count == 0)
        #expect(model.rows.isEmpty)
        #expect(ForecastWidgetModel.emptyText == "No items")
    }

    @Test func staleNoteTakesThePlaceOfOneRow() throws {
        let model = try WidgetScenario.load("typical").model
        #expect(model.rows(for: .medium, stale: true).map(\.name) == ["Do the line trimming"])
        #expect(model.rows(for: .large, stale: true).map(\.name) == ["Do the line trimming", "Mow the lawn", "Pay rent"])
        #expect(ForecastWidgetFamily.medium.rowLimit == 2)
        #expect(ForecastWidgetFamily.large.rowLimit == 8)
    }

    @Test func updatedNoteGivesTheTimeAndTheDayWhenNotToday() throws {
        // Arrange
        let scenario = try WidgetScenario.load("typical")
        let fetchedAt = scenario.nowDate
        let cache = ForecastWidgetCache(
            origin: URL(string: "https://tasks.example.com")!, fetchedAt: fetchedAt, settings: .init(scenario.settings),
            model: scenario.model)
        // Act / Assert
        #expect(cache.updatedNote(now: fetchedAt.addingTimeInterval(45 * 60)) == "Updated 2:20 PM")
        #expect(cache.updatedNote(now: fetchedAt.addingTimeInterval(24 * 3600)) == "Updated Yesterday 2:20 PM")
    }
}
