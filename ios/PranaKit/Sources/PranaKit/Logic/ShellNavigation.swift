// Author: John Grimes

import Foundation

/// The shell's navigation rules, ported from `src/web/components/Shell.tsx`, `src/web/lib/perspectives.ts` and the
/// routes in `src/web/App.tsx` (spec §2).
public enum ShellNavigation {
    /// The tab bar shows at most this many perspectives before "More" (the web `BottomBar`).
    public static let maxTabs = 4

    /// The id the perspective editor uses for a perspective that is not saved yet (`/perspectives/new/edit`).
    public static let newPerspectiveId = "new"

    /// The perspective a route shows (`perspectiveIdFromPath`); nil for Settings and the perspective editor.
    public static func perspectiveId(of route: Route) -> String? {
        switch route {
        case .inbox: "inbox"
        case .projects: "projects"
        case .tags: "tags"
        case .forecast: "forecast"
        case .flagged: "flagged"
        case .review: "review"
        case .completed: "completed"
        case .changed: "changed"
        case .search: "search"
        case .perspective(let id): id
        case .perspectiveEditor, .settings: nil
        }
    }

    /// The rail's perspectives (`railItems`): favourites in rank order, then the current perspective when it is not a
    /// favourite.
    public static func railItems(_ perspectives: [Perspective], currentId: String?) -> [Perspective] {
        let sorted = PerspectiveStyle.sorted(perspectives)
        var items = sorted.filter(\.favorite)
        if let currentId, let current = sorted.first(where: { $0.id == currentId }), !current.favorite {
            items.append(current)
        }
        return items
    }

    /// The tab bar's perspectives: the first `maxTabs` rail items.
    public static func tabItems(_ perspectives: [Perspective], currentId: String?) -> [Perspective] {
        Array(railItems(perspectives, currentId: currentId).prefix(maxTabs))
    }

    /// The home page (`/`): the first favourite perspective, else the Inbox (also while perspectives are loading).
    public static func home(_ perspectives: [Perspective]?) -> Route {
        guard let first = PerspectiveStyle.sorted(perspectives ?? []).first(where: \.favorite) else { return .inbox }
        return PerspectiveStyle.route(of: first)
    }

    /// The route to show: `route`, or the home page when there is none.
    public static func resolve(_ route: Route?, perspectives: [Perspective]?) -> Route {
        route ?? home(perspectives)
    }

    /// Where a Quick Open match goes (`open` in `QuickOpen.tsx`).
    public static func route(for result: QuickOpenResult, perspectives: [Perspective]) -> Route {
        switch result.type {
        case .perspective:
            perspectives.first { $0.id == result.id }.map(PerspectiveStyle.route(of:)) ?? .perspective(id: result.id)
        case .project: .projects(project: result.id, folder: nil)
        case .folder: .projects(project: nil, folder: result.id)
        default: .tags(tag: result.id)
        }
    }

    /// A run of a name, matched or not.
    public struct Segment: Hashable, Sendable {
        public var text: String
        public var matched: Bool
    }

    /// Splits `text` into runs for highlighting Quick Open matches (`Highlight` in `SmartMatch.tsx`). `ranges` are the
    /// server's `[start, end)` pairs in UTF-16 units; malformed or out-of-range pairs are clamped or skipped.
    public static func highlightSegments(_ text: String, ranges: [[Int]]) -> [Segment] {
        let units = Array(text.utf16)
        func slice(_ from: Int, _ to: Int) -> String { String(decoding: units[from..<to], as: UTF16.self) }
        var segments: [Segment] = []
        var pos = 0
        for range in ranges where range.count == 2 {
            let start = min(max(range[0], pos), units.count)
            let end = min(max(range[1], start), units.count)
            guard end > start else { continue }
            if start > pos { segments.append(Segment(text: slice(pos, start), matched: false)) }
            segments.append(Segment(text: slice(start, end), matched: true))
            pos = end
        }
        if pos < units.count || segments.isEmpty { segments.append(Segment(text: slice(pos, units.count), matched: false)) }
        return segments
    }

    /// Whether two routes show the same page (only a sidebar choice or query differs), so the page stays in place.
    public static func samePage(_ a: Route, _ b: Route) -> Bool {
        switch (a, b) {
        case (.perspectiveEditor(let x), .perspectiveEditor(let y)): x == y
        case (.settings, .settings): true
        default: perspectiveId(of: a) != nil && perspectiveId(of: a) == perspectiveId(of: b)
        }
    }

