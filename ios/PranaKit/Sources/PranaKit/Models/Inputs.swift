// Author: John Grimes

import Foundation

// Request bodies. Optional fields are omitted when nil; nullable fields use a double optional, where `.some(nil)`
// sends an explicit `null` (clearing the value) and `nil` leaves the field out.

/// Where an item goes among its siblings: `start`, `end`, or before/after a sibling. Mirrors `Position`.
public enum Position: Codable, Sendable, Hashable {
    case start
    case end
    case before(String)
    case after(String)

    private enum Keys: String, CodingKey { case before, after }

    /// Decodes `"start"`, `"end"`, `{before}` or `{after}`.
    public init(from decoder: Decoder) throws {
        if let word = try? decoder.singleValueContainer().decode(String.self) {
            switch word {
            case "start": self = .start
            case "end": self = .end
            default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unknown position \(word)"))
            }
            return
        }
        let c = try decoder.container(keyedBy: Keys.self)
        if let id = try c.decodeIfPresent(String.self, forKey: .before) { self = .before(id) } else { self = .after(try c.decode(String.self, forKey: .after)) }
    }

    /// Encodes the server's form.
    public func encode(to encoder: Encoder) throws {
        switch self {
        case .start:
            var c = encoder.singleValueContainer()
            try c.encode("start")
        case .end:
            var c = encoder.singleValueContainer()
            try c.encode("end")
        case .before(let id):
            var c = encoder.container(keyedBy: Keys.self)
            try c.encode(id, forKey: .before)
        case .after(let id):
            var c = encoder.container(keyedBy: Keys.self)
            try c.encode(id, forKey: .after)
        }
    }
}

/// `POST /tasks`. Mirrors `TaskCreate`; date fields accept ISO or natural language (the server normalises).
public struct TaskCreate: Codable, Sendable, Hashable {
    /// Client-generated id (`ClientID.make()`).
    public var id: String?
    public var name: String
    public var note: String?
    public var parentId: String?
    public var projectId: String?
    public var inbox: Bool?
    public var position: Position?
    public var flagged: Bool?
    public var deferDate: String??
    public var plannedDate: String??
    public var dueDate: String??
    public var estimatedMinutes: Int??
    public var tagIds: [String]?
    public var `repeat`: RepeatRule??
    public var sequential: Bool?
    public var completedByChildren: Bool?

    /// Creates a body.
    public init(
        id: String? = nil, name: String, note: String? = nil, parentId: String? = nil, projectId: String? = nil,
        inbox: Bool? = nil, position: Position? = nil, flagged: Bool? = nil, deferDate: String?? = nil,
        plannedDate: String?? = nil, dueDate: String?? = nil, estimatedMinutes: Int?? = nil, tagIds: [String]? = nil,
        repeat: RepeatRule?? = nil, sequential: Bool? = nil, completedByChildren: Bool? = nil
    ) {
        self.id = id
        self.name = name
        self.note = note
        self.parentId = parentId
        self.projectId = projectId
        self.inbox = inbox
        self.position = position
        self.flagged = flagged
        self.deferDate = deferDate
        self.plannedDate = plannedDate
        self.dueDate = dueDate
        self.estimatedMinutes = estimatedMinutes
        self.tagIds = tagIds
        self.repeat = `repeat`
        self.sequential = sequential
        self.completedByChildren = completedByChildren
    }
}

/// `PATCH /tasks/{id}` and `POST /tasks/batch` patch. Mirrors `TaskPatch`.
public struct TaskPatch: Codable, Sendable, Hashable {
    public var name: String?
    public var note: String?
    public var flagged: Bool?
    public var deferDate: String??
    public var plannedDate: String??
    public var dueDate: String??
    public var estimatedMinutes: Int??
    public var `repeat`: RepeatRule??
    public var sequential: Bool?
    public var completedByChildren: Bool?
    public var assignedProjectId: String??
    public var tagIds: [String]?

