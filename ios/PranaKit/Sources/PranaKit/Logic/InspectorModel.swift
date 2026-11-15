// Author: John Grimes

import Foundation

/// A field across a multiple selection: one shared value, or mixed values ("Multiple values").
public enum MultiValue<Value: Equatable>: Equatable {
    /// Every selected item has this value.
    case same(Value)
    /// The selected items differ.
    case mixed

    /// The shared value, or nil when mixed.
    public var value: Value? {
        if case .same(let v) = self { return v }
        return nil
    }

    /// Whether the selected items differ.
    public var isMixed: Bool { self == .mixed }

    /// The shared value's label, or "Multiple values" when mixed.
    public func label(_ describe: (Value) -> String) -> String {
        switch self {
        case .same(let v): describe(v)
        case .mixed: InspectorModel.multipleValues
        }
    }
}

extension MultiValue: Sendable where Value: Sendable {}

/// A tag on at least one selected item, and whether every selected item has it.
public struct TagPresence: Hashable, Sendable, Identifiable {
    /// The tag id.
    public var id: String
    /// Whether every selected item has the tag.
    public var onAll: Bool

    /// Creates a presence.
    public init(id: String, onAll: Bool) {
        self.id = id
        self.onAll = onAll
    }
}

/// How choosing a project in the Project field changes a task: inbox items get an assigned project (they stay in
/// the Inbox until Clean Up); other tasks move to the end of the project, or back to the Inbox.
public enum ProjectAssignment: Hashable, Sendable {
    /// Set `assignedProjectId`.
    case assign(String?)
    /// Move the task.
    case move(MoveTarget)
}

/// One inspector field edit, mapped to the task or project PATCH body that carries it.
public enum InspectorEdit: Hashable, Sendable {
    case name(String)
    case note(String)
    case flagged(Bool)
    /// A date field: natural-language or ISO text (the server parses it; the preview resolves it), or nil to clear.
    case date(DateField, String?)
    case estimatedMinutes(Int?)
    case repeatRule(RepeatRule?)
    /// Action group type.
    case sequential(Bool)
    case completedByChildren(Bool)
    case projectType(ProjectType)
    case projectStatus(ProjectStatus)
    case folder(String?)
    case reviewInterval(ReviewInterval)
    case nextReview(String?)

    /// The task PATCH body, or nil for project-only fields.
    public var taskPatch: TaskPatch? {
        var p = TaskPatch()
        switch self {
        case .name(let v): p.name = v
        case .note(let v): p.note = v
        case .flagged(let v): p.flagged = v
        case .date(.defer, let v): p.deferDate = .some(v)
        case .date(.planned, let v): p.plannedDate = .some(v)
        case .date(.due, let v): p.dueDate = .some(v)
        case .estimatedMinutes(let v): p.estimatedMinutes = .some(v)
        case .repeatRule(let v): p.repeat = .some(v)
        case .sequential(let v): p.sequential = v
        case .completedByChildren(let v): p.completedByChildren = v
        case .projectType, .projectStatus, .folder, .reviewInterval, .nextReview: return nil
        }
        return p
    }

    /// The project PATCH body, or nil for fields projects do not have (group type).
    public var projectPatch: ProjectPatch? {
        var p = ProjectPatch()
        switch self {
        case .name(let v): p.name = v
        case .note(let v): p.note = v
        case .flagged(let v): p.flagged = v
        case .date(.defer, let v): p.deferDate = .some(v)
        case .date(.planned, let v): p.plannedDate = .some(v)
        case .date(.due, let v): p.dueDate = .some(v)
        case .estimatedMinutes(let v): p.estimatedMinutes = .some(v)
        case .repeatRule(let v): p.repeat = .some(v)
        case .completedByChildren(let v): p.completedByChildren = v
        case .projectType(let v): p.type = v
        case .projectStatus(let v): p.status = v
        case .folder(let v): p.folderId = .some(v)
        case .reviewInterval(let v): p.reviewInterval = v
        case .nextReview(let v): p.nextReview = .some(v)
        case .sequential: return nil
        }
        return p
    }
}

