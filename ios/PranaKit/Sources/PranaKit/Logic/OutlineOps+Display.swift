// Author: John Grimes

import Foundation

/// Where a kept row goes back into the server's rows (`Placement` in `src/web/lib/outlineModel.ts`).
public enum StickyPlacement: Sendable, Hashable {
    /// After a row, optionally after its subtree too.
    case after(String, skipSubtree: Bool)
    /// Before a row.
    case before(String)
    /// At the start of the group.
    case start
    /// At the end of the group.
    case end
}

/// A row the outline keeps visible until Clean Up or navigation (completed, dropped or edited away rows).
public struct StickyRow: Sendable, Hashable {
    public var row: OutlineRow
    public var groupKey: String
    public var placement: StickyPlacement
    /// Version of the server contents current when the row was kept; until newer contents arrive its absence from
    /// them proves nothing.
    public var since: Int?

    /// Creates a kept row.
    public init(row: OutlineRow, groupKey: String, placement: StickyPlacement, since: Int? = nil) {
        self.row = row
        self.groupKey = groupKey
        self.placement = placement
        self.since = since
    }
}

/// A row as displayed: its group and whether it shows a disclosure triangle.
public struct DisplayRow: Sendable, Hashable, Identifiable {
    public var row: OutlineRow
    public var groupKey: String
    /// Has visible children in the display (disclosure triangle).
    public var hasChildren: Bool

    /// Creates a display row.
    public init(row: OutlineRow, groupKey: String, hasChildren: Bool) {
        self.row = row
        self.groupKey = groupKey
        self.hasChildren = hasChildren
    }

    /// `groupKey/id`: a row can show in several groups (e.g. tag groups).
    public var id: String { "\(groupKey)/\(row.id)" }
}

/// A group with its visible rows.
public struct DisplayGroup: Sendable, Hashable, Identifiable {
    public var group: OutlineGroup
    public var rows: [DisplayRow]

    /// The group key.
    public var id: String { group.key }
}

extension Array where Element == DisplayGroup {
    /// Whether the disclosure column is reserved: some row in the outline has children (spec §3).
    public var hasDisclosureColumn: Bool { contains { $0.rows.contains(where: \.hasChildren) } }
}

/// The pure display model of the outline (port of the rest of `src/web/lib/outlineModel.ts`): merges server contents
/// with rows kept visible until Clean Up, applies collapse state and works out which rows Clean Up removes.
public enum OutlineDisplay {
    static func insert(_ rows: inout [OutlineRow], _ sticky: StickyRow) {
        switch sticky.placement {
        case .start:
            rows.insert(sticky.row, at: 0)
        case .end:
            rows.append(sticky.row)
        case .before(let id):
            guard let idx = rows.firstIndex(where: { $0.id == id }) else { return rows.append(sticky.row) }
            rows.insert(sticky.row, at: idx)
        case .after(let id, let skipSubtree):
            guard let idx = rows.firstIndex(where: { $0.id == id }) else { return rows.append(sticky.row) }
            rows.insert(sticky.row, at: skipSubtree ? OutlineRows.blockEnd(rows, idx) : idx + 1)
        }
    }

    /// Server groups + kept rows (in insertion order) − deleted ids.
    public static func mergeContents(_ groups: [OutlineGroup], sticky: [StickyRow], deleted: Set<String>) -> [OutlineGroup] {
        var out = groups.map { g in
            var g = g
            g.rows.removeAll { deleted.contains($0.id) }
            return g
        }
        for s in sticky where !deleted.contains(s.row.id) {
            guard let gi = out.firstIndex(where: { $0.key == s.groupKey }) ?? (out.isEmpty ? nil : 0) else {
                out.append(OutlineGroup(key: s.groupKey, title: "", kind: .none, rows: [s.row]))
                continue
            }
            if out[gi].rows.contains(where: { $0.id == s.row.id }) { continue }
            insert(&out[gi].rows, s)
        }
        return out
    }

    /// Flattens groups into visible rows, hiding descendants of collapsed rows (`collapsed` holds `groupKey/id`).
    public static func visibleRows(_ groups: [OutlineGroup], collapsed: Set<String>) -> [DisplayGroup] {
        groups.map { group in
            var rows: [DisplayRow] = []
            var hideDeeperThan = Int.max
            for (i, row) in group.rows.enumerated() {
                if row.depth > hideDeeperThan { continue }
                hideDeeperThan = Int.max
                let hasChildren = i + 1 < group.rows.count && group.rows[i + 1].depth > row.depth
                rows.append(DisplayRow(row: row, groupKey: group.key, hasChildren: hasChildren))
                if hasChildren && collapsed.contains("\(group.key)/\(row.id)") { hideDeeperThan = row.depth }
            }
            return DisplayGroup(group: group, rows: rows)
        }
    }

    /// Placement that keeps `id` where it currently is in `rows` (used when a mutation makes it stop matching).
    public static func placementOf(_ rows: [OutlineRow], _ id: String) -> StickyPlacement {
        guard let idx = rows.firstIndex(where: { $0.id == id }), idx > 0 else { return .start }
        return .after(rows[idx - 1].id, skipSubtree: false)
    }

