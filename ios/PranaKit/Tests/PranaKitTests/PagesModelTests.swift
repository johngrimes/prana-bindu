// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Forecast page logic (`src/web/pages/ForecastPage.tsx`).
@Suite struct ForecastPageModelTests {
    private func day(_ key: String, _ date: String?, due: Int = 0, badge: ForecastBadge? = nil, rows: [String] = []) -> ForecastDay {
        ForecastDay(
            key: key, date: date, title: key, dueCount: due, count: rows.count, deferredCount: 0, badge: badge,
            rows: rows.map { OutlineRow(kind: .task, id: $0, depth: 0, task: TaskItem(id: $0)) })
    }

    private var forecast: ForecastResponse {
        ForecastResponse(
            today: "2026-11-04",
            days: [
                day("PAST", nil, due: 1, badge: .overdue, rows: ["old"]), day("TODAY", "2026-11-04", due: 1, rows: ["now", "old"]),
                day("2026-11-05", "2026-11-05", rows: ["soon"]), day("FUTURE", nil, due: 2, rows: ["later"]),
            ],
            calendar: [ForecastCalendarDay(date: "2026-11-01", dueCount: 0, count: 0), ForecastCalendarDay(date: "2026-11-05", dueCount: 3, count: 4)])
    }

    @Test func calendarHasFiveWeeksFromTheFirstCalendarDay() {
        let cells = ForecastPageModel.calendarCells(forecast, firstWeekday: 1)
        #expect(cells.count == 35)
        #expect(cells.first == "2026-11-01")
        #expect(cells.last == "2026-12-05")
    }

    @Test func calendarFallsBackToTheStartOfTheWeekHonouringFirstWeekday() {
        var empty = forecast
        empty.calendar = []
        // 2026-11-04 is a Wednesday; weeks starting Monday begin on 2 November.
        #expect(ForecastPageModel.calendarCells(empty, firstWeekday: 2).first == "2026-11-02")
    }

    @Test func calendarHeaderStartsOnTheFirstWeekday() {
        #expect(ForecastPageModel.weekdayHeaders(firstWeekday: 1) == ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"])
        #expect(ForecastPageModel.weekdayHeaders(firstWeekday: 2) == ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"])
    }

    @Test func stripLabelsAndKeys() {
        let f = forecast
        #expect(ForecastPageModel.label(f.days[0], today: f.today) == ForecastPageModel.Label(top: "Past", bottom: ""))
        #expect(ForecastPageModel.label(f.days[1], today: f.today) == ForecastPageModel.Label(top: "Today", bottom: ""))
        #expect(ForecastPageModel.label(f.days[2], today: f.today) == ForecastPageModel.Label(top: "Thu", bottom: "5"))
        #expect(ForecastPageModel.selectionKey(f.days[1], today: f.today) == "TODAY")
        #expect(ForecastPageModel.selectionKey(f.days[2], today: f.today) == "2026-11-05")
        #expect(ForecastPageModel.selectionKey(f.days[3], today: f.today) == "FUTURE")
    }

    @Test func sectionsAreTitledLikeTheWebApp() {
        let groups = ForecastPageModel.groups(forecast, single: nil, selected: nil)
        #expect(groups.map(\.title) == ["Past", "Today — Wed, Nov 4", "Thu, Nov 5", "Future"])
        #expect(groups.map(\.key) == ["PAST", "TODAY", "2026-11-05", "FUTURE"])
        #expect(groups.allSatisfy { $0.kind == .date })
    }

    @Test func dayParameterSelectsOneSection() {
        #expect(ForecastPageModel.groups(forecast, single: nil, selected: "TODAY").map(\.key) == ["TODAY"])
        #expect(ForecastPageModel.groups(forecast, single: nil, selected: "2026-11-04").map(\.key) == ["TODAY"])
        #expect(ForecastPageModel.groups(forecast, single: nil, selected: "2026-11-05").map(\.key) == ["2026-11-05"])
        #expect(ForecastPageModel.groups(forecast, single: nil, selected: "PAST").map(\.key) == ["PAST"])
    }

    @Test func aDayOutsideTheForecastComesFromItsOwnRequest() {
        #expect(ForecastPageModel.isOutside(forecast, selected: "2026-11-20"))
        #expect(!ForecastPageModel.isOutside(forecast, selected: "2026-11-05"))
        #expect(!ForecastPageModel.isOutside(forecast, selected: "TODAY"))
        let single = ForecastResponse(today: "2026-11-04", days: [day("2026-11-20", "2026-11-20", rows: ["x"])], calendar: [])
        let groups = ForecastPageModel.groups(forecast, single: single, selected: "2026-11-20")
        #expect(groups.map(\.title) == ["Fri, Nov 20"])
        // Until it arrives, nothing is shown rather than every day.
        #expect(ForecastPageModel.groups(forecast, single: nil, selected: "2026-11-20").isEmpty)
    }

    @Test func pastCalendarDaysAreDisabled() {
        #expect(ForecastPageModel.isPast("2026-11-03", today: "2026-11-04"))
        #expect(!ForecastPageModel.isPast("2026-11-04", today: "2026-11-04"))
    }

    @Test func calendarCellsShowTheDayOfTheMonth() {
        #expect(ForecastPageModel.dayOfMonth("2026-12-05") == 5)
    }
}

/// View options and page presentation (`ViewOptions.tsx`, `PerspectivePage.tsx`).
@Suite struct PageOptionsTests {
    private func builtin(_ id: String) -> Perspective { Perspective(id: id, builtin: true, name: id.capitalized) }

