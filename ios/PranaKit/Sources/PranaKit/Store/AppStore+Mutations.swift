// Author: John Grimes

import Foundation

/// Where a created task's row shows.
public enum RowPlacement: Sendable, Hashable {
    /// Inbox end (or start), the end of its parent, or the start of its project (`defaultPlace` in the web client).
    case automatic
    /// Nowhere until the refresh.
    case none
    /// At this place.
    case at(RowPlace)
}

/// Every write the web client makes (`actions` in `src/web/api/queries.ts`). Each shows its change at once and is sent
/// in the background; failures are reported by the queue.
extension AppStore {
    private var reader: StoreReader { StoreReader(store: self) }
    private var nowISO: String { DateTime.formatFixed(now()) }

    /// The finished-occurrence row shown above a repeating task completed or dropped here, until the server's clone
    /// arrives.
    public static func occurrenceId(_ id: String) -> String { "\(id).~" }

    /// Stand-in rows are not items yet: they cannot be selected or changed until the server's copy replaces them.
    public static func isOccurrenceStandIn(_ id: String) -> Bool { id.hasSuffix(".~") }

    /// Queues a write for one request and reports the tasks it returns, so the outline keeps them visible until Clean
    /// Up; `keepRows: false` lets rows leave as soon as the refresh says so.
    @discardableResult
    func enqueue<T: Decodable & Sendable>(
        _ request: APIRequest<T>, label: String?, changes: [Change], creates: [String] = [], erases: Bool = false,
        keepRows: Bool = true, lane: Lane = .main, waitFor: [String] = [],
        landed: (@Sendable (WriteOutcome) -> [Change])? = nil, onSuccess: (@MainActor @Sendable (T) -> Void)? = nil
    ) -> WriteTicket {
        let queued = writesQueued
        let success: @MainActor @Sendable (WriteOutcome) -> Void = { [weak self] outcome in
            guard let self else { return }
            if let value = outcome.value as? T { onSuccess?(value) }
            if keepRows { reportTasks(Self.tasks(from: outcome.value), queued: queued) }
        }
        return writes.write(
            WriteSpec(
                label: label, changes: changes, send: WriteSpec.sending(request), landed: landed, creates: creates,
                erases: erases, lane: lane, waitFor: waitFor, onSuccess: success))
    }

    /// The tasks a write response reports.
    static func tasks(from value: (any Sendable)?) -> [TaskItem] {
        switch value {
        case let changed as Changed: changed.changed
        case let task as TaskItem: [task]
        case let project as Project: [project.task]
        default: []
        }
    }

    // MARK: Helpers (ports of queries.ts)

    private func taskFields(_ patch: some Encodable) -> Fields {
        Optimistic.changesFromPatch(JSONBridge.fields(patch), settings: settings, now: now())
    }

    /// Status changes: finished tasks are marked, repeating ones get a finished occurrence above them instead.
    func statusChanges(_ ids: [String], _ status: ActivityStatus, scope: RepeatScope = .series) -> [Change] {
        let ts = nowISO
        let fields: Fields =
            switch status {
            case .completed: ["completed": .string(ts), "dropped": .null]
            case .dropped: ["dropped": .string(ts), "completed": .null]
            default: ["completed": .null, "dropped": .null]
            }
        let groups = reader.outline() ?? []
        var changes: [Change] = []
        var plain: [String] = []
        for id in ids {
            let task = reader.task(id)
            let repeats = task?.repeat != nil && status != .active && (status == .completed || scope == .occurrence)
            guard let task, repeats else {
                plain.append(id)
                continue
            }
            for g in groups {
                guard let idx = g.rows.firstIndex(where: { $0.id == id }), g.rows[idx].kind == .task else { continue }
                let cloneId = Self.occurrenceId(id)
                var cloneFields = JSONBridge.fields(task).merging(fields) { _, new in new }
                cloneFields["id"] = .string(cloneId)
                cloneFields["repeat"] = .null
                let clone = Drafts.draftTask(cloneId, cloneFields, settings: settings, now: now())
                changes.append(.row(RowChange(
                    id: cloneId, at: OutlineRows.placeAt(g.rows, idx, groupKey: g.key),
                    rows: [OutlineRow(kind: .task, id: cloneId, depth: g.rows[idx].depth, task: clone)], inGroup: g.key)))
            }
        }
        if !plain.isEmpty {
            let projects = plain.filter { reader.task($0)?.isProject == true }
            changes.append(.taskFields(plain, fields))
            if !projects.isEmpty {
                changes.append(.task(ids: projects, project: ["status": .string(status.rawValue), "effectiveStatus": .string(status.rawValue)]))
            }
        }
        return changes
    }

