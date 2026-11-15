// Author: John Grimes

import Foundation

/// Row placement in evaluated outlines: the parts of `src/web/lib/outlineModel.ts` that optimistic previews and undo
/// snapshots need.
public enum OutlineRows {
    /// Index just past `rows[index]` and its subtree (the deeper rows that follow it).
    public static func blockEnd(_ rows: [OutlineRow], _ index: Int) -> Int {
        let depth = index < rows.count ? rows[index].depth : 0
        var end = index + 1
        while end < rows.count, rows[end].depth > depth { end += 1 }
        return end
    }

    /// Where `rows[index]` sits: its displayed parent (else its task's parent) and previous sibling.
    public static func placeAt(_ rows: [OutlineRow], _ index: Int, groupKey: String) -> RowPlace {
        let row = index < rows.count ? rows[index] : nil
        let depth = row?.depth ?? 0
        var after: String?
        var parentId: String?
        var parentShown = false
        var i = index - 1
        while i >= 0 {
            let r = rows[i]
            if r.depth < depth {
                parentId = r.id
                parentShown = true
                break
            }
            if r.depth == depth && after == nil { after = r.id }
            i -= 1
        }
        if !parentShown { parentId = row?.task?.parentId }
        return RowPlace(parentId: parentId, after: after, groupKey: groupKey)
    }

    /// A displayed row found in an outline.
    public struct Found: Sendable, Hashable {
        /// Index over all groups' rows.
        public var index: Int
        public var at: RowPlace
        public var row: OutlineRow
        /// The row and its subtree.
        public var block: [OutlineRow]
    }

    /// The first displayed occurrence of `id`: its index over all groups, place, row and subtree.
    public static func findRow(_ groups: [OutlineGroup], _ id: String) -> Found? {
        var offset = 0
        for g in groups {
            if let idx = g.rows.firstIndex(where: { $0.id == id }) {
                return Found(
                    index: offset + idx, at: placeAt(g.rows, idx, groupKey: g.key), row: g.rows[idx],
                    block: Array(g.rows[idx..<blockEnd(g.rows, idx)]))
            }
            offset += g.rows.count
        }
        return nil
    }

    private static func withParent(_ row: OutlineRow, _ parentId: String?) -> OutlineRow {
        guard row.kind == .task, var task = row.task, task.parentId != parentId else { return row }
        task.parentId = parentId
        var out = row
        out.task = task
        return out
    }

    /// Moves, adds or removes one row (with its subtree) in a group's rows. A row is placed after its displayed sibling
    /// anchor, else under its displayed parent, else at the start/end of the group named by `groupKey`; when no anchor
    /// is shown in this group, a present row stays where it is and an absent one is not added.
    static func applyRowChange(_ rows: [OutlineRow], _ c: RowChange, groupKey: String) -> [OutlineRow] {
        if let inGroup = c.inGroup, inGroup != groupKey { return rows }
        let idx = rows.firstIndex { $0.id == c.id }
        guard let at = c.at else {
            guard let idx else { return rows }
            return Array(rows[..<idx]) + Array(rows[blockEnd(rows, idx)...])
        }
        var block: [OutlineRow]
        var rest: [OutlineRow]
        if let idx {
            let end = blockEnd(rows, idx)
            block = Array(rows[idx..<end])
            rest = Array(rows[..<idx]) + Array(rows[end...])
        } else {
            guard let added = c.rows, !added.isEmpty else { return rows }
            // Rows of the block shown elsewhere in the group are placed by their own changes.
            let shown = Set(rows.map(\.id))
            block = added.enumerated().filter { $0.offset == 0 || !shown.contains($0.element.id) }.map(\.element)
            rest = rows
        }
        let anchor = !at.last && at.after != nil ? (rest.firstIndex { $0.id == at.after } ?? -1) : -1
        let parent = at.parentId != nil ? (rest.firstIndex { $0.id == at.parentId } ?? -1) : -1
        let first = at.last || at.after == nil
        let pos: Int
        let depth: Int
        if anchor >= 0 {
            pos = blockEnd(rest, anchor)
            depth = rest[anchor].depth
        } else if parent >= 0 && first {
            pos = at.last ? blockEnd(rest, parent) : parent + 1
            depth = rest[parent].depth + 1
        } else if at.parentId == nil && at.groupKey == groupKey && (first || idx == nil) {
            pos = at.after == nil && !at.last ? 0 : rest.count
            depth = 0
        } else if let idx {
            pos = idx
            depth = block.first?.depth ?? 0
        } else {
            return rows
        }
        let shift = depth - (block.first?.depth ?? 0)
        let moved = block.enumerated().map { i, r -> OutlineRow in
            var shifted = r
            if shift != 0 { shifted.depth += shift }
            return i == 0 ? withParent(shifted, at.parentId) : shifted
        }
        return Array(rest[..<pos]) + moved + Array(rest[pos...])
    }

    /// Groups with row changes applied in order.
    public static func applyRowChanges(_ groups: [OutlineGroup], _ changes: [RowChange]) -> [OutlineGroup] {
        var out = groups
        for c in changes {
            out = out.map { g in
                var g = g
                g.rows = applyRowChange(g.rows, c, groupKey: g.key)
                return g
            }
            if let at = c.at, at.ensureGroup, let key = at.groupKey, let rows = c.rows, !rows.isEmpty,
                !out.contains(where: { $0.key == key })
            {
                let base = rows[0].depth
                out.append(OutlineGroup(key: key, title: "", kind: .none, rows: rows.map { r in
                    var r = r
                    r.depth -= base
                    return r
                }))
            }
        }
        return out
    }
}
