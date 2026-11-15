// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// The shell's navigation rules (`src/web/components/Shell.tsx`, `src/web/lib/perspectives.ts`, `App.tsx`): rail and
/// tab bar items, the home page, the perspective a route shows, Quick Open targets and restoring the last route.
struct ShellNavigationTests {
    /// The built-ins as the server seeds them: Inbox, Forecast and Review are favourites.
    let builtins: [Perspective] = [
        Perspective(id: "inbox", builtin: true, name: "Inbox", favorite: true, rank: 0),
        Perspective(id: "forecast", builtin: true, name: "Forecast", favorite: true, rank: 65536),
        Perspective(id: "review", builtin: true, name: "Review", favorite: true, rank: 196608),
        Perspective(id: "projects", builtin: true, name: "Projects", rank: 327680),
        Perspective(id: "tags", builtin: true, name: "Tags", rank: 393216),
        Perspective(id: "flagged", builtin: true, name: "Flagged", rank: 458752),
        Perspective(id: "search", builtin: true, name: "Search", rank: 655360),
    ]

    // MARK: Rail and tab bar

    @Test func railShowsFavouritesInRankOrder() {
        // Arrange: shuffled, with a custom favourite ranked between the built-ins.
        let custom = Perspective(id: "mine", name: "Mine", favorite: true, rank: 100_000)
        let perspectives = (builtins + [custom]).reversed()

        // Act
        let rail = ShellNavigation.railItems(Array(perspectives), currentId: nil)

        // Assert
        #expect(rail.map(\.id) == ["inbox", "forecast", "mine", "review"])
    }

    @Test func railAppendsTheCurrentPerspectiveWhenItIsNotAFavourite() {
        let rail = ShellNavigation.railItems(builtins, currentId: "flagged")
        #expect(rail.map(\.id) == ["inbox", "forecast", "review", "flagged"])
    }

    @Test func railDoesNotRepeatTheCurrentFavourite() {
        let rail = ShellNavigation.railItems(builtins, currentId: "forecast")
        #expect(rail.map(\.id) == ["inbox", "forecast", "review"])
    }

    @Test func tabBarShowsAtMostFourItems() {
        // Arrange: five favourites.
        let perspectives = builtins.map { var p = $0; p.favorite = true; return p }

        // Act
        let tabs = ShellNavigation.tabItems(perspectives, currentId: "search")

        // Assert: as the web BottomBar, the first four rail items (the current one may fall off the end).
        #expect(tabs.map(\.id) == ["inbox", "forecast", "review", "projects"])
    }

    // MARK: Home

    @Test func homeIsTheFirstFavourite() {
        var perspectives = builtins
        perspectives[0].favorite = false
        #expect(ShellNavigation.home(perspectives) == .forecast(day: nil))
    }

    @Test func homeIsACustomFavouriteRoute() {
        let custom = Perspective(id: "mine", name: "Mine", favorite: true, rank: -1)
        #expect(ShellNavigation.home(builtins + [custom]) == .perspective(id: "mine"))
    }

    @Test func homeDefaultsToInbox() {
        #expect(ShellNavigation.home(nil) == .inbox)
        #expect(ShellNavigation.home([]) == .inbox)
        #expect(ShellNavigation.home(builtins.map { var p = $0; p.favorite = false; return p }) == .inbox)
    }

    @Test func resolvingNoRouteGoesHome() {
        #expect(ShellNavigation.resolve(nil, perspectives: builtins) == .inbox)
        #expect(ShellNavigation.resolve(.flagged, perspectives: builtins) == .flagged)
    }

    // MARK: Perspective of a route (perspectiveIdFromPath)

