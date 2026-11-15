// Author: John Grimes

import Foundation

/// Tags added to and removed from a task, resolved against the task as shown when the preview applies.
public struct TagEdit: Sendable, Hashable {
    public var add: [String]
    public var remove: [String]

    /// Creates an edit.
    public init(add: [String] = [], remove: [String] = []) {
        self.add = add
        self.remove = remove
    }

    /// The tag ids after the edit: removed ones go, added ones not yet present go on the end.
    public func apply(to tagIds: [String]) -> [String] {
        tagIds.filter { !remove.contains($0) } + add.filter { !tagIds.contains($0) }
    }
}

/// Field changes for tasks (`TaskChanges` in `src/web/lib/optimistic.ts`): plain fields, plus an optional tag edit
/// that depends on each task's current tags.
public struct TaskChange: Sendable, Hashable {
    public var fields: Fields
    public var tagEdit: TagEdit?

    /// Creates a change.
    public init(_ fields: Fields = [:], tagEdit: TagEdit? = nil) {
        self.fields = fields
        self.tagEdit = tagEdit
    }

    /// The concrete fields this change sets on `task`.
    public func resolved(for task: TaskItem) -> Fields {
        guard let tagEdit else { return fields }
        var out = fields
        out["tagIds"] = .array(tagEdit.apply(to: task.tagIds).map { .string($0) })
        return out
    }
}

/// Where a row sits in an outline: under `parentId` (a displayed row, or nil for a group root), after sibling `after`.
public struct RowPlace: Sendable, Hashable {
    public var parentId: String?
    /// Previous sibling; nil places the row first under its parent.
    public var after: String?
    /// Places the row after the parent's last child instead (`after` is ignored).
    public var last: Bool
    /// Group that takes a root row (`parentId` nil) when no anchor is shown, e.g. `inbox`.
    public var groupKey: String?
    /// Shows the `groupKey` group (holding just this row) when the outline has no such group yet.
    public var ensureGroup: Bool

    /// Creates a place.
    public init(parentId: String?, after: String?, last: Bool = false, groupKey: String? = nil, ensureGroup: Bool = false) {
        self.parentId = parentId
        self.after = after
        self.last = last
        self.groupKey = groupKey
        self.ensureGroup = ensureGroup
    }
}

/// A row (with its subtree) placed somewhere, or removed when `at` is nil.
public struct RowChange: Sendable, Hashable {
    public var id: String
    public var at: RowPlace?
    /// The row and its subtree, for showing it where it is not displayed yet (created or restored rows).
    public var rows: [OutlineRow]?
    /// Limits the change to one group (e.g. a row leaving its old project's group).
    public var inGroup: String?

    /// Creates a row change.
    public init(id: String, at: RowPlace?, rows: [OutlineRow]? = nil, inGroup: String? = nil) {
        self.id = id
        self.at = at
        self.rows = rows
        self.inGroup = inGroup
    }
}

/// The cached lists item changes apply to.
public enum ListName: String, Sendable, Hashable, CaseIterable {
    case folders, tags, perspectives, projects
}

/// An item of one of the cached lists.
public enum ListItem: Sendable, Hashable {
    case folder(Folder)
    case tag(Tag)
    case perspective(Perspective)
    case project(Project)

    /// The item's id.
    public var id: String {
        switch self {
        case .folder(let v): v.id
        case .tag(let v): v.id
        case .perspective(let v): v.id
        case .project(let v): v.id
        }
    }

    /// The item's JSON fields.
    var fields: Fields {
        switch self {
        case .folder(let v): JSONBridge.fields(v)
        case .tag(let v): JSONBridge.fields(v)
        case .perspective(let v): JSONBridge.fields(v)
        case .project(let v): JSONBridge.fields(v)
        }
    }
}

/// A record type held in one of the cached lists.
public protocol ListEntity: Codable, Sendable, Identifiable where ID == String {
    /// The list holding this type.
    static var listName: ListName { get }
    /// The record, if `item` is one of this type.
    init?(_ item: ListItem)
    /// The record as a list item.
    var listItem: ListItem { get }
}

extension Folder: ListEntity {
    /// Folders.
    public static var listName: ListName { .folders }
    /// The folder in `item`.
    public init?(_ item: ListItem) {
        guard case .folder(let v) = item else { return nil }
        self = v
    }
    /// As a list item.
    public var listItem: ListItem { .folder(self) }
}

extension Tag: ListEntity {
    /// Tags.
    public static var listName: ListName { .tags }
    /// The tag in `item`.
    public init?(_ item: ListItem) {
        guard case .tag(let v) = item else { return nil }
        self = v
    }
    /// As a list item.
    public var listItem: ListItem { .tag(self) }
}

extension Perspective: ListEntity {
    /// Perspectives.
    public static var listName: ListName { .perspectives }
    /// The perspective in `item`.
    public init?(_ item: ListItem) {
        guard case .perspective(let v) = item else { return nil }
        self = v
    }
    /// As a list item.
    public var listItem: ListItem { .perspective(self) }
}

extension Project: ListEntity {
    /// Projects.
    public static var listName: ListName { .projects }
    /// The project in `item`.
    public init?(_ item: ListItem) {
        guard case .project(let v) = item else { return nil }
        self = v
    }
    /// As a list item.
    public var listItem: ListItem { .project(self) }
}

/// What an item change does.
public enum ItemEdit: Sendable, Hashable {
    /// Adds the item, or replaces it.
    case replace(ListItem)
    /// Removes the item.
    case remove
    /// Merges fields into the item (top-level fields, like an object spread).
    case patch(Fields)
}

/// A list item added, replaced, removed or patched.
public struct ItemChange: Sendable, Hashable {
    public var list: ListName
    public var id: String
    public var edit: ItemEdit

    /// Creates an item change.
    public init(list: ListName, id: String, edit: ItemEdit) {
        self.list = list
        self.id = id
        self.edit = edit
    }
}

/// One change a pending write makes to what is shown (`Change` in `src/web/lib/optimistic.ts`). A write's changes show
/// from the moment it is queued until the refresh after it lands; a failure reverts them. Changes are data, so the
/// queue can capture what they overwrite as an instant undo snapshot.
public enum Change: Sendable, Hashable {
    /// Field changes to tasks and, for projects, to their project records.
    case task(ids: [String], task: TaskChange? = nil, project: Fields? = nil)
    /// A row moved, added or removed in outlines.
    case row(RowChange)
    /// A cached list item changed.
    case item(ItemChange)
    /// Settings changed.
    case settings(Fields)
    /// An attachment added (or replaced) on a task's detail, or removed when `value` is nil.
    case attachment(taskId: String, id: String, value: Attachment?)

    /// Plain field changes to tasks.
    public static func taskFields(_ ids: [String], _ fields: Fields) -> Change {
        .task(ids: ids, task: TaskChange(fields))
    }

    /// The row change, if this is one.
    public var rowChange: RowChange? {
        if case .row(let change) = self { return change }
        return nil
    }

    /// Whether this is a field change touching item `id`.
    func touches(_ id: String) -> Bool {
        if case .task(let ids, _, _) = self { return ids.contains(id) }
        return false
    }
}
