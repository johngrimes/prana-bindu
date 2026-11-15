// Author: John Grimes

import Foundation

/// Visual state of a task's status circle (`circleState` in `src/web/components/outline/StatusCircle.tsx`, spec §3).
public enum CircleState: String, Sendable, Hashable, CaseIterable {
    case available, next, blocked, overdue, dueSoon, flagged, repeating, completed, dropped

    /// The state shown for `task`, in the web client's priority order.
    public init(_ task: TaskItem) {
        if task.completed != nil || task.effectiveCompleted {
            self = .completed
        } else if task.dropped != nil || task.effectiveDropped {
            self = .dropped
        } else if task.overdue {
            self = .overdue
        } else if task.dueSoon {
            self = .dueSoon
        } else if task.effectiveFlagged {
            self = .flagged
        } else if task.blocked {
            self = .blocked
        } else if task.repeat != nil {
            self = .repeating
        } else if task.firstAvailable {
            self = .next
        } else {
            self = .available
        }
    }

    /// Whether the circle carries a small repeat badge (repeating tasks whose circle shows another state).
    public func showsRepeatBadge(for task: TaskItem) -> Bool {
        task.repeat != nil && self != .repeating && self != .completed
    }
}

/// The chips and indicators of a row (`Row.tsx`): due and defer chips, flag, repeat, note and attachments.
public struct RowBadges: Sendable, Hashable {
    /// How a chip is tinted.
    public enum Tone: Sendable, Hashable {
        /// Red: overdue.
        case danger
        /// Orange: due soon.
        case warn
        /// Neutral.
        case muted
    }

    /// A date chip; `implied` dates are inherited from an ancestor (shown in italics).
    public struct DateChip: Sendable, Hashable {
        public var value: String
        public var implied: Bool
        public var tone: Tone

        /// Creates a chip.
        public init(value: String, implied: Bool, tone: Tone) {
            self.value = value
            self.implied = implied
            self.tone = tone
        }
    }

    /// The row's flag: its own, inherited (outline flag icon) or none.
    public enum Flag: Sendable, Hashable {
        case none, own, implied
    }

    public var due: DateChip?
    /// Shown while the task is deferred.
    public var deferUntil: DateChip?
    public var flag: Flag
    public var repeats: Bool
    public var hasNote: Bool
    public var attachmentCount: Int

    /// The badges of `task`.
    public init(_ task: TaskItem) {
        due = task.effectiveDueDate.map { value in
            DateChip(value: value, implied: task.dueDate == nil, tone: task.overdue ? .danger : task.dueSoon ? .warn : .muted)
        }
        deferUntil = task.deferred ? task.effectiveDeferDate.map { DateChip(value: $0, implied: task.deferDate == nil, tone: .muted) } : nil
        flag = task.flagged ? .own : task.effectiveFlagged ? .implied : .none
        repeats = task.repeat != nil
        hasNote = !task.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        attachmentCount = task.attachmentCount
    }

    /// A project row's status line: "On Hold", "N remaining" when active, else the status.
    public static func projectSummary(_ project: Project) -> String {
        switch project.status {
        case .onHold: "On Hold"
        case .active: "\(project.remainingCount) remaining"
        default: project.status.rawValue
        }
    }
}

/// Selection keys of outline rows (`rowKey`/`parseSelectionKey` in the web client): tasks and projects by id, folders
/// and tags prefixed, since ids of different kinds may collide.
public enum OutlineRowKey {
    /// A parsed selection key.
    public struct Parsed: Sendable, Hashable {
        public var kind: RowKind
        public var id: String

        /// Creates a parsed key.
        public init(kind: RowKind, id: String) {
            self.kind = kind
            self.id = id
        }
    }

    /// The selection key of `row`.
    public static func key(_ row: OutlineRow) -> String {
        switch row.kind {
        case .folder: "folder:\(row.id)"
        case .tag: "tag:\(row.id)"
        default: row.id
        }
    }

    /// The kind and id in a selection key (tasks and projects both parse as `.task`).
    public static func parse(_ key: String) -> Parsed {
        if key.hasPrefix("folder:") { return Parsed(kind: .folder, id: String(key.dropFirst(7))) }
        if key.hasPrefix("tag:") { return Parsed(kind: .tag, id: String(key.dropFirst(4))) }
        return Parsed(kind: .task, id: key)
    }
}

