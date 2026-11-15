// Author: John Grimes

import Foundation

/// The current (previewed) state, as shown, used to capture what a write overwrites. `nil` means unknown (not loaded).
@MainActor
public protocol StateReader {
    /// The task as shown, or nil when it is not loaded.
    func task(_ id: String) -> TaskItem?
    /// The project's own fields as shown, or nil when not loaded.
    func projectRecord(_ id: String) -> ProjectRecord?
    /// The displayed outline groups (nil when no outline is shown).
    func outline() -> [OutlineGroup]?
    /// `.none` when the list is not loaded; `.some(nil)` when it is loaded but has no item `id`.
    func item(_ list: ListName, _ id: String) -> ListItem??
    /// Settings as shown, or nil when not loaded.
    func settings() -> Settings?
    /// `.none` when the task's detail is not loaded; `.some(nil)` when it has no attachment `id`.
    func attachment(taskId: String, id: String) -> Attachment??
}

/// Optimistic previews (port of `src/web/lib/optimistic.ts`): the changes a queued write makes, shown on top of server
/// data until the refresh that follows it lands. The server stays authoritative; derived fields recomputed here
/// (effective dates, overdue, deferred, status) are a best-effort preview, and knock-on effects (counts, siblings
/// becoming available, perspective membership) wait for the refresh.
public enum Optimistic {
    private static let dateFields: [(key: String, field: DateField)] = [("deferDate", .defer), ("plannedDate", .planned), ("dueDate", .due)]

    /// Resolves a date input (ISO or natural language) the way the server will: `.some(nil)` for a clear, `.none` when
    /// unparseable (the server decides).
    public static func resolveDateInput(_ input: String?, field: DateField, settings: Settings, now: Date) -> String?? {
        guard let input else { return .some(nil) }
        if let value = DateTime.normaliseIsoDate(input) ?? NaturalLanguage.previewDate(input, field: field, settings: settings, now: now) {
            return .some(value)
        }
        return .none
    }

    /// Task changes implied by a PATCH body; unparseable dates are left to the server.
    public static func changesFromPatch(_ patch: Fields, settings: Settings, now: Date) -> Fields {
        var changes = patch
        for (key, field) in dateFields {
            guard let input = patch[key] else { continue }
            changes[key] = nil
            let text: String?
            switch input {
            case .null: text = nil
            case .string(let s): text = s
            default: continue
            }
            switch resolveDateInput(text, field: field, settings: settings, now: now) {
            case .some(.some(let value)): changes[key] = .string(value)
            case .some(.none): changes[key] = .null
            case .none: break
            }
        }
        return changes
    }

    /// Instant of a stored date value in epoch milliseconds.
    private static func ms(_ value: String?, _ settings: Settings) -> Int64? {
        value.flatMap { DateTime.dateValueToMilliseconds($0, timeZone: settings.timeZone) }
    }

    /// The value inherited from ancestors, when the current effective value visibly comes from them.
    private static func inherited(_ own: String?, _ effective: String?) -> String? {
        effective != nil && effective != own ? effective : nil
    }

    /// Applies `changes` to `task` and recomputes the derived fields that depend only on the task itself.
    public static func projectTask(_ task: TaskItem, _ changes: Fields, settings: Settings, now: Date) -> TaskItem {
        var next = JSONBridge.merging(task, changes)
        let has = { (key: String) in changes[key] != nil }
        if has("flagged") { next.effectiveFlagged = next.flagged || (task.effectiveFlagged && !task.flagged) }

        if has("dueDate") {
            let parent = inherited(task.dueDate, task.effectiveDueDate)
            let own = next.dueDate
            next.effectiveDueDate = own == nil ? parent : parent != nil && (ms(parent, settings) ?? 0) < (ms(own, settings) ?? 0) ? parent : own
        }
        if has("deferDate") {
            let parent = inherited(task.deferDate, task.effectiveDeferDate)
            let own = next.deferDate
            next.effectiveDeferDate = own == nil ? parent : parent != nil && (ms(parent, settings) ?? 0) > (ms(own, settings) ?? 0) ? parent : own
        }
        if has("plannedDate") { next.effectivePlannedDate = next.plannedDate ?? inherited(task.plannedDate, task.effectivePlannedDate) }

        if has("completed") || has("dropped") {
            next.effectiveCompleted = next.completed != nil
            next.effectiveDropped = next.dropped != nil
        }
        next.remaining = !next.effectiveCompleted && !next.effectiveDropped

        let nowMs = DateTime.milliseconds(now)
        let deferMs = ms(next.effectiveDeferDate, settings)
        next.deferred = deferMs.map { $0 > nowMs } ?? false
        if next.deferred != task.deferred { next.blocked = next.deferred || next.remainingChildCount > 0 }
        next.blocked = next.remaining && next.blocked
        next.available = next.remaining && !next.blocked

        let dueMs = ms(next.effectiveDueDate, settings)
        let tomorrow = DateTime.addDaysToKey(DateDisplay.todayKey(timeZone: settings.timeZone, now: now), 1)
        let tomorrowStart = DateTime.dayStartInstant(tomorrow, timeZone: settings.timeZone).map(DateTime.milliseconds) ?? nowMs
        let dueSoonLimit = settings.dueSoonSeconds == 0 ? tomorrowStart : nowMs + Int64(settings.dueSoonSeconds) * 1000
        next.overdue = next.remaining && dueMs != nil && dueMs! < nowMs
        next.dueSoon = next.remaining && !next.overdue && dueMs != nil && dueMs! <= dueSoonLimit
        next.status =
            next.effectiveCompleted ? .completed
            : next.effectiveDropped ? .dropped
            : next.overdue ? .overdue
            : next.dueSoon ? .dueSoon
            : next.blocked ? .blocked
            : next.firstAvailable ? .next
            : .available
        return next
    }