    /// Creates a patch; pass `.some(nil)` to clear a nullable field.
    public init(
        name: String? = nil, note: String? = nil, flagged: Bool? = nil, deferDate: String?? = nil,
        plannedDate: String?? = nil, dueDate: String?? = nil, estimatedMinutes: Int?? = nil, repeat: RepeatRule?? = nil,
        sequential: Bool? = nil, completedByChildren: Bool? = nil, assignedProjectId: String?? = nil, tagIds: [String]? = nil
    ) {
        self.name = name
        self.note = note
        self.flagged = flagged
        self.deferDate = deferDate
        self.plannedDate = plannedDate
        self.dueDate = dueDate
        self.estimatedMinutes = estimatedMinutes
        self.repeat = `repeat`
        self.sequential = sequential
        self.completedByChildren = completedByChildren
        self.assignedProjectId = assignedProjectId
        self.tagIds = tagIds
    }
}

/// `POST /tasks/{id}/move` and `POST /tasks/move` target. Mirrors `TaskMove`.
public struct MoveTarget: Codable, Sendable, Hashable {
    public var parentId: String?
    public var projectId: String?
    public var inbox: Bool?
    public var position: Position

    /// Creates a target.
    public init(parentId: String? = nil, projectId: String? = nil, inbox: Bool? = nil, position: Position = .end) {
        self.parentId = parentId
        self.projectId = projectId
        self.inbox = inbox
        self.position = position
    }
}

/// `POST /projects`. Mirrors `ProjectCreate`.
public struct ProjectCreate: Codable, Sendable, Hashable {
    public var id: String?
    public var name: String
    public var note: String?
    public var position: Position?
    public var flagged: Bool?
    public var deferDate: String??
    public var plannedDate: String??
    public var dueDate: String??
    public var estimatedMinutes: Int??
    public var tagIds: [String]?
    public var `repeat`: RepeatRule??
    public var completedByChildren: Bool?
    public var type: ProjectType
    public var folderId: String??
    public var status: ProjectStatus?
    public var reviewInterval: ReviewInterval?

    /// Creates a body.
    public init(
        id: String? = nil, name: String, note: String? = nil, position: Position? = nil, flagged: Bool? = nil,
        deferDate: String?? = nil, plannedDate: String?? = nil, dueDate: String?? = nil, estimatedMinutes: Int?? = nil,
        tagIds: [String]? = nil, repeat: RepeatRule?? = nil, completedByChildren: Bool? = nil,
        type: ProjectType = .parallel, folderId: String?? = nil, status: ProjectStatus? = nil,
        reviewInterval: ReviewInterval? = nil
    ) {
        self.id = id
        self.name = name
        self.note = note
        self.position = position
        self.flagged = flagged
        self.deferDate = deferDate
        self.plannedDate = plannedDate
        self.dueDate = dueDate
        self.estimatedMinutes = estimatedMinutes
        self.tagIds = tagIds
        self.repeat = `repeat`
        self.completedByChildren = completedByChildren
        self.type = type
        self.folderId = folderId
        self.status = status
        self.reviewInterval = reviewInterval
    }
}

/// `PATCH /projects/{id}` and `POST /projects/batch` patch. Mirrors `ProjectPatch`.
public struct ProjectPatch: Codable, Sendable, Hashable {
    public var name: String?
    public var note: String?
    public var flagged: Bool?
    public var deferDate: String??
    public var plannedDate: String??
    public var dueDate: String??
    public var estimatedMinutes: Int??
    public var `repeat`: RepeatRule??
    public var completedByChildren: Bool?
    public var tagIds: [String]?
    public var type: ProjectType?
    public var status: ProjectStatus?
    public var folderId: String??
    public var reviewInterval: ReviewInterval?
    public var nextReview: String??

    /// Creates a patch; pass `.some(nil)` to clear a nullable field.
    public init(
        name: String? = nil, note: String? = nil, flagged: Bool? = nil, deferDate: String?? = nil,
        plannedDate: String?? = nil, dueDate: String?? = nil, estimatedMinutes: Int?? = nil, repeat: RepeatRule?? = nil,
        completedByChildren: Bool? = nil, tagIds: [String]? = nil, type: ProjectType? = nil, status: ProjectStatus? = nil,
        folderId: String?? = nil, reviewInterval: ReviewInterval? = nil, nextReview: String?? = nil
    ) {
        self.name = name
        self.note = note
        self.flagged = flagged
        self.deferDate = deferDate
        self.plannedDate = plannedDate
        self.dueDate = dueDate
        self.estimatedMinutes = estimatedMinutes
        self.repeat = `repeat`
        self.completedByChildren = completedByChildren
        self.tagIds = tagIds
        self.type = type
        self.status = status
        self.folderId = folderId
        self.reviewInterval = reviewInterval
        self.nextReview = nextReview
    }

