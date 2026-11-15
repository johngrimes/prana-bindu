// Author: John Grimes

import Foundation

/// How often a project is reviewed (spec §1.4).
public struct ReviewInterval: Codable, Sendable, Hashable {
    public var steps: Int
    public var unit: IntervalUnit

    /// Creates an interval of `steps` × `unit`.
    public init(steps: Int, unit: IntervalUnit) {
        self.steps = steps
        self.unit = unit
    }
}

/// A project's own fields, without its root task (`Project.omit({ task: true })` in `src/shared/schemas.ts`).
public struct ProjectRecord: Codable, Sendable, Hashable, Identifiable {
    /// Equals the root task's id.
    public var id: String
    public var folderId: String?
    public var type: ProjectType
    public var status: ProjectStatus
    public var effectiveStatus: ProjectStatus
    public var reviewInterval: ReviewInterval
    public var lastReview: String
    public var nextReview: String?
    public var stalled: Bool
    public var pending: Bool
    public var remainingCount: Int
    public var availableCount: Int
    public var dueSoonCount: Int
    public var overdueCount: Int

    /// Creates a project record; defaults describe a new, empty, active project.
    public init(
        id: String, folderId: String? = nil, type: ProjectType = .parallel, status: ProjectStatus = .active,
        effectiveStatus: ProjectStatus = .active, reviewInterval: ReviewInterval = ReviewInterval(steps: 1, unit: .week),
        lastReview: String = "", nextReview: String? = nil, stalled: Bool = false, pending: Bool = false,
        remainingCount: Int = 0, availableCount: Int = 0, dueSoonCount: Int = 0, overdueCount: Int = 0
    ) {
        self.id = id
        self.folderId = folderId
        self.type = type
        self.status = status
        self.effectiveStatus = effectiveStatus
        self.reviewInterval = reviewInterval
        self.lastReview = lastReview
        self.nextReview = nextReview
        self.stalled = stalled
        self.pending = pending
        self.remainingCount = remainingCount
        self.availableCount = availableCount
        self.dueSoonCount = dueSoonCount
        self.overdueCount = overdueCount
    }
}

/// A project: its root task plus project fields (spec §1.2). Mirrors `Project`; the JSON is flat with a `task` member.
@dynamicMemberLookup
public struct Project: Codable, Sendable, Hashable, Identifiable {
    /// The project's own fields.
    public var record: ProjectRecord
    /// The project's root task (name, note, dates, flags).
    public var task: TaskItem

    /// Equals `task.id`.
    public var id: String { record.id }

    /// Creates a project from its record and root task.
    public init(record: ProjectRecord, task: TaskItem) {
        self.record = record
        self.task = task
    }

    /// Reads and writes the project's own fields directly (`project.status`).
    public subscript<T>(dynamicMember keyPath: WritableKeyPath<ProjectRecord, T>) -> T {
        get { record[keyPath: keyPath] }
        set { record[keyPath: keyPath] = newValue }
    }

    private enum CodingKeys: String, CodingKey { case task }

    /// Decodes the flat JSON: project fields beside a `task` member.
    public init(from decoder: Decoder) throws {
        record = try ProjectRecord(from: decoder)
        task = try decoder.container(keyedBy: CodingKeys.self).decode(TaskItem.self, forKey: .task)
    }

    /// Encodes the flat JSON the server uses.
    public func encode(to encoder: Encoder) throws {
        try record.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(task, forKey: .task)
    }
}

/// A folder of projects (spec §1.2). Mirrors `Folder`.
public struct Folder: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var note: String
    public var parentId: String?
    /// Sort order among siblings. The server sends integers; client previews may use fractions between them.
    public var rank: Double
    public var status: FolderStatus
    public var effectiveActive: Bool
    public var added: String
    public var modified: String

    /// Creates a folder; defaults describe a new active folder.
    public init(
        id: String, name: String, note: String = "", parentId: String? = nil, rank: Double = 0,
        status: FolderStatus = .active, effectiveActive: Bool = true, added: String = "", modified: String = ""
    ) {
        self.id = id
        self.name = name
        self.note = note
        self.parentId = parentId
        self.rank = rank
        self.status = status
        self.effectiveActive = effectiveActive
        self.added = added
        self.modified = modified
    }
}

