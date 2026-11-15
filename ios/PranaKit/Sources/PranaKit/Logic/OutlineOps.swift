// Author: John Grimes

import Foundation

/// Where dragged tasks go in the outline (`MoveTarget` in `src/web/lib/outlineOps.ts`).
public enum OutlineMoveTarget: Sendable, Hashable {
    /// Before a sibling row.
    case before(String)
    /// After a sibling row (and its subtree).
    case after(String)
    /// Inside a row, at the start or end of its children.
    case inside(String, atEnd: Bool)

    /// The `moveTasks` request body for this target.
    public var request: MoveTarget {
        switch self {
        case .before(let id): MoveTarget(position: .before(id))
        case .after(let id): MoveTarget(position: .after(id))
        case .inside(let id, let atEnd): MoveTarget(parentId: id, position: atEnd ? .end : .start)
        }
    }
}

/// Previews of outline restructuring (indent, outdent, group, ungroup, move up/down, drag moves), computed on the
/// displayed rows the way the server applies them to the task tree (port of `src/web/lib/outlineOps.ts`). Each
/// function returns row changes for the store's instant writes (`AppStore.outline`, `AppStore.moveTasks`).
public enum OutlineOps {
    struct Located {
        var rows: [OutlineRow]
        var idx: Int
        var groupKey: String
        /// Displayed parent row index, or -1 for a group root.
        var parent: Int
    }

    static func locate(_ groups: [OutlineGroup], _ id: String) -> Located? {
        for g in groups {
            guard let idx = g.rows.firstIndex(where: { $0.id == id }) else { continue }
            let depth = g.rows[idx].depth
            var parent = idx - 1
            while parent >= 0 && g.rows[parent].depth >= depth { parent -= 1 }
            return Located(rows: g.rows, idx: idx, groupKey: g.key, parent: parent)
        }
        return nil
    }

    /// Sibling row ids of `loc` (same displayed parent and depth), in order.
    static func siblings(_ loc: Located) -> [String] {
        let rows = loc.rows
        let depth = rows[loc.idx].depth
        let end = loc.parent >= 0 ? OutlineRows.blockEnd(rows, loc.parent) : rows.count
        var out: [String] = []
        var i = loc.parent + 1
        while i < end {
            if rows[i].depth == depth { out.append(rows[i].id) }
            i = OutlineRows.blockEnd(rows, i)
        }
        return out
    }

    static func parentId(of loc: Located) -> String? {
        loc.parent >= 0 ? loc.rows[loc.parent].id : loc.rows[loc.idx].task?.parentId
    }

    /// `ids` in display order (ids not shown are dropped).
    static func ordered(_ groups: [OutlineGroup], _ ids: [String]) -> [String] {
        var order: [String: Int] = [:]
        var n = 0
        for g in groups {
            for r in g.rows where order[r.id] == nil {
                order[r.id] = n
                n += 1
            }
        }
        return ids.filter { order[$0] != nil }.sorted { order[$0]! < order[$1]! }
    }

    /// Row changes for an outline operation on the selected task ids, simulated step by step like the server does.
    /// `groupRow` is the new (untitled) group for `.group`.
    public static func changes(_ op: OutlineOperation, ids: [String], groups: [OutlineGroup], groupRow: OutlineRow? = nil) -> [Change] {
        let selected = Set(ids)
        let order = ordered(groups, ids)
        var changes: [Change] = []
        var state = groups
        func place(_ id: String, _ at: RowPlace?, rows: [OutlineRow]? = nil) {
            let change = RowChange(id: id, at: at, rows: rows)
            changes.append(.row(change))
            state = OutlineRows.applyRowChanges(state, [change])
        }
        func parentSelected(_ loc: Located) -> Bool {
            parentId(of: loc).map(selected.contains) ?? false
        }

        switch op {
        case .indent:
            for id in order {
                guard let loc = locate(state, id), !parentSelected(loc) else { continue }
                let sibs = siblings(loc)
                let before = sibs[..<(sibs.firstIndex(of: id) ?? 0)]
                if let prev = before.reversed().first(where: { !selected.contains($0) }) {
                    place(id, RowPlace(parentId: prev, after: nil, last: true))
                }
            }
        case .outdent:
            for id in order.reversed() {
                guard let loc = locate(state, id), loc.parent >= 0, !parentSelected(loc) else { continue }
                let parent = loc.rows[loc.parent]
                guard parent.kind == .task, let parentLoc = locate(state, parent.id) else { continue }
                place(id, RowPlace(parentId: parentId(of: parentLoc), after: parent.id, groupKey: parentLoc.groupKey))
            }
        case .moveUp:
            for id in order {
                guard let loc = locate(state, id) else { continue }
                let sibs = siblings(loc)
                guard let i = sibs.firstIndex(of: id), i >= 1, !selected.contains(sibs[i - 1]) else { continue }
                place(id, RowPlace(parentId: parentId(of: loc), after: i >= 2 ? sibs[i - 2] : nil, groupKey: loc.groupKey))
            }
        case .moveDown:
            for id in order.reversed() {
                guard let loc = locate(state, id) else { continue }
                let sibs = siblings(loc)
                guard let i = sibs.firstIndex(of: id), i + 1 < sibs.count, !selected.contains(sibs[i + 1]) else { continue }
                place(id, RowPlace(parentId: parentId(of: loc), after: sibs[i + 1], groupKey: loc.groupKey))
            }
        case .group:
            guard let first = order.first, let loc = locate(state, first), let groupRow else { break }
            let sibs = siblings(loc)
            let i = sibs.firstIndex(of: loc.rows[loc.idx].id) ?? 0
            var row = groupRow
            row.depth = loc.rows[loc.idx].depth
            place(groupRow.id, RowPlace(parentId: parentId(of: loc), after: i >= 1 ? sibs[i - 1] : nil, groupKey: loc.groupKey), rows: [row])
            for id in order {
                guard let l = locate(state, id), !parentSelected(l) else { continue }
                place(id, RowPlace(parentId: groupRow.id, after: nil, last: true))
            }
        case .ungroup:
            for id in order {
                guard let loc = locate(state, id) else { continue }
                let depth = loc.rows[loc.idx].depth
                var children: [String] = []
                let end = OutlineRows.blockEnd(loc.rows, loc.idx)
                var i = loc.idx + 1
                while i < end {
                    if loc.rows[i].depth == depth + 1 { children.append(loc.rows[i].id) }
                    i = OutlineRows.blockEnd(loc.rows, i)
                }
                if children.isEmpty { continue }
                let sibs = siblings(loc)
                let si = sibs.firstIndex(of: id) ?? 0
                var after: String? = si >= 1 ? sibs[si - 1] : nil
                let parent = parentId(of: loc)
                for child in children {
                    place(child, RowPlace(parentId: parent, after: after, groupKey: loc.groupKey))
                    after = child
                }
                place(id, nil)
            }
        default:
            break
        }
        return changes
    }