    /// Folder and tag rows carrying the cached folder/tag records, which show edits before the server confirms them.
    public static func withCachedContainers(_ groups: [OutlineGroup], folders: [String: Folder], tags: [String: Tag]) -> [OutlineGroup] {
        groups.map { g in
            var g = g
            g.rows = g.rows.map { row in
                var row = row
                if row.kind == .folder, let folder = folders[row.id] { row.folder = folder }
                if row.kind == .tag, let tag = tags[row.id] { row.tag = tag }
                return row
            }
            return g
        }
    }

    /// Keys (`groupKey/id`) of rows Clean Up will remove from the view (spec §2 Inbox, §3 Row): kept rows that newer
    /// server contents no longer include, and inbox items Clean Up files away (with their subtrees). Rows `placed` by
    /// pending writes are not judged until the server has them.
    public static func leavingRows(
        _ merged: [OutlineGroup], server: [OutlineGroup], serverVersion: Int, sticky: [StickyRow], projectIds: Set<String>,
        placed: Set<String> = []
    ) -> Set<String> {
        let serverKeys = Set(server.flatMap { g in g.rows.map { "\(g.key)/\($0.id)" } })
        let unconfirmed = Set(sticky.filter { $0.since == serverVersion }.map(\.row.id)).union(placed)
        var out = Set<String>()
        for g in merged {
            var filedDepth: Int?
            for row in g.rows {
                let key = "\(g.key)/\(row.id)"
                if let depth = filedDepth, row.depth > depth {
                    out.insert(key)
                    continue
                }
                filedDepth = nil
                if !serverKeys.contains(key) && !unconfirmed.contains(row.id) { out.insert(key) }
                if g.key == "inbox", row.kind == .task, let t = row.task, t.inInbox, t.parentId == nil,
                    (t.assignedProjectId.map(projectIds.contains) ?? false) || !t.tagIds.isEmpty
                {
                    out.insert(key)
                    filedDepth = row.depth
                }
            }
        }
        return out
    }

    /// Clean Up's preview: each leaving row (`groupKey/id`) removed from its group.
    public static func cleanUpChanges(_ leaving: some Sequence<String>) -> [Change] {
        leaving.compactMap { key in
            guard let slash = key.lastIndex(of: "/") else { return nil }
            return .row(RowChange(id: String(key[key.index(after: slash)...]), at: nil, inGroup: String(key[..<slash])))
        }
    }
}

/// Rows an outline keeps in place until Clean Up or navigation (`KeptState` in `Outline.tsx`): rows touched by writes,
/// with their fresh data, and rows hidden locally (deleted or discarded here).
public struct KeptRows: Sendable, Hashable {
    /// Writes queued before this scope began (e.g. before a Clean Up) are not kept.
    public var since: Int
    public var sticky: [StickyRow] = []
    public var deleted: Set<String> = []

    /// Starts keeping rows for writes queued from `since` on.
    public init(since: Int) {
        self.since = since
    }

    /// Keeps rows of tasks a landed write returned (queued as the `queued`th write) where `merged` shows them now.
    /// A finished repeating task's server clone (`id.n`) takes the place of its stand-in row (`id.~`).
    public mutating func keep(_ tasks: [TaskItem], queued: Int, merged: [OutlineGroup], serverVersion: Int) {
        guard queued >= since else { return }
        for t in tasks {
            if let existing = sticky.firstIndex(where: { $0.row.id == t.id }) {
                sticky[existing].row = Self.withTask(sticky[existing].row, t)
                continue
            }
            let base = Self.cloneBase(t.id)
            for g in merged {
                guard let r = g.rows.first(where: { $0.id == t.id }) ?? base.flatMap({ b in g.rows.first { $0.id == "\(b).~" } }) else { continue }
                var row = r
                row.id = t.id
                sticky.append(StickyRow(row: Self.withTask(row, t), groupKey: g.key, placement: OutlineDisplay.placementOf(g.rows, r.id), since: serverVersion))
                if r.id != t.id { deleted.insert(r.id) }
                break
            }
        }
    }

    /// Replaces kept rows with re-read copies (`nil` drops rows whose task no longer exists).
    public mutating func reread(_ results: [String: TaskItem?]) {
        sticky = sticky.compactMap { s in
            guard let result = results[s.row.id] else { return s }
            guard let task = result else { return nil }
            var s = s
            s.row = Self.withTask(s.row, task)
            return s
        }
    }

    /// `base` for a clone id `base.n`.
    static func cloneBase(_ id: String) -> String? {
        guard let dot = id.lastIndex(of: "."), dot != id.startIndex else { return nil }
        let suffix = id[id.index(after: dot)...]
        guard !suffix.isEmpty, suffix.allSatisfy(\.isNumber) else { return nil }
        return String(id[..<dot])
    }

    /// The row carrying `task` (a project row's project task, else the row's task).
    public static func withTask(_ row: OutlineRow, _ task: TaskItem) -> OutlineRow {
        var out = row
        if row.kind == .project, var project = row.project {
            project.task = task
            out.project = project
        } else {
            out.task = task
        }
        return out
    }
}