    private static let statusLabel: [ActivityStatus: String] = [.active: "Mark Active", .completed: "Complete", .dropped: "Drop"]

    /// Field changes of tasks moved to a container; rows are placed by the caller's `rows` changes.
    func moveFields(_ ids: [String], _ target: MoveTarget) -> [Change] {
        let projectId: String??
        if let id = target.projectId {
            projectId = .some(id)
        } else if let parent = target.parentId {
            projectId = .some(reader.task(parent)?.projectId)
        } else if target.inbox == true {
            projectId = .some(nil)
        } else {
            return []
        }
        let resolved = projectId ?? nil
        let project = resolved.flatMap { id in state.projects?.first { $0.id == id } }
        var fields: Fields = [
            "parentId": (target.parentId ?? target.projectId).map(JSONValue.string) ?? .null,
            "inInbox": .bool(target.inbox == true),
            "projectId": resolved.map(JSONValue.string) ?? .null,
            "projectName": project.map { .string($0.task.name) } ?? .null,
        ]
        if target.inbox != true { fields["assignedProjectId"] = .null }
        // Descendants of moved tasks keep their parent.
        let roots = ids.filter { id in
            var parent = reader.task(id)?.parentId
            while let p = parent {
                if ids.contains(p) { return false }
                parent = reader.task(p)?.parentId
            }
            return true
        }
        return [.taskFields(roots, fields)]
    }

    /// Every row and list entry for deleted items goes.
    func deleteChanges(_ selection: DeleteSelection) -> [Change] {
        selection.allIds.map { .row(RowChange(id: $0, at: nil)) }
            + (selection.projectIds ?? []).map { .item(ItemChange(list: .projects, id: $0, edit: .remove)) }
            + (selection.folderIds ?? []).map { .item(ItemChange(list: .folders, id: $0, edit: .remove)) }
            + (selection.tagIds ?? []).map { .item(ItemChange(list: .tags, id: $0, edit: .remove)) }
    }

    /// Where a created task shows when the caller does not place it: inbox end, or the start of its project.
    func defaultPlace(_ input: TaskCreate) -> RowPlace? {
        let last = input.position != .start
        if let parentId = input.parentId { return RowPlace(parentId: parentId, after: nil, last: last) }
        if let projectId = input.projectId { return RowPlace(parentId: projectId, after: nil, last: last, groupKey: projectId) }
        let plain = input.position == nil || input.position == .start || input.position == .end
        guard input.inbox == true || plain else { return nil }
        // On the Inbox page the first item also brings the (until then absent) inbox group.
        return RowPlace(parentId: nil, after: nil, last: last, groupKey: "inbox", ensureGroup: activeContentsKey?.perspectiveId == "inbox")
    }

    /// A container moved to `parentId` at `position` among its siblings.
    private func containerSiblings(folderParent parentId: String?, excluding id: String, includeProjects: Bool) -> [(id: String, rank: Double)] {
        let folders = (state.folders ?? []).filter { $0.parentId == parentId && $0.id != id }.map { (id: $0.id, rank: $0.rank) }
        let projects = includeProjects ? (state.projects ?? []).filter { $0.folderId == parentId && $0.id != id }.map { (id: $0.id, rank: $0.task.rank) } : []
        return folders + projects
    }

