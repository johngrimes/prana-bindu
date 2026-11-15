// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// The outline's row presentation, selection, keyboard and new-item rules (ports of `StatusCircle.tsx`, `Row.tsx` and
/// `Outline.tsx` in `src/web/components/outline`).
struct OutlineRowLogicTests {
    static func task(_ build: (inout TaskItem) -> Void = { _ in }) -> TaskItem {
        var t = TaskItem(id: "t", name: "t")
        build(&t)
        return t
    }

    static let weekly = RepeatRule(rule: "FREQ=WEEKLY", scheduleType: .regularly, anchorDate: .due, catchUpAutomatically: false)

    // MARK: Status circle

    @Test func circleStatesFollowTheWebPriorityOrder() {
        #expect(CircleState(Self.task()) == .available)
        #expect(CircleState(Self.task { $0.firstAvailable = true }) == .next)
        #expect(CircleState(Self.task { $0.repeat = Self.weekly; $0.firstAvailable = true }) == .repeating)
        #expect(CircleState(Self.task { $0.blocked = true; $0.repeat = Self.weekly }) == .blocked)
        #expect(CircleState(Self.task { $0.effectiveFlagged = true; $0.blocked = true }) == .flagged)
        #expect(CircleState(Self.task { $0.dueSoon = true; $0.effectiveFlagged = true }) == .dueSoon)
        #expect(CircleState(Self.task { $0.overdue = true; $0.dueSoon = true }) == .overdue)
        #expect(CircleState(Self.task { $0.effectiveDropped = true; $0.overdue = true }) == .dropped)
        #expect(CircleState(Self.task { $0.dropped = "x" }) == .dropped)
        #expect(CircleState(Self.task { $0.effectiveCompleted = true; $0.dropped = "x" }) == .completed)
        #expect(CircleState(Self.task { $0.completed = "x" }) == .completed)
    }

    @Test func aRepeatBadgeShowsOnUnfinishedCirclesThatAreNotRepeatingState() {
        #expect(CircleState.overdue.showsRepeatBadge(for: Self.task { $0.repeat = Self.weekly }))
        #expect(!CircleState.repeating.showsRepeatBadge(for: Self.task { $0.repeat = Self.weekly }))
        #expect(!CircleState.completed.showsRepeatBadge(for: Self.task { $0.repeat = Self.weekly }))
        #expect(!CircleState.overdue.showsRepeatBadge(for: Self.task()))
    }

    // MARK: Row badges

    @Test func dueChipIsRedWhenOverdueOrangeWhenDueSoonAndImpliedWhenInherited() {
        let own = RowBadges(Self.task { $0.dueDate = "2026-11-01T06:00:00.000Z"; $0.effectiveDueDate = "2026-11-01T06:00:00.000Z"; $0.overdue = true })
        #expect(own.due == RowBadges.DateChip(value: "2026-11-01T06:00:00.000Z", implied: false, tone: .danger))
        let inherited = RowBadges(Self.task { $0.effectiveDueDate = "2026-11-05T06:00:00.000Z"; $0.dueSoon = true })
        #expect(inherited.due == RowBadges.DateChip(value: "2026-11-05T06:00:00.000Z", implied: true, tone: .warn))
        #expect(RowBadges(Self.task { $0.effectiveDueDate = "x"; $0.dueDate = "x" }).due?.tone == .muted)
        #expect(RowBadges(Self.task()).due == nil)
    }

