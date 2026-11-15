// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Port of `src/web/lib/optimistic.test.ts`: previews of pending writes and the undo snapshots that revert them.
@MainActor
struct OptimisticTests {
    let now = DateTime.date(milliseconds: 1_793_448_000_000)  // 2026-10-31T12:00:00.000Z

    func task(_ build: (inout TaskItem) -> Void = { _ in }) -> TaskItem {
        var t = TaskItem(id: "t", name: "t")
        build(&t)
        return t
    }

    @Test func nowIsTheTestInstant() {
        #expect(DateTime.formatFixed(now) == "2026-10-31T12:00:00.000Z")
    }

    // MARK: changesFromPatch

    @Test func resolvesNaturalLanguageAndIsoDatesAndLeavesUnparseableOnesToTheServer() {
        let changes = Optimistic.changesFromPatch(
            ["dueDate": "2026-11-02", "deferDate": "2026-11-01T08:30", "plannedDate": "gibberish", "name": "x"],
            settings: testSettings, now: now)
        #expect(changes == ["name": "x", "dueDate": "2026-11-02T17:00:00.000", "deferDate": "2026-11-01T08:30:00.000"])
    }

    @Test func passesClearsThrough() {
        #expect(Optimistic.changesFromPatch(["dueDate": .null], settings: testSettings, now: now) == ["dueDate": .null])
    }

    // MARK: projectTask

    @Test func marksATaskDueWithinTheDueSoonWindow() {
        let t = Optimistic.projectTask(task(), ["dueDate": "2026-11-01T17:00:00.000"], settings: testSettings, now: now)
        #expect(t.effectiveDueDate == "2026-11-01T17:00:00.000")
        #expect(t.dueSoon && !t.overdue)
        #expect(t.status == .dueSoon)
    }

    @Test func marksAPastDueDateOverdue() {
        #expect(Optimistic.projectTask(task(), ["dueDate": "2026-10-30T17:00:00.000"], settings: testSettings, now: now).status == .overdue)
    }

    @Test func keepsAnEarlierInheritedDueDateWhenTheOwnOneIsLater() {
        let inherited = task { $0.effectiveDueDate = "2026-10-30T17:00:00.000" }
        #expect(Optimistic.projectTask(inherited, ["dueDate": "2026-12-01T17:00:00.000"], settings: testSettings, now: now).effectiveDueDate == "2026-10-30T17:00:00.000")
        #expect(Optimistic.projectTask(inherited, ["dueDate": .null], settings: testSettings, now: now).effectiveDueDate == "2026-10-30T17:00:00.000")
    }

    @Test func dropsTheOwnDueDateFromTheEffectiveValueWhenCleared() {
        let own = task {
            $0.dueDate = "2026-11-01T17:00:00.000"
            $0.effectiveDueDate = "2026-11-01T17:00:00.000"
            $0.dueSoon = true
            $0.status = .dueSoon
        }
        let t = Optimistic.projectTask(own, ["dueDate": .null], settings: testSettings, now: now)
        #expect(t.effectiveDueDate == nil)
        #expect(!t.dueSoon)
        #expect(t.status == .available)
    }

    @Test func blocksATaskDeferredIntoTheFutureAndUnblocksItWhenCleared() {
        let deferred = Optimistic.projectTask(task(), ["deferDate": "2026-11-05T00:00:00.000"], settings: testSettings, now: now)
        #expect(deferred.deferred && deferred.blocked && !deferred.available)
        #expect(deferred.status == .blocked)
        let cleared = Optimistic.projectTask(deferred, ["deferDate": .null], settings: testSettings, now: now)
        #expect(!cleared.deferred && !cleared.blocked)
        #expect(cleared.status == .available)
    }

    @Test func completingATaskMakesItNoLongerRemaining() {
        let overdue = task {
            $0.dueDate = "2026-10-30T17:00:00.000"
            $0.effectiveDueDate = "2026-10-30T17:00:00.000"
        }
        let t = Optimistic.projectTask(overdue, ["completed": "2026-10-31T12:00:00.000Z"], settings: testSettings, now: now)
        #expect(!t.remaining && !t.overdue)
        #expect(t.status == .completed)
    }

    @Test func keepsAnInheritedFlagWhenTheOwnFlagIsCleared() {
        #expect(Optimistic.projectTask(task { $0.effectiveFlagged = true }, ["flagged": false], settings: testSettings, now: now).effectiveFlagged)
        let own = task {
            $0.flagged = true
            $0.effectiveFlagged = true
        }
        #expect(!Optimistic.projectTask(own, ["flagged": false], settings: testSettings, now: now).effectiveFlagged)
    }

    // MARK: previews

    @Test func applyTaskChangesInOrderOnTheChangedTasksOnly() {
        let changes: [Change] = [
            .taskFields(["t"], ["name": "first"]),
            .task(ids: ["t"], task: TaskChange(tagEdit: TagEdit(add: ["x"], remove: []))),
        ]
        let shown = Optimistic.previewTask(task(), changes, settings: testSettings, now: now)
        #expect(shown.name == "first")
        #expect(shown.tagIds == ["x"])
        #expect(Optimistic.previewTask(TaskItem(id: "other", name: "t"), changes, settings: testSettings, now: now).name == "t")
    }

