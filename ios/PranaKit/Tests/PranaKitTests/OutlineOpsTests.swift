// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Ports of `src/web/lib/outlineOps.test.ts`: previews of outline operations and drag moves.
@MainActor
struct OutlineOpsTests {
    static func row(_ id: String, _ depth: Int, _ parentId: String? = nil) -> OutlineRow {
        var task = TaskItem(id: id, name: id)
        task.parentId = parentId
        return OutlineRow(kind: .task, id: id, depth: depth, task: task)
    }

    /// Inbox: a, b (children b1, b2), c, d.
    static func inbox() -> [OutlineGroup] {
        [
            OutlineGroup(
                key: "inbox", title: "Inbox", kind: .none,
                rows: [row("a", 0), row("b", 0), row("b1", 1, "b"), row("b2", 1, "b"), row("c", 0), row("d", 0)])
        ]
    }

    /// "id@depth" per row, and each task row's parentId where it is set.
    static func shape(_ groups: [OutlineGroup]) -> [String] {
        groups.map { g in
            g.rows.map { r in "\(r.id)@\(r.depth)" + (r.task?.parentId.map { "<\($0)" } ?? "") }.joined(separator: " ")
        }
    }

    static func run(_ changes: [Change], _ groups: [OutlineGroup] = inbox()) -> [String] {
        shape(OutlineRows.applyRowChanges(groups, changes.compactMap(\.rowChange)))
    }

    // MARK: Outline operation previews

    @Test func indentsUnderThePreviousSiblingAfterItsChildren() {
        #expect(Self.run(OutlineOps.changes(.indent, ids: ["c"], groups: Self.inbox())) == ["a@0 b@0 b1@1<b b2@1<b c@1<b d@0"])
    }

    @Test func indentsAdjacentSelectedSiblingsTogetherUnderTheFirstUnselectedOne() {
        #expect(Self.run(OutlineOps.changes(.indent, ids: ["c", "d"], groups: Self.inbox())) == ["a@0 b@0 b1@1<b b2@1<b c@1<b d@1<b"])
    }

    @Test func doesNotIndentTheFirstSibling() {
        #expect(OutlineOps.changes(.indent, ids: ["a"], groups: Self.inbox()).isEmpty)
    }

    @Test func outdentsAfterTheParentKeepingTheOrderOfSeveralChildren() {
        #expect(Self.run(OutlineOps.changes(.outdent, ids: ["b1", "b2"], groups: Self.inbox())) == ["a@0 b@0 b1@0 b2@0 c@0 d@0"])
    }

    @Test func movesUpAndDownAmongSiblingsWithSubtrees() {
        #expect(Self.run(OutlineOps.changes(.moveUp, ids: ["c"], groups: Self.inbox())) == ["a@0 c@0 b@0 b1@1<b b2@1<b d@0"])
        #expect(Self.run(OutlineOps.changes(.moveDown, ids: ["a"], groups: Self.inbox())) == ["b@0 b1@1<b b2@1<b a@0 c@0 d@0"])
        #expect(Self.run(OutlineOps.changes(.moveUp, ids: ["b"], groups: Self.inbox())) == ["b@0 b1@1<b b2@1<b a@0 c@0 d@0"])
    }

    @Test func groupsTheSelectionIntoANewGroupWhereTheFirstItemWas() {
        let changes = OutlineOps.changes(.group, ids: ["c", "d"], groups: Self.inbox(), groupRow: Self.row("g", 0))
        #expect(Self.run(changes) == ["a@0 b@0 b1@1<b b2@1<b g@0 c@1<g d@1<g"])
    }

    @Test func ungroupsChildrenTakeTheGroupsPlaceAndTheGroupGoes() {
        #expect(Self.run(OutlineOps.changes(.ungroup, ids: ["b"], groups: Self.inbox())) == ["a@0 b1@0 b2@0 c@0 d@0"])
    }

    @Test func isIdempotent() {
        let changes = OutlineOps.changes(.indent, ids: ["c"], groups: Self.inbox()).compactMap(\.rowChange)
        let once = OutlineRows.applyRowChanges(Self.inbox(), changes)
        #expect(Self.shape(OutlineRows.applyRowChanges(once, changes)) == Self.shape(once))
    }

    @Test func worksUnderAProjectHeaderRow() {
        let groups = [
            OutlineGroup(
                key: "p", title: "P", kind: .project,
                rows: [OutlineRow(kind: .project, id: "p", depth: 0), Self.row("x", 1, "p"), Self.row("y", 1, "p")])
        ]
        #expect(Self.run(OutlineOps.changes(.moveUp, ids: ["y"], groups: groups), groups) == ["p@0 y@1<p x@1<p"])
        #expect(OutlineOps.changes(.outdent, ids: ["x"], groups: groups).isEmpty)
    }

    // MARK: Move previews

    @Test func movesTasksBeforeAnAnchorKeepingTheirOrder() {
        #expect(Self.run(OutlineOps.moveChanges(["d", "a"], to: .before("c"), groups: Self.inbox())) == ["b@0 b1@1<b b2@1<b a@0 d@0 c@0"])
    }