    @Test func perspectiveIdOfRoutes() {
        #expect(ShellNavigation.perspectiveId(of: .inbox) == "inbox")
        #expect(ShellNavigation.perspectiveId(of: .projects(project: "p1", folder: nil)) == "projects")
        #expect(ShellNavigation.perspectiveId(of: .tags(tag: "t")) == "tags")
        #expect(ShellNavigation.perspectiveId(of: .forecast(day: "TODAY")) == "forecast")
        #expect(ShellNavigation.perspectiveId(of: .review(project: nil)) == "review")
        #expect(ShellNavigation.perspectiveId(of: .search(query: "x")) == "search")
        #expect(ShellNavigation.perspectiveId(of: .perspective(id: "a/b")) == "a/b")
        #expect(ShellNavigation.perspectiveId(of: .perspectiveEditor(id: "a")) == nil)
        #expect(ShellNavigation.perspectiveId(of: .settings) == nil)
    }

    @Test func samePageIgnoresSidebarChoicesAndQueries() {
        #expect(ShellNavigation.samePage(.search(query: ""), .search(query: "milk")))
        #expect(ShellNavigation.samePage(.projects(project: nil, folder: nil), .projects(project: "p", folder: nil)))
        #expect(ShellNavigation.samePage(.review(project: "a"), .review(project: "b")))
        #expect(ShellNavigation.samePage(.settings, .settings))
        #expect(!ShellNavigation.samePage(.perspectiveEditor(id: "a"), .perspectiveEditor(id: "b")))
        #expect(!ShellNavigation.samePage(.perspective(id: "a"), .perspective(id: "b")))
        #expect(!ShellNavigation.samePage(.flagged, .tags(tag: nil)))
        #expect(!ShellNavigation.samePage(.settings, .perspectiveEditor(id: "a")))
    }

    // MARK: Deep links

    @Test func deepLinkWithoutPathOpensHomeWithQuickEntry() throws {
        let link = try #require(DeepLink(url: URL(string: "prana://?quickEntry=1")!))
        #expect(ShellNavigation.resolve(link.route, perspectives: builtins) == .inbox)
        #expect(link.quickEntry)
    }

    @Test func deepLinkKeepsOtherParameters() throws {
        let link = try #require(DeepLink(url: URL(string: "prana://forecast?day=TODAY&quickEntry=1")!))
        #expect(ShellNavigation.resolve(link.route, perspectives: builtins) == .forecast(day: "TODAY"))
        #expect(link.quickEntry)
    }

    // MARK: Quick Open

    @Test func quickOpenTargets() {
        func result(_ type: QuickOpenType, _ id: String) -> QuickOpenResult {
            QuickOpenResult(type: type, id: id, name: id, score: 1, matches: [])
        }
        #expect(ShellNavigation.route(for: result(.perspective, "flagged"), perspectives: builtins) == .flagged)
        #expect(ShellNavigation.route(for: result(.perspective, "gone"), perspectives: builtins) == .perspective(id: "gone"))
        #expect(ShellNavigation.route(for: result(.project, "p1"), perspectives: builtins) == .projects(project: "p1", folder: nil))
        #expect(ShellNavigation.route(for: result(.folder, "f1"), perspectives: builtins) == .projects(project: nil, folder: "f1"))
        #expect(ShellNavigation.route(for: result(.tag, "t1"), perspectives: builtins) == .tags(tag: "t1"))
    }

    @Test func quickOpenHighlightsMatchedRanges() {
        // `Highlight` in SmartMatch.tsx: [start, end) ranges in UTF-16 units.
        let segments = ShellNavigation.highlightSegments("Café Errands", ranges: [[0, 2], [5, 7]])
        #expect(segments.map(\.text) == ["Ca", "fé ", "Er", "rands"])
        #expect(segments.map(\.matched) == [true, false, true, false])
        #expect(ShellNavigation.highlightSegments("Home", ranges: []).map(\.text) == ["Home"])
        // Out-of-range or malformed ranges are clamped, never crash.
        #expect(ShellNavigation.highlightSegments("ab", ranges: [[1, 9], [5]]).map(\.text) == ["a", "b"])
    }

    // MARK: State restoration

    @Test func restoresTheStoredRoute() {
        let route = Route.projects(project: "a b", folder: nil)
        #expect(ShellNavigation.restoredRoute(ShellNavigation.storedValue(route)) == route)
        #expect(ShellNavigation.storedValue(nil) == "")
        #expect(ShellNavigation.restoredRoute("") == nil)
        #expect(ShellNavigation.restoredRoute("not a link") == nil)
    }