    @Test func deferChipShowsOnlyWhileDeferred() {
        #expect(RowBadges(Self.task { $0.effectiveDeferDate = "x" }).deferUntil == nil)
        #expect(
            RowBadges(Self.task { $0.effectiveDeferDate = "x"; $0.deferred = true }).deferUntil
                == RowBadges.DateChip(value: "x", implied: true, tone: .muted))
        #expect(RowBadges(Self.task { $0.deferDate = "x"; $0.effectiveDeferDate = "x"; $0.deferred = true }).deferUntil?.implied == false)
    }

    @Test func flagsAreOwnImpliedOrAbsent() {
        #expect(RowBadges(Self.task { $0.flagged = true; $0.effectiveFlagged = true }).flag == .own)
        #expect(RowBadges(Self.task { $0.effectiveFlagged = true }).flag == .implied)
        #expect(RowBadges(Self.task()).flag == .none)
    }

    @Test func noteAttachmentAndRepeatIndicators() {
        let badges = RowBadges(Self.task { $0.note = "  hi "; $0.attachmentCount = 2; $0.repeat = Self.weekly })
        #expect(badges.hasNote && badges.attachmentCount == 2 && badges.repeats)
        #expect(!RowBadges(Self.task { $0.note = "  \n" }).hasNote)
    }

    @Test func projectSummaryReadsLikeTheWebRow() {
        func project(_ status: ProjectStatus, _ remaining: Int = 0) -> Project {
            Project(record: ProjectRecord(id: "p", status: status, remainingCount: remaining), task: TaskItem(id: "p"))
        }
        #expect(RowBadges.projectSummary(project(.active, 3)) == "3 remaining")
        #expect(RowBadges.projectSummary(project(.onHold)) == "On Hold")
        #expect(RowBadges.projectSummary(project(.completed)) == "completed")
    }

    // MARK: Row keys

    @Test func rowKeysPrefixFoldersAndTags() {
        #expect(OutlineRowKey.key(OutlineRow(kind: .task, id: "a", depth: 0)) == "a")
        #expect(OutlineRowKey.key(OutlineRow(kind: .project, id: "p", depth: 0)) == "p")
        #expect(OutlineRowKey.key(OutlineRow(kind: .folder, id: "f", depth: 0)) == "folder:f")
        #expect(OutlineRowKey.key(OutlineRow(kind: .tag, id: "t", depth: 0)) == "tag:t")
        #expect(OutlineRowKey.parse("folder:f") == OutlineRowKey.Parsed(kind: .folder, id: "f"))
        #expect(OutlineRowKey.parse("tag:t") == OutlineRowKey.Parsed(kind: .tag, id: "t"))
        #expect(OutlineRowKey.parse("a") == OutlineRowKey.Parsed(kind: .task, id: "a"))
    }

    // MARK: Selection

    static let order = ["a", "b", "c", "d"]

    @Test func plainClickSelectsOneAndSetsTheAnchor() {
        let s = OutlineSelecting.click("c", .none, order: Self.order, state: OutlineSelectionState(keys: ["a"], anchor: "a"))
        #expect(s == OutlineSelectionState(keys: ["c"], anchor: "c"))
    }

    @Test func commandClickTogglesMembership() {
        var s = OutlineSelecting.click("c", .toggle, order: Self.order, state: OutlineSelectionState(keys: ["a"], anchor: "a"))
        #expect(s == OutlineSelectionState(keys: ["a", "c"], anchor: "c"))
        s = OutlineSelecting.click("a", .toggle, order: Self.order, state: s)
        #expect(s == OutlineSelectionState(keys: ["c"], anchor: "a"))
    }

    @Test func shiftClickSelectsTheRangeFromTheAnchor() {
        let s = OutlineSelecting.click("b", .extend, order: Self.order, state: OutlineSelectionState(keys: ["d"], anchor: "d"))
        #expect(s == OutlineSelectionState(keys: ["b", "c", "d"], anchor: "d"))
    }

    @Test func arrowsMoveTheSelectionAndClampAtTheEnds() {
        #expect(OutlineSelecting.move(by: 1, extend: false, order: Self.order, state: OutlineSelectionState()).keys == ["a"])
        #expect(OutlineSelecting.move(by: -1, extend: false, order: Self.order, state: OutlineSelectionState()).keys == ["d"])
        #expect(OutlineSelecting.move(by: 1, extend: false, order: Self.order, state: OutlineSelectionState(keys: ["b", "c"], anchor: "b")).keys == ["d"])
        #expect(OutlineSelecting.move(by: -1, extend: false, order: Self.order, state: OutlineSelectionState(keys: ["a"], anchor: "a")).keys == ["a"])
    }

    @Test func shiftArrowsExtendFromTheAnchor() {
        var s = OutlineSelectionState(keys: ["b"], anchor: "b")
        s = OutlineSelecting.move(by: 1, extend: true, order: Self.order, state: s)
        #expect(s == OutlineSelectionState(keys: ["b", "c"], anchor: "b"))
        s = OutlineSelecting.move(by: 1, extend: true, order: Self.order, state: s)
        #expect(s.keys == ["b", "c", "d"])
        s = OutlineSelecting.move(by: -1, extend: true, order: Self.order, state: OutlineSelectionState(keys: ["b"], anchor: "b"))
        #expect(s == OutlineSelectionState(keys: ["a", "b"], anchor: "b"))
    }

    // MARK: Keyboard (spec §2)

    @Test func keysMapToOutlineCommands() {
        func cmd(_ key: OutlineKey, shift: Bool = false, alt: Bool = false, command: Bool = false) -> OutlineKeyCommand? {
            OutlineKeyCommand.command(for: key, shift: shift, alt: alt, command: command, hasSelection: true)
        }
        #expect(cmd(.down) == .moveSelection(1, extend: false))
        #expect(cmd(.up, shift: true) == .moveSelection(-1, extend: true))
        #expect(cmd(.up, shift: true, alt: true) == .operation(.moveUp))
        #expect(cmd(.down, shift: true, alt: true) == .operation(.moveDown))
        #expect(cmd(.left, shift: true) == .operation(.outdent))
        #expect(cmd(.right, shift: true) == .operation(.indent))
        #expect(cmd(.left) == .collapse(true))
        #expect(cmd(.right) == .collapse(false))
        #expect(cmd(.return) == .newItem(.after))
        #expect(cmd(.return, shift: true) == .newItem(.before))
        #expect(cmd(.return, command: true) == .edit)
        #expect(cmd(.tab) == .edit)
        #expect(cmd(.character("e")) == .edit)
        #expect(cmd(.character("'")) == .editNote)
        #expect(cmd(.character("]")) == .operation(.indent))
        #expect(cmd(.character("[")) == .operation(.outdent))
        #expect(cmd(.character("}")) == .newItem(.child))
        #expect(cmd(.character("{")) == .newItem(.outdented))
        #expect(cmd(.character("g")) == .operation(.group))
        #expect(cmd(.character("u")) == .operation(.ungroup))
        #expect(cmd(.character(" ")) == .complete)
        #expect(cmd(.character("f")) == .flag)
        #expect(cmd(.delete) == .delete)
        #expect(cmd(.escape) == .clearSelection)
        #expect(cmd(.character("x")) == nil)
        #expect(cmd(.character("g"), command: true) == nil)
    }

    @Test func selectionCommandsNeedASelection() {
        for key: OutlineKey in [.return, .delete, .escape, .character(" "), .character("f"), .character("}"), .tab] {
            #expect(OutlineKeyCommand.command(for: key, shift: false, alt: false, command: false, hasSelection: false) == nil)
        }
        #expect(OutlineKeyCommand.command(for: .down, shift: false, alt: false, command: false, hasSelection: false) == .moveSelection(1, extend: false))
    }

    // MARK: New items

    @Test func newItemTargetsFollowTheContents() {
        #expect(NewItemTarget(contents: .inbox) == NewItemTarget())
        #expect(NewItemTarget(contents: ContentsKey(perspectiveId: "projects", project: "p")) == NewItemTarget(projectId: "p"))
        #expect(NewItemTarget(contents: ContentsKey(perspectiveId: "review", project: "p")) == NewItemTarget(projectId: "p"))
        #expect(NewItemTarget(contents: ContentsKey(perspectiveId: "tags", tag: "t")) == NewItemTarget(tagIds: ["t"]))
        #expect(NewItemTarget(contents: ContentsKey(perspectiveId: "tags", tag: "untagged")) == NewItemTarget())
        #expect(NewItemTarget(contents: ContentsKey(perspectiveId: "flagged")) == NewItemTarget(flagged: true))
    }

    @Test func projectColumnShowsOutsideProjectsInboxAndReview() {
        #expect(!OutlinePresentation.showsProject(.inbox))
        #expect(!OutlinePresentation.showsProject(ContentsKey(perspectiveId: "projects")))
        #expect(!OutlinePresentation.showsProject(ContentsKey(perspectiveId: "review", project: "p")))
        #expect(OutlinePresentation.showsProject(ContentsKey(perspectiveId: "flagged")))
        #expect(OutlinePresentation.showsProject(ContentsKey(perspectiveId: "forecast", day: "TODAY")))
    }

    @Test func emptyTextsMatchSpec() {
        #expect(OutlinePresentation.emptyText(OutlineContents(perspectiveId: "inbox", groups: [])) == "No items")
        #expect(OutlinePresentation.emptyText(OutlineContents(perspectiveId: "projects", groups: [])) == "No projects")
        #expect(OutlinePresentation.emptyText(OutlineContents(perspectiveId: "projects", groups: [], emptyText: "No remaining projects")) == "No remaining projects")
        #expect(OutlinePresentation.emptyText(OutlineContents(perspectiveId: "custom", groups: [])) == "No items")
    }

    static func row(_ id: String, _ depth: Int, parent: String? = nil, kind: RowKind = .task) -> OutlineRow {
        if kind == .project {
            let task = TaskItem(id: id, name: id, isProject: true)
            return OutlineRow(kind: .project, id: id, depth: depth, project: Project(record: ProjectRecord(id: id), task: task))
        }
        return OutlineRow(kind: kind, id: id, depth: depth, task: kind == .task ? TaskItem(id: id, name: id, parentId: parent) : nil)
    }

    /// A project group: p, then x (child x1), y.
    static let projectGroups = [
        OutlineGroup(
            key: "p", title: "P", kind: .project,
            rows: [row("p", 0, kind: .project), row("x", 1, parent: "p"), row("x1", 2, parent: "x"), row("y", 1, parent: "p")])
    ]

    static func display(_ id: String) -> DisplayRow? {
        OutlineDisplay.visibleRows(projectGroups, collapsed: []).flatMap(\.rows).first { $0.row.id == id }
    }

    @Test func newSiblingGoesAfterTheRowWithItsPlace() {
        let plan = NewItemPlan.make(relativeTo: Self.display("x"), .after, target: NewItemTarget(projectId: "p"), groups: Self.projectGroups)
        #expect(plan == .create(TaskCreate(name: "", position: .after("x")), RowPlace(parentId: "p", after: "x", groupKey: "p")))
    }

    @Test func newItemAboveTakesThePreviousSiblingsPlace() {
        let plan = NewItemPlan.make(relativeTo: Self.display("y"), .before, target: nil, groups: Self.projectGroups)
        #expect(plan == .create(TaskCreate(name: "", position: .before("y")), RowPlace(parentId: "p", after: "x", groupKey: "p")))
    }

    @Test func newChildGoesFirstUnderTheRowAndProjectsAlwaysTakeChildren() {
        #expect(
            NewItemPlan.make(relativeTo: Self.display("x"), .child, target: nil, groups: Self.projectGroups)
                == .create(TaskCreate(name: "", parentId: "x", position: .start), RowPlace(parentId: "x", after: nil, groupKey: "p")))
        #expect(
            NewItemPlan.make(relativeTo: Self.display("p"), .after, target: nil, groups: Self.projectGroups)
                == .create(TaskCreate(name: "", projectId: "p", position: .start), RowPlace(parentId: "p", after: nil, groupKey: "p")))
    }

    @Test func newOutdentedItemGoesAfterTheParentButNotAfterAProject() {
        #expect(
            NewItemPlan.make(relativeTo: Self.display("x1"), .outdented, target: nil, groups: Self.projectGroups)
                == .create(TaskCreate(name: "", position: .after("x")), RowPlace(parentId: "p", after: "x", groupKey: "p")))
        #expect(
            NewItemPlan.make(relativeTo: Self.display("y"), .outdented, target: nil, groups: Self.projectGroups)
                == .create(TaskCreate(name: "", position: .after("y")), RowPlace(parentId: "p", after: "y", groupKey: "p")))
    }

    @Test func newItemsCarryTheTargetsTagsAndFlag() {
        let plan = NewItemPlan.make(relativeTo: Self.display("x"), .after, target: NewItemTarget(tagIds: ["t"], flagged: true), groups: Self.projectGroups)
        #expect(plan == .create(TaskCreate(name: "", position: .after("x"), flagged: true, tagIds: ["t"]), RowPlace(parentId: "p", after: "x", groupKey: "p")))
    }

    @Test func withNothingSelectedANewItemGoesAtTheEndOfTheTarget() {
        #expect(
            NewItemPlan.make(relativeTo: nil, .after, target: NewItemTarget(projectId: "p"), groups: Self.projectGroups)
                == .create(TaskCreate(name: "", projectId: "p", position: .end), RowPlace(parentId: "p", after: nil, last: true, groupKey: "p")))
        #expect(
            NewItemPlan.make(relativeTo: nil, .after, target: NewItemTarget(), groups: [])
                == .create(
                    TaskCreate(name: "", inbox: true, position: .end),
                    RowPlace(parentId: nil, after: nil, last: true, groupKey: "inbox", ensureGroup: true)))
        #expect(
            NewItemPlan.make(relativeTo: nil, .after, target: NewItemTarget(projectId: "q"), groups: Self.projectGroups)
                == .create(
                    TaskCreate(name: "", projectId: "q", position: .end),
                    RowPlace(parentId: nil, after: nil, last: true, groupKey: "p", ensureGroup: true)))
    }

    @Test func withoutATargetOrOnFoldersAndTagsQuickEntryOpens() {
        #expect(NewItemPlan.make(relativeTo: nil, .after, target: nil, groups: []) == .quickEntry)
        let folder = DisplayRow(row: OutlineRow(kind: .folder, id: "f", depth: 0), groupKey: "g", hasChildren: false)
        #expect(NewItemPlan.make(relativeTo: folder, .after, target: NewItemTarget(), groups: []) == .quickEntry)
    }
}