    private func projectChanges(_ patch: ProjectPatch) -> (task: Fields, project: Fields) {
        var task = taskFields(patch.taskPatch)
        var project: Fields = [:]
        if let type = patch.type { project["type"] = .string(type.rawValue) }
        if let folderId = patch.folderId { project["folderId"] = folderId.map(JSONValue.string) ?? .null }
        if let interval = patch.reviewInterval { project["reviewInterval"] = JSONBridge.value(interval) }
        if let nextReview = patch.nextReview {
            switch Optimistic.resolveDateInput(nextReview, field: .defer, settings: settings, now: now()) {
            case .some(let value): project["nextReview"] = value.map(JSONValue.string) ?? .null
            case .none: break
            }
        }
        if let status = patch.status {
            project["status"] = .string(status.rawValue)
            project["effectiveStatus"] = .string(status.rawValue)
            // A project's completed/dropped timestamps live on its task (spec §1.2).
            task["completed"] = status == .completed ? .string(nowISO) : .null
            task["dropped"] = status == .dropped ? .string(nowISO) : .null
        }
        return (task, project)
    }

    // MARK: Tasks

    /// Creates a task with a client-generated id (or `input.id`) and returns the id at once.
    @discardableResult
    public func createTask(_ input: TaskCreate, placement: RowPlacement = .automatic) -> String {
        var input = input
        let id = input.id ?? ClientID.make()
        input.id = id
        let container = input.projectId ?? input.parentId.flatMap { reader.task($0)?.projectId }
        var fields: Fields = [
            "name": .string(input.name),
            "note": .string(input.note ?? ""),
            "parentId": (input.parentId ?? input.projectId).map(JSONValue.string) ?? .null,
            "projectId": container.map(JSONValue.string) ?? .null,
            "projectName": container.flatMap { id in state.projects?.first { $0.id == id }?.task.name }.map(JSONValue.string) ?? .null,
            "inInbox": .bool(input.parentId == nil && input.projectId == nil && (input.inbox ?? true)),
            "flagged": .bool(input.flagged ?? false),
            "tagIds": JSONBridge.value(input.tagIds ?? []),
            "estimatedMinutes": (input.estimatedMinutes ?? nil).map { .number(Double($0)) } ?? .null,
            "repeat": (input.repeat ?? nil).map { JSONBridge.value($0) } ?? .null,
            "sequential": .bool(input.sequential ?? false),
            "completedByChildren": .bool(input.completedByChildren ?? false),
        ]
        fields.merge(taskFields(TaskPatch(deferDate: input.deferDate, plannedDate: input.plannedDate, dueDate: input.dueDate))) { _, new in new }
        let task = Drafts.draftTask(id, fields, settings: settings, now: now())
        let place: RowPlace? =
            switch placement {
            case .automatic: defaultPlace(input)
            case .none: nil
            case .at(let place): place
            }
        let changes: [Change] = place.map { [.row(RowChange(id: id, at: $0, rows: [OutlineRow(kind: .task, id: id, depth: 0, task: task)]))] } ?? []
        enqueue(
            Endpoints.createTask(input), label: "Add Action", changes: changes, creates: [id],
            // The inspector keeps showing the new item while its full detail loads.
            onSuccess: { [weak self] created in self?.seedDetail(created, project: nil) })
        return id
    }

    /// Edits a task.
    public func patchTask(_ id: String, _ patch: TaskPatch) {
        enqueue(Endpoints.patchTask(id, patch), label: "Edit Action", changes: [.taskFields([id], taskFields(patch))])
    }

    /// Applies one patch to several tasks.
    public func batchPatchTasks(_ ids: [String], _ patch: TaskPatch) {
        enqueue(Endpoints.batchPatchTasks(ids, patch), label: "Edit Actions", changes: [.taskFields(ids, taskFields(patch))])
    }

    /// Completes (or un-completes) tasks as one change.
    public func complete(_ ids: [String], completed: Bool = true) {
        let label = completed ? "Complete" : "Mark Incomplete"
        let changes = statusChanges(ids, completed ? .completed : .active)
        if ids.count == 1 {
            enqueue(Endpoints.completeTask(ids[0], completed: completed), label: label, changes: changes)
        } else {
            enqueue(Endpoints.completeTasks(ids, completed: completed), label: label, changes: changes)
        }
    }

