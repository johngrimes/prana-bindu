// Author: John Grimes

import Foundation

/// Instant writes behind the inspector and Quick Entry (spec §3, §4): each maps a field edit onto the typed
/// mutations, so previews, undo and rollback come from the store.
extension AppStore {
    /// Applies one field edit to a task, action group, inbox item or project (projects take the project PATCH).
    public func apply(_ edit: InspectorEdit, to detail: TaskDetail) {
        if detail.project != nil {
            if let patch = edit.projectPatch { patchProject(detail.id, patch) }
        } else if let patch = edit.taskPatch {
            patchTask(detail.id, patch)
        }
    }

    /// Applies one field edit to every selected task in a single batch write (one undo step).
    public func apply(_ edit: InspectorEdit, toAll ids: [String]) {
        guard let patch = edit.taskPatch, !ids.isEmpty else { return }
        batchPatchTasks(ids, patch)
    }

    /// Sets the project of one task (nil clears it): assigns inbox items, moves other tasks.
    public func setProject(_ projectId: String?, for task: TaskItem) {
        switch InspectorModel.projectAssignment(for: task, projectId: projectId) {
        case .assign(let id): patchTask(task.id, TaskPatch(assignedProjectId: .some(id)))
        case .move(let target): moveTasks([task.id], to: target)
        }
    }

    /// Sets the project of every selected task: inbox items are assigned, the others move to its end.
    public func setProject(_ projectId: String, forAll tasks: [TaskItem]) {
        let split = InspectorModel.splitForProjectMove(tasks)
        if !split.inbox.isEmpty { batchPatchTasks(split.inbox, TaskPatch(assignedProjectId: .some(projectId))) }
        if !split.others.isEmpty { moveTasks(split.others, to: MoveTarget(projectId: projectId, position: .end)) }
    }

    /// Creates a parallel project named `name` (smart match "Create …") and returns its id at once.
    @discardableResult
    public func createProject(named name: String) -> String {
        createProject(ProjectCreate(name: name, type: .parallel))
    }

    /// Creates a top-level tag named `name` and adds it to a task.
    public func createTag(named name: String, addingTo taskId: String) {
        let tagId = createTag(name: name)
        addTag(tagId, to: taskId)
    }

    /// Creates the Quick Entry item and returns its id, or the reason it cannot be saved (the sheet stays open).
    public func save(_ draft: QuickEntryDraft) -> Result<String, QuickEntryError> {
        switch draft.makeTask(id: ClientID.make(), settings: settings, now: now()) {
        case .failure(let error): return .failure(error)
        case .success(let task):
            let id = createTask(task)
            toast(draft.confirmation)
            return .success(id)
        }
    }
}
