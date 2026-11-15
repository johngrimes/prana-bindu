// Author: John Grimes

import Foundation

/// A task (or a project's root task) as the server returns it (spec §1.2, §1.3). Mirrors `Task` in
/// `src/shared/schemas.ts`; named `TaskItem` because Swift's `Task` is taken.
///
/// Date values stay exactly as the server sends them: fixed instants end in `Z`, floating wall times have no offset.
public struct TaskItem: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var note: String
    public var parentId: String?
    public var projectId: String?
    /// True when this task is a project's root task.
    public var isProject: Bool
    public var inInbox: Bool
    /// Sort order among siblings. The server sends integers; client previews may use fractions between them.
    public var rank: Double
    public var flagged: Bool
    public var deferDate: String?
    public var plannedDate: String?
    public var dueDate: String?
    public var estimatedMinutes: Int?
    /// When the task was completed (fixed timestamp), or nil.
    public var completed: String?
    /// When the task was dropped (fixed timestamp), or nil.
    public var dropped: String?
    public var added: String
    public var modified: String
    public var sequential: Bool
    public var completedByChildren: Bool
    public var `repeat`: RepeatRule?
    public var assignedProjectId: String?
    public var tagIds: [String]
    public var attachmentCount: Int
    public var childCount: Int
    public var remainingChildCount: Int
    // Derived (spec §1.3).
    public var effectiveFlagged: Bool
    public var effectiveDeferDate: String?
    public var effectivePlannedDate: String?
    public var effectiveDueDate: String?
    public var effectiveCompleted: Bool
    public var effectiveDropped: Bool
    public var remaining: Bool
    public var deferred: Bool
    public var blocked: Bool
    public var available: Bool
    public var firstAvailable: Bool
    public var overdue: Bool
    public var dueSoon: Bool
    public var status: TaskStatus
    /// The containing project's name, for display.
    public var projectName: String?

    /// Creates a task; the defaults describe a new, empty, available task (as drafts start out).
    public init(
        id: String, name: String = "", note: String = "", parentId: String? = nil, projectId: String? = nil,
        isProject: Bool = false, inInbox: Bool = false, rank: Double = 0, flagged: Bool = false, deferDate: String? = nil,
        plannedDate: String? = nil, dueDate: String? = nil, estimatedMinutes: Int? = nil, completed: String? = nil,
        dropped: String? = nil, added: String = "", modified: String = "", sequential: Bool = false,
        completedByChildren: Bool = false, repeat: RepeatRule? = nil, assignedProjectId: String? = nil,
        tagIds: [String] = [], attachmentCount: Int = 0, childCount: Int = 0, remainingChildCount: Int = 0,
        effectiveFlagged: Bool = false, effectiveDeferDate: String? = nil, effectivePlannedDate: String? = nil,
        effectiveDueDate: String? = nil, effectiveCompleted: Bool = false, effectiveDropped: Bool = false,
        remaining: Bool = true, deferred: Bool = false, blocked: Bool = false, available: Bool = true,
        firstAvailable: Bool = false, overdue: Bool = false, dueSoon: Bool = false, status: TaskStatus = .available,
        projectName: String? = nil
    ) {
        self.id = id
        self.name = name
        self.note = note
        self.parentId = parentId
        self.projectId = projectId
        self.isProject = isProject
        self.inInbox = inInbox
        self.rank = rank
        self.flagged = flagged
        self.deferDate = deferDate
        self.plannedDate = plannedDate
        self.dueDate = dueDate
        self.estimatedMinutes = estimatedMinutes
        self.completed = completed
        self.dropped = dropped
        self.added = added
        self.modified = modified
        self.sequential = sequential
        self.completedByChildren = completedByChildren
        self.repeat = `repeat`
        self.assignedProjectId = assignedProjectId
        self.tagIds = tagIds
        self.attachmentCount = attachmentCount
        self.childCount = childCount
        self.remainingChildCount = remainingChildCount
        self.effectiveFlagged = effectiveFlagged
        self.effectiveDeferDate = effectiveDeferDate
        self.effectivePlannedDate = effectivePlannedDate
        self.effectiveDueDate = effectiveDueDate
        self.effectiveCompleted = effectiveCompleted
        self.effectiveDropped = effectiveDropped
        self.remaining = remaining
        self.deferred = deferred
        self.blocked = blocked
        self.available = available
        self.firstAvailable = firstAvailable
        self.overdue = overdue
        self.dueSoon = dueSoon
        self.status = status
        self.projectName = projectName
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, note, parentId, projectId, isProject, inInbox, rank, flagged, deferDate, plannedDate, dueDate
        case estimatedMinutes, completed, dropped, added, modified, sequential, completedByChildren, `repeat`
        case assignedProjectId, tagIds, attachmentCount, childCount, remainingChildCount, effectiveFlagged
        case effectiveDeferDate, effectivePlannedDate, effectiveDueDate, effectiveCompleted, effectiveDropped, remaining
        case deferred, blocked, available, firstAvailable, overdue, dueSoon, status, projectName
    }

    /// Encodes every key, with explicit nulls (as the server does), so previews can merge field changes reliably.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(note, forKey: .note)
        try c.encode(parentId, forKey: .parentId)
        try c.encode(projectId, forKey: .projectId)
        try c.encode(isProject, forKey: .isProject)
        try c.encode(inInbox, forKey: .inInbox)
        try c.encode(rank, forKey: .rank)
        try c.encode(flagged, forKey: .flagged)
        try c.encode(deferDate, forKey: .deferDate)
        try c.encode(plannedDate, forKey: .plannedDate)
        try c.encode(dueDate, forKey: .dueDate)
        try c.encode(estimatedMinutes, forKey: .estimatedMinutes)
        try c.encode(completed, forKey: .completed)
        try c.encode(dropped, forKey: .dropped)
        try c.encode(added, forKey: .added)
        try c.encode(modified, forKey: .modified)
        try c.encode(sequential, forKey: .sequential)
        try c.encode(completedByChildren, forKey: .completedByChildren)
        try c.encode(`repeat`, forKey: .repeat)
        try c.encode(assignedProjectId, forKey: .assignedProjectId)
        try c.encode(tagIds, forKey: .tagIds)
        try c.encode(attachmentCount, forKey: .attachmentCount)
        try c.encode(childCount, forKey: .childCount)
        try c.encode(remainingChildCount, forKey: .remainingChildCount)
        try c.encode(effectiveFlagged, forKey: .effectiveFlagged)
        try c.encode(effectiveDeferDate, forKey: .effectiveDeferDate)
        try c.encode(effectivePlannedDate, forKey: .effectivePlannedDate)
        try c.encode(effectiveDueDate, forKey: .effectiveDueDate)
        try c.encode(effectiveCompleted, forKey: .effectiveCompleted)
        try c.encode(effectiveDropped, forKey: .effectiveDropped)
        try c.encode(remaining, forKey: .remaining)
        try c.encode(deferred, forKey: .deferred)
        try c.encode(blocked, forKey: .blocked)
        try c.encode(available, forKey: .available)
        try c.encode(firstAvailable, forKey: .firstAvailable)
        try c.encode(overdue, forKey: .overdue)
        try c.encode(dueSoon, forKey: .dueSoon)
        try c.encode(status, forKey: .status)
        try c.encode(projectName, forKey: .projectName)
    }
}