    /// The task-level part of the patch (fields stored on the project's root task).
    public var taskPatch: TaskPatch {
        TaskPatch(
            name: name, note: note, flagged: flagged, deferDate: deferDate, plannedDate: plannedDate, dueDate: dueDate,
            estimatedMinutes: estimatedMinutes, repeat: `repeat`, completedByChildren: completedByChildren, tagIds: tagIds)
    }
}

/// `POST /folders`. Mirrors `FolderCreate`.
public struct FolderCreate: Codable, Sendable, Hashable {
    public var id: String?
    public var name: String
    public var note: String?
    public var parentId: String??
    public var position: Position?

    /// Creates a body.
    public init(id: String? = nil, name: String, note: String? = nil, parentId: String?? = nil, position: Position? = nil) {
        self.id = id
        self.name = name
        self.note = note
        self.parentId = parentId
        self.position = position
    }
}

/// `PATCH /folders/{id}`. Mirrors `FolderPatch`.
public struct FolderPatch: Codable, Sendable, Hashable {
    public var name: String?
    public var note: String?
    public var status: FolderStatus?

    /// Creates a patch.
    public init(name: String? = nil, note: String? = nil, status: FolderStatus? = nil) {
        self.name = name
        self.note = note
        self.status = status
    }
}

/// `POST /tags`. Mirrors `TagCreate`.
public struct TagCreate: Codable, Sendable, Hashable {
    public var id: String?
    public var name: String
    public var note: String?
    public var parentId: String??
    public var position: Position?
    public var status: TagStatus?
    public var childrenMutuallyExclusive: Bool?

    /// Creates a body.
    public init(
        id: String? = nil, name: String, note: String? = nil, parentId: String?? = nil, position: Position? = nil,
        status: TagStatus? = nil, childrenMutuallyExclusive: Bool? = nil
    ) {
        self.id = id
        self.name = name
        self.note = note
        self.parentId = parentId
        self.position = position
        self.status = status
        self.childrenMutuallyExclusive = childrenMutuallyExclusive
    }
}

/// `PATCH /tags/{id}`. Mirrors `TagPatch`.
public struct TagPatch: Codable, Sendable, Hashable {
    public var name: String?
    public var note: String?
    public var status: TagStatus?
    public var childrenMutuallyExclusive: Bool?

    /// Creates a patch.
    public init(name: String? = nil, note: String? = nil, status: TagStatus? = nil, childrenMutuallyExclusive: Bool? = nil) {
        self.name = name
        self.note = note
        self.status = status
        self.childrenMutuallyExclusive = childrenMutuallyExclusive
    }
}

/// `POST /{projects,folders,tags}/{id}/move`. Mirrors `ContainerMove`; `parentId` nil moves to the top level.
public struct ContainerMove: Codable, Sendable, Hashable {
    public var parentId: String?
    public var position: Position

    /// Creates a body.
    public init(parentId: String?, position: Position = .end) {
        self.parentId = parentId
        self.position = position
    }

    private enum CodingKeys: String, CodingKey { case parentId, position }

    /// Always sends `parentId` (null for the top level), as the server requires it.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(parentId, forKey: .parentId)
        try c.encode(position, forKey: .position)
    }
}

/// Partial presentation for creating or editing a perspective.
public struct PresentationPatch: Codable, Sendable, Hashable {
    public var layout: Perspective.Presentation.Layout?
    public var grouping: Grouping?
    public var sorting: Sorting?
    public var sidebar: Perspective.Presentation.SidebarKind?

    /// Creates a patch.
    public init(layout: Perspective.Presentation.Layout? = nil, grouping: Grouping? = nil, sorting: Sorting? = nil, sidebar: Perspective.Presentation.SidebarKind? = nil) {
        self.layout = layout
        self.grouping = grouping
        self.sorting = sorting
        self.sidebar = sidebar
    }
}

