// Author: John Grimes

import Foundation

/// An item offered by a smart-match field (project or tag pickers): its id, name and an optional detail such as the
/// folder or parent-tag path.
public struct MatchItem: Hashable, Sendable, Identifiable {
    /// The project or tag id.
    public var id: String
    /// The name matched against the typed text.
    public var name: String
    /// Secondary text, e.g. `Work : Clients`.
    public var detail: String?

    /// Creates an item.
    public init(id: String, name: String, detail: String? = nil) {
        self.id = id
        self.name = name
        self.detail = detail
    }
}

/// A parent-linked, ranked item (folders, tags) that `Entities.flattenTree` can order.
public protocol TreeItem {
    /// The item's id.
    var id: String { get }
    /// The parent's id, nil at the top level.
    var parentId: String? { get }
    /// The order among siblings.
    var rank: Double { get }
}

extension Folder: TreeItem {}
extension Tag: TreeItem {}

/// An item of a flattened tree with its depth (0 at the top level).
public struct TreeNode<Item: TreeItem>: Identifiable {
    /// The item.
    public let item: Item
    /// Its depth below the top level.
    public let depth: Int
    /// The item's id.
    public var id: String { item.id }
}

extension TreeNode: Sendable where Item: Sendable {}
extension TreeNode: Equatable where Item: Equatable {}

/// Helpers over folders, projects and tags. Port of `src/web/lib/entities.ts`.
public enum Entities {
    /// Items keyed by id (a later duplicate wins, like a JS `Map`).
    public static func byId<T: Identifiable>(_ items: [T]?) -> [T.ID: T] {
        Dictionary((items ?? []).map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    }

    /// "Parent : Child" path of a tag.
    public static func tagPath(_ tag: Tag, tags: [String: Tag]) -> String {
        var names = [tag.name]
        var parent = tag.parentId.flatMap { tags[$0] }
        while let p = parent {
            names.insert(p.name, at: 0)
            parent = p.parentId.flatMap { tags[$0] }
        }
        return names.joined(separator: " : ")
    }

    /// "Parent : Child" path of a folder; "" for no folder.
    public static func folderPath(_ folderId: String?, folders: [String: Folder]) -> String {
        var names: [String] = []
        var folder = folderId.flatMap { folders[$0] }
        while let f = folder {
            names.insert(f.name, at: 0)
            folder = f.parentId.flatMap { folders[$0] }
        }
        return names.joined(separator: " : ")
    }

    /// Projects offered by the Project smart-match field: remaining (active or on hold) ones, with their folder path.
    public static func projectChoices(_ projects: [Project]?, folders: [Folder]?) -> [MatchItem] {
        let map = byId(folders)
        return (projects ?? [])
            .filter { $0.effectiveStatus == .active || $0.effectiveStatus == .onHold }
            .map { p in
                let path = folderPath(p.folderId, folders: map)
                return MatchItem(id: p.id, name: p.task.name, detail: path.isEmpty ? nil : path)
            }
    }

    /// Tags offered by a tag smart-match field: not dropped and not in `excluding`, with their parent path.
    public static func tagChoices(_ tags: [Tag]?, excluding: [String] = []) -> [MatchItem] {
        let map = byId(tags)
        return (tags ?? [])
            .filter { $0.effectiveStatus != .dropped && !excluding.contains($0.id) }
            .map { t in
                let detail = t.parentId == nil ? nil : tagPath(t, tags: map).components(separatedBy: " : ").dropLast().joined(separator: " : ")
                return MatchItem(id: t.id, name: t.name, detail: detail)
            }
    }

    /// Depth-first ordering of a parent-linked list by rank; items whose parent is missing count as top level.
    public static func flattenTree<T: TreeItem>(_ items: [T]) -> [TreeNode<T>] {
        let ids = Set(items.map(\.id))
        var children: [String?: [T]] = [:]
        for item in items {
            let parent = item.parentId.flatMap { ids.contains($0) ? $0 : nil }
            children[parent, default: []].append(item)
        }
        var out: [TreeNode<T>] = []
        func walk(_ parent: String?, _ depth: Int) {
            // A stable sort, like `Array.prototype.sort`.
            let sorted = (children[parent] ?? []).enumerated().sorted { a, b in
                a.element.rank != b.element.rank ? a.element.rank < b.element.rank : a.offset < b.offset
            }
            for (_, child) in sorted {
                out.append(TreeNode(item: child, depth: depth))
                walk(child.id, depth + 1)
            }
        }
        walk(nil, 0)
        return out
    }

    /// A file size: `512 B`, `1.5 KB` (one decimal below 10 KB), `200 KB`, `5.2 MB`, `1.0 GB`.
    public static func formatBytes(_ size: Int) -> String {
        let kb = 1024.0
        let value = Double(size)
        if size < 1024 { return "\(size) B" }
        if size < 1024 * 1024 { return String(format: size < 10240 ? "%.1f KB" : "%.0f KB", value / kb) }
        if size < 1024 * 1024 * 1024 { return String(format: "%.1f MB", value / kb / kb) }
        return String(format: "%.1f GB", value / kb / kb / kb)
    }
}