/// A tag (spec §1.2). Mirrors `Tag`.
public struct Tag: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var note: String
    public var parentId: String?
    /// Sort order among siblings. The server sends integers; client previews may use fractions between them.
    public var rank: Double
    public var status: TagStatus
    public var effectiveStatus: TagStatus
    public var childrenMutuallyExclusive: Bool
    public var added: String
    public var modified: String
    public var remainingCount: Int
    public var availableCount: Int

    /// Creates a tag; defaults describe a new active tag.
    public init(
        id: String, name: String, note: String = "", parentId: String? = nil, rank: Double = 0,
        status: TagStatus = .active, effectiveStatus: TagStatus = .active, childrenMutuallyExclusive: Bool = false,
        added: String = "", modified: String = "", remainingCount: Int = 0, availableCount: Int = 0
    ) {
        self.id = id
        self.name = name
        self.note = note
        self.parentId = parentId
        self.rank = rank
        self.status = status
        self.effectiveStatus = effectiveStatus
        self.childrenMutuallyExclusive = childrenMutuallyExclusive
        self.added = added
        self.modified = modified
        self.remainingCount = remainingCount
        self.availableCount = availableCount
    }
}

/// A notification on a task (spec §1.2). Mirrors `Alarm`.
public struct Alarm: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var taskId: String
    public var kind: AlarmKind
    public var fireDate: String?
    public var offsetSeconds: Int?
    /// Computed fire time, or nil when the anchor date is unset.
    public var effectiveFireDate: String?
}

/// A file attached to a task. Mirrors `Attachment`; `uploading` is a client-only flag for previews of uploads in flight.
public struct Attachment: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var taskId: String
    public var name: String
    public var contentType: String
    public var size: Int
    public var sha256: String
    public var added: String
    /// True while the file is still being uploaded (client-side previews only; never sent by the server).
    public var uploading: Bool?

    /// Creates an attachment record.
    public init(
        id: String, taskId: String, name: String, contentType: String, size: Int, sha256: String, added: String,
        uploading: Bool? = nil
    ) {
        self.id = id
        self.taskId = taskId
        self.name = name
        self.contentType = contentType
        self.size = size
        self.sha256 = sha256
        self.added = added
        self.uploading = uploading
    }
}

/// A task with its children, alarms, attachments and (for a project's root task) project fields. Mirrors `TaskDetail`
/// (`Task.extend(...)`): the JSON is the task's fields plus these members.
@dynamicMemberLookup
public struct TaskDetail: Codable, Sendable, Hashable, Identifiable {
    /// The task itself.
    public var task: TaskItem
    public var children: [TaskItem]
    public var alarms: [Alarm]
    public var attachments: [Attachment]
    /// Project fields when the task is a project's root task.
    public var project: ProjectRecord?

    /// The task's id.
    public var id: String { task.id }

    /// Creates a detail.
    public init(task: TaskItem, children: [TaskItem] = [], alarms: [Alarm] = [], attachments: [Attachment] = [], project: ProjectRecord? = nil) {
        self.task = task
        self.children = children
        self.alarms = alarms
        self.attachments = attachments
        self.project = project
    }

    /// Reads and writes the task's fields directly (`detail.name`).
    public subscript<T>(dynamicMember keyPath: WritableKeyPath<TaskItem, T>) -> T {
        get { task[keyPath: keyPath] }
        set { task[keyPath: keyPath] = newValue }
    }

    private enum CodingKeys: String, CodingKey { case children, alarms, attachments, project }

    /// Decodes the flat JSON.
    public init(from decoder: Decoder) throws {
        task = try TaskItem(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        children = try c.decode([TaskItem].self, forKey: .children)
        alarms = try c.decode([Alarm].self, forKey: .alarms)
        attachments = try c.decode([Attachment].self, forKey: .attachments)
        project = try c.decodeIfPresent(ProjectRecord.self, forKey: .project)
    }

    /// Encodes the flat JSON.
    public func encode(to encoder: Encoder) throws {
        try task.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(children, forKey: .children)
        try c.encode(alarms, forKey: .alarms)
        try c.encode(attachments, forKey: .attachments)
        try c.encode(project, forKey: .project)
    }
}
