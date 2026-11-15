// Author: John Grimes

import Foundation

/// The Projects and Tags sidebars' trees and drag moves (`src/web/components/Sidebars.tsx`, spec §4).
public enum SidebarTree {
    /// A row of the Projects sidebar: a folder or a project, with its depth (0 = top level).
    public enum ProjectsEntry: Hashable, Sendable, Identifiable {
        case folder(Folder, depth: Int)
        case project(Project, depth: Int)

        /// `f:<id>` or `p:<id>`.
        public var id: String {
            switch self {
            case .folder(let f, _): "f:\(f.id)"
            case .project(let p, _): "p:\(p.id)"
            }
        }

        /// The folder or project id.
        public var itemId: String {
            switch self {
            case .folder(let f, _): f.id
            case .project(let p, _): p.id
            }
        }

        /// Indentation level.
        public var depth: Int {
            switch self {
            case .folder(_, let d), .project(_, let d): d
            }
        }

        /// The containing folder (nil at the top level).
        public var parentId: String? {
            switch self {
            case .folder(let f, _): f.parentId
            case .project(let p, _): p.folderId
            }
        }

        /// Whether this is a folder.
        public var isFolder: Bool {
            if case .folder = self { true } else { false }
        }
    }

    /// A row of the Tags sidebar.
    public struct TagEntry: Hashable, Sendable, Identifiable {
        public var tag: Tag
        public var depth: Int
        /// The tag id.
        public var id: String { tag.id }
    }

    /// A move of a folder, project or tag: its new parent and position among the parent's children.
    public struct ContainerMove: Hashable, Sendable {
        public var id: String
        /// True for a folder (`moveFolder`), false for a project or tag.
        public var isFolder: Bool
        public var parentId: String?
        public var position: Position

        /// Creates a move.
        public init(id: String, isFolder: Bool, parentId: String?, position: Position) {
            self.id = id
            self.isFolder = isFolder
            self.parentId = parentId
            self.position = position
        }
    }

    /// Folders and projects in one depth-first tree, sharing one rank ordering within each folder (spec §1.2). Dropped
    /// folders and dropped or completed projects show only with `showDropped` (the Everything filter).
    public static func projectEntries(folders: [Folder], projects: [Project], showDropped: Bool) -> [ProjectsEntry] {
        let visibleFolders = folders.filter { showDropped || $0.effectiveActive }
        let visibleProjects = projects.filter {
            showDropped || ($0.effectiveStatus != .dropped && $0.effectiveStatus != .completed)
        }
        var out: [ProjectsEntry] = []
        func walk(_ parentId: String?, _ depth: Int) {
            let kids: [(rank: Double, entry: ProjectsEntry)] =
                visibleFolders.filter { $0.parentId == parentId }.map { ($0.rank, .folder($0, depth: depth)) }
                + visibleProjects.filter { $0.folderId == parentId }.map { ($0.task.rank, .project($0, depth: depth)) }
            // Stable: folders before projects on equal ranks, as in the web app's sort.
            for kid in kids.enumerated().sorted(by: { ($0.element.rank, $0.offset) < ($1.element.rank, $1.offset) }) {
                out.append(kid.element.entry)
                if case .folder(let f, _) = kid.element.entry { walk(f.id, depth + 1) }
            }
        }
        walk(nil, 0)
        return out
    }

    /// Tags depth-first by rank; a tag whose parent is not listed shows at the top level (`flattenTree`). Dropped tags
    /// show only with `showDropped`.
    public static func tagEntries(_ tags: [Tag], showDropped: Bool) -> [TagEntry] {
        let visible = tags.filter { showDropped || $0.effectiveStatus != .dropped }
        let ids = Set(visible.map(\.id))
        var children: [String?: [Tag]] = [:]
        for tag in visible {
            let parent = tag.parentId.flatMap { ids.contains($0) ? $0 : nil }
            children[parent, default: []].append(tag)
        }
        var out: [TagEntry] = []
        func walk(_ parent: String?, _ depth: Int) {
            let kids = (children[parent] ?? []).enumerated().sorted { ($0.element.rank, $0.offset) < ($1.element.rank, $1.offset) }
            for kid in kids {
                out.append(TagEntry(tag: kid.element, depth: depth))
                walk(kid.element.id, depth + 1)
            }
        }
        walk(nil, 0)
        return out
    }

