// Author: John Grimes

import Foundation

/// A task's display status (spec §1.3). Mirrors `TaskStatus` in `src/shared/schemas.ts`.
public struct TaskStatus: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let completed: Self = "completed"
    public static let dropped: Self = "dropped"
    public static let overdue: Self = "overdue"
    public static let dueSoon: Self = "dueSoon"
    public static let blocked: Self = "blocked"
    public static let next: Self = "next"
    public static let available: Self = "available"
}

/// Availability filter of a perspective (spec §4).
public struct Availability: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let next: Self = "next"
    public static let available: Self = "available"
    public static let remaining: Self = "remaining"
    public static let all: Self = "all"
}

/// How a project's actions become available (spec §1.2).
public struct ProjectType: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let parallel: Self = "parallel"
    public static let sequential: Self = "sequential"
    public static let singleActions: Self = "singleActions"
}

/// A project's status (spec §1.2).
public struct ProjectStatus: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let active: Self = "active"
    public static let onHold: Self = "onHold"
    public static let completed: Self = "completed"
    public static let dropped: Self = "dropped"
}

/// A folder's status.
public struct FolderStatus: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let active: Self = "active"
    public static let dropped: Self = "dropped"
}

/// A tag's status.
public struct TagStatus: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let active: Self = "active"
    public static let onHold: Self = "onHold"
    public static let dropped: Self = "dropped"
}

/// Calendar unit of a review interval.
public struct IntervalUnit: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let day: Self = "day"
    public static let week: Self = "week"
    public static let month: Self = "month"
    public static let year: Self = "year"
}

/// Grouping of a perspective's rows (spec §4).
public struct Grouping: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let none: Self = "none"
    public static let tag: Self = "tag"
    public static let tagsCombined: Self = "tagsCombined"
    public static let project: Self = "project"
    public static let folder: Self = "folder"
    public static let due: Self = "due"
    public static let `defer`: Self = "defer"
    public static let planned: Self = "planned"
    public static let completed: Self = "completed"
    public static let dropped: Self = "dropped"
    public static let added: Self = "added"
    public static let changed: Self = "changed"
    public static let flagged: Self = "flagged"
}

/// Sorting of a perspective's rows (spec §4).
public struct Sorting: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let manual: Self = "manual"
    public static let due: Self = "due"
    public static let `defer`: Self = "defer"
    public static let planned: Self = "planned"
    public static let completed: Self = "completed"
    public static let added: Self = "added"
    public static let changed: Self = "changed"
    public static let flagged: Self = "flagged"
    public static let duration: Self = "duration"
    public static let name: Self = "name"
}

/// Rule combination of a custom perspective (spec §4.1).
public struct Aggregation: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let all: Self = "all"
    public static let any: Self = "any"
    public static let none: Self = "none"
}

/// What an alarm's fire time is relative to.
public struct AlarmKind: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let absolute: Self = "absolute"
    public static let dueRelative: Self = "dueRelative"
    public static let deferRelative: Self = "deferRelative"
    public static let plannedRelative: Self = "plannedRelative"
}

/// What an outline row shows.
public struct RowKind: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let task: Self = "task"
    public static let project: Self = "project"
    public static let folder: Self = "folder"
    public static let tag: Self = "tag"
}

/// What an outline group is keyed by.
public struct GroupKind: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let none: Self = "none"
    public static let project: Self = "project"
    public static let folder: Self = "folder"
    public static let tag: Self = "tag"
    public static let date: Self = "date"
    public static let flagged: Self = "flagged"
    public static let kind: Self = "kind"
}

/// The kind of a Quick Open match.
public struct QuickOpenType: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let perspective: Self = "perspective"
    public static let folder: Self = "folder"
    public static let project: Self = "project"
    public static let tag: Self = "tag"
}

/// The badge of a Forecast day.
public struct ForecastBadge: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let overdue: Self = "overdue"
    public static let dueSoon: Self = "dueSoon"
}

/// Status a set of tasks is changed to by `POST /tasks/status`.
public struct ActivityStatus: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let active: Self = "active"
    public static let completed: Self = "completed"
    public static let dropped: Self = "dropped"
}

/// Whether completing or dropping a repeating task affects one occurrence or the whole series.
public struct RepeatScope: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let occurrence: Self = "occurrence"
    public static let series: Self = "series"
}

/// Restructuring operations of `POST /tasks/outline` (spec §3).
public struct OutlineOperation: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let indent: Self = "indent"
    public static let outdent: Self = "outdent"
    public static let group: Self = "group"
    public static let ungroup: Self = "ungroup"
    public static let moveUp: Self = "moveUp"
    public static let moveDown: Self = "moveDown"
}