    /// Row changes for moving tasks (their subtrees travel with them), keeping their display order, like `moveTasks`.
    public static func moveChanges(_ ids: [String], to target: OutlineMoveTarget, groups: [OutlineGroup]) -> [Change] {
        let selected = Set(ids)
        let roots = ordered(groups, ids).filter { id in
            var loc = locate(groups, id)
            while let l = loc, l.parent >= 0 {
                let p = l.rows[l.parent]
                if selected.contains(p.id) { return false }
                loc = locate(groups, p.id)
            }
            return true
        }
        var at: RowPlace
        switch target {
        case .inside(let parent, let atEnd):
            at = RowPlace(parentId: parent, after: nil, last: atEnd, groupKey: parent)
        case .before(let anchor):
            guard let loc = locate(groups, anchor) else { return [] }
            let sibs = siblings(loc).filter { !selected.contains($0) }
            let i = sibs.firstIndex(of: anchor) ?? 0
            at = RowPlace(parentId: parentId(of: loc), after: i >= 1 ? sibs[i - 1] : nil, groupKey: loc.groupKey)
        case .after(let anchor):
            guard let loc = locate(groups, anchor) else { return [] }
            at = RowPlace(parentId: parentId(of: loc), after: anchor, groupKey: loc.groupKey)
        }
        var changes: [Change] = []
        for id in roots {
            changes.append(.row(RowChange(id: id, at: at)))
            at = RowPlace(parentId: at.parentId, after: id, groupKey: at.groupKey)
        }
        return changes
    }

    /// Where rows dropped between displayed rows go (index `index` among `rows`, as a list insertion reports it):
    /// before the row below, after the last row at the end, and into a project around its header row.
    public static func insertionTarget(rows: [DisplayRow], at index: Int) -> OutlineMoveTarget? {
        if index < rows.count {
            let below = rows[index].row
            return below.kind == .project ? .inside(below.id, atEnd: false) : .before(below.id)
        }
        guard let last = rows.last?.row else { return nil }
        return last.kind == .project ? .inside(last.id, atEnd: true) : .after(last.id)
    }

    /// Rows dropped on a sidebar project (or the inbox when `projectId` is nil) leave the group of their old container
    /// and join the new one's, at its end (`containerMoveRows` in `Outline.tsx`). Descendants travel with their rows.
    public static func containerMoveChanges(_ ids: [String], projectId: String?, groups: [OutlineGroup]) -> [Change] {
        let groupKey = projectId ?? "inbox"
        return ids.flatMap { id -> [Change] in
            guard let found = OutlineRows.findRow(groups, id), let task = found.row.task else { return [] }
            let inMovedBlock = ids.contains { other in
                other != id && (OutlineRows.findRow(groups, other)?.block.contains { $0.id == id } ?? false)
            }
            if inMovedBlock { return [] }
            let oldKey = task.inInbox ? "inbox" : (task.projectId ?? "no-project")
            let leaving = groups.filter { $0.key == oldKey && $0.key != groupKey }.map { g in
                Change.row(RowChange(id: id, at: nil, inGroup: g.key))
            }
            let at = RowPlace(parentId: projectId, after: nil, last: true, groupKey: groupKey)
            return leaving + [.row(RowChange(id: id, at: at, rows: found.block))]
        }
    }
}