    @Test func inboxOmitsFirstAvailableAndRewordsAvailable() {
        #expect(PageOptions.filters(for: "inbox").map(\.label) == ["Available", "Remaining", "Everything"])
        #expect(PageOptions.filters(for: "inbox").first?.hint == "Items not blocked or deferred")
        #expect(PageOptions.filters(for: "projects").map(\.label) == ["First Available", "Available", "Remaining", "Everything"])
        #expect(PageOptions.filters(for: "projects").map(\.value) == [.next, .available, .remaining, .all])
    }

    @Test func defaultFiltersPerPerspective() {
        #expect(PageOptions.filter(builtin("inbox"), contents: nil) == .remaining)
        #expect(PageOptions.filter(builtin("flagged"), contents: nil) == .available)
        #expect(PageOptions.filter(builtin("tags"), contents: nil) == .available)
        #expect(PageOptions.filter(builtin("projects"), contents: nil) == .remaining)
        var custom = builtin("x")
        custom.viewOptions.filter = .all
        #expect(PageOptions.filter(custom, contents: nil) == .all)
        let contents = OutlineContents(perspectiveId: "completed", viewOptions: ViewOptions(filter: .all), groups: [])
        #expect(PageOptions.filter(builtin("completed"), contents: contents) == .all)
    }

    @Test func flaggedGroupingsMatchTheWebList() {
        #expect(
            PageOptions.flaggedGroupings.map(\.label) == [
                "Ungrouped", "Tag", "Tags (Combined)", "Project", "Due Date", "Planned Date", "Defer Date", "Completed Date",
                "Dropped Date", "Added Date", "Changed Date",
            ])
    }

    @Test func viewOptionsOnlyForBuiltinsThatHaveThem() {
        #expect(["inbox", "projects", "tags", "flagged", "forecast"].allSatisfy { PageOptions.hasViewOptions(builtin($0)) })
        #expect(!PageOptions.hasViewOptions(builtin("review")))
        #expect(!PageOptions.hasViewOptions(builtin("completed")))
        #expect(!PageOptions.hasViewOptions(Perspective(id: "inbox", builtin: false, name: "Custom")))
    }

    @Test func sidebarKinds() {
        #expect(PageOptions.sidebar(builtin("projects")) == .projects)
        #expect(["tags", "flagged", "completed", "changed"].allSatisfy { PageOptions.sidebar(builtin($0)) == .tags })
        #expect(PageOptions.sidebar(builtin("inbox")) == .none)
        let custom = Perspective(id: "c", name: "C", presentation: Perspective.Presentation(sidebar: .tags))
        #expect(PageOptions.sidebar(custom) == .tags)
    }

    @Test func emptyTextFallsBackLikeTheWebApp() {
        #expect(PageOptions.emptyText(perspectiveId: "inbox", contents: nil) == "No items")
        #expect(PageOptions.emptyText(perspectiveId: "projects", contents: nil) == "No projects")
        #expect(PageOptions.emptyText(perspectiveId: "flagged", contents: nil) == "No items")
        let contents = OutlineContents(perspectiveId: "projects", groups: [], emptyText: "No remaining projects")
        #expect(PageOptions.emptyText(perspectiveId: "projects", contents: contents) == "No remaining projects")
    }

    @Test func titleFollowsTheSidebarSelection() {
        let projects = [Project(record: ProjectRecord(id: "p"), task: TaskItem(id: "p", name: "Garden"))]
        let tags = [PranaKit.Tag(id: "t", name: "Home")]
        let folders = [Folder(id: "f", name: "Work")]
        let p = builtin("projects")
        #expect(PageOptions.title(p, key: ContentsKey(perspectiveId: "projects", project: "p"), projects: projects, folders: folders, tags: tags) == "Garden")
        #expect(PageOptions.title(p, key: ContentsKey(perspectiveId: "projects", folder: "f"), projects: projects, folders: folders, tags: tags) == "Work")
        #expect(PageOptions.title(builtin("tags"), key: ContentsKey(perspectiveId: "tags", tag: "untagged"), projects: projects, folders: folders, tags: tags) == "Untagged")
        #expect(PageOptions.title(builtin("tags"), key: ContentsKey(perspectiveId: "tags", tag: "t"), projects: projects, folders: folders, tags: tags) == "Home")
        #expect(PageOptions.title(p, key: ContentsKey(perspectiveId: "projects", project: "gone"), projects: projects, folders: folders, tags: tags) == "Projects")
    }
}

/// Search page helpers (`src/web/pages/SearchPage.tsx`).
@Suite struct SearchPageModelTests {
    @Test func noSnippetWithoutAMatch() {
        #expect(SearchPageModel.noteSnippet("nothing here", query: "zebra") == nil)
    }

    @Test func shortNotesAreShownWholeWithWhitespaceCollapsed() {
        #expect(SearchPageModel.noteSnippet("Buy\n\nmilk  today", query: "milk") == "Buy milk today")
    }

    @Test func longNotesAreCutAroundTheFirstMatch() {
        let note = String(repeating: "a", count: 100) + "needle" + String(repeating: "b", count: 200)
        let snippet = SearchPageModel.noteSnippet(note, query: "NEEDLE")
        // Starts 40 characters before the match, 140 characters long, with ellipses on both ends.
        #expect(snippet == "…" + String(repeating: "a", count: 40) + "needle" + String(repeating: "b", count: 94) + "…")
    }

    @Test func highlightSegmentsSplitAtMatches() {
        let segments = SearchPageModel.segments("Plan the garden", query: "garden plan")
        #expect(segments == [.init(text: "Plan", match: true), .init(text: " the ", match: false), .init(text: "garden", match: true)])
    }
}
