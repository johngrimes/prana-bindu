// Author: John Grimes

import Foundation

/// Client-generated ids for new items (spec §1, §9).
public enum ClientID {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")

    /// A new id in the server's format: 11 characters of `[A-Za-z0-9_-]` (like `src/domain/ids.ts`).
    public static func make() -> String {
        var generator = SystemRandomNumberGenerator()
        return String((0..<11).map { _ in alphabet[Int(generator.next() & 63)] })
    }
}

/// The records shown for items created on this device until the server's copy arrives (port of
/// `src/web/lib/drafts.ts`).
public enum Drafts {
    /// A new task as the server would return it, with `fields` applied and derived fields previewed.
    public static func draftTask(_ id: String, _ fields: Fields, settings: Settings, now: Date) -> TaskItem {
        let stamp = DateTime.formatFixed(now)
        return Optimistic.projectTask(TaskItem(id: id, added: stamp, modified: stamp), fields, settings: settings, now: now)
    }

    /// A new project with its root task.
    public static func draftProject(
        _ id: String, _ fields: Fields, type: ProjectType, folderId: String?, status: ProjectStatus = .active,
        reviewInterval: ReviewInterval = ReviewInterval(steps: 1, unit: .week), settings: Settings, now: Date
    ) -> Project {
        var taskFields = fields
        taskFields["isProject"] = true
        taskFields["projectId"] = .string(id)
        taskFields["projectName"] = fields["name"] ?? ""
        // New projects sort last until the server ranks them.
        taskFields["rank"] = .number(9_007_199_254_740_991)
        let record = ProjectRecord(
            id: id, folderId: folderId, type: type, status: status, effectiveStatus: status, reviewInterval: reviewInterval,
            lastReview: DateTime.formatFixed(now))
        return Project(record: record, task: draftTask(id, taskFields, settings: settings, now: now))
    }

    /// A new folder.
    public static func draftFolder(_ id: String, name: String, parentId: String?, rank: Double, now: Date) -> Folder {
        let stamp = DateTime.formatFixed(now)
        return Folder(id: id, name: name, parentId: parentId, rank: rank, added: stamp, modified: stamp)
    }

    /// A new tag.
    public static func draftTag(_ id: String, name: String, parentId: String?, rank: Double, now: Date) -> Tag {
        let stamp = DateTime.formatFixed(now)
        return Tag(id: id, name: name, parentId: parentId, rank: rank, added: stamp, modified: stamp)
    }

    /// Rank that places an item at `position` among `siblings` (folders, tags, projects and perspectives sort by rank).
    /// Previews may use fractional ranks; the server renumbers.
    public static func rankAt(_ siblings: [(id: String, rank: Double)], _ position: Position) -> Double {
        let ranks = siblings.map(\.rank)
        let afterLast = (ranks.max() ?? -1) + 1
        switch position {
        case .start: return ranks.isEmpty ? 0 : ranks.min()! - 1
        case .end: return ranks.isEmpty ? 0 : afterLast
        case .before(let anchor), .after(let anchor):
            let sorted = siblings.sorted { $0.rank < $1.rank }
            guard let i = sorted.firstIndex(where: { $0.id == anchor }) else { return ranks.isEmpty ? 0 : afterLast }
            let before: Bool
            if case .before = position { before = true } else { before = false }
            let n = before ? i - 1 : i + 1
            guard sorted.indices.contains(n) else { return sorted[i].rank + (before ? -1 : 1) }
            return (sorted[i].rank + sorted[n].rank) / 2
        }
    }
}