/// Selected row keys (in selection order) and the anchor of range selections.
public struct OutlineSelectionState: Sendable, Hashable {
    public var keys: [String]
    public var anchor: String?

    /// Creates a selection.
    public init(keys: [String] = [], anchor: String? = nil) {
        self.keys = keys
        self.anchor = anchor
    }
}

/// Selection gestures of the outline (`selectRow` and `moveSelection` in `Outline.tsx`).
public enum OutlineSelecting {
    /// Modifier of a click or tap.
    public enum Modifier: Sendable, Hashable {
        /// Selects just the row.
        case none
        /// Cmd-click: adds or removes the row.
        case toggle
        /// Shift-click: selects the range from the anchor.
        case extend
    }

    /// The selection after clicking the row `key`; `order` is the displayed rows' keys.
    public static func click(_ key: String, _ modifier: Modifier, order: [String], state: OutlineSelectionState) -> OutlineSelectionState {
        switch modifier {
        case .toggle:
            let keys = state.keys.contains(key) ? state.keys.filter { $0 != key } : state.keys + [key]
            return OutlineSelectionState(keys: keys, anchor: key)
        case .extend:
            if let anchor = state.anchor, let a = order.firstIndex(of: anchor), let b = order.firstIndex(of: key) {
                return OutlineSelectionState(keys: Array(order[min(a, b)...max(a, b)]), anchor: anchor)
            }
            return OutlineSelectionState(keys: [key], anchor: key)
        case .none:
            return OutlineSelectionState(keys: [key], anchor: key)
        }
    }

    /// The selection after ↑ (`delta` -1) or ↓ (+1), extended from the anchor with Shift.
    public static func move(by delta: Int, extend: Bool, order: [String], state: OutlineSelectionState) -> OutlineSelectionState {
        guard !order.isEmpty else { return state }
        let focusKey = extend && !state.keys.isEmpty ? (delta > 0 ? state.keys.last : state.keys.first) : nil
        var idx: Int
        if let focusKey {
            idx = (order.firstIndex(of: focusKey) ?? -1) + delta
        } else {
            let current = delta > 0 ? order.lastIndex(where: state.keys.contains) : order.firstIndex(where: state.keys.contains)
            idx = current.map { $0 + delta } ?? (delta > 0 ? 0 : order.count - 1)
        }
        idx = max(0, min(order.count - 1, idx))
        if extend, let anchor = state.anchor, let a = order.firstIndex(of: anchor) {
            return OutlineSelectionState(keys: Array(order[min(a, idx)...max(a, idx)]), anchor: anchor)
        }
        return OutlineSelectionState(keys: [order[idx]], anchor: order[idx])
    }
}

/// A hardware key the outline handles.
public enum OutlineKey: Sendable, Hashable {
    case up, down, left, right, `return`, tab, escape, delete
    case character(String)
}

/// Where a new item goes relative to a row.
public enum NewItemPosition: Sendable, Hashable {
    /// The next sibling (Return).
    case after
    /// The previous sibling (Shift-Return).
    case before
    /// The first child (`}`).
    case child
    /// After the row's parent (`{`).
    case outdented
}

/// What an outline key does (as in `Outline.tsx`; spec §3 Editing).
public enum OutlineKeyCommand: Sendable, Hashable {
    case moveSelection(Int, extend: Bool)
    case operation(OutlineOperation)
    /// Collapses (true) or expands the selected rows.
    case collapse(Bool)
    case newItem(NewItemPosition)
    /// Edits the first selected row's title.
    case edit
    /// Opens the inspector at the note.
    case editNote
    case complete
    case flag
    case delete
    case clearSelection

    /// The command for `key` with modifiers, or nil when the outline ignores it.
    public static func command(for key: OutlineKey, shift: Bool, alt: Bool, command: Bool, hasSelection: Bool) -> OutlineKeyCommand? {
        if command { return key == .return && hasSelection ? .edit : nil }
        switch key {
        case .up, .down:
            let delta = key == .up ? -1 : 1
            if alt && shift { return .operation(key == .up ? .moveUp : .moveDown) }
            return .moveSelection(delta, extend: shift)
        case .left, .right:
            if shift { return .operation(key == .left ? .outdent : .indent) }
            return hasSelection ? .collapse(key == .left) : nil
        case .return:
            return hasSelection ? .newItem(shift ? .before : .after) : nil
        case .tab:
            return hasSelection && !alt ? .edit : nil
        case .escape:
            return hasSelection ? .clearSelection : nil
        case .delete:
            return hasSelection ? .delete : nil
        case .character(let c):
            switch c {
            case "e", "E": return hasSelection && !alt ? .edit : nil
            case "'": return hasSelection ? .editNote : nil
            case "]": return .operation(.indent)
            case "[": return .operation(.outdent)
            case "}": return hasSelection ? .newItem(.child) : nil
            case "{": return hasSelection ? .newItem(.outdented) : nil
            case "g": return .operation(.group)
            case "u": return .operation(.ungroup)
            case " ": return hasSelection ? .complete : nil
            case "f": return hasSelection ? .flag : nil
            default: return nil
            }
        }
    }
}

