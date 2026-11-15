// Author: John Grimes

import Foundation

/// A perspective: built-in or custom (spec §4). Mirrors `Perspective` in `src/shared/schemas.ts`.
public struct Perspective: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var builtin: Bool
    public var name: String
    /// Icon name (web icon identifiers, e.g. `inbox`, `perspective`).
    public var icon: String
    /// CSS colour, or nil for the default.
    public var color: String?
    public var favorite: Bool
    public var rank: Int
    public var aggregation: Aggregation
    /// Rule objects (spec §4.1), kept as JSON so unknown rules round-trip.
    public var rules: [JSONValue]
    public var presentation: Presentation
    public var viewOptions: ViewOptions

    /// How a custom perspective lays out its rows (spec §4.1).
    public struct Presentation: Codable, Sendable, Hashable {
        /// `projects` or `flat`.
        public var layout: Layout
        public var grouping: Grouping
        public var sorting: Sorting
        /// `projects`, `tags` or `none`.
        public var sidebar: SidebarKind

        /// Layout of a perspective's rows.
        public struct Layout: OpenEnum {
            public let rawValue: String
            public init(rawValue: String) { self.rawValue = rawValue }
            public static let projects: Self = "projects"
            public static let flat: Self = "flat"
        }

        /// Which sidebar a perspective shows.
        public struct SidebarKind: OpenEnum {
            public let rawValue: String
            public init(rawValue: String) { self.rawValue = rawValue }
            public static let projects: Self = "projects"
            public static let tags: Self = "tags"
            public static let none: Self = "none"
        }

        /// Creates a presentation; defaults match the server's.
        public init(layout: Layout = .projects, grouping: Grouping = .none, sorting: Sorting = .manual, sidebar: SidebarKind = .projects) {
            self.layout = layout
            self.grouping = grouping
            self.sorting = sorting
            self.sidebar = sidebar
        }
    }

    /// Creates a perspective; defaults describe a new custom perspective (`draftPerspective` in the web client).
    public init(
        id: String, builtin: Bool = false, name: String, icon: String = "perspective", color: String? = nil,
        favorite: Bool = false, rank: Int = 0, aggregation: Aggregation = .all, rules: [JSONValue] = [],
        presentation: Presentation = Presentation(), viewOptions: ViewOptions = ViewOptions()
    ) {
        self.id = id
        self.builtin = builtin
        self.name = name
        self.icon = icon
        self.color = color
        self.favorite = favorite
        self.rank = rank
        self.aggregation = aggregation
        self.rules = rules
        self.presentation = presentation
        self.viewOptions = viewOptions
    }
}

/// Per-perspective view options (spec §4, View menu). Mirrors `ViewOptions`; every field is optional.
public struct ViewOptions: Codable, Sendable, Hashable {
    public var filter: Availability?
    public var grouping: Grouping?
    /// Tags perspective.
    public var sortByDueAndFlagged: Bool?
    /// Projects perspective.
    public var showInbox: Bool?
    /// Projects perspective.
    public var showFolders: Bool?
    /// Forecast perspective.
    public var forecast: Forecast?

    /// Forecast view options; every field is optional.
    public struct Forecast: Codable, Sendable, Hashable {
        public var includePlanned: Bool?
        public var includeDefer: Bool?
        public var includeNotification: Bool?
        public var includeOnHold: Bool?
        public var todayIncludesFlagged: Bool?
        public var todayIncludesTag: Bool?
        public var organized: Bool?
        public var preserveHierarchy: Bool?
        public var keepSorted: Bool?

        /// Creates forecast options.
        public init(
            includePlanned: Bool? = nil, includeDefer: Bool? = nil, includeNotification: Bool? = nil,
            includeOnHold: Bool? = nil, todayIncludesFlagged: Bool? = nil, todayIncludesTag: Bool? = nil,
            organized: Bool? = nil, preserveHierarchy: Bool? = nil, keepSorted: Bool? = nil
        ) {
            self.includePlanned = includePlanned
            self.includeDefer = includeDefer
            self.includeNotification = includeNotification
            self.includeOnHold = includeOnHold
            self.todayIncludesFlagged = todayIncludesFlagged
            self.todayIncludesTag = todayIncludesTag
            self.organized = organized
            self.preserveHierarchy = preserveHierarchy
            self.keepSorted = keepSorted
        }
    }

    /// Creates view options.
    public init(
        filter: Availability? = nil, grouping: Grouping? = nil, sortByDueAndFlagged: Bool? = nil,
        showInbox: Bool? = nil, showFolders: Bool? = nil, forecast: Forecast? = nil
    ) {
        self.filter = filter
        self.grouping = grouping
        self.sortByDueAndFlagged = sortByDueAndFlagged
        self.showInbox = showInbox
        self.showFolders = showFolders
        self.forecast = forecast
    }
}

/// One row of an evaluated perspective: a task (with depth for hierarchy) or a project/folder/tag header.
public struct OutlineRow: Codable, Sendable, Hashable, Identifiable {
    public var kind: RowKind
    public var id: String
    /// Indentation level within its group (0 = top level).
    public var depth: Int
    public var task: TaskItem?
    public var project: Project?
    public var folder: Folder?
    public var tag: Tag?

    /// Creates a row.
    public init(kind: RowKind, id: String, depth: Int, task: TaskItem? = nil, project: Project? = nil, folder: Folder? = nil, tag: Tag? = nil) {
        self.kind = kind
        self.id = id
        self.depth = depth
        self.task = task
        self.project = project
        self.folder = folder
        self.tag = tag
    }
}

/// An ordered group of rows in an evaluated perspective.
public struct OutlineGroup: Codable, Sendable, Hashable, Identifiable {
    /// Stable key (a tag id, `untagged`, `PAST`, `2026-11-02`, `bucket:today`, `inbox`…).
    public var key: String
    public var title: String
    public var kind: GroupKind
    public var rows: [OutlineRow]

    /// The group key.
    public var id: String { key }

    /// Creates a group.
    public init(key: String, title: String, kind: GroupKind, rows: [OutlineRow]) {
        self.key = key
        self.title = title
        self.kind = kind
        self.rows = rows
    }
}

/// An evaluated perspective (`GET /perspectives/{id}/contents`). Mirrors `PerspectiveContents`.
public struct OutlineContents: Codable, Sendable, Hashable {
    public var perspectiveId: String
    public var viewOptions: ViewOptions
    public var groups: [OutlineGroup]
    /// Text shown when there are no rows, or nil for the default.
    public var emptyText: String?

    /// Creates contents.
    public init(perspectiveId: String, viewOptions: ViewOptions = ViewOptions(), groups: [OutlineGroup], emptyText: String? = nil) {
        self.perspectiveId = perspectiveId
        self.viewOptions = viewOptions
        self.groups = groups
        self.emptyText = emptyText
    }
}
