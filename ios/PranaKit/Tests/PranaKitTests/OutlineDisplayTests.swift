// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Ports of `src/web/lib/outlineModel.test.ts` (kept rows, collapse, Clean Up greying) and the outline's display rules.
struct OutlineDisplayTests {
    static func task(_ id: String, _ build: (inout TaskItem) -> Void = { _ in }) -> TaskItem {
        var t = TaskItem(id: id, name: id)
        build(&t)
        return t
    }

    static func row(_ id: String, _ depth: Int = 0, _ build: (inout TaskItem) -> Void = { _ in }) -> OutlineRow {
        OutlineRow(kind: .task, id: id, depth: depth, task: task(id, build))
    }

    static func group(_ rows: [OutlineRow], _ key: String = "g") -> OutlineGroup {
        OutlineGroup(key: key, title: "", kind: .none, rows: rows)
    }

    static func ids(_ groups: [OutlineGroup]) -> [String] { groups.flatMap { $0.rows.map(\.id) } }

    // MARK: mergeContents

    @Test func keepsACompletedRowAtItsOldPositionAfterTheServerStopsReturningIt() {
        let before = [Self.row("a"), Self.row("b"), Self.row("c")]
        let after = [Self.group([Self.row("a"), Self.row("c")])]
        let sticky = [
            StickyRow(
                row: Self.row("b") { $0.completed = "2026-10-31T00:00:00.000Z" }, groupKey: "g",
                placement: OutlineDisplay.placementOf(before, "b"))
        ]
        let merged = OutlineDisplay.mergeContents(after, sticky: sticky, deleted: [])
        #expect(Self.ids(merged) == ["a", "b", "c"])
        #expect(merged[0].rows[1].task?.completed == "2026-10-31T00:00:00.000Z")
    }

    @Test func insertsANewSiblingAfterTheAnchorsSubtree() {
        let groups = [Self.group([Self.row("a"), Self.row("a1", 1), Self.row("a2", 1), Self.row("b")])]
        let merged = OutlineDisplay.mergeContents(
            groups, sticky: [StickyRow(row: Self.row("new"), groupKey: "g", placement: .after("a", skipSubtree: true))], deleted: [])
        #expect(Self.ids(merged) == ["a", "a1", "a2", "new", "b"])
    }

    @Test func doesNotDuplicateRowsTheServerAlreadyReturnsAndHidesDeletedRows() {
        let groups = [Self.group([Self.row("a"), Self.row("b")])]
        let merged = OutlineDisplay.mergeContents(groups, sticky: [StickyRow(row: Self.row("a"), groupKey: "g", placement: .start)], deleted: ["b"])
        #expect(Self.ids(merged) == ["a"])
    }

    // MARK: visibleRows

    @Test func hidesDescendantsOfCollapsedRowsAndMarksRowsWithChildren() {
        let groups = [Self.group([Self.row("a"), Self.row("a1", 1), Self.row("a1x", 2), Self.row("b")])]
        let shown = OutlineDisplay.visibleRows(groups, collapsed: ["g/a"])
        #expect(shown[0].rows.map(\.row.id) == ["a", "b"])
        #expect(shown[0].rows.map(\.hasChildren) == [true, false])
        #expect(OutlineDisplay.visibleRows(groups, collapsed: [])[0].rows.map(\.row.id) == ["a", "a1", "a1x", "b"])
    }

    @Test func reservesTheDisclosureColumnOnlyWhenSomeRowHasChildren() {
        #expect(OutlineDisplay.visibleRows([Self.group([Self.row("a"), Self.row("a1", 1)])], collapsed: []).hasDisclosureColumn)
        #expect(!OutlineDisplay.visibleRows([Self.group([Self.row("a"), Self.row("b")])], collapsed: []).hasDisclosureColumn)
    }

    // MARK: leavingRows

    static func inboxRow(_ id: String, _ depth: Int = 0, _ build: (inout TaskItem) -> Void = { _ in }) -> OutlineRow {
        row(id, depth) {
            $0.inInbox = true
            $0.parentId = depth == 0 ? nil : "parent"
            build(&$0)
        }
    }

    @Test func marksKeptRowsThatNewerServerContentsNoLongerInclude() {
        let before = [Self.group([Self.row("a"), Self.row("b")])]
        let after = [Self.group([Self.row("a")])]
        let sticky = [StickyRow(row: Self.row("b"), groupKey: "g", placement: OutlineDisplay.placementOf(before[0].rows, "b"), since: 1)]
        let merged = OutlineDisplay.mergeContents(after, sticky: sticky, deleted: [])
        #expect(OutlineDisplay.leavingRows(merged, server: after, serverVersion: 2, sticky: sticky, projectIds: []) == ["g/b"])
    }

    @Test func doesNotMarkAKeptRowBeforeContentsNewerThanItsChangeArrive() {
        let current = [Self.group([Self.row("a")])]
        let sticky = [StickyRow(row: Self.row("new"), groupKey: "g", placement: .end, since: 1)]
        let merged = OutlineDisplay.mergeContents(current, sticky: sticky, deleted: [])
        #expect(OutlineDisplay.leavingRows(merged, server: current, serverVersion: 1, sticky: sticky, projectIds: []).isEmpty)
    }