    @Test func doesNotRestoreTheUnsavedPerspectiveEditor() {
        let stored = ShellNavigation.storedValue(.perspectiveEditor(id: ShellNavigation.newPerspectiveId))
        #expect(ShellNavigation.restoredRoute(stored) == nil)
    }
}

/// What a page's header offers (`Workspace` props per page in `src/web/pages`).
struct PageChromeTests {
    let perspectives: [Perspective] = [
        Perspective(id: "inbox", builtin: true, name: "Inbox", favorite: true),
        Perspective(id: "projects", builtin: true, name: "Projects"),
        Perspective(id: "mine", name: "Mine", presentation: .init(sidebar: .tags)),
        Perspective(id: "plain", name: "Plain", presentation: .init(sidebar: .none)),
    ]

    @Test func inboxHasViewOptionsButNoSidebar() {
        let chrome = PageChrome(route: .inbox, perspectives: perspectives)
        #expect(chrome == PageChrome(sidebar: nil, hasViewOptions: true, canCleanUp: true, canCreate: true, canReorder: true, hasInspector: true))
    }

    @Test func sidebarsPerRoute() {
        func sidebar(_ route: Route) -> PageSidebar? { PageChrome(route: route, perspectives: perspectives).sidebar }
        #expect(sidebar(.projects(project: nil, folder: nil)) == .projects)
        #expect(sidebar(.tags(tag: nil)) == .tags(perspectiveId: "tags"))
        #expect(sidebar(.flagged) == .tags(perspectiveId: "flagged"))
        #expect(sidebar(.completed) == .tags(perspectiveId: "completed"))
        #expect(sidebar(.changed) == .tags(perspectiveId: "changed"))
        #expect(sidebar(.forecast(day: nil)) == .forecast)
        #expect(sidebar(.review(project: nil)) == .review)
        #expect(sidebar(.perspective(id: "mine")) == .tags(perspectiveId: "mine"))
        #expect(sidebar(.perspective(id: "plain")) == nil)
        #expect(sidebar(.perspective(id: "unknown")) == nil)
        #expect(sidebar(.search(query: "x")) == nil)
    }

    @Test func sidebarTitles() {
        #expect(PageSidebar.projects.title == "Projects")
        #expect(PageSidebar.tags(perspectiveId: "flagged").title == "Tags")
        #expect(PageSidebar.forecast.title == "Calendar")
        #expect(PageSidebar.review.title == "Projects to review")
    }

    @Test func builtinSidebarsShowWhileThePerspectivesLoad() {
        #expect(PageSidebar(route: .projects(project: nil, folder: nil), perspectives: nil) == .projects)
        #expect(PageSidebar(route: .flagged, perspectives: nil) == .tags(perspectiveId: "flagged"))
        #expect(PageSidebar(route: .inbox, perspectives: nil) == nil)
        #expect(PageChrome(route: .inbox, perspectives: nil).hasViewOptions)
    }

    @Test func viewOptionsOnlyOnTheWebAppsBuiltins() {
        for route: Route in [.inbox, .projects(project: nil, folder: nil), .tags(tag: nil), .flagged, .forecast(day: nil)] {
            #expect(PageChrome(route: route, perspectives: perspectives).hasViewOptions, "\(route)")
        }
        for route: Route in [.review(project: nil), .completed, .changed, .search(query: ""), .perspective(id: "mine"), .settings] {
            #expect(!PageChrome(route: route, perspectives: perspectives).hasViewOptions, "\(route)")
        }
    }

