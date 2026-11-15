// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// The inspector's pure rules, ported from `src/web/components/inspector/*`: labels, multi-selection merging
/// ("Multiple values"), field mapping to task and project patches, natural-language date entry, alarms, review
/// intervals and repeat-editor edits.
struct InspectorModelTests {
    private let settings: Settings = {
        var s = Settings.defaults(timeZone: "Australia/Brisbane")
        s.dateFormat = .dayMonthYear
        s.use24HourTime = false
        s.defaultDueTime = "17:00"
        return s
    }()

    /// 2026-11-04 09:00 in Brisbane (UTC+10).
    private let now = Date(timeIntervalSince1970: 1_793_746_800)

    // MARK: Labels

    @Test func kindLabelFollowsTheWebOrder() {
        #expect(InspectorModel.kindLabel(TaskDetail(task: TaskItem(id: "p", isProject: true), project: ProjectRecord(id: "p"))) == "Project")
        #expect(InspectorModel.kindLabel(TaskDetail(task: TaskItem(id: "i", inInbox: true))) == "Inbox Item")
        #expect(InspectorModel.kindLabel(TaskDetail(task: TaskItem(id: "g", childCount: 2))) == "Action Group")
        #expect(InspectorModel.kindLabel(TaskDetail(task: TaskItem(id: "a"))) == "Action")
    }

    @Test func groupsAreTasksWithChildrenThatAreNotProjects() {
        #expect(InspectorModel.isGroup(TaskDetail(task: TaskItem(id: "g", childCount: 1))))
        #expect(!InspectorModel.isGroup(TaskDetail(task: TaskItem(id: "p", childCount: 1), project: ProjectRecord(id: "p"))))
        #expect(!InspectorModel.isGroup(TaskDetail(task: TaskItem(id: "a"))))
    }