    /// Parent links of folders or tags, for `isDescendant`.
    public static func parents(of folders: [Folder]) -> [String: String?] {
        Dictionary(folders.map { ($0.id, $0.parentId) }, uniquingKeysWith: { a, _ in a })
    }

    /// Parent links of tags, for `isDescendant`.
    public static func parents(of tags: [Tag]) -> [String: String?] {
        Dictionary(tags.map { ($0.id, $0.parentId) }, uniquingKeysWith: { a, _ in a })
    }

    /// Whether `id` is `ancestor` or lies inside it.
    public static func isDescendant(_ id: String, of ancestor: String, parents: [String: String?]) -> Bool {
        var current: String? = id
        var seen = Set<String>()
        while let c = current, seen.insert(c).inserted {
            if c == ancestor { return true }
            current = parents[c] ?? nil
        }
        return false
    }

    /// "Work : Sub" path of a folder ("" for none).
    public static func folderPath(_ id: String?, folders: [Folder]) -> String {
        let byId = Dictionary(folders.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var names: [String] = []
        var current = id.flatMap { byId[$0] }
        var seen = Set<String>()
        while let f = current, seen.insert(f.id).inserted {
            names.insert(f.name, at: 0)
            current = f.parentId.flatMap { byId[$0] }
        }
        return names.joined(separator: " : ")
    }

    /// The move for dragging Projects-sidebar row `from` to list offset `to` (SwiftUI `onMove` semantics: the row is
    /// inserted before the row now at `to`). The row joins the parent of the row it lands before (or after the last
    /// row, in its parent). Nil when nothing changes or the move is not allowed (a folder into itself).
    public static func projectsMove(_ entries: [ProjectsEntry], from: Int, to: Int, folders: [Folder]) -> ContainerMove? {
        let rows = entries.map { Row(id: $0.itemId, parentId: $0.parentId, isFolder: $0.isFolder) }
        return move(rows, from: from, to: to, parents: parents(of: folders))
    }

    /// The move for dragging Tags-sidebar row `from` to list offset `to` (see `projectsMove`).
    public static func tagMove(_ entries: [TagEntry], from: Int, to: Int, tags: [Tag]) -> ContainerMove? {
        let rows = entries.map { Row(id: $0.tag.id, parentId: $0.tag.parentId, isFolder: true) }
        guard var result = move(rows, from: from, to: to, parents: parents(of: tags)) else { return nil }
        result.isFolder = false
        return result
    }

    /// A row reduced to what a move needs; `isFolder` marks rows that can contain the moved row's kind.
    private struct Row {
        var id: String
        var parentId: String?
        var isFolder: Bool
    }

    private static func move(_ rows: [Row], from: Int, to: Int, parents: [String: String?]) -> ContainerMove? {
        guard rows.indices.contains(from), (0...rows.count).contains(to), to != from, to != from + 1 else { return nil }
        let moving = rows[from]
        let parentId: String?
        let position: Position
        if to < rows.count {
            parentId = rows[to].parentId
            position = .before(rows[to].id)
        } else {
            let last = rows[rows.count - 1].id == moving.id ? rows[rows.count - 2] : rows[rows.count - 1]
            parentId = last.parentId
            position = .after(last.id)
        }
        // A folder (or tag) cannot move into itself or its own subtree.
        if moving.isFolder, let parentId, isDescendant(parentId, of: moving.id, parents: parents) { return nil }
        // Already there: the same parent, next to the same sibling.
        if parentId == moving.parentId {
            let siblings = rows.filter { $0.parentId == moving.parentId }.map(\.id)
            if let at = siblings.firstIndex(of: moving.id) {
                if case .before(let id) = position, at + 1 < siblings.count, siblings[at + 1] == id { return nil }
                if case .after(let id) = position, at > 0, siblings[at - 1] == id { return nil }
            }
        }
        return ContainerMove(id: moving.id, isFolder: moving.isFolder, parentId: parentId, position: position)
    }
}
