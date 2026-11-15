// Author: John Grimes

import Foundation

/// The kind of a custom perspective rule (spec §4.1), as shown by the rule editor. Port of `RuleKind` in
/// `src/web/lib/rules.ts`.
public enum RuleKind: String, CaseIterable, Hashable, Sendable {
    /// `aggregateType` + `aggregateRules`: a nested group.
    case group
    /// `actionAvailability`.
    case availability
    /// `actionStatus` (due / flagged).
    case status
    /// A single boolean property key, see `PerspectiveRules.booleanRules`.
    case boolean
    /// `actionWithinDuration` (minutes).
    case withinDuration
    /// `actionDateField` with a date condition.
    case date
    /// `actionHasTagWithStatus`.
    case tagStatus
    /// `actionHasAnyOfTags`.
    case anyTags
    /// `actionHasAllOfTags`.
    case allTags
    /// `actionHasProjectWithStatus`.
    case projectStatus
    /// `actionWithinFocus` (project and folder ids).
    case focus
    /// `actionMatchingSearch`.
    case search
    /// A rule the editor does not understand; it is kept unchanged.
    case unknown

    /// The kinds a user can add, in menu order (`RULE_KIND_LABELS` in the web app).
    public static let addable: [RuleKind] = [
        .availability, .status, .boolean, .withinDuration, .date, .tagStatus, .anyTags, .allTags, .projectStatus,
        .focus, .search, .group,
    ]

    /// The editor label, e.g. "Tagged with any of"; "Unsupported rule (kept)" for unknown rules.
    public var label: String {
        switch self {
        case .availability: "Availability"
        case .status: "Status (due / flagged)"
        case .boolean: "Item property"
        case .withinDuration: "Duration at most"
        case .date: "Date"
        case .tagStatus: "Has a tag with status"
        case .anyTags: "Tagged with any of"
        case .allTags: "Tagged with all of"
        case .projectStatus: "Project status"
        case .focus: "Within projects / folders"
        case .search: "Matches search"
        case .group: "Group of rules"
        case .unknown: "Unsupported rule (kept)"
        }
    }
}

/// The condition of a date rule. Raw values are the rule keys; `between` uses the pair
/// `actionDateIsAfterDateSpec` / `actionDateIsBeforeDateSpec`.
public enum DateCondition: String, CaseIterable, Hashable, Sendable {
    /// `actionDateIsToday`.
    case isToday = "actionDateIsToday"
    /// `actionDateIsYesterday`.
    case isYesterday = "actionDateIsYesterday"
    /// `actionDateIsTomorrow`.
    case isTomorrow = "actionDateIsTomorrow"
    /// `actionDateIsInThePast` with `relativeBeforeAmount` / `relativeComponent`.
    case isInThePast = "actionDateIsInThePast"
    /// `actionDateIsInTheNext` with `relativeAfterAmount` / `relativeComponent`.
    case isInTheNext = "actionDateIsInTheNext"
    /// `actionDateIsOnDateSpec` with a `dynamic` date text.
    case isOnDateSpec = "actionDateIsOnDateSpec"
    /// After one date spec and before another.
    case between

    /// The editor label, e.g. "is in the next".
    public var label: String {
        switch self {
        case .isToday: "is today"
        case .isYesterday: "is yesterday"
        case .isTomorrow: "is tomorrow"
        case .isInThePast: "is in the past"
        case .isInTheNext: "is in the next"
        case .isOnDateSpec: "is on"
        case .between: "is between"
        }
    }
}

/// A value offered by a rule editor picker, with its label.
public struct RuleOption<Value: Hashable & Sendable>: Hashable, Sendable {
    /// The value stored in the rule.
    public let value: Value
    /// The label shown to the user.
    public let label: String

    /// Creates an option.
    public init(_ value: Value, _ label: String) {
        self.value = value
        self.label = label
    }
}