    /// Drops (or un-drops) tasks as one change; `scope` chooses one occurrence or the series of repeating tasks.
    public func drop(_ ids: [String], dropped: Bool = true, scope: RepeatScope? = nil) {
        let label = dropped ? "Drop" : "Mark Active"
        let changes = statusChanges(ids, dropped ? .dropped : .active, scope: scope ?? .series)
        if ids.count == 1 {
            enqueue(Endpoints.dropTask(ids[0], dropped: dropped, scope: scope), label: label, changes: changes)
        } else {
            enqueue(Endpoints.dropTasks(ids, dropped: dropped, scope: scope), label: label, changes: changes)
        }
    }

    /// Sets the status of several tasks.
    public func setStatus(_ ids: [String], _ status: ActivityStatus, scope: RepeatScope? = nil) {
        enqueue(
            Endpoints.setStatus(ids, status, scope: scope), label: Self.statusLabel[status] ?? "Edit Actions",
            changes: statusChanges(ids, status, scope: scope ?? .series))
    }

    /// Moves tasks; `rows` places the moved rows in the shown outline. The ticket reports when the move lands.
    @discardableResult
    public func moveTasks(_ ids: [String], to target: MoveTarget, rows: [Change] = []) -> WriteTicket {
        let changes = moveFields(ids, target) + rows
        if ids.count == 1 {
            return enqueue(Endpoints.moveTask(ids[0], to: target), label: "Move", changes: changes)
        }
        return enqueue(Endpoints.moveTasks(ids, to: target), label: "Move", changes: changes)
    }

    /// Deletes items of any kind as one change. The ticket reports a failure (the outline shows hidden rows again).
    @discardableResult
    public func deleteItems(_ selection: DeleteSelection) -> WriteTicket {
        let label = selection.allIds.count == 1 ? "Delete" : "Delete Items"
        return enqueue(Endpoints.delete(selection), label: label, changes: deleteChanges(selection))
    }

    /// Adds and removes tags on several tasks.
    public func editTags(_ ids: [String], add: [String] = [], remove: [String] = []) {
        enqueue(
            Endpoints.editTags(ids, add: add.isEmpty ? nil : add, remove: remove.isEmpty ? nil : remove), label: "Edit Tags",
            changes: [.task(ids: ids, task: TaskChange(tagEdit: TagEdit(add: add, remove: remove)))])
    }

    /// Deletes a task.
    public func deleteTask(_ id: String) {
        enqueue(Endpoints.deleteTask(id), label: "Delete Action", changes: deleteChanges(DeleteSelection(taskIds: [id])))
    }

    /// Discards a just-created, still-untitled item: the server reverts its creation if that is still the newest
    /// change (so this device forgets its undo step too), otherwise deletes it normally.
    @discardableResult
    public func discardTask(_ id: String) -> WriteTicket {
        let erased = writes.forgetCreation(id)
        return enqueue(
            Endpoints.discardTask(id), label: erased ? nil : "Delete Action", changes: deleteChanges(DeleteSelection(taskIds: [id])),
            erases: erased, keepRows: false)
    }

    /// Adds a tag to a task.
    public func addTag(_ tagId: String, to taskId: String) {
        enqueue(
            Endpoints.addTag(taskId: taskId, tagId: tagId), label: "Add Tag",
            changes: [.task(ids: [taskId], task: TaskChange(tagEdit: TagEdit(add: [tagId])))])
    }

    /// Removes a tag from a task.
    public func removeTag(_ tagId: String, from taskId: String) {
        enqueue(
            Endpoints.removeTag(taskId: taskId, tagId: tagId), label: "Remove Tag",
            changes: [.task(ids: [taskId], task: TaskChange(tagEdit: TagEdit(remove: [tagId])))])
    }

    /// Restructures the outline; `rows` is the preview (from the outline logic); `groupId` names the new group.
    public func outline(_ op: OutlineOperation, ids: [String], rows: [Change], groupId: String? = nil) {
        let labels: [OutlineOperation: String] = [
            .indent: "Indent", .outdent: "Outdent", .group: "Group", .ungroup: "Ungroup", .moveUp: "Move Up", .moveDown: "Move Down",
        ]
        enqueue(
            Endpoints.outline(op, ids: ids, groupId: groupId), label: labels[op] ?? op.rawValue, changes: rows,
            creates: groupId.map { [$0] } ?? [])
    }