    // MARK: Applying changes to server data

    /// `task` with every task change for it applied, in order.
    public static func previewTask(_ task: TaskItem, _ changes: [Change], settings: Settings, now: Date) -> TaskItem {
        var out = task
        for c in changes {
            guard case .task(let ids, let change?, _) = c, ids.contains(task.id) else { continue }
            out = projectTask(out, change.resolved(for: out), settings: settings, now: now)
        }
        return out
    }

    /// A project record with its project changes applied.
    public static func previewProjectRecord(_ id: String, _ record: ProjectRecord, _ changes: [Change]) -> ProjectRecord {
        var out = record
        for c in changes {
            guard case .task(let ids, _, let project?) = c, ids.contains(id) else { continue }
            out = JSONBridge.merging(out, project)
        }
        return out
    }

    static func previewProject(_ project: Project, _ changes: [Change], settings: Settings, now: Date) -> Project {
        guard changes.contains(where: { $0.touches(project.id) }) else { return project }
        return Project(
            record: previewProjectRecord(project.id, project.record, changes),
            task: previewTask(project.task, changes, settings: settings, now: now))
    }

    /// A cached list with its item changes (and, for projects, task changes) applied.
    public static func previewList<T: ListEntity>(_ items: [T], _ changes: [Change], settings: Settings, now: Date) -> [T] {
        var out = items
        for c in changes {
            guard case .item(let change) = c, change.list == T.listName else { continue }
            let idx = out.firstIndex { $0.id == change.id }
            switch change.edit {
            case .remove:
                if let idx { out.remove(at: idx) }
            case .replace(let item):
                guard let value = T(item) else { continue }
                if let idx { out[idx] = value } else { out.append(value) }
            case .patch(let fields):
                if let idx { out[idx] = JSONBridge.merging(out[idx], fields) }
            }
        }
        if T.self == Project.self, let projects = out as? [Project] {
            return projects.map { previewProject($0, changes, settings: settings, now: now) } as? [T] ?? out
        }
        return out
    }

    /// Settings with settings changes applied.
    public static func previewSettings(_ settings: Settings, _ changes: [Change]) -> Settings {
        var out = settings
        for c in changes {
            if case .settings(let fields) = c { out = JSONBridge.merging(out, fields) }
        }
        return out
    }

    static func previewRow(_ row: OutlineRow, _ changes: [Change], settings: Settings, now: Date) -> OutlineRow {
        guard changes.contains(where: { $0.touches(row.id) }) else { return row }
        var out = row
        if row.kind == .task, let task = row.task {
            out.task = previewTask(task, changes, settings: settings, now: now)
        } else if row.kind == .project, let project = row.project {
            out.project = previewProject(project, changes, settings: settings, now: now)
        }
        return out
    }

    /// Outline groups with row moves, additions and removals, then field changes, applied.
    public static func previewGroups(_ groups: [OutlineGroup], _ changes: [Change], settings: Settings, now: Date) -> [OutlineGroup] {
        if changes.isEmpty { return groups }
        let moved = OutlineRows.applyRowChanges(groups, changes.compactMap(\.rowChange))
        return moved.map { g in
            var g = g
            g.rows = g.rows.map { previewRow($0, changes, settings: settings, now: now) }
            return g
        }
    }