/// Editing operations on custom perspective rules (spec §4.1). Port of `src/web/lib/rules.ts` and the pure parts of
/// `src/web/pages/PerspectiveEditor.tsx`.
///
/// A rule is a `JSONValue` object keyed by rule type, and a rule list is `[JSONValue]`; nested groups hold their
/// children in `aggregateRules`, and a disabled rule is wrapped as `{"disabledRule": rule}`. Every operation returns
/// new values and touches only what it edits, so imported rules with unknown keys round-trip unchanged. Paths are
/// index lists through nested `aggregateRules`, e.g. `[1, 0]` is the first child of the second top-level rule.
public enum PerspectiveRules {
    /// Single-key boolean properties (`BOOLEAN_RULES`), in menu order.
    public static let booleanRules: [RuleOption<String>] = [
        RuleOption("actionHasDueDate", "Has a due date"),
        RuleOption("actionHasDeferDate", "Has a defer date"),
        RuleOption("actionHasPlannedDate", "Has a planned date"),
        RuleOption("actionHasDuration", "Has a duration"),
        RuleOption("actionIsProject", "Is a project"),
        RuleOption("actionIsGroup", "Is an action group"),
        RuleOption("actionIsProjectOrGroup", "Is a project or action group"),
        RuleOption("actionRepeats", "Repeats"),
        RuleOption("actionIsLeaf", "Has no children"),
        RuleOption("actionIsUntagged", "Is untagged"),
        RuleOption("actionHasNoProject", "Has no project"),
        RuleOption("actionIsInSingleActionsList", "Is in a single actions list"),
    ]

    /// `actionAvailability` values.
    public static let availabilityOptions: [RuleOption<String>] = [
        RuleOption("firstAvailable", "First available"),
        RuleOption("available", "Available"),
        RuleOption("remaining", "Remaining"),
        RuleOption("completed", "Completed"),
        RuleOption("dropped", "Dropped"),
    ]

    /// `actionStatus` values.
    public static let statusOptions: [RuleOption<String>] = [
        RuleOption("due", "Due or due soon"),
        RuleOption("flagged", "Flagged"),
    ]

    /// `actionHasTagWithStatus` values.
    public static let tagStatusOptions: [RuleOption<String>] = [
        RuleOption("active", "Active"),
        RuleOption("remaining", "Remaining"),
        RuleOption("onHold", "On hold"),
        RuleOption("dropped", "Dropped"),
        RuleOption("stalled", "Stalled"),
    ]

    /// `actionHasProjectWithStatus` values.
    public static let projectStatusOptions: [RuleOption<String>] = [
        RuleOption("active", "Active"),
        RuleOption("remaining", "Remaining"),
        RuleOption("onHold", "On hold"),
        RuleOption("completed", "Completed"),
        RuleOption("dropped", "Dropped"),
        RuleOption("stalled", "Stalled"),
        RuleOption("pending", "Pending"),
    ]

    /// `actionWithinDuration` values in minutes.
    public static let durationOptions: [RuleOption<Int>] = [5, 15, 30, 60, 120, 240].map { minutes in
        RuleOption(
            minutes, minutes < 60 ? "\(minutes) minutes" : "\(minutes / 60) hour\(minutes > 60 ? "s" : "")")
    }

    /// `actionDateField` values.
    public static let dateFields = ["due", "defer", "planned", "completed", "dropped", "added", "changed"]

    /// `relativeComponent` values for "in the past" / "in the next", labelled in the plural ("days").
    public static let relativeComponents: [RuleOption<String>] = ["hour", "day", "week", "month", "year"].map {
        RuleOption($0, "\($0)s")
    }

    /// The label for a date field, e.g. "Due date".
    public static func dateFieldLabel(_ field: String) -> String {
        "\(field.prefix(1).uppercased())\(field.dropFirst()) date"
    }

    // MARK: Enabling

    /// Whether the rule is wrapped as `{"disabledRule": …}` (with a non-null object or array inside).
    public static func isDisabled(_ rule: JSONValue) -> Bool {
        switch rule["disabledRule"] {
        case .object, .array: true
        default: false
        }
    }

    /// The rule itself, unwrapping a disabled wrapper.
    public static func inner(_ rule: JSONValue) -> JSONValue {
        isDisabled(rule) ? rule["disabledRule"] ?? rule : rule
    }

    /// Enables (unwraps) or disables (wraps) a rule; already-disabled rules are not wrapped twice.
    public static func setEnabled(_ rule: JSONValue, _ enabled: Bool) -> JSONValue {
        if enabled { return inner(rule) }
        return isDisabled(rule) ? rule : .object(["disabledRule": rule])
    }

    /// Replaces the inner rule, keeping the disabled wrapper if present.
    public static func replaceInner(_ rule: JSONValue, with next: JSONValue) -> JSONValue {
        isDisabled(rule) ? .object(["disabledRule": next]) : next
    }

    // MARK: Kinds

