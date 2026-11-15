// Author: John Grimes

import Foundation

/// Why Quick Entry cannot save yet.
public enum QuickEntryError: Error, Hashable, Sendable {
    /// The title is blank.
    case emptyTitle
    /// The due text does not parse; the sheet stays open.
    case unparseableDue

    /// The message shown under the field.
    public var message: String {
        switch self {
        case .emptyTitle: "Enter a title"
        case .unparseableDue: DateEntry.invalidMessage
        }
    }
}

/// The Quick Entry form (spec §4, `src/web/components/QuickEntry.tsx`). The due date is parsed on the device before
/// saving, so a fast save never loses it and a queued or retried save cannot resolve "tomorrow" differently.
public struct QuickEntryDraft: Hashable, Sendable {
    /// The title.
    public var name = ""
    /// The chosen project; nil saves to the Inbox.
    public var project: MatchItem?
    /// Chosen tags, in the order added.
    public var tags: [MatchItem] = []
    /// Natural-language due date text.
    public var due = ""
    /// The note.
    public var note = ""
    /// Whether the item is flagged.
    public var flagged = false

    /// An empty form.
    public init() {}

    /// Whether Save is enabled.
    public var canSave: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The sheet title: the project's name, or "Inbox".
    public var title: String { project?.name ?? "Inbox" }

    /// The toast after saving.
    public var confirmation: String { project.map { "Added to \($0.name)" } ?? "Added to Inbox" }

    /// Adds a tag once.
    public mutating func addTag(_ tag: MatchItem) {
        if !tags.contains(where: { $0.id == tag.id }) { tags.append(tag) }
    }

    /// Removes a tag.
    public mutating func removeTag(_ id: String) {
        tags.removeAll { $0.id == id }
    }

    /// The hint under the Due field.
    public func duePreview(settings: Settings, now: Date) -> DateEntry.Preview {
        guard !due.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .none }
        switch Optimistic.resolveDateInput(due, field: .due, settings: settings, now: now) {
        case .some(let value?): return .parsed(DateDisplay.formatDateTime(value, settings: settings))
        default: return .invalid
        }
    }

    /// The create body: Inbox, or the start of the chosen project, with the due date already resolved.
    public func makeTask(id: String, settings: Settings, now: Date) -> Result<TaskCreate, QuickEntryError> {
        guard canSave else { return .failure(.emptyTitle) }
        var dueDate: String?
        if !due.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard case .some(let value?) = Optimistic.resolveDateInput(due, field: .due, settings: settings, now: now) else {
                return .failure(.unparseableDue)
            }
            dueDate = value
        }
        var task = TaskCreate(id: id, name: name.trimmingCharacters(in: .whitespacesAndNewlines))
        task.note = note.isEmpty ? nil : note
        task.flagged = flagged
        task.dueDate = .some(dueDate)
        task.tagIds = tags.map(\.id)
        if let project {
            task.projectId = project.id
            task.position = .start
        } else {
            task.inbox = true
        }
        return .success(task)
    }
}