/// `POST /perspectives`. Mirrors `PerspectiveCreate`.
public struct PerspectiveCreate: Codable, Sendable, Hashable {
    public var id: String?
    public var name: String
    public var icon: String?
    public var color: String??
    public var favorite: Bool?
    public var aggregation: Aggregation?
    public var rules: [JSONValue]?
    public var presentation: PresentationPatch?

    /// Creates a body.
    public init(
        id: String? = nil, name: String, icon: String? = nil, color: String?? = nil, favorite: Bool? = nil,
        aggregation: Aggregation? = nil, rules: [JSONValue]? = nil, presentation: PresentationPatch? = nil
    ) {
        self.id = id
        self.name = name
        self.icon = icon
        self.color = color
        self.favorite = favorite
        self.aggregation = aggregation
        self.rules = rules
        self.presentation = presentation
    }
}

/// `PATCH /perspectives/{id}`. Mirrors `PerspectivePatch`.
public struct PerspectivePatch: Codable, Sendable, Hashable {
    public var name: String?
    public var icon: String?
    public var color: String??
    public var favorite: Bool?
    public var aggregation: Aggregation?
    public var rules: [JSONValue]?
    public var presentation: PresentationPatch?
    public var rank: Int?

    /// Creates a patch.
    public init(
        name: String? = nil, icon: String? = nil, color: String?? = nil, favorite: Bool? = nil,
        aggregation: Aggregation? = nil, rules: [JSONValue]? = nil, presentation: PresentationPatch? = nil, rank: Int? = nil
    ) {
        self.name = name
        self.icon = icon
        self.color = color
        self.favorite = favorite
        self.aggregation = aggregation
        self.rules = rules
        self.presentation = presentation
        self.rank = rank
    }
}

/// `PATCH /settings`: any subset of settings. Mirrors `Settings.partial()`.
public struct SettingsPatch: Codable, Sendable, Hashable {
    public var timeZone: String?
    public var dateFormat: Settings.DateFormat?
    public var firstWeekday: Int?
    public var use24HourTime: Bool?
    public var defaultDeferTime: String?
    public var defaultDueTime: String?
    public var defaultPlannedTime: String?
    public var dueSoonSeconds: Int?
    public var theme: Settings.Theme?
    public var forecastTagId: String??

    /// Creates a patch.
    public init(
        timeZone: String? = nil, dateFormat: Settings.DateFormat? = nil, firstWeekday: Int? = nil,
        use24HourTime: Bool? = nil, defaultDeferTime: String? = nil, defaultDueTime: String? = nil,
        defaultPlannedTime: String? = nil, dueSoonSeconds: Int? = nil, theme: Settings.Theme? = nil,
        forecastTagId: String?? = nil
    ) {
        self.timeZone = timeZone
        self.dateFormat = dateFormat
        self.firstWeekday = firstWeekday
        self.use24HourTime = use24HourTime
        self.defaultDeferTime = defaultDeferTime
        self.defaultDueTime = defaultDueTime
        self.defaultPlannedTime = defaultPlannedTime
        self.dueSoonSeconds = dueSoonSeconds
        self.theme = theme
        self.forecastTagId = forecastTagId
    }
}

/// `POST /parse` request: what kind of value to parse and, for dates, which field's default time applies.
public struct ParseRequest: Codable, Sendable, Hashable {
    /// `date` or `duration`.
    public var kind: String
    /// `defer`, `due` or `planned` (dates only).
    public var field: String?
    public var text: String

    /// Creates a request.
    public init(kind: String, field: String? = nil, text: String) {
        self.kind = kind
        self.field = field
        self.text = text
    }
}

/// `POST /delete` selection: items of any kind deleted in one change.
public struct DeleteSelection: Codable, Sendable, Hashable {
    public var taskIds: [String]?
    public var projectIds: [String]?
    public var folderIds: [String]?
    public var tagIds: [String]?

    /// Creates a selection.
    public init(taskIds: [String]? = nil, projectIds: [String]? = nil, folderIds: [String]? = nil, tagIds: [String]? = nil) {
        self.taskIds = taskIds
        self.projectIds = projectIds
        self.folderIds = folderIds
        self.tagIds = tagIds
    }

    /// Every id in the selection.
    public var allIds: [String] { (taskIds ?? []) + (projectIds ?? []) + (folderIds ?? []) + (tagIds ?? []) }
}