    /// Classifies a rule (looking through a disabled wrapper) by its keys.
    public static func kind(of rule: JSONValue) -> RuleKind {
        let members = objectMembers(inner(rule))
        let keyed: [(String, RuleKind)] = [
            ("aggregateType", .group), ("actionAvailability", .availability), ("actionStatus", .status),
            ("actionWithinDuration", .withinDuration), ("actionDateField", .date),
            ("actionHasTagWithStatus", .tagStatus), ("actionHasAnyOfTags", .anyTags),
            ("actionHasAllOfTags", .allTags), ("actionHasProjectWithStatus", .projectStatus),
            ("actionWithinFocus", .focus), ("actionMatchingSearch", .search),
        ]
        for (key, kind) in keyed where members[key] != nil { return kind }
        if members.count == 1, let key = members.keys.first, booleanRules.contains(where: { $0.value == key }) {
            return .boolean
        }
        return .unknown
    }

    /// The rule a new rule of `kind` starts as; nil for `.unknown`.
    public static func defaultRule(_ kind: RuleKind) -> JSONValue? {
        switch kind {
        case .group: .object(["aggregateType": .string("any"), "aggregateRules": .array([])])
        case .availability: .object(["actionAvailability": .string("available")])
        case .status: .object(["actionStatus": .string("flagged")])
        case .boolean: .object(["actionHasDueDate": .bool(true)])
        case .withinDuration: .object(["actionWithinDuration": .number(30)])
        case .date: .object(["actionDateField": .string("due"), "actionDateIsToday": .bool(true)])
        case .tagStatus: .object(["actionHasTagWithStatus": .string("active")])
        case .anyTags: .object(["actionHasAnyOfTags": .array([])])
        case .allTags: .object(["actionHasAllOfTags": .array([])])
        case .projectStatus: .object(["actionHasProjectWithStatus": .string("active")])
        case .focus: .object(["actionWithinFocus": .array([])])
        case .search: .object(["actionMatchingSearch": .array([])])
        case .unknown: nil
        }
    }

    // MARK: Date rules

    /// The condition of a date rule; `.isToday` when none is recognised.
    public static func dateCondition(of rule: JSONValue) -> DateCondition {
        let members = objectMembers(inner(rule))
        if members["actionDateIsAfterDateSpec"] != nil || members["actionDateIsBeforeDateSpec"] != nil { return .between }
        return DateCondition.allCases.first { members[$0.rawValue] != nil } ?? .isToday
    }

    /// Builds a date rule for `field` + `condition`, carrying over compatible parameters from `previous` (the
    /// unwrapped rule being edited): the relative amount and unit, and date spec texts.
    public static func buildDateRule(field: String, condition: DateCondition, previous: JSONValue) -> JSONValue {
        let past = previous["actionDateIsInThePast"]
        let next = previous["actionDateIsInTheNext"]
        let amount = present(past?["relativeBeforeAmount"]) ?? present(next?["relativeAfterAmount"]) ?? .number(1)
        let component = present(past?["relativeComponent"]) ?? present(next?["relativeComponent"]) ?? .string("week")
        func spec(_ key: String, _ fallback: String) -> JSONValue {
            .object(["dynamic": present(previous[key]?["dynamic"]) ?? .string(fallback)])
        }
        var members: [String: JSONValue] = ["actionDateField": .string(field)]
        switch condition {
        case .isInThePast:
            members[condition.rawValue] = .object(["relativeBeforeAmount": amount, "relativeComponent": component])
        case .isInTheNext:
            members[condition.rawValue] = .object(["relativeAfterAmount": amount, "relativeComponent": component])
        case .isOnDateSpec:
            members[condition.rawValue] = spec("actionDateIsOnDateSpec", "today")
        case .between:
            members["actionDateIsAfterDateSpec"] = spec("actionDateIsAfterDateSpec", "today")
            members["actionDateIsBeforeDateSpec"] = spec("actionDateIsBeforeDateSpec", "next week")
        case .isToday, .isYesterday, .isTomorrow:
            members[condition.rawValue] = .bool(true)
        }
        return .object(members)
    }

    /// The relative amount of an "in the past" / "in the next" rule; 1 when absent.
    public static func relativeAmount(of rule: JSONValue) -> Int {
        let relative = relativeParameters(of: rule)
        let value = present(relative?["relativeBeforeAmount"]) ?? present(relative?["relativeAfterAmount"])
        if case .number(let number) = value, number.isFinite { return Int(number) }
        return 1
    }

