// Author: John Grimes

import Observation
import PranaKit
import SwiftUI

/// PranaKit's group, not SwiftUI's disclosure `OutlineGroup`.
private typealias OutlineGroup = PranaKit.OutlineGroup

/// Collapsed rows (`groupKey/id`), remembered across outlines for the session like the web's `ui.collapsed`.
@MainActor
@Observable
final class OutlineCollapse {
    static let shared = OutlineCollapse()
    var keys: Set<String> = []

    /// Expands every occurrence of the rows `ids` (in any group).
    func expand(_ ids: Set<String>) {
        let remaining = keys.filter { key in
            guard let slash = key.lastIndex(of: "/") else { return true }
            return !ids.contains(String(key[key.index(after: slash)...]))
        }
        if remaining != keys { keys = remaining }
    }
}

/// The outline's behaviour (port of `Outline.tsx`): rows kept until Clean Up, the displayed rows, selection, inline
/// editing and every command (new items, restructuring, completion, flags, deletion, drag moves). Views stay thin.
@MainActor
@Observable
final class OutlineController {
    @ObservationIgnored let store: AppStore
    @ObservationIgnored var selectionModel: SelectionModel
    @ObservationIgnored var navigator: Navigator?
    private(set) var contentsKey: ContentsKey
    var newItemTarget: NewItemTarget?
    /// The server's rows when they do not come from the store's contents (the Forecast's days); nil uses
    /// `store.base.contents[contentsKey]`.
    @ObservationIgnored var serverOverride: [PranaKit.OutlineGroup]?

    /// Rows kept visible until Clean Up or navigation.
    var kept: KeptRows
    /// Bumped whenever the server's contents for this outline change (kept rows record it).
    private(set) var serverVersion = 0
    /// The row whose title is being edited.
    var editingId: String?
    /// Selection anchor for Shift-range selection from the keyboard.
    var anchor: String?
    /// Rows this outline created that have not been titled yet (discarded if left empty).
    @ObservationIgnored var untitledNew: Set<String> = []
    @ObservationIgnored private var listener: UUID?
    @ObservationIgnored private var epoch: Int
    @ObservationIgnored private var journal: Int
    @ObservationIgnored private var rereadVersion = -1

    init(store: AppStore, contentsKey: ContentsKey, selection: SelectionModel) {
        self.store = store
        self.contentsKey = contentsKey
        self.selectionModel = selection
        kept = KeptRows(since: store.writesQueued)
        epoch = store.stickyEpoch
        journal = store.journalEpoch
    }

    // MARK: Lifecycle

    /// Starts keeping rows touched by writes (until Clean Up or navigation).
    func start() {
        guard listener == nil else { return }
        listener = store.onTasksChanged { [weak self] tasks, queued in
            guard let self else { return }
            kept.keep(tasks, queued: queued, merged: merged(), serverVersion: serverVersion)
        }
    }

    /// Stops listening.
    func stop() {
        if let listener { store.removeTaskListener(listener) }
        listener = nil
    }

    /// A new scope (another route's contents) starts with no kept rows.
    func show(_ key: ContentsKey) {
        guard key != contentsKey else { return }
        contentsKey = key
        kept = KeptRows(since: store.writesQueued)
        editingId = nil
        untitledNew = []
    }

    /// Follows the store's epochs: Clean Up and navigation drop kept rows; undo/redo forgets local deletions.
    func syncEpochs() {
        if store.stickyEpoch != epoch {
            epoch = store.stickyEpoch
            kept = KeptRows(since: store.writesQueued)
        } else if store.journalEpoch != journal {
            journal = store.journalEpoch
            kept.deleted = []
        }
    }

    /// The server's contents changed: newer than any kept row's, and kept rows it lacks are re-read.
    func serverChanged() {
        serverVersion += 1
        rereadMissing()
    }

    /// Kept rows the server no longer returns are re-read so they show current data (e.g. after undo/redo); rows that
    /// no longer exist (undone creation) are dropped.
    private func rereadMissing() {
        let present = Set(serverGroups.flatMap { $0.rows.map(\.id) })
        let missing = kept.sticky.filter { $0.row.kind == .task && !present.contains($0.row.id) && !kept.deleted.contains($0.row.id) }
        guard !missing.isEmpty, rereadVersion != serverVersion else { return }
        rereadVersion = serverVersion
        let ids = missing.map(\.row.id)
        Task { [weak self, store] in
            var results: [String: TaskItem?] = [:]
            for id in ids {
                do throws(APIError) {
                    results[id] = .some(try await store.send(Endpoints.task(id)).task)
                } catch .server(let status, _, _) where status == 404 {
                    results[id] = .some(nil)
                } catch {}
            }
            guard let self, !results.isEmpty else { return }
            kept.reread(results)
        }
    }

