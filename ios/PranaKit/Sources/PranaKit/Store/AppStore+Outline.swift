// Author: John Grimes

import Foundation

/// Drops of outline rows onto the sidebar (`dropTasks` in `src/web/components/outline/Outline.tsx`): onto a project or
/// the inbox moves them, onto a tag adds the tag. Each drop is one request, so one undo step.
extension AppStore {
    /// Moves dragged tasks to the end of a project (or the inbox when `projectId` is nil). Their rows leave the old
    /// container's group at once; rows kept in place before the move are dropped once it lands.
    @discardableResult
    public func moveDraggedTasks(_ ids: [String], toProject projectId: String?) -> WriteTicket {
        let groups = activeContentsKey.flatMap { state.contents[$0]?.groups } ?? []
        let rows = OutlineOps.containerMoveChanges(ids, projectId: projectId, groups: groups)
        let target = projectId.map { MoveTarget(projectId: $0, position: .end) } ?? MoveTarget(inbox: true, position: .end)
        let ticket = moveTasks(ids, to: target, rows: rows)
        Task { [weak self] in
            guard (try? await ticket.value()) != nil else { return }
            self?.resetSticky()
        }
        return ticket
    }

    /// Adds a tag to dragged tasks, with a toast saying so.
    public func tagDraggedTasks(_ ids: [String], tagId: String) {
        editTags(ids, add: [tagId])
        toast(ids.count == 1 ? "Tag added" : "Tag added to \(ids.count) items")
    }
}