    /// The relative unit of an "in the past" / "in the next" rule, e.g. "day"; "week" when absent.
    public static func relativeComponent(of rule: JSONValue) -> String {
        if case .string(let component) = present(relativeParameters(of: rule)?["relativeComponent"]) { return component }
        return "week"
    }

    /// Rewrites the relative amount and unit of an unwrapped date rule for its current condition (past when the
    /// condition is "in the past", otherwise next), keeping only the date field.
    public static func setRelative(_ rule: JSONValue, amount: Int, component: String) -> JSONValue {
        let condition = dateCondition(of: rule)
        let field = present(rule["actionDateField"]) ?? .string("due")
        let parameters: JSONValue =
            condition == .isInThePast
            ? .object(["relativeBeforeAmount": .number(Double(amount)), "relativeComponent": .string(component)])
            : .object(["relativeAfterAmount": .number(Double(amount)), "relativeComponent": .string(component)])
        return .object(["actionDateField": field, condition.rawValue: parameters])
    }

    /// The `dynamic` text of a date spec member such as `actionDateIsOnDateSpec`; empty when absent.
    public static func dateSpecText(of rule: JSONValue, key: String) -> String {
        if case .string(let text) = inner(rule)[key]?["dynamic"] { return text }
        return ""
    }

    /// Search terms typed as comma-separated text, trimmed, with blanks dropped.
    public static func searchTerms(_ text: String) -> [String] {
        text.split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    // MARK: Tree edits

    /// The children of a group rule (looking through a disabled wrapper); empty for other rules.
    public static func children(of rule: JSONValue) -> [JSONValue] {
        if case .array(let children) = inner(rule)["aggregateRules"] { return children }
        return []
    }

    /// Appends `child` to a group rule, keeping its disabled wrapper.
    public static func appendChild(_ child: JSONValue, to group: JSONValue) -> JSONValue {
        var members = objectMembers(inner(group))
        members["aggregateRules"] = .array(children(of: group) + [child])
        return replaceInner(group, with: .object(members))
    }

    /// Replaces the rule at `path` with `transform(rule)`, or removes it when the transform returns nil. Paths that
    /// are empty or out of range leave the rules unchanged.
    public static func update(
        _ rules: [JSONValue], at path: [Int], _ transform: (JSONValue) -> JSONValue?
    ) -> [JSONValue] {
        guard let head = path.first else { return rules }
        let rest = Array(path.dropFirst())
        var out: [JSONValue] = []
        for (index, rule) in rules.enumerated() {
            guard index == head else {
                out.append(rule)
                continue
            }
            if rest.isEmpty {
                if let next = transform(rule) { out.append(next) }
                continue
            }
            var members = objectMembers(inner(rule))
            members["aggregateRules"] = .array(update(children(of: rule), at: rest, transform))
            out.append(replaceInner(rule, with: .object(members)))
        }
        return out
    }

    /// Moves the rule at `path` one place up (`delta` -1) or down (+1) within its list; moves past either end are
    /// ignored.
    public static func move(_ rules: [JSONValue], at path: [Int], by delta: Int) -> [JSONValue] {
        let index = path.last ?? 0
        func reorder(_ list: [JSONValue]) -> [JSONValue] {
            let target = index + delta
            guard list.indices.contains(target), list.indices.contains(index) else { return list }
            var copy = list
            copy.insert(copy.remove(at: index), at: target)
            return copy
        }
        let parentPath = Array(path.dropLast())
        if parentPath.isEmpty { return reorder(rules) }
        return update(rules, at: parentPath) { group in
            var members = objectMembers(inner(group))
            members["aggregateRules"] = .array(reorder(children(of: group)))
            return replaceInner(group, with: .object(members))
        }
    }

    // MARK: Helpers

    /// Object members, or none for other values.
    private static func objectMembers(_ value: JSONValue) -> [String: JSONValue] {
        if case .object(let members) = value { return members }
        return [:]
    }

    /// The value unless it is absent or JSON null (JavaScript's `??`).
    private static func present(_ value: JSONValue?) -> JSONValue? {
        if case .null = value { return nil }
        return value
    }

    /// The parameters of an "in the past" or "in the next" condition.
    private static func relativeParameters(of rule: JSONValue) -> JSONValue? {
        let unwrapped = inner(rule)
        return present(unwrapped["actionDateIsInThePast"]) ?? present(unwrapped["actionDateIsInTheNext"])
    }
}