    // MARK: Displayed rows

    /// Last server data for this outline.
    var serverGroups: [PranaKit.OutlineGroup] { serverOverride ?? store.base.contents[contentsKey]?.groups ?? [] }

    /// The server data with pending previews applied, as shown.
    var shownGroups: [PranaKit.OutlineGroup] {
        serverOverride.map(previewed) ?? store.state.contents[contentsKey]?.groups ?? []
    }

    /// Server rows from outside the store's contents with the pending previews applied, as the store does for them.
    func previewed(_ server: [PranaKit.OutlineGroup]) -> [PranaKit.OutlineGroup] {
        Optimistic.previewGroups(server, store.pendingChanges, settings: store.settings, now: Date())
    }

    /// Shown contents (pending previews applied) + kept rows − locally hidden ones, with cached folders and tags.
    func merged(_ shown: [PranaKit.OutlineGroup]? = nil) -> [PranaKit.OutlineGroup] {
        let groups = shown ?? shownGroups
        let merged = OutlineDisplay.mergeContents(groups, sticky: kept.sticky, deleted: kept.deleted)
        let folders = Dictionary((store.state.folders ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let tags = Dictionary((store.state.tags ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return OutlineDisplay.withCachedContainers(merged, folders: folders, tags: tags)
    }

    /// Everything a render needs, computed once.
    struct Snapshot {
        var merged: [PranaKit.OutlineGroup]
        var display: [DisplayGroup]
        var flat: [DisplayRow]
        var leaving: Set<String>
        var disclosureColumn: Bool
    }

    /// The display for `shown` contents.
    func snapshot(_ shown: [PranaKit.OutlineGroup]) -> Snapshot {
        let merged = merged(shown)
        let display = OutlineDisplay.visibleRows(merged, collapsed: OutlineCollapse.shared.keys)
        let flat = display.flatMap(\.rows)
        let placed = Set(store.pendingChanges.compactMap { $0.rowChange?.at != nil ? $0.rowChange?.id : nil })
        let projectIds = Set((store.state.projects ?? []).map(\.id))
        let leaving = OutlineDisplay.leavingRows(
            merged, server: serverGroups, serverVersion: serverVersion, sticky: kept.sticky, projectIds: projectIds, placed: placed)
        return Snapshot(merged: merged, display: display, flat: flat, leaving: leaving, disclosureColumn: display.hasDisclosureColumn)
    }

    private var current: Snapshot { snapshot(shownGroups) }

    /// Clean Up's preview: the greyed rows removed from their groups.
    func leavingChanges() -> [Change] {
        OutlineDisplay.cleanUpChanges(current.leaving.sorted())
    }

    // MARK: Selection

    /// Selected row keys (`OutlineRowKey`), in display order.
    var selectedKeys: [String] {
        let sel = selectionModel.selection
        guard !sel.isEmpty else { return [] }
        let keys = Set(sel.ids.map { id in
            switch sel.kind {
            case .folder: "folder:\(id)"
            case .tag: "tag:\(id)"
            default: id
            }
        })
        let flat = current.flat
        let ordered = flat.map { OutlineRowKey.key($0.row) }.filter(keys.contains)
        var seen = Set<String>()
        return ordered.filter { seen.insert($0).inserted }
    }

    /// Selects rows by key (the inspector edits them); the kind follows the first row.
    func select(_ keys: [String], anchor: String? = nil) {
        self.anchor = anchor ?? keys.last
        guard let first = keys.first else {
            selectionModel.selection = .none
            return
        }
        let parsed = keys.map(OutlineRowKey.parse)
        let kind: Selection.Kind =
            switch parsed[0].kind {
            case .folder: .folder
            case .tag: .tag
            default: current.flat.first { $0.row.id == parsed[0].id }?.row.kind == .project ? .project : .task
            }
        _ = first
        selectionModel.selection = Selection(ids: Set(parsed.map(\.id)), kind: kind)
    }

    /// Selects a row as a tap does (`selectRow`): plain, toggling (Cmd) or extending (Shift).
    func tap(_ row: DisplayRow, _ modifier: OutlineSelecting.Modifier = .none) {
        let order = selectableOrder()
        let state = OutlineSelecting.click(
            OutlineRowKey.key(row.row), modifier, order: order, state: OutlineSelectionState(keys: selectedKeys, anchor: anchor))
        editingId = nil
        select(state.keys, anchor: state.anchor)
        if modifier == .none, navigator?.isCompact == true { navigator?.showInspector() }
    }

    /// Moves or extends the selection with ↑/↓ (`moveSelection`).
    func moveSelection(_ delta: Int, extend: Bool) {
        let state = OutlineSelecting.move(
            by: delta, extend: extend, order: selectableOrder(), state: OutlineSelectionState(keys: selectedKeys, anchor: anchor))
        editingId = nil
        select(state.keys, anchor: state.anchor)
    }

    private func selectableOrder() -> [String] {
        current.flat.filter { !AppStore.isOccurrenceStandIn($0.row.id) }.map { OutlineRowKey.key($0.row) }
    }

    func clearSelection() {
        select([])
    }

    private func firstSelectedRow() -> DisplayRow? {
        let keys = Set(selectedKeys)
        return current.flat.first { keys.contains(OutlineRowKey.key($0.row)) }
    }

    private func lastSelectedRow() -> DisplayRow? {
        let keys = Set(selectedKeys)
        return current.flat.last { keys.contains(OutlineRowKey.key($0.row)) }
    }

    func findRow(_ id: String) -> DisplayRow? {
        current.flat.first { $0.row.id == id }
    }

    // MARK: Collapse

    func isCollapsed(_ row: DisplayRow) -> Bool {
        OutlineCollapse.shared.keys.contains(row.id)
    }

    func setCollapsed(_ row: DisplayRow, _ value: Bool) {
        if value { OutlineCollapse.shared.keys.insert(row.id) } else { OutlineCollapse.shared.keys.remove(row.id) }
    }

    /// Expands `taskId`'s ancestors so a row being edited is never hidden in a collapsed parent.
    private func expandAncestors(_ taskId: String, moved: [Change] = []) {
        let flat = current.flat
        func parentOf(_ id: String) -> String? {
            if let at = moved.compactMap(\.rowChange).first(where: { $0.id == id && $0.at != nil })?.at { return at.parentId }
            return flat.first { $0.row.id == id }?.row.task?.parentId
        }
        var ancestors = Set<String>()
        var p = parentOf(taskId)
        while let id = p, !ancestors.contains(id) {
            ancestors.insert(id)
            p = parentOf(id)
        }
        if !ancestors.isEmpty { OutlineCollapse.shared.expand(ancestors) }
    }

    // MARK: Commands

    /// Adds a new item relative to a row (or at the target's end) and starts editing it (`createItem`).
    func createItem(relativeTo row: DisplayRow?, _ position: NewItemPosition) {
        switch NewItemPlan.make(relativeTo: row, position, target: newItemTarget, groups: current.merged) {
        case .quickEntry:
            navigator?.showsQuickEntry = true
        case .create(var input, let at):
            let id = ClientID.make()
            input.id = id
            store.createTask(input, placement: .at(at))
            untitledNew.insert(id)
            // A child added under a collapsed row would be hidden: expand its parent so the editor is visible.
            if let parent = at.parentId { OutlineCollapse.shared.expand([parent]) }
            select([id])
            editingId = id
        }
    }

    /// "New item" from the shell: after the last selected row, else at the target's end.
    func newItem() {
        createItem(relativeTo: lastSelectedRow(), .after)
    }

    /// Restructures the selected tasks at once (the server applies the same operation in the background).
    @discardableResult
    func outlineOperation(_ op: OutlineOperation) -> [Change] {
        let flat = current.flat
        let ids = selectedKeys.filter { key in flat.first { $0.row.id == key }?.row.kind == .task }
        guard !ids.isEmpty else { return [] }
        var group: OutlineRow?
        if op == .group {
            let first = flat.first { ids.contains($0.row.id) }?.row.task
            let id = ClientID.make()
            var fields: Fields = [:]
            if let first {
                fields = [
                    "parentId": first.parentId.map(JSONValue.string) ?? .null,
                    "projectId": first.projectId.map(JSONValue.string) ?? .null,
                    "projectName": first.projectName.map(JSONValue.string) ?? .null,
                    "inInbox": .bool(first.inInbox),
                ]
            }
            group = OutlineRow(kind: .task, id: id, depth: 0, task: Drafts.draftTask(id, fields, settings: store.settings, now: .now))
        }
        let rows = OutlineOps.changes(op, ids: ids, groups: current.merged, groupRow: group)
        store.outline(op, ids: ids, rows: rows, groupId: group?.id)
        // The new group is unnamed: select it and start editing its title.
        if let group {
            select([group.id])
            editingId = group.id
        }
        return rows
    }

    func toggleComplete(_ row: OutlineRow) {
        guard let task = Self.task(of: row) else { return }
        if task.dropped != nil {
            store.drop([task.id], dropped: false)
        } else {
            store.complete([task.id], completed: task.completed == nil)
        }
    }

    func toggleFlag(_ row: OutlineRow) {
        guard let task = Self.task(of: row) else { return }
        if row.kind == .project {
            store.patchProject(task.id, ProjectPatch(flagged: !task.flagged))
        } else {
            store.patchTask(task.id, TaskPatch(flagged: !task.flagged))
        }
    }

    /// Completes (or, when all are done, reopens) the selected items in one request = one undo step.
    func completeSelection() {
        let tasks = selectedRows().compactMap { Self.task(of: $0.row) }
        guard !tasks.isEmpty else { return }
        let open = tasks.filter { $0.completed == nil && $0.dropped == nil }
        if !open.isEmpty {
            store.complete(open.map(\.id))
        } else {
            store.setStatus(tasks.map(\.id), .active)
        }
    }

    /// Flags (or unflags, when all are flagged) the selection with one batch request per kind.
    func flagSelection() {
        let rows = selectedRows().filter { Self.task(of: $0.row) != nil }.map(\.row)
        guard !rows.isEmpty else { return }
        let flagged = !rows.allSatisfy { Self.task(of: $0)?.flagged == true }
        let projects = rows.filter { $0.kind == .project }.map(\.id)
        let tasks = rows.filter { $0.kind == .task }.map(\.id)
        if !tasks.isEmpty { store.batchPatchTasks(tasks, TaskPatch(flagged: flagged)) }
        if !projects.isEmpty { store.batchPatchProjects(projects, ProjectPatch(flagged: flagged)) }
    }

    private func selectedRows() -> [DisplayRow] {
        let keys = Set(selectedKeys)
        var seen = Set<String>()
        return current.flat.filter { keys.contains(OutlineRowKey.key($0.row)) && seen.insert($0.row.id).inserted }
    }

    func deleteSelection() {
        deleteKeys(selectedKeys)
    }

    /// Deletes rows with one request (one undo step), with an undoable toast.
    func deleteKeys(_ keys: [String]) {
        guard !keys.isEmpty else { return }
        var taskIds: [String] = []
        var projectIds: [String] = []
        var folderIds: [String] = []
        var tagIds: [String] = []
        for key in keys {
            let p = OutlineRowKey.parse(key)
            switch p.kind {
            case .folder: folderIds.append(p.id)
            case .tag: tagIds.append(p.id)
            default:
                if findRow(p.id)?.row.kind == .project { projectIds.append(p.id) } else { taskIds.append(p.id) }
            }
        }
        let selection = DeleteSelection(
            taskIds: taskIds.isEmpty ? nil : taskIds, projectIds: projectIds.isEmpty ? nil : projectIds,
            folderIds: folderIds.isEmpty ? nil : folderIds, tagIds: tagIds.isEmpty ? nil : tagIds)
        let ids = selection.allIds
        // Kept rows stay hidden after the refresh too; a failed delete shows them again.
        let ticket = store.deleteItems(selection)
        kept.deleted.formUnion(ids)
        Task { [weak self] in
            do { _ = try await ticket.value() } catch { self?.kept.deleted.subtract(ids) }
        }
        clearSelection()
        editingId = nil
        store.toast(keys.count == 1 ? "Deleted 1 item" : "Deleted \(keys.count) items", action: .undo)
    }

    func removeTag(_ tagId: String, from row: OutlineRow) {
        store.removeTag(tagId, from: row.id)
    }

    func startEditing(_ row: DisplayRow) {
        select([OutlineRowKey.key(row.row)])
        editingId = row.row.id
    }

    /// What follows committing a title edit.
    enum EditThen {
        /// Stop editing (Escape, blur, Shift-Return).
        case stop
        /// Add a sibling below (Return).
        case after
        /// Add a sibling above.
        case above
        /// Indent or outdent the row and keep editing (Tab / Shift-Tab).
        case indent, outdent
    }

    /// Commits an inline title edit (`commitEdit`): a new row left untitled is discarded.
    func commitEdit(_ row: OutlineRow, text: String, then: EditThen) {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let isNew = untitledNew.contains(row.id)
        if then == .indent || then == .outdent {
            if !empty { untitledNew.remove(row.id) }
            if text != Self.title(of: row) { store.patchTask(row.id, TaskPatch(name: text)) }
            select([row.id])
            expandAncestors(row.id, moved: outlineOperation(then == .indent ? .indent : .outdent))
            select([row.id])
            editingId = row.id
            return
        }
        if editingId == row.id { editingId = nil }
        untitledNew.remove(row.id)
        // A freshly created row left untitled is discarded; the server reverts its creation atomically when that is
        // still the newest change, otherwise deletes it.
        if isNew && row.kind == .task && empty {
            kept.deleted.insert(row.id)
            clearSelection()
            let ticket = store.discardTask(row.id)
            Task { [weak self] in
                do { _ = try await ticket.value() } catch { self?.kept.deleted.remove(row.id) }
            }
            return
        }
        if text != Self.title(of: row) {
            switch row.kind {
            case .folder: store.patchFolder(row.id, FolderPatch(name: text))
            case .tag: store.patchTag(row.id, TagPatch(name: text))
            case .project: store.patchProject(row.id, ProjectPatch(name: text))
            default: store.patchTask(row.id, TaskPatch(name: text))
            }
        }
        guard let current = findRow(row.id) else { return }
        switch then {
        case .after: createItem(relativeTo: current, .after)
        case .above: createItem(relativeTo: current, .before)
        default: break
        }
    }

    /// Runs a hardware-keyboard command; returns whether it was handled.
    func perform(_ command: OutlineKeyCommand) {
        switch command {
        case .moveSelection(let delta, let extend):
            moveSelection(delta, extend: extend)
        case .operation(let op):
            outlineOperation(op)
        case .collapse(let collapse):
            for row in selectedRows() where row.hasChildren { setCollapsed(row, collapse) }
        case .newItem(let position):
            let row = position == .before ? firstSelectedRow() : lastSelectedRow()
            if let row { createItem(relativeTo: row, position) }
        case .edit:
            if let row = firstSelectedRow() { editingId = row.row.id }
        case .editNote:
            navigator?.showInspector()
        case .complete:
            completeSelection()
        case .flag:
            flagSelection()
        case .delete:
            deleteSelection()
        case .clearSelection:
            clearSelection()
        }
    }

    // MARK: Drag and drop

    /// Whether `ids` may be dropped on `target` (not folders or tags, not into their own subtree, not on themselves).
    func accepts(_ ids: [String], on target: DisplayRow) -> Bool {
        let row = target.row
        if ids.contains(row.id) || row.kind == .folder || row.kind == .tag { return false }
        var parent = Self.task(of: row)?.parentId
        while let p = parent {
            if ids.contains(p) { return false }
            parent = findRow(p)?.row.task?.parentId
        }
        return true
    }

    /// The list's move gesture in reorder mode: rows at `from` (with the selection, when the dragged row is selected)
    /// dropped before `rows[to]`.
    func moveRows(_ from: IndexSet, to: Int, rows: [DisplayRow]) {
        guard let first = from.first, first < rows.count else { return }
        insertDrop(dragIds(for: rows[first]), rows: rows, at: to)
    }

    /// Moves rows dropped between `rows` at `index` (reorder mode) with one request (one undo step), whatever the
    /// selection size: before the row below, after the last row, or into a project around its header.
    func insertDrop(_ ids: [String], rows: [DisplayRow], at index: Int) {
        guard let move = OutlineOps.insertionTarget(rows: rows, at: index) else { return }
        let request: MoveTarget
        switch move {
        case .before(let id), .after(let id):
            guard let target = rows.first(where: { $0.row.id == id }), accepts(ids, on: target) else { return }
            request = move.request
        case .inside(let id, let atEnd):
            // Inside a project row: the project is the container.
            request = MoveTarget(projectId: id, position: atEnd ? .end : .start)
        }
        let ticket = store.moveTasks(ids, to: request, rows: OutlineOps.moveChanges(ids, to: move, groups: current.merged))
        // Rows kept in place before the move are dropped once it lands (they may have moved away).
        Task { [weak store] in
            guard (try? await ticket.value()) != nil else { return }
            store?.resetSticky()
        }
    }

    /// The ids a drag from `row` carries: the selection when the row is selected, else the row.
    func dragIds(for row: DisplayRow) -> [String] {
        let keys = selectedKeys
        guard keys.contains(row.row.id) else { return [row.row.id] }
        return current.flat.filter { $0.row.kind == .task && keys.contains($0.row.id) }.map(\.row.id)
    }

    // MARK: Helpers

    /// The task of a task or project row.
    static func task(of row: OutlineRow) -> TaskItem? {
        switch row.kind {
        case .task: row.task
        case .project: row.project?.task
        default: nil
        }
    }

    /// A row's title.
    static func title(of row: OutlineRow) -> String {
        task(of: row)?.name ?? row.folder?.name ?? row.tag?.name ?? ""
    }
}