    @Test func doesNotMarkRowsPlacedByPendingWrites() {
        let current = [Self.group([Self.row("a")])]
        let merged = [Self.group([Self.row("a"), Self.row("new")])]
        #expect(OutlineDisplay.leavingRows(merged, server: current, serverVersion: 1, sticky: [], projectIds: [], placed: ["new"]).isEmpty)
    }

    @Test func marksRowsPerGroupSoATaskLeavingOneTagGroupStaysNormalInAnother() {
        let server = [Self.group([Self.row("t")], "tag1"), Self.group([], "tag2")]
        let merged = [Self.group([Self.row("t")], "tag1"), Self.group([Self.row("t")], "tag2")]
        #expect(OutlineDisplay.leavingRows(merged, server: server, serverVersion: 1, sticky: [], projectIds: []) == ["tag2/t"])
    }

    @Test func marksInboxItemsCleanUpWillFileAwayWithTheirSubtrees() {
        let rows = [
            Self.inboxRow("project", 0) { $0.assignedProjectId = "p1" },
            Self.inboxRow("project-child", 1),
            Self.inboxRow("tagged", 0) { $0.tagIds = ["t1"] },
            Self.inboxRow("missing-project", 0) { $0.assignedProjectId = "deleted" },
            Self.inboxRow("plain"),
        ]
        let groups = [Self.group(rows, "inbox")]
        #expect(
            OutlineDisplay.leavingRows(groups, server: groups, serverVersion: 1, sticky: [], projectIds: ["p1"])
                == ["inbox/project", "inbox/project-child", "inbox/tagged"])
    }

    @Test func leavesTaggedInboxItemsAloneOutsideTheInboxGroup() {
        let groups = [Self.group([Self.inboxRow("tagged", 0) { $0.tagIds = ["t1"] }], "TODAY")]
        #expect(OutlineDisplay.leavingRows(groups, server: groups, serverVersion: 1, sticky: [], projectIds: []).isEmpty)
    }

    @Test func cleanUpRowsRemoveEachLeavingRowFromItsGroup() {
        let changes = OutlineDisplay.cleanUpChanges(["inbox/a", "tag/x/b"]).compactMap(\.rowChange)
        #expect(changes == [RowChange(id: "a", at: nil, inGroup: "inbox"), RowChange(id: "b", at: nil, inGroup: "tag/x")])
    }

    // MARK: Cached containers

    @Test func folderAndTagRowsCarryTheCachedRecords() {
        let folder = Folder(id: "f", name: "Renamed")
        let tag = Tag(id: "t", name: "Renamed tag")
        let groups = [
            Self.group([OutlineRow(kind: .folder, id: "f", depth: 0, folder: Folder(id: "f", name: "Old")), OutlineRow(kind: .tag, id: "t", depth: 0)])
        ]
        let out = OutlineDisplay.withCachedContainers(groups, folders: ["f": folder], tags: ["t": tag])
        #expect(out[0].rows[0].folder?.name == "Renamed")
        #expect(out[0].rows[1].tag?.name == "Renamed tag")
    }

    // MARK: Kept rows (rows touched by writes stay put until Clean Up or navigation)

    @Test func keepsATaskReturnedByAWriteWhereItIsShownWithItsFreshData() {
        let merged = [Self.group([Self.row("a"), Self.row("b"), Self.row("c")])]
        var kept = KeptRows(since: 0)
        kept.keep([Self.task("b") { $0.completed = "x" }], queued: 3, merged: merged, serverVersion: 7)
        #expect(kept.sticky.map(\.row.id) == ["b"])
        #expect(kept.sticky[0].row.task?.completed == "x")
        #expect(kept.sticky[0].placement == .after("a", skipSubtree: false))
        #expect(kept.sticky[0].since == 7)
        // A later write's copy refreshes the kept row in place.
        kept.keep([Self.task("b") { $0.name = "B" }], queued: 4, merged: merged, serverVersion: 8)
        #expect(kept.sticky.count == 1 && kept.sticky[0].row.task?.name == "B")
    }

    @Test func ignoresWritesQueuedBeforeTheScopeBegan() {
        var kept = KeptRows(since: 5)
        kept.keep([Self.task("a")], queued: 4, merged: [Self.group([Self.row("a")])], serverVersion: 1)
        #expect(kept.sticky.isEmpty)
    }

    @Test func aRepeatingTasksServerCloneReplacesItsStandIn() {
        let merged = [Self.group([Self.row("r.~"), Self.row("r")])]
        var kept = KeptRows(since: 0)
        kept.keep([Self.task("r.3") { $0.completed = "x" }], queued: 1, merged: merged, serverVersion: 1)
        #expect(kept.sticky.map(\.row.id) == ["r.3"])
        #expect(kept.deleted == ["r.~"])
    }

    @Test func rowsKeepTheirKindWhenTheirTaskIsReplaced() {
        let project = Project(record: ProjectRecord(id: "p"), task: Self.task("p"))
        let row = OutlineRow(kind: .project, id: "p", depth: 0, project: project)
        let out = KeptRows.withTask(row, Self.task("p") { $0.name = "New" })
        #expect(out.project?.task.name == "New")
        #expect(out.task == nil)
    }
}