    @Test func statusPrefersDroppedThenCompleted() {
        #expect(InspectorModel.status(of: TaskItem(id: "a")) == .active)
        #expect(InspectorModel.status(of: TaskItem(id: "a", completed: "2026-01-01T00:00:00.000Z")) == .completed)
        #expect(
            InspectorModel.status(of: TaskItem(id: "a", completed: "2026-01-01T00:00:00.000Z", dropped: "2026-01-02T00:00:00.000Z"))
                == .dropped)
    }

    @Test func flagLabelShowsInheritedFlags() {
        #expect(InspectorModel.flagLabel(TaskItem(id: "a", flagged: true)) == "Flagged")
        #expect(InspectorModel.flagLabel(TaskItem(id: "a", effectiveFlagged: true)) == "Flag inherited (tap to flag)")
        #expect(InspectorModel.flagLabel(TaskItem(id: "a")) == "Unflagged")
    }

    // MARK: Multiple selection

    @Test func sameReportsOneValueOrMultipleValues() {
        let a = TaskItem(id: "a", flagged: true, dueDate: "2026-11-05T17:00:00.000")
        let b = TaskItem(id: "b", flagged: true, dueDate: nil)
        #expect(InspectorModel.same([a, b], \.flagged) == .same(true))
        #expect(InspectorModel.same([a, b], \.dueDate) == .mixed)
        #expect(InspectorModel.same([b, b], \.dueDate) == .same(nil))
        #expect(InspectorModel.same([TaskItem](), \.flagged) == .mixed)
        #expect(MultiValue<Bool>.mixed.label { $0 ? "Flagged" : "Unflagged" } == "Multiple values")
        #expect(MultiValue.same(false).label { $0 ? "Flagged" : "Unflagged" } == "Unflagged")
    }

    @Test func commonStatusIsNilWhenMixed() {
        let active = TaskItem(id: "a")
        let done = TaskItem(id: "b", completed: "2026-01-01T00:00:00.000Z")
        let dropped = TaskItem(id: "c", dropped: "2026-01-01T00:00:00.000Z")
        #expect(InspectorModel.commonStatus([active, active]) == .active)
        #expect(InspectorModel.commonStatus([done, done]) == .completed)
        #expect(InspectorModel.commonStatus([dropped]) == .dropped)
        #expect(InspectorModel.commonStatus([active, done]) == nil)
    }

    @Test func tagPresenceListsEveryTagInFirstSeenOrderAndWhetherAllHaveIt() {
        let a = TaskItem(id: "a", tagIds: ["t1", "t2"])
        let b = TaskItem(id: "b", tagIds: ["t2", "t3"])
        #expect(
            InspectorModel.tagPresence([a, b]) == [
                TagPresence(id: "t1", onAll: false), TagPresence(id: "t2", onAll: true), TagPresence(id: "t3", onAll: false),
            ])
    }

    @Test func dropChoiceIsAskedWhenAnUndroppedSelectedItemRepeats() {
        let repeating = TaskItem(id: "a", repeat: .defaultRepeat)
        let droppedRepeating = TaskItem(id: "b", dropped: "2026-01-01T00:00:00.000Z", repeat: .defaultRepeat)
        #expect(InspectorModel.needsDropChoice([TaskItem(id: "c"), repeating]))
        #expect(!InspectorModel.needsDropChoice([TaskItem(id: "c"), droppedRepeating]))
        #expect(InspectorModel.dropMessage(name: "Water plants") == "“Water plants” repeats. Skip just this occurrence (the next one is scheduled), or drop it completely?")
        #expect(InspectorModel.multipleDropMessage == "Some selected items repeat. Skip just this occurrence of each (the next ones are scheduled), or drop them completely?")
    }

    // MARK: Project field

    @Test func choosingAProjectAssignsInboxItemsAndMovesOthers() {
        let inbox = TaskItem(id: "i", inInbox: true)
        let action = TaskItem(id: "a", projectId: "p0")
        #expect(InspectorModel.projectAssignment(for: inbox, projectId: "p1") == .assign("p1"))
        #expect(InspectorModel.projectAssignment(for: inbox, projectId: nil) == .assign(nil))
        #expect(InspectorModel.projectAssignment(for: action, projectId: "p1") == .move(MoveTarget(projectId: "p1", position: .end)))
        #expect(InspectorModel.projectAssignment(for: action, projectId: nil) == .move(MoveTarget(inbox: true, position: .end)))
    }

    @Test func shownProjectIsTheAssignedOneForInboxItems() {
        #expect(InspectorModel.shownProjectId(TaskItem(id: "i", projectId: nil, inInbox: true, assignedProjectId: "p2")) == "p2")
        #expect(InspectorModel.shownProjectId(TaskItem(id: "a", projectId: "p1")) == "p1")
    }

    @Test func multipleSelectionSplitsInboxItemsFromOthersAndSkipsProjects() {
        let tasks = [TaskItem(id: "i", inInbox: true), TaskItem(id: "a", projectId: "p"), TaskItem(id: "p", isProject: true)]
        let split = InspectorModel.splitForProjectMove(tasks)
        #expect(split.inbox == ["i"])
        #expect(split.others == ["a"])
    }

    // MARK: Field mapping

    @Test func editsMapToTaskPatches() {
        #expect(InspectorEdit.name("New").taskPatch == TaskPatch(name: "New"))
        #expect(InspectorEdit.date(.due, "tomorrow").taskPatch == TaskPatch(dueDate: .some("tomorrow")))
        #expect(InspectorEdit.date(.defer, nil).taskPatch == TaskPatch(deferDate: .some(nil)))
        #expect(InspectorEdit.date(.planned, "x").taskPatch == TaskPatch(plannedDate: .some("x")))
        #expect(InspectorEdit.estimatedMinutes(30).taskPatch == TaskPatch(estimatedMinutes: .some(30)))
        #expect(InspectorEdit.repeatRule(nil).taskPatch == TaskPatch(repeat: .some(nil)))
        #expect(InspectorEdit.sequential(true).taskPatch == TaskPatch(sequential: true))
        #expect(InspectorEdit.projectType(.sequential).taskPatch == nil)
    }

    @Test func editsMapToProjectPatches() {
        #expect(InspectorEdit.flagged(true).projectPatch == ProjectPatch(flagged: true))
        #expect(InspectorEdit.note("n").projectPatch == ProjectPatch(note: "n"))
        #expect(InspectorEdit.date(.due, "fri").projectPatch == ProjectPatch(dueDate: .some("fri")))
        #expect(InspectorEdit.projectType(.singleActions).projectPatch == ProjectPatch(type: .singleActions))
        #expect(InspectorEdit.folder(nil).projectPatch == ProjectPatch(folderId: .some(nil)))
        #expect(InspectorEdit.projectStatus(.onHold).projectPatch == ProjectPatch(status: .onHold))
        #expect(
            InspectorEdit.reviewInterval(ReviewInterval(steps: 2, unit: .month)).projectPatch
                == ProjectPatch(reviewInterval: ReviewInterval(steps: 2, unit: .month)))
        #expect(InspectorEdit.nextReview("2026-12-01").projectPatch == ProjectPatch(nextReview: .some("2026-12-01")))
        #expect(InspectorEdit.completedByChildren(true).projectPatch == ProjectPatch(completedByChildren: true))
        #expect(InspectorEdit.sequential(true).projectPatch == nil)
    }

    @Test func dateValuesReadTheMatchingField() {
        let task = TaskItem(id: "a", deferDate: "d", plannedDate: "p", dueDate: "u", effectiveDeferDate: "ed", effectivePlannedDate: "ep", effectiveDueDate: "eu")
        #expect(InspectorModel.dateValue(task, .defer) == "d")
        #expect(InspectorModel.dateValue(task, .planned) == "p")
        #expect(InspectorModel.dateValue(task, .due) == "u")
        #expect(InspectorModel.effectiveDateValue(task, .due) == "eu")
    }

    // MARK: Date entry

    @Test func dateEntryPreviewsParsedTextAndFlagsUnparseableText() {
        #expect(DateEntry.preview("", display: "", field: .due, settings: settings, now: now) == .none)
        #expect(DateEntry.preview("05/11/2026 5:00 PM", display: "05/11/2026 5:00 PM", field: .due, settings: settings, now: now) == .none)
        #expect(DateEntry.preview("tomorrow", display: "", field: .due, settings: settings, now: now) == .parsed("Thu 05/11/2026 5:00 PM"))
        #expect(DateEntry.preview("blah blah", display: "", field: .due, settings: settings, now: now) == .invalid)
        #expect(DateEntry.invalidMessage == "Unable to parse date")
    }

    @Test func dateEntryCommitsOnlyChangedText() {
        #expect(DateEntry.commit("05/11/2026", display: "05/11/2026") == nil)
        #expect(DateEntry.commit("  ", display: "05/11/2026") == .some(nil))
        #expect(DateEntry.commit(" fri 5pm ", display: "") == .some("fri 5pm"))
        #expect(DateEntry.commit("", display: "") == nil)
    }

    @Test func durationEntryParsesOrReportsAnError() {
        #expect(DurationEntry.commit("1h 30m", display: "") == .valid(90))
        #expect(DurationEntry.commit("", display: "1h") == .valid(nil))
        #expect(DurationEntry.commit("1h", display: "1h") == .unchanged)
        #expect(DurationEntry.commit("soon", display: "") == .invalid)
        #expect(DurationEntry.invalidMessage == "Unable to parse duration")
    }

    @Test func pickerValuesKeepTheDayAndTimeChosen() {
        // A date-time picker returns a floating value at the chosen minute.
        let picked = DateEntry.floating(from: Date(timeIntervalSince1970: 1_793_779_200), settings: settings)  // 2026-11-04 18:00 Brisbane
        #expect(picked == "2026-11-04T18:00:00.000")
        // Date-only (Next review) keeps the stored time, or the field default.
        #expect(DateEntry.dayOnly(dayKey: "2026-12-01", replacing: nil, field: .defer, settings: settings) == "2026-12-01T00:00:00.000")
        #expect(DateEntry.pickerStart(nil, field: .due, settings: settings, now: now) == Date(timeIntervalSince1970: 1_793_775_600))
    }

    // MARK: Notifications

    @Test func alarmsDescribeOffsetsLikeTheWeb() {
        func alarm(_ kind: AlarmKind, _ secs: Int?, fire: String? = nil) -> Alarm {
            Alarm(id: "x", taskId: "t", kind: kind, fireDate: fire, offsetSeconds: secs, effectiveFireDate: nil)
        }
        #expect(InspectorModel.describe(alarm(.dueRelative, 0), settings: settings) == "At due time")
        #expect(InspectorModel.describe(alarm(.deferRelative, -3600), settings: settings) == "1 h before defer")
        #expect(InspectorModel.describe(alarm(.plannedRelative, 172_800), settings: settings) == "2 d after planned")
        #expect(InspectorModel.describe(alarm(.dueRelative, -900), settings: settings) == "15 min before due")
        #expect(InspectorModel.describe(alarm(.dueRelative, nil), settings: settings) == "At due time")
        #expect(
            InspectorModel.describe(alarm(.absolute, nil, fire: "2026-11-05T07:00:00.000Z"), settings: settings) == "Thu 05/11/2026 5:00 PM")
    }

    // MARK: Review

    @Test func intervalsPluraliseTheirUnit() {
        #expect(InspectorModel.formatInterval(ReviewInterval(steps: 1, unit: .week)) == "1 week")
        #expect(InspectorModel.formatInterval(ReviewInterval(steps: 2, unit: .month)) == "2 months")
        #expect(InspectorModel.unitLabel(.day, steps: 1) == "day")
        #expect(InspectorModel.unitLabel(.year, steps: 3) == "years")
    }

    // MARK: Repeat editor edits

    @Test func changingFrequencyClearsDayChoices() {
        var form = RepeatForm(rule: "FREQ=WEEKLY;BYDAY=MO,WE")
        form.setFrequency(.monthly)
        #expect(form.rule == "FREQ=MONTHLY")
        #expect(form.byDay.isEmpty)
    }

    @Test func dayOfMonthModeStartsOnTheFirst() {
        var form = RepeatForm(rule: "FREQ=MONTHLY")
        form.setMonthlyMode(.dayOfMonth)
        #expect(form.rule == "FREQ=MONTHLY;BYMONTHDAY=1")
        var kept = RepeatForm(rule: "FREQ=MONTHLY;BYMONTHDAY=15")
        kept.setMonthlyMode(.dayOfMonth)
        #expect(kept.byMonthDay == [15])
    }

    @Test func endKindsStartFromWebDefaults() {
        var form = RepeatForm(rule: "FREQ=DAILY")
        form.setEndKind(.count, now: now)
        #expect(form.end == .count(5))
        form.setEndKind(.until, now: now)
        // The web editor takes the UTC day 30 days on: 2026-11-03T23:00Z + 30 days.
        #expect(form.end == .until("2026-12-03"))
        form.setEndKind(.never, now: now)
        #expect(form.end == .never)
        #expect(RepeatForm.EndKind(.count(3)) == .count)
    }

    @Test func togglesAddAndRemoveWeekdaysAndMonths() {
        var form = RepeatForm(rule: "FREQ=WEEKLY;BYDAY=MO")
        form.toggle(.friday)
        form.toggle(.monday)
        #expect(form.byDay == [.friday])
        var yearly = RepeatForm(rule: "FREQ=YEARLY")
        yearly.toggleMonth(3)
        yearly.toggleMonth(12)
        yearly.toggleMonth(3)
        #expect(yearly.byMonth == [12])
    }

    @Test func frequencyLabelsPluraliseWithTheInterval() {
        #expect(RepeatFrequency.daily.label(interval: 1) == "day")
        #expect(RepeatFrequency.hourly.label(interval: 2) == "hours")
    }

    @Test func offersTheWebsUnitsPlusAnUnknownRulesOwn() {
        let web: [RepeatFrequency] = [.daily, .weekly, .monthly, .yearly]
        #expect(RepeatFrequency.options(for: .weekly) == web)
        #expect(RepeatFrequency.options(for: .hourly) == web + [.hourly])
        #expect(RepeatForm(rule: "FREQ=MINUTELY;INTERVAL=30").rule == "FREQ=MINUTELY;INTERVAL=30")
    }
}