    /// Clean Up: `rows` removes the greyed rows from the shown outline at once.
    public func cleanUp(rows: [Change] = []) {
        enqueue(Endpoints.cleanup(), label: "Clean Up", changes: rows)
        noteCleanUp()
    }

    // MARK: Projects

    /// Creates a project with a client-generated id (or `input.id`) and returns the id at once.
    @discardableResult
    public func createProject(_ input: ProjectCreate) -> String {
        var input = input
        let id = input.id ?? ClientID.make()
        input.id = id
        let dates = taskFields(TaskPatch(deferDate: input.deferDate, dueDate: input.dueDate))
        var fields: Fields = [
            "name": .string(input.name), "note": .string(input.note ?? ""), "flagged": .bool(input.flagged ?? false),
            "tagIds": JSONBridge.value(input.tagIds ?? []), "dueDate": .null, "deferDate": .null,
        ]
        fields.merge(dates) { _, new in new }
        let project = Drafts.draftProject(
            id, fields, type: input.type, folderId: input.folderId ?? nil, settings: settings, now: now())
        enqueue(
            Endpoints.createProject(input), label: "New Project",
            changes: [.item(ItemChange(list: .projects, id: id, edit: .replace(.project(project))))], creates: [id],
            onSuccess: { [weak self] created in self?.seedDetail(created.task, project: created.record) })
        return id
    }

    /// Edits a project.
    public func patchProject(_ id: String, _ patch: ProjectPatch) {
        let (task, project) = projectChanges(patch)
        enqueue(Endpoints.patchProject(id, patch), label: "Edit Project", changes: [.task(ids: [id], task: TaskChange(task), project: project)])
    }

    /// Applies one patch to several projects.
    public func batchPatchProjects(_ ids: [String], _ patch: ProjectPatch) {
        let (task, project) = projectChanges(patch)
        enqueue(
            Endpoints.batchPatchProjects(ids, patch), label: ids.count == 1 ? "Edit Project" : "Edit Projects",
            changes: [.task(ids: ids, task: TaskChange(task), project: project)])
    }

    /// Deletes a project.
    public func deleteProject(_ id: String) {
        enqueue(Endpoints.deleteProject(id), label: "Delete Project", changes: deleteChanges(DeleteSelection(projectIds: [id])))
    }

    /// Marks a project reviewed; its next review moves on by its interval from today.
    public func markReviewed(_ id: String) {
        var changes: [Change] = []
        if case .some(.project(let project))? = reader.item(.projects, id) {
            let tz = settings.timeZone
            let dayMs: Int64 = 86_400_000
            let day = DateTime.instantToNaive(now(), timeZone: tz) / dayMs * dayMs
            let unit: DateTime.Unit =
                switch project.reviewInterval.unit {
                case .day: .day
                case .month: .month
                case .year: .year
                default: .week
                }
            let next = DateTime.formatFloating(DateTime.addToNaive(day, project.reviewInterval.steps, unit))
            changes.append(.task(ids: [id], project: ["lastReview": .string(nowISO), "nextReview": .string(next)]))
        }
        // The Review perspective keeps reviewed projects listed itself, until Clean Up (spec §3).
        enqueue(Endpoints.markReviewed(id), label: "Mark Reviewed", changes: changes, keepRows: false)
    }

    /// Moves a project into a folder (nil for the top level) at `position` among its siblings.
    public func moveProject(_ id: String, parentId: String?, position: Position) {
        var changes: [Change] = []
        if var task = state.projects?.first(where: { $0.id == id })?.task {
            task.rank = Drafts.rankAt(containerSiblings(folderParent: parentId, excluding: id, includeProjects: true), position)
            changes.append(.item(ItemChange(
                list: .projects, id: id,
                edit: .patch(["folderId": parentId.map(JSONValue.string) ?? .null, "task": JSONBridge.value(task)]))))
        }
        enqueue(Endpoints.moveProject(id, ContainerMove(parentId: parentId, position: position)), label: "Move Project", changes: changes)
    }

    // MARK: Folders