/// Pure rules of the inspector (`src/web/components/inspector/Inspector.tsx`).
public enum InspectorModel {
    /// The placeholder for a field whose selected items differ.
    public static let multipleValues = "Multiple values"

    /// The heading above the title: Project, Inbox Item, Action Group or Action.
    public static func kindLabel(_ detail: TaskDetail) -> String {
        if detail.project != nil { return "Project" }
        if detail.inInbox { return "Inbox Item" }
        if detail.childCount > 0 { return "Action Group" }
        return "Action"
    }

    /// Whether the item is an action group (a task with children that is not a project).
    public static func isGroup(_ detail: TaskDetail) -> Bool {
        detail.project == nil && detail.childCount > 0
    }

    /// The task's own status: dropped, then completed, else active.
    public static func status(of task: TaskItem) -> ActivityStatus {
        if task.dropped != nil { return .dropped }
        if task.completed != nil { return .completed }
        return .active
    }

    /// The status shared by every selected task, or nil when they differ.
    public static func commonStatus(_ tasks: [TaskItem]) -> ActivityStatus? {
        if tasks.allSatisfy({ $0.completed != nil }) { return .completed }
        if tasks.allSatisfy({ $0.dropped != nil }) { return .dropped }
        if tasks.allSatisfy({ $0.completed == nil && $0.dropped == nil }) { return .active }
        return nil
    }

    /// The flag button's label.
    public static func flagLabel(_ task: TaskItem) -> String {
        task.flagged ? "Flagged" : task.effectiveFlagged ? "Flag inherited (tap to flag)" : "Unflagged"
    }

    /// One field across the selection: `.same` when every item has the first item's value, else `.mixed`.
    public static func same<Item, Value: Equatable>(_ items: [Item], _ key: KeyPath<Item, Value>) -> MultiValue<Value> {
        guard let first = items.first?[keyPath: key] else { return .mixed }
        return items.allSatisfy({ $0[keyPath: key] == first }) ? .same(first) : .mixed
    }

    /// Every tag on any selected task, in first-seen order, with whether all of them have it.
    public static func tagPresence(_ tasks: [TaskItem]) -> [TagPresence] {
        var seen: [String] = []
        for id in tasks.flatMap(\.tagIds) where !seen.contains(id) { seen.append(id) }
        return seen.map { id in TagPresence(id: id, onAll: tasks.allSatisfy { $0.tagIds.contains(id) }) }
    }

    /// Whether dropping the selection must first ask "Skip this occurrence" or "Drop completely": some selected item
    /// repeats and is not dropped yet.
    public static func needsDropChoice(_ tasks: [TaskItem]) -> Bool {
        tasks.contains { $0.dropped == nil && $0.repeat != nil }
    }

    /// The question asked before dropping one repeating item.
    public static func dropMessage(name: String) -> String {
        "“\(name)” repeats. Skip just this occurrence (the next one is scheduled), or drop it completely?"
    }

    /// The question asked before dropping several items when some repeat.
    public static let multipleDropMessage =
        "Some selected items repeat. Skip just this occurrence of each (the next ones are scheduled), or drop them completely?"

    /// The project shown in the Project field: an inbox item's assigned project, otherwise the containing one.
    public static func shownProjectId(_ task: TaskItem) -> String? {
        task.inInbox ? task.assignedProjectId : task.projectId
    }

    /// What choosing `projectId` (nil to clear) in the Project field does to `task`.
    public static func projectAssignment(for task: TaskItem, projectId: String?) -> ProjectAssignment {
        if task.inInbox { return .assign(projectId) }
        if let projectId { return .move(MoveTarget(projectId: projectId, position: .end)) }
        return .move(MoveTarget(inbox: true, position: .end))
    }