/// Where "New item" goes when nothing is selected (`NewItemTarget` in `Outline.tsx`): the inbox (with the page's tag
/// or flag) or a project.
public struct NewItemTarget: Sendable, Hashable {
    public var projectId: String?
    public var tagIds: [String]?
    public var flagged: Bool?

    /// Creates a target; no project means the inbox.
    public init(projectId: String? = nil, tagIds: [String]? = nil, flagged: Bool? = nil) {
        self.projectId = projectId
        self.tagIds = tagIds
        self.flagged = flagged
    }

    /// The target for an outline's contents, as the web pages choose it.
    public init(contents key: ContentsKey) {
        if let project = key.project {
            self.init(projectId: project)
        } else if let tag = key.tag, tag != "untagged" {
            self.init(tagIds: [tag])
        } else if key.perspectiveId == "flagged" {
            self.init(flagged: true)
        } else {
            self.init()
        }
    }
}

/// Per-page outline settings the web pages pass to `Outline`.
public enum OutlinePresentation {
    /// Whether rows show their project (outside Projects, Inbox and Review).
    public static func showsProject(_ key: ContentsKey) -> Bool {
        !["projects", "inbox", "review"].contains(key.perspectiveId)
    }

    /// The empty-state text (spec §2).
    public static func emptyText(_ contents: OutlineContents) -> String {
        if let text = contents.emptyText { return text }
        return contents.perspectiveId == "projects" ? "No projects" : "No items"
    }
}

/// How a new item is created (`createItem` in `Outline.tsx`).
public enum NewItemPlan: Sendable, Hashable {
    /// Create this task, shown at this place.
    case create(TaskCreate, RowPlace)
    /// No place in the outline for it: open Quick Entry instead.
    case quickEntry

    /// The plan for a new item relative to `row` (nil: nothing selected) in the displayed `groups`.
    public static func make(relativeTo row: DisplayRow?, _ position: NewItemPosition, target: NewItemTarget?, groups: [OutlineGroup]) -> NewItemPlan {
        guard let row else {
            guard let target else { return .quickEntry }
            var input = TaskCreate(name: "", position: .end, flagged: target.flagged, tagIds: target.tagIds)
            if let project = target.projectId { input.projectId = project } else { input.inbox = true }
            // At the end of the project's group when shown, else of the first group (a new one in an empty outline).
            if let project = target.projectId, groups.contains(where: { $0.key == project }) {
                return .create(input, RowPlace(parentId: project, after: nil, last: true, groupKey: project))
            }
            let key = groups.first?.key ?? target.projectId ?? "inbox"
            return .create(input, RowPlace(parentId: nil, after: nil, last: true, groupKey: key, ensureGroup: true))
        }
        let r = row.row
        let task = r.kind == .project ? r.project?.task : r.kind == .task ? r.task : nil
        guard task != nil else { return .quickEntry }
        var input = TaskCreate(name: "", flagged: target?.flagged, tagIds: target?.tagIds)
        if r.kind == .project || position == .child {
            if r.kind == .project { input.projectId = r.id } else { input.parentId = r.id }
            input.position = .start
            return .create(input, RowPlace(parentId: r.id, after: nil, groupKey: row.groupKey))
        }
        var anchor = r
        if position == .outdented, let parentId = task?.parentId,
            let parent = groups.lazy.flatMap(\.rows).first(where: { $0.id == parentId }), parent.kind != .project
        {
            anchor = parent
        }
        let place = OutlineRows.findRow(groups, anchor.id)?.at
        input.position = position == .before ? .before(r.id) : .after(anchor.id)
        return .create(
            input, RowPlace(parentId: place?.parentId, after: position == .before ? place?.after : anchor.id, groupKey: row.groupKey))
    }
}