    /// Creates a folder and returns its id at once.
    @discardableResult
    public func createFolder(name: String, parentId: String? = nil, position: Position = .end, id: String? = nil) -> String {
        let id = id ?? ClientID.make()
        let rank = Drafts.rankAt(containerSiblings(folderParent: parentId, excluding: id, includeProjects: true), position)
        let folder = Drafts.draftFolder(id, name: name, parentId: parentId, rank: rank, now: now())
        enqueue(
            Endpoints.createFolder(FolderCreate(id: id, name: name, parentId: .some(parentId), position: position)), label: "New Folder",
            changes: [.item(ItemChange(list: .folders, id: id, edit: .replace(.folder(folder))))], creates: [id])
        return id
    }

    /// Edits a folder.
    public func patchFolder(_ id: String, _ patch: FolderPatch) {
        enqueue(
            Endpoints.patchFolder(id, patch), label: "Edit Folder",
            changes: [.item(ItemChange(list: .folders, id: id, edit: .patch(JSONBridge.fields(patch))))])
    }

    /// Deletes a folder.
    public func deleteFolder(_ id: String) {
        enqueue(Endpoints.deleteFolder(id), label: "Delete Folder", changes: deleteChanges(DeleteSelection(folderIds: [id])))
    }

    /// Moves a folder.
    public func moveFolder(_ id: String, parentId: String?, position: Position) {
        let rank = Drafts.rankAt(containerSiblings(folderParent: parentId, excluding: id, includeProjects: false), position)
        enqueue(
            Endpoints.moveFolder(id, ContainerMove(parentId: parentId, position: position)), label: "Move Folder",
            changes: [.item(ItemChange(list: .folders, id: id, edit: .patch(["parentId": parentId.map(JSONValue.string) ?? .null, "rank": .number(rank)])))])
    }

    // MARK: Tags

    private func tagSiblings(_ parentId: String?, excluding id: String) -> [(id: String, rank: Double)] {
        (state.tags ?? []).filter { $0.parentId == parentId && $0.id != id }.map { (id: $0.id, rank: $0.rank) }
    }

    /// Creates a tag and returns its id at once.
    @discardableResult
    public func createTag(name: String, parentId: String? = nil, position: Position = .end, id: String? = nil) -> String {
        let id = id ?? ClientID.make()
        let tag = Drafts.draftTag(id, name: name, parentId: parentId, rank: Drafts.rankAt(tagSiblings(parentId, excluding: id), position), now: now())
        enqueue(
            Endpoints.createTag(TagCreate(id: id, name: name, parentId: .some(parentId), position: position)), label: "New Tag",
            changes: [.item(ItemChange(list: .tags, id: id, edit: .replace(.tag(tag))))], creates: [id])
        return id
    }

    /// Edits a tag.
    public func patchTag(_ id: String, _ patch: TagPatch) {
        var fields = JSONBridge.fields(patch)
        if let status = patch.status { fields["effectiveStatus"] = .string(status.rawValue) }
        enqueue(Endpoints.patchTag(id, patch), label: "Edit Tag", changes: [.item(ItemChange(list: .tags, id: id, edit: .patch(fields)))])
    }

    /// Deletes a tag.
    public func deleteTag(_ id: String) {
        enqueue(Endpoints.deleteTag(id), label: "Delete Tag", changes: deleteChanges(DeleteSelection(tagIds: [id])))
    }

    /// Moves a tag.
    public func moveTag(_ id: String, parentId: String?, position: Position) {
        let rank = Drafts.rankAt(tagSiblings(parentId, excluding: id), position)
        enqueue(
            Endpoints.moveTag(id, ContainerMove(parentId: parentId, position: position)), label: "Move Tag",
            changes: [.item(ItemChange(list: .tags, id: id, edit: .patch(["parentId": parentId.map(JSONValue.string) ?? .null, "rank": .number(rank)])))])
    }

    // MARK: Perspectives

