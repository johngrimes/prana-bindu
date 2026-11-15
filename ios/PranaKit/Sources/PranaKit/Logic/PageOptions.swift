// Author: John Grimes

import Foundation

/// View options and page presentation for perspective pages (spec §4). Ports `src/web/components/ViewOptions.tsx`
/// and the presentation rules of `src/web/pages/PerspectivePage.tsx`.
public enum PageOptions {
    /// A choice in a view-options list.
    public struct Choice<Value: Hashable & Sendable>: Hashable, Sendable, Identifiable {
        public var value: Value
        public var label: String
        public var hint: String

        /// The value.
        public var id: Value { value }
    }

    private static let allFilters: [Choice<Availability>] = [
        Choice(value: .next, label: "First Available", hint: "The first available action in each project"),
        Choice(value: .available, label: "Available", hint: "Items not blocked, deferred, or on hold"),
        Choice(value: .remaining, label: "Remaining", hint: "Items not completed or dropped"),
        Choice(value: .all, label: "Everything", hint: "Including completed and dropped items"),
    ]

    /// The Filter choices: Inbox omits First Available, and its Available means "not blocked or deferred".
    public static func filters(for perspectiveId: String) -> [Choice<Availability>] {
        guard perspectiveId == "inbox" else { return allFilters }
        return allFilters.filter { $0.value != .next }.map { choice in
            var choice = choice
            if choice.value == .available { choice.hint = "Items not blocked or deferred" }
            return choice
        }
    }

    /// The default filter of the built-in perspectives that have one.
    public static let defaultFilters: [String: Availability] = [
        "inbox": .remaining, "flagged": .available, "projects": .remaining, "tags": .available,
    ]

    /// The filter in force: the perspective's own (a pending change shows at once), else the server's effective one,
    /// else the built-in default, else Remaining.
    public static func filter(_ perspective: Perspective, contents: OutlineContents?) -> Availability {
        perspective.viewOptions.filter ?? contents?.viewOptions.filter ?? defaultFilters[perspective.id] ?? .remaining
    }

    /// Flagged's "Group actions by" choices.
    public static let flaggedGroupings: [Choice<Grouping>] = [
        (Grouping.none, "Ungrouped"), (.tag, "Tag"), (.tagsCombined, "Tags (Combined)"), (.project, "Project"),
        (.due, "Due Date"), (.planned, "Planned Date"), (.defer, "Defer Date"), (.completed, "Completed Date"),
        (.dropped, "Dropped Date"), (.added, "Added Date"), (.changed, "Changed Date"),
    ].map { Choice(value: $0.0, label: $0.1, hint: "") }

    /// The perspective with `id` in `perspectives`, or a built-in stand-in while the list is loading (or for an
    /// unknown id, which then has no sidebar and no view options).
    public static func perspective(_ id: String, in perspectives: [Perspective]?) -> Perspective {
        perspectives?.first { $0.id == id } ?? Perspective(id: id, builtin: true, name: id)
    }

    /// Built-in perspectives whose view options the user adjusts (custom perspectives use their saved settings).
    public static func hasViewOptions(_ perspective: Perspective) -> Bool {
        perspective.builtin && ["inbox", "projects", "tags", "flagged", "forecast"].contains(perspective.id)
    }

    /// Which sidebar a perspective page shows.
    public static func sidebar(_ perspective: Perspective) -> Perspective.Presentation.SidebarKind {
        guard perspective.builtin else { return perspective.presentation.sidebar }
        switch perspective.id {
        case "projects": return .projects
        case "tags", "completed", "changed", "flagged": return .tags
        default: return .none
        }
    }

    /// The empty-state text: the server's, else the default per perspective ("No items", "No projects").
    public static func emptyText(perspectiveId: String, contents: OutlineContents?) -> String {
        contents?.emptyText ?? (perspectiveId == "projects" ? "No projects" : "No items")
    }

    /// The page title: the selected project, folder or tag, else the perspective's name.
    public static func title(
        _ perspective: Perspective, key: ContentsKey, projects: [Project], folders: [Folder], tags: [Tag]
    ) -> String {
        if let id = key.project { return projects.first { $0.id == id }?.task.name ?? perspective.name }
        if let id = key.folder { return folders.first { $0.id == id }?.name ?? perspective.name }
        if let id = key.tag {
            return id == "untagged" ? "Untagged" : (tags.first { $0.id == id }?.name ?? perspective.name)
        }
        return perspective.name
    }
}

/// Search page helpers (`src/web/pages/SearchPage.tsx`).
public enum SearchPageModel {
    /// A run of text, highlighted when it matched the query.
    public struct Segment: Hashable, Sendable {
        public var text: String
        public var match: Bool

        /// Creates a segment.
        public init(text: String, match: Bool) {
            self.text = text
            self.match = match
        }
    }

    /// Up to 140 characters of a note around its first match (from 40 before it), whitespace collapsed, with
    /// ellipses where cut. Nil when the note does not match.
    public static func noteSnippet(_ note: String, query: String) -> String? {
        guard let first = matchRanges(note, query: query).first else { return nil }
        let chars = Array(note)
        let start = max(0, first.lowerBound - 40)
        let end = min(chars.count, start + 140)
        let body = String(chars[start..<end]).replacing(/\s+/, with: " ")
        return (start > 0 ? "…" : "") + body + (start + 140 < chars.count ? "…" : "")
    }

    /// `text` split into matched and unmatched runs for highlighting.
    public static func segments(_ text: String, query: String) -> [Segment] {
        let chars = Array(text)
        var out: [Segment] = []
        var at = 0
        for range in matchRanges(text, query: query) {
            if range.lowerBound > at { out.append(Segment(text: String(chars[at..<range.lowerBound]), match: false)) }
            out.append(Segment(text: String(chars[range]), match: true))
            at = range.upperBound
        }
        if at < chars.count { out.append(Segment(text: String(chars[at...]), match: false)) }
        return out
    }
}