    @Test func movesIntoARowAtTheEndOfItsChildren() {
        #expect(
            Self.run(OutlineOps.moveChanges(["a"], to: .inside("b", atEnd: true), groups: Self.inbox())) == ["b@0 b1@1<b b2@1<b a@1<b c@0 d@0"])
    }

    @Test func movesASelectedParentWithItsSubtreeSkippingSelectedDescendants() {
        #expect(Self.run(OutlineOps.moveChanges(["b", "b1"], to: .after("d"), groups: Self.inbox())) == ["a@0 c@0 d@0 b@0 b1@1<b b2@1<b"])
    }

    @Test func moveTargetsMapToTheServerRequest() {
        #expect(OutlineMoveTarget.before("c").request == MoveTarget(position: .before("c")))
        #expect(OutlineMoveTarget.after("c").request == MoveTarget(position: .after("c")))
        #expect(OutlineMoveTarget.inside("b", atEnd: true).request == MoveTarget(parentId: "b", position: .end))
    }

    // MARK: Drops between rows (reorder mode)

    static func display(_ rows: [OutlineRow]) -> [DisplayRow] {
        OutlineDisplay.visibleRows([OutlineGroup(key: "g", title: "", kind: .none, rows: rows)], collapsed: []).flatMap(\.rows)
    }

    @Test func aDropBetweenRowsTakesThePlaceBeforeTheRowBelow() {
        let rows = Self.display(Self.inbox()[0].rows)
        #expect(OutlineOps.insertionTarget(rows: rows, at: 0) == .before("a"))
        #expect(OutlineOps.insertionTarget(rows: rows, at: 3) == .before("b2"))
        #expect(OutlineOps.insertionTarget(rows: rows, at: 6) == .after("d"))
        #expect(OutlineOps.insertionTarget(rows: [], at: 0) == nil)
    }

    @Test func aDropAroundAProjectHeaderGoesIntoTheProject() {
        let project = OutlineRow(kind: .project, id: "p", depth: 0)
        #expect(OutlineOps.insertionTarget(rows: Self.display([project, Self.row("x", 1, "p")]), at: 0) == .inside("p", atEnd: false))
        #expect(OutlineOps.insertionTarget(rows: Self.display([project]), at: 1) == .inside("p", atEnd: true))
    }

    // MARK: Row changes (outlineModel)

    @Test func addsAnAbsentRowByGroupKeyAtTheEndOrStart() {
        let added = Self.row("n", 0)
        #expect(
            Self.run([.row(RowChange(id: "n", at: RowPlace(parentId: nil, after: nil, last: true, groupKey: "inbox"), rows: [added]))])
                == ["a@0 b@0 b1@1<b b2@1<b c@0 d@0 n@0"])
        #expect(
            Self.run([.row(RowChange(id: "n", at: RowPlace(parentId: nil, after: nil, groupKey: "inbox"), rows: [added]))])
                == ["n@0 a@0 b@0 b1@1<b b2@1<b c@0 d@0"])
        #expect(
            Self.run([.row(RowChange(id: "n", at: RowPlace(parentId: nil, after: nil, groupKey: "elsewhere"), rows: [added]))])
                == ["a@0 b@0 b1@1<b b2@1<b c@0 d@0"])
    }

    @Test func removesARowWithItsSubtreeOnlyInTheNamedGroupWhenScoped() {
        #expect(Self.run([.row(RowChange(id: "b", at: nil))]) == ["a@0 c@0 d@0"])
        #expect(Self.run([.row(RowChange(id: "b", at: nil, inGroup: "other"))]) == ["a@0 b@0 b1@1<b b2@1<b c@0 d@0"])
    }

    // MARK: Undo snapshots of row changes

    @Test(arguments: ["group", "ungroup", "indent", "delete", "create"])
    func restoresTheOutlineAfter(_ label: String) {
        let changes: [Change] =
            switch label {
            case "group": OutlineOps.changes(.group, ids: ["c", "d"], groups: Self.inbox(), groupRow: Self.row("g", 0))
            case "ungroup": OutlineOps.changes(.ungroup, ids: ["b"], groups: Self.inbox())
            case "indent": OutlineOps.changes(.indent, ids: ["c", "d"], groups: Self.inbox())
            case "delete": [.row(RowChange(id: "b", at: nil))]
            default: [.row(RowChange(id: "n", at: RowPlace(parentId: nil, after: "a"), rows: [Self.row("n", 0)]))]
            }
        let before = Optimistic.invertChanges(changes, reader: StubReader(readOutline: { Self.inbox() }))
        let after = OutlineRows.applyRowChanges(Self.inbox(), changes.compactMap(\.rowChange))
        #expect(Self.shape(OutlineRows.applyRowChanges(after, before.compactMap(\.rowChange))) == Self.shape(Self.inbox()))
    }

    // MARK: Container moves (drops on sidebar projects or the inbox)

    @Test func rowsDroppedOnAProjectLeaveTheirOldGroupAndJoinTheProjects() {
        var inboxTask = TaskItem(id: "a", name: "a")
        inboxTask.inInbox = true
        let groups = [
            OutlineGroup(key: "inbox", title: "Inbox", kind: .none, rows: [OutlineRow(kind: .task, id: "a", depth: 0, task: inboxTask)]),
            OutlineGroup(key: "p", title: "P", kind: .project, rows: [OutlineRow(kind: .project, id: "p", depth: 0)]),
        ]
        let changes = OutlineOps.containerMoveChanges(["a"], projectId: "p", groups: groups).compactMap(\.rowChange)
        #expect(changes.map(\.id) == ["a", "a"])
        #expect(changes[0].at == nil && changes[0].inGroup == "inbox")
        #expect(changes[1].at == RowPlace(parentId: "p", after: nil, last: true, groupKey: "p"))
        #expect(Self.shape(OutlineRows.applyRowChanges(groups, changes)) == ["", "p@0 a@1<p"])
    }

    @Test func descendantsOfMovedRowsTravelWithThem() {
        let changes = OutlineOps.containerMoveChanges(["b", "b1"], projectId: nil, groups: Self.inbox()).compactMap(\.rowChange)
        #expect(changes.map(\.id) == ["b"])
    }
}