    /// Creates a custom perspective and returns its id at once.
    @discardableResult
    public func createPerspective(_ input: PerspectiveCreate) -> String {
        var input = input
        let id = input.id ?? ClientID.make()
        input.id = id
        let rank = ((state.perspectives ?? []).map(\.rank).max() ?? -1) + 1
        var presentation = Perspective.Presentation()
        if let p = input.presentation { presentation = JSONBridge.merging(presentation, JSONBridge.fields(p)) }
        let perspective = Perspective(
            id: id, name: input.name, icon: input.icon ?? "perspective", color: input.color ?? nil, favorite: input.favorite ?? false,
            rank: rank, aggregation: input.aggregation ?? .all, rules: input.rules ?? [], presentation: presentation)
        enqueue(
            Endpoints.createPerspective(input), label: "New Perspective",
            changes: [.item(ItemChange(list: .perspectives, id: id, edit: .replace(.perspective(perspective))))], creates: [id])
        return id
    }

    /// Edits a perspective.
    public func patchPerspective(_ id: String, _ patch: PerspectivePatch) {
        var fields = JSONBridge.fields(patch)
        fields["presentation"] = nil
        if let presentation = patch.presentation, case .some(.perspective(let current))? = reader.item(.perspectives, id) {
            fields["presentation"] = JSONBridge.value(JSONBridge.merging(current.presentation, JSONBridge.fields(presentation)))
        }
        enqueue(
            Endpoints.patchPerspective(id, patch), label: "Edit Perspective",
            changes: [.item(ItemChange(list: .perspectives, id: id, edit: .patch(fields)))])
    }

    /// Deletes a custom perspective.
    public func deletePerspective(_ id: String) {
        enqueue(
            Endpoints.deletePerspective(id), label: "Delete Perspective",
            changes: [.item(ItemChange(list: .perspectives, id: id, edit: .remove))])
    }

    /// Saves a perspective's view options (UI state: not journaled, so not undoable).
    public func setViewOptions(_ id: String, _ options: ViewOptions) {
        enqueue(
            Endpoints.setViewOptions(id, options), label: nil,
            changes: [.item(ItemChange(list: .perspectives, id: id, edit: .patch(["viewOptions": JSONBridge.value(options)])))])
    }

    // MARK: Settings

    /// Changes settings.
    public func patchSettings(_ patch: SettingsPatch) {
        enqueue(Endpoints.patchSettings(patch), label: "Change Settings", changes: [.settings(JSONBridge.fields(patch))])
    }

    /// Restores every setting but the time zone, which defaults to the server's and shows on refresh.
    public func resetSettings() {
        var defaults = JSONBridge.fields(Settings.defaults(timeZone: settings.timeZone))
        defaults["timeZone"] = nil
        enqueue(Endpoints.resetSettings(), label: "Restore Default Settings", changes: [.settings(defaults)])
    }

    // MARK: Attachments

    /// Uploads beside the queue (after the task's own creation lands); the file shows as uploading meanwhile.
    public func uploadAttachment(taskId: String, file: UploadFile) {
        let id = "upload:\(UUID().uuidString)"
        let pending = Attachment(
            id: id, taskId: taskId, name: file.name, contentType: file.contentType, size: file.data.count, sha256: "", added: nowISO,
            uploading: true)
        // An absolute count, so it still holds once the refreshed task includes the upload.
        let shown = reader.task(taskId)?.attachmentCount
        let count = Change.taskFields(shown == nil ? [] : [taskId], ["attachmentCount": .number(Double((shown ?? 0) + 1))])
        let changes: [Change] = [.attachment(taskId: taskId, id: id, value: pending), count]
        enqueue(
            Endpoints.uploadAttachment(taskId: taskId, file: file), label: "Add Attachment", changes: changes, lane: .upload,
            waitFor: [taskId],
            // Under its real id, so the refreshed detail does not list it twice.
            landed: { outcome in
                guard let attachment = outcome.value as? Attachment else { return changes }
                return [.attachment(taskId: taskId, id: attachment.id, value: attachment), count]
            })
    }

    /// Deletes an attachment.
    public func deleteAttachment(taskId: String, id: String) {
        let shown = reader.task(taskId)?.attachmentCount
        enqueue(
            Endpoints.deleteAttachment(id), label: "Delete Attachment",
            changes: [
                .attachment(taskId: taskId, id: id, value: nil),
                .taskFields(shown == nil ? [] : [taskId], ["attachmentCount": .number(Double(max(0, (shown ?? 1) - 1)))]),
            ])
    }
}