    /// The string saved for state restoration (the route's `prana://` link; empty for the home page).
    public static func storedValue(_ route: Route?) -> String {
        route?.url.absoluteString ?? ""
    }

    /// The route saved by `storedValue`, or nil (home) when there is none, it does not parse, or it is the editor of a
    /// perspective that was never saved.
    public static func restoredRoute(_ stored: String?) -> Route? {
        guard let stored, !stored.isEmpty, let url = URL(string: stored), let route = Route(url: url) else { return nil }
        if case .perspectiveEditor(newPerspectiveId) = route { return nil }
        return route
    }
}

/// Which sidebar a page shows (spec §2, §4): the Projects tree, the Tags tree (filtering the given perspective), the
/// Forecast calendar or the Review list.
public enum PageSidebar: Hashable, Sendable {
    case projects
    /// The Tags tree filtering the perspective with this id.
    case tags(perspectiveId: String)
    case forecast
    case review

    /// The sidebar of the page for `route`, or nil when it has none. Custom perspectives take theirs from their
    /// presentation; while the list is loading, built-in perspectives use their own.
    public init?(route: Route, perspectives: [Perspective]?) {
        switch route {
        case .forecast: self = .forecast
        case .review: self = .review
        case .search, .perspectiveEditor, .settings: return nil
        default:
            guard let id = ShellNavigation.perspectiveId(of: route) else { return nil }
            switch PageOptions.sidebar(PageOptions.perspective(id, in: perspectives)) {
            case .projects: self = .projects
            case .tags: self = .tags(perspectiveId: id)
            default: return nil
            }
        }
    }

    /// The sidebar's title.
    public var title: String {
        switch self {
        case .projects: "Projects"
        case .tags: "Tags"
        case .forecast: "Calendar"
        case .review: "Projects to review"
        }
    }
}

/// What a page's header and panels offer: its sidebar, view options, Clean Up, New item, Reorder and the inspector.
/// Mirrors the `Workspace` props each page passes in `src/web/pages`.
public struct PageChrome: Equatable, Sendable {
    /// The page's sidebar, or nil when it has none.
    public var sidebar: PageSidebar?
    /// Whether the page has a view options panel (V).
    public var hasViewOptions: Bool
    /// Whether Clean Up (K) applies.
    public var canCleanUp: Bool
    /// Whether New item (N) applies.
    public var canCreate: Bool
    /// Whether the page's outline can be reordered (Reorder in the menus).
    public var canReorder: Bool
    /// Whether the page has an inspector.
    public var hasInspector: Bool

    /// Creates chrome from its parts.
    public init(sidebar: PageSidebar?, hasViewOptions: Bool, canCleanUp: Bool, canCreate: Bool, canReorder: Bool, hasInspector: Bool) {
        self.sidebar = sidebar
        self.hasViewOptions = hasViewOptions
        self.canCleanUp = canCleanUp
        self.canCreate = canCreate
        self.canReorder = canReorder
        self.hasInspector = hasInspector
    }

    /// The chrome of the page for `route`.
    public init(route: Route, perspectives: [Perspective]?) {
        switch route {
        case .settings, .perspectiveEditor:
            self.init(sidebar: nil, hasViewOptions: false, canCleanUp: false, canCreate: false, canReorder: false, hasInspector: false)
        case .search:
            self.init(sidebar: nil, hasViewOptions: false, canCleanUp: false, canCreate: true, canReorder: false, hasInspector: true)
        default:
            let hasViewOptions = ShellNavigation.perspectiveId(of: route).map {
                PageOptions.hasViewOptions(PageOptions.perspective($0, in: perspectives))
            } ?? false
            self.init(
                sidebar: PageSidebar(route: route, perspectives: perspectives), hasViewOptions: hasViewOptions,
                canCleanUp: true, canCreate: true, canReorder: true, hasInspector: true)
        }
    }
}

/// Where the phone shows the floating "+" that opens Quick Entry: over the outline pages, above the Review page's
/// pinned Previous / Next / Mark Reviewed buttons, and not on the form pages (Settings, the perspective editor), where
/// it would cover their controls.
public enum QuickEntryButtonPlacement: Equatable, Sendable {
    /// In the page's bottom trailing corner, above the tab bar.
    case floating
    /// Above the page's pinned footer; the page lays it out.
    case aboveFooter
    /// Not shown.
    case hidden

    /// The placement on the page for `route`.
    public init(route: Route) {
        switch route {
        case .settings, .perspectiveEditor: self = .hidden
        case .review: self = .aboveFooter
        default: self = .floating
        }
    }
}