    /// A multiple selection's tasks split for a project move: inbox items are assigned, others moved; projects stay.
    public static func splitForProjectMove(_ tasks: [TaskItem]) -> (inbox: [String], others: [String]) {
        let movable = tasks.filter { !$0.isProject }
        return (movable.filter(\.inInbox).map(\.id), movable.filter { !$0.inInbox }.map(\.id))
    }

    /// The stored value of a date field.
    public static func dateValue(_ task: TaskItem, _ field: DateField) -> String? {
        switch field {
        case .defer: task.deferDate
        case .planned: task.plannedDate
        case .due: task.dueDate
        }
    }

    /// The effective (possibly inherited) value of a date field.
    public static func effectiveDateValue(_ task: TaskItem, _ field: DateField) -> String? {
        switch field {
        case .defer: task.effectiveDeferDate
        case .planned: task.effectivePlannedDate
        case .due: task.effectiveDueDate
        }
    }

    /// A notification's description: the fire date of an absolute one, else `At due time` or
    /// `15 min before due` / `1 h after defer` / `2 d before planned`.
    public static func describe(_ alarm: Alarm, settings: Settings) -> String {
        if alarm.kind == .absolute { return DateDisplay.formatDateTime(alarm.fireDate, settings: settings) }
        let secs = alarm.offsetSeconds ?? 0
        let anchor = alarm.kind == .dueRelative ? "due" : alarm.kind == .deferRelative ? "defer" : "planned"
        if secs == 0 { return "At \(anchor) time" }
        let abs = Swift.abs(secs)
        let amount =
            abs % 86400 == 0 ? "\(abs / 86400) d" : abs % 3600 == 0 ? "\(abs / 3600) h" : "\(Int((Double(abs) / 60).rounded())) min"
        return "\(amount) \(secs < 0 ? "before" : "after") \(anchor)"
    }

    /// "1 week", "2 months".
    public static func formatInterval(_ interval: ReviewInterval) -> String {
        "\(interval.steps) \(unitLabel(interval.unit, steps: interval.steps))"
    }

    /// A review interval unit, plural unless `steps` is 1.
    public static func unitLabel(_ unit: IntervalUnit, steps: Int) -> String {
        steps == 1 ? unit.rawValue : "\(unit.rawValue)s"
    }

    /// The review interval units offered.
    public static let intervalUnits: [IntervalUnit] = [.day, .week, .month, .year]
}

/// The natural-language date field (`DateField` in `Fields.tsx`): live preview while typing, commit on submit, and
/// conversions for the native date picker.
public enum DateEntry {
    /// The hint under a date field being edited.
    public enum Preview: Hashable, Sendable {
        /// Nothing to show (blank or unchanged text).
        case none
        /// The parsed date, formatted for reading.
        case parsed(String)
        /// The text does not parse.
        case invalid
    }

    /// The error shown for text that does not parse.
    public static let invalidMessage = "Unable to parse date"

    /// The hint for `text` typed over the field's displayed `display` text.
    public static func preview(_ text: String, display: String, field: DateField, settings: Settings, now: Date) -> Preview {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text != display else { return .none }
        guard let value = NaturalLanguage.previewDate(text, field: field, settings: settings, now: now) else { return .invalid }
        return .parsed(DateDisplay.formatDateTime(value, settings: settings))
    }