    @Test func searchSettingsAndEditorLimitTheHeader() {
        #expect(PageChrome(route: .search(query: ""), perspectives: perspectives)
            == PageChrome(sidebar: nil, hasViewOptions: false, canCleanUp: false, canCreate: true, canReorder: false, hasInspector: true))
        let bare = PageChrome(sidebar: nil, hasViewOptions: false, canCleanUp: false, canCreate: false, canReorder: false, hasInspector: false)
        #expect(PageChrome(route: .settings, perspectives: perspectives) == bare)
        #expect(PageChrome(route: .perspectiveEditor(id: "mine"), perspectives: perspectives) == bare)
    }

    @Test func phonesFloatQuickEntryOverOutlinesAndLiftItAboveTheReviewButtons() {
        for route: Route in [.inbox, .projects(project: nil, folder: nil), .tags(tag: nil), .forecast(day: nil), .flagged,
                             .completed, .changed, .search(query: "x"), .perspective(id: "mine")] {
            #expect(QuickEntryButtonPlacement(route: route) == .floating, "\(route)")
        }
        #expect(QuickEntryButtonPlacement(route: .review(project: nil)) == .aboveFooter)
        #expect(QuickEntryButtonPlacement(route: .settings) == .hidden)
        #expect(QuickEntryButtonPlacement(route: .perspectiveEditor(id: "mine")) == .hidden)
    }
}

/// The keyboard shortcuts sheet (`src/web/components/ShortcutsSheet.tsx`) and the global commands behind it.
struct KeyboardShortcutsTests {
    @Test func sheetListsTheWebAppsShortcuts() {
        let sections = KeyboardShortcuts.sections
        #expect(sections.map(\.title) == ["Global", "Outline", "Review"])
        #expect(sections[0].entries.map(\.keys) == ["C", "N", "O", "P", "V", "K", "S", "/", "Z / ⌘Z", "⇧Z / ⌘⇧Z", "⇧S", "⇧I", "?"])
        #expect(sections[0].entries.map(\.label) == [
            "Quick Entry", "New item in current location", "Quick Open", "Perspectives", "View options", "Clean Up",
            "Refresh", "Search", "Undo", "Redo", "Toggle sidebar", "Toggle inspector", "Keyboard shortcuts",
        ])
        #expect(sections[1].entries.count == 16)
        #expect(sections[1].entries.first == KeyboardShortcuts.Entry("↑ / ↓", "Move selection"))
        #expect(sections[1].entries.last == KeyboardShortcuts.Entry("Esc", "Stop editing / clear selection / end reorder"))
        #expect(sections[2].entries == [KeyboardShortcuts.Entry("⌘⇧R", "Mark Reviewed"), KeyboardShortcuts.Entry("⌘[ / ⌘]", "Previous / next project")])
        #expect(KeyboardShortcuts.footnote == "Single-key shortcuts are ignored while typing in a field.")
    }

    @Test func everyGlobalCommandHasItsKeysAndIsListed() {
        let listed = Set(KeyboardShortcuts.sections[0].entries.map(\.label))
        for command in ShellCommand.allCases {
            #expect(listed.contains(command.title), "\(command)")
            #expect(!command.chords.isEmpty, "\(command)")
        }
    }

    @Test func chordsMatchTheWebKeys() {
        #expect(ShellCommand.quickEntry.chords == [KeyChord("c")])
        #expect(ShellCommand.refresh.chords == [KeyChord("s")])
        #expect(ShellCommand.search.chords == [KeyChord("/")])
        #expect(ShellCommand.undo.chords == [KeyChord("z"), KeyChord("z", command: true)])
        #expect(ShellCommand.redo.chords == [KeyChord("z", shift: true), KeyChord("z", shift: true, command: true)])
        #expect(ShellCommand.toggleSidebar.chords == [KeyChord("s", shift: true)])
        #expect(ShellCommand.toggleInspector.chords == [KeyChord("i", shift: true)])
        #expect(ShellCommand.shortcuts.chords == [KeyChord("?", shift: true)])
        // No two commands share a chord.
        let all = ShellCommand.allCases.flatMap(\.chords)
        #expect(Set(all).count == all.count)
    }

    @Test func singleKeyCommandsAreSuspendedWhileAnOverlayIsOpen() {
        // As `useGlobalShortcuts`: ⌘Z/⌘⇧Z always work; everything else waits for the overlay to close.
        #expect(KeyChord("z", command: true).worksOverOverlays)
        #expect(KeyChord("z", shift: true, command: true).worksOverOverlays)
        #expect(!KeyChord("z").worksOverOverlays)
        #expect(!KeyChord("?", shift: true).worksOverOverlays)
    }
}