    @Test func addPatchAndRemoveListItemsAndApplyTaskChangesToProjectRows() {
        let folders = [Folder(id: "a", name: "A"), Folder(id: "b", name: "B")]
        let changes: [Change] = [
            .item(ItemChange(list: .folders, id: "c", edit: .replace(.folder(Folder(id: "c", name: "C"))))),
            .item(ItemChange(list: .folders, id: "a", edit: .patch(["name": "A2"]))),
            .item(ItemChange(list: .folders, id: "b", edit: .remove)),
        ]
        #expect(Optimistic.previewList(folders, changes, settings: testSettings, now: now).map(\.name) == ["A2", "C"])
        let project = Project(record: ProjectRecord(id: "t"), task: task())
        let shown = Optimistic.previewList(
            [project], [.task(ids: ["t"], task: TaskChange(["name": "renamed"]), project: ["status": "onHold"])],
            settings: testSettings, now: now)
        #expect(shown.first?.task.name == "renamed")
        #expect(shown.first?.status == .onHold)
    }

    @Test func previewDetailAppliesAttachmentsAndRemovedChildren() {
        let detail = TaskDetail(task: task(), children: [TaskItem(id: "c1"), TaskItem(id: "c2")])
        let attachment = Attachment(id: "up", taskId: "t", name: "a.txt", contentType: "text/plain", size: 1, sha256: "", added: "", uploading: true)
        let shown = Optimistic.previewDetail(
            detail, [.attachment(taskId: "t", id: "up", value: attachment), .row(RowChange(id: "c1", at: nil))],
            settings: testSettings, now: now)
        #expect(shown.attachments == [attachment])
        #expect(shown.children.map(\.id) == ["c2"])
    }

    // MARK: undo snapshots

    @Test func capturesTheOverwrittenValuesWhichRestoreTheShownState() {
        // Arrange
        let reader = StubReader(
            readTask: { $0 == "t" ? self.task { $0.name = "old" } : nil },
            readItem: { list, id in
                if list == .folders && id == "f" { return .some(.folder(Folder(id: "f", name: "Old folder"))) }
                return list == .folders ? .some(nil) : .none
            },
            readSettings: { testSettings })
        let changes: [Change] = [
            .taskFields(["t", "unloaded"], ["flagged": true]),
            .item(ItemChange(list: .folders, id: "f", edit: .patch(["name": "New folder"]))),
            .item(ItemChange(list: .folders, id: "n", edit: .replace(.folder(Folder(id: "n", name: "Created"))))),
            .settings(["theme": "dark"]),
        ]
        // Act
        let before = Optimistic.invertChanges(changes, reader: reader)
        // Assert: applying the write then its snapshot shows the original state again.
        let folders = Optimistic.previewList(
            Optimistic.previewList([Folder(id: "f", name: "Old folder")], changes, settings: testSettings, now: now), before,
            settings: testSettings, now: now)
        #expect(folders.map(\.name) == ["Old folder"])
        let flagged = Optimistic.previewTask(Optimistic.previewTask(task(), changes, settings: testSettings, now: now), before, settings: testSettings, now: now)
        #expect(!flagged.flagged)
        #expect(Optimistic.previewSettings(Optimistic.previewSettings(testSettings, changes), before).theme == .system)
    }

    @Test func snapshotsRestoreRemovedRowsWhereTheyWere() {
        // A deleted row (with its subtree) comes back at the same place when undone.
        let rows = [
            OutlineRow(kind: .task, id: "a", depth: 0, task: TaskItem(id: "a")),
            OutlineRow(kind: .task, id: "b", depth: 0, task: TaskItem(id: "b")),
            OutlineRow(kind: .task, id: "b1", depth: 1, task: TaskItem(id: "b1", parentId: "b")),
            OutlineRow(kind: .task, id: "c", depth: 0, task: TaskItem(id: "c")),
        ]
        let groups = [OutlineGroup(key: "inbox", title: "Inbox", kind: .none, rows: rows)]
        let delete: [Change] = [.row(RowChange(id: "b", at: nil))]
        let before = Optimistic.invertChanges(delete, reader: StubReader(readOutline: { groups }))
        let removed = OutlineRows.applyRowChanges(groups, delete.compactMap(\.rowChange))
        #expect(removed[0].rows.map(\.id) == ["a", "c"])
        let restored = OutlineRows.applyRowChanges(removed, before.compactMap(\.rowChange))
        #expect(restored[0].rows.map(\.id) == ["a", "b", "b1", "c"])
        #expect(restored[0].rows.map(\.depth) == [0, 0, 1, 0])
    }

    // MARK: rows

    @Test func placesANewRowAtTheEndOfTheInboxGroupAndCreatesTheGroupWhenAsked() {
        let row = OutlineRow(kind: .task, id: "n", depth: 0, task: TaskItem(id: "n"))
        let place = RowPlace(parentId: nil, after: nil, last: true, groupKey: "inbox", ensureGroup: true)
        let added = OutlineRows.applyRowChanges([], [RowChange(id: "n", at: place, rows: [row])])
        #expect(added.map(\.key) == ["inbox"])
        let existing = [OutlineGroup(key: "inbox", title: "Inbox", kind: .none, rows: [OutlineRow(kind: .task, id: "a", depth: 0)])]
        #expect(OutlineRows.applyRowChanges(existing, [RowChange(id: "n", at: place, rows: [row])])[0].rows.map(\.id) == ["a", "n"])
    }

    @Test func rankAtPlacesBetweenNeighbours() {
        let siblings: [(id: String, rank: Double)] = [("a", 1), ("b", 2), ("c", 5)]
        #expect(Drafts.rankAt(siblings, .start) == 0)
        #expect(Drafts.rankAt(siblings, .end) == 6)
        #expect(Drafts.rankAt(siblings, .after("b")) == 3.5)
        #expect(Drafts.rankAt(siblings, .before("a")) == 0)
        #expect(Drafts.rankAt([], .end) == 0)
    }

    @Test func clientIdsAreElevenCharactersOfTheServerAlphabet() {
        let ids = (0..<200).map { _ in ClientID.make() }
        #expect(ids.allSatisfy { $0.count == 11 && $0.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" } })
        #expect(Set(ids).count == ids.count)
    }
}