    /// What committing `text` sends: nil when unchanged, `.some(nil)` to clear, otherwise the trimmed text.
    public static func commit(_ text: String, display: String) -> String?? {
        if text == display { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return .some(trimmed.isEmpty ? nil : trimmed)
    }

    /// The floating value of an instant chosen in the date-time picker (shown in the settings time zone).
    public static func floating(from date: Date, settings: Settings) -> String {
        DateDisplay.wallToFloating(DateDisplay.instantToWall(date, timeZone: settings.timeZone))
    }

    /// A date-only pick (Next review): that day, keeping the stored time or the field's default time.
    public static func dayOnly(dayKey: String, replacing value: String?, field: DateField, settings: Settings) -> String {
        DateDisplay.withDay(value, dayKey: dayKey, field: field, settings: settings)
    }

    /// Where the picker opens: the stored value, or today at the field's default time when empty.
    public static func pickerStart(_ value: String?, field: DateField, settings: Settings, now: Date) -> Date {
        if let value, let date = DateTime.dateValueToInstant(value, timeZone: settings.timeZone) { return date }
        var today = DateDisplay.instantToWall(now, timeZone: settings.timeZone)
        let time = DateDisplay.defaultTime(for: field, settings: settings)
        today.hour = time.hour
        today.minute = time.minute
        return DateTime.dateValueToInstant(DateDisplay.wallToFloating(today), timeZone: settings.timeZone) ?? now
    }

    /// The `YYYY-MM-DD` day of an instant in the settings time zone.
    public static func dayKey(of date: Date, settings: Settings) -> String {
        DateDisplay.todayKey(timeZone: settings.timeZone, now: date)
    }
}

/// The Duration field (`DurationField` in `Fields.tsx`).
public enum DurationEntry {
    /// What committing the typed text does.
    public enum Outcome: Hashable, Sendable {
        /// The text did not change.
        case unchanged
        /// Set (or clear, nil) the estimate in minutes.
        case valid(Int?)
        /// The text does not parse; nothing is sent.
        case invalid
    }

    /// The error shown for text that does not parse.
    public static let invalidMessage = "Unable to parse duration"

    /// The outcome of committing `text` over the displayed `display`.
    public static func commit(_ text: String, display: String) -> Outcome {
        if text == display { return .unchanged }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .valid(nil) }
        return NaturalLanguage.parseDuration(text).map { .valid($0) } ?? .invalid
    }

    /// The displayed text of an estimate.
    public static func display(_ minutes: Int?) -> String {
        minutes.map(NaturalLanguage.formatDuration) ?? ""
    }
}

// MARK: - Repeat editor edits

extension RepeatFrequency {
    /// The unit as offered in the editor: singular when the interval is 1, e.g. "day" / "days".
    public func label(interval: Int) -> String {
        interval == 1 ? unitNames.one : unitNames.many
    }
}

extension RepeatForm {
    /// The kind of end the editor's segmented control shows.
    public enum EndKind: String, Hashable, Sendable, CaseIterable {
        case never, count, until

        /// The kind of an end value.
        public init(_ end: End) {
            switch end {
            case .never: self = .never
            case .count: self = .count
            case .until: self = .until
            }
        }
    }

    /// Changes the unit, clearing weekday, day-of-month and month choices (as the web editor does).
    public mutating func setFrequency(_ freq: RepeatFrequency) {
        self.freq = freq
        byDay = []
        monthlyMode = .none
        byMonthDay = []
        byMonth = []
    }

    /// Changes the monthly mode; day of month starts on the 1st when no day is chosen yet.
    public mutating func setMonthlyMode(_ mode: MonthlyMode) {
        monthlyMode = mode
        if mode == .dayOfMonth && byMonthDay.isEmpty { byMonthDay = [1] }
    }

    /// Changes the kind of end: after 5 times, or on the (UTC) day 30 days from `now`, like the web editor.
    public mutating func setEndKind(_ kind: EndKind, now: Date) {
        switch kind {
        case .never: end = .never
        case .count: end = .count(5)
        case .until:
            let later = DateTime.milliseconds(now) + 30 * DateTime.millisecondsPerDay
            end = .until(DateTime.dayKeyOfNaive(later))
        }
    }

    /// Adds or removes a weekday (weekly rules).
    public mutating func toggle(_ day: RepeatWeekday) {
        if byDay.contains(day) { byDay.removeAll { $0 == day } } else { byDay.append(day) }
    }

    /// Adds or removes a month, 1...12 (yearly rules).
    public mutating func toggleMonth(_ month: Int) {
        if byMonth.contains(month) { byMonth.removeAll { $0 == month } } else { byMonth.append(month) }
    }
}