    /// Ids of rows removed everywhere (not only from one group).
    private static func removedIds(_ changes: [Change]) -> Set<String> {
        Set(changes.compactMap { c in
            guard let row = c.rowChange, row.at == nil, row.inGroup == nil else { return nil }
            return row.id
        })
    }

    /// Task detail with field, project, child and attachment changes applied.
    public static func previewDetail(_ detail: TaskDetail, _ changes: [Change], settings: Settings, now: Date) -> TaskDetail {
        if changes.isEmpty { return detail }
        var out = detail
        out.task = previewTask(detail.task, changes, settings: settings, now: now)
        out.project = detail.project.map { previewProjectRecord(detail.id, $0, changes) }
        let removed = removedIds(changes)
        out.children = detail.children.filter { !removed.contains($0.id) }.map { previewTask($0, changes, settings: settings, now: now) }
        for c in changes {
            guard case .attachment(let taskId, let id, let value) = c, taskId == detail.id else { continue }
            out.attachments.removeAll { $0.id == id }
            if let value { out.attachments.append(value) }
        }
        return out
    }

    /// Search results with field changes applied and removed items gone.
    public static func previewSearch(_ results: SearchResults, _ changes: [Change], settings: Settings, now: Date) -> SearchResults {
        if changes.isEmpty { return results }
        let removed = removedIds(changes)
        let folderIds = Set(results.folders.map(\.id))
        let tagIds = Set(results.tags.map(\.id))
        var out = results
        out.tasks = results.tasks.filter { !removed.contains($0.id) }.map { previewTask($0, changes, settings: settings, now: now) }
        out.projects = previewList(results.projects, changes, settings: settings, now: now).filter { !removed.contains($0.id) }
        out.folders = previewList(results.folders, changes, settings: settings, now: now).filter { folderIds.contains($0.id) }
        out.tags = previewList(results.tags, changes, settings: settings, now: now).filter { tagIds.contains($0.id) }
        return out
    }

    // MARK: Undo snapshots

    /// The changes that restore what `changes` overwrite, read before they apply. Field changes on items that are not
    /// loaded are skipped.
    @MainActor
    public static func invertChanges(_ changes: [Change], reader: some StateReader) -> [Change] {
        var fields: [Change] = []
        var places: [(index: Int, change: RowChange)] = []
        var removals: [Change] = []
        let groups = reader.outline() ?? []
        for c in changes {
            switch c {
            case .task(let ids, let taskChange, let project):
                for id in ids {
                    if let taskChange, let task = reader.task(id) {
                        fields.append(.taskFields([id], JSONBridge.pick(task, taskChange.resolved(for: task).keys)))
                    }
                    if let project, let record = reader.projectRecord(id) {
                        fields.append(.task(ids: [id], project: JSONBridge.pick(record, project.keys)))
                    }
                }
            case .row(let row):
                if let found = OutlineRows.findRow(groups, row.id) {
                    // A removed row's subtree goes with it: restore every row of the block where it was.
                    places.append((found.index, RowChange(id: row.id, at: found.at, rows: found.block)))
                } else if row.at != nil {
                    removals.append(.row(RowChange(id: row.id, at: nil)))
                }
            case .item(let item):
                guard let current = reader.item(item.list, item.id) else { continue }
                switch item.edit {
                case .replace, .remove:
                    fields.append(.item(ItemChange(list: item.list, id: item.id, edit: current.map { .replace($0) } ?? .remove)))
                case .patch(let patch):
                    if let current {
                        let all = current.fields
                        var picked: Fields = [:]
                        for key in patch.keys { picked[key] = all[key] ?? .null }
                        fields.append(.item(ItemChange(list: item.list, id: item.id, edit: .patch(picked))))
                    }
                }
            case .settings(let changed):
                if let current = reader.settings() { fields.append(.settings(JSONBridge.pick(current, changed.keys))) }
            case .attachment(let taskId, let id, _):
                if let current = reader.attachment(taskId: taskId, id: id) {
                    fields.append(.attachment(taskId: taskId, id: id, value: current))
                }
            }
        }
        // Rows go back top to bottom (so each anchor is in place first), and rows the write added leave last.
        places.sort { $0.index < $1.index }
        return fields.reversed() + places.map { .row($0.change) } + removals
    }
}
