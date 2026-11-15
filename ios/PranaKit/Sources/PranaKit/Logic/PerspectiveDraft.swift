// Author: John Grimes

import Foundation

/// The editable fields of a custom perspective while the editor has it open (`Draft` in
/// `src/web/pages/PerspectiveEditor.tsx`). Nothing is stored until the user saves; saving sends the whole draft.
public struct PerspectiveDraft: Sendable, Hashable {
    public var name: String
    /// Web icon name from `PerspectiveStyle.icons`.
    public var icon: String
    /// `#rrggbb`, or nil for the accent colour.
    public var color: String?
    public var favorite: Bool
    public var aggregation: Aggregation
    /// Top-level rules (spec §4.1), kept as JSON so unknown rules round-trip.
    public var rules: [JSONValue]
    public var presentation: Perspective.Presentation

    /// Creates a draft from explicit values.
    public init(
        name: String, icon: String, color: String?, favorite: Bool, aggregation: Aggregation, rules: [JSONValue],
        presentation: Perspective.Presentation
    ) {
        self.name = name
        self.icon = icon
        self.color = color
        self.favorite = favorite
        self.aggregation = aggregation
        self.rules = rules
        self.presentation = presentation
    }

    /// A draft of an existing perspective (`toDraft`).
    public init(_ perspective: Perspective) {
        self.init(
            name: perspective.name, icon: perspective.icon, color: perspective.color, favorite: perspective.favorite,
            aggregation: perspective.aggregation, rules: perspective.rules, presentation: perspective.presentation)
    }

    /// The draft shown for a new perspective (`NEW_PERSPECTIVE`).
    public static let newPerspective = PerspectiveDraft(
        name: "New Perspective", icon: "layers", color: "#4f6fd1", favorite: true, aggregation: .all,
        rules: [.object(["actionAvailability": .string("available")])],
        presentation: Perspective.Presentation(layout: .projects, grouping: .none, sorting: .manual, sidebar: .projects))

    /// Whether the draft can be saved: the name is required.
    public var canSave: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The presentation as a full patch.
    private var presentationPatch: PresentationPatch {
        PresentationPatch(
            layout: presentation.layout, grouping: presentation.grouping, sorting: presentation.sorting,
            sidebar: presentation.sidebar)
    }

    /// The body that creates this draft as a new perspective with the given client id.
    public func createInput(id: String) -> PerspectiveCreate {
        PerspectiveCreate(
            id: id, name: name, icon: icon, color: .some(color), favorite: favorite, aggregation: aggregation,
            rules: rules, presentation: presentationPatch)
    }

    /// The patch that saves this draft over an existing perspective (every field but the rank).
    public var patch: PerspectivePatch {
        PerspectivePatch(
            name: name, icon: icon, color: .some(color), favorite: favorite, aggregation: aggregation, rules: rules,
            presentation: presentationPatch)
    }

    /// The body that creates a copy of this draft named "<name> copy".
    public func duplicateInput(id: String) -> PerspectiveCreate {
        var copy = self
        copy.name = "\(name) copy"
        return copy.createInput(id: id)
    }

    // MARK: Ordering

    /// A new rank for one perspective.
    public struct RankChange: Sendable, Hashable {
        public let id: String
        public let rank: Int

        /// Creates a change.
        public init(id: String, rank: Int) {
            self.id = id
            self.rank = rank
        }
    }

    /// Moves a perspective one place up (-1) or down (+1) in rank order by swapping ranks with its neighbour, as
    /// the web editor's arrows do. Empty when there is no neighbour that way.
    public static func reorder(_ perspectives: [Perspective], id: String, by delta: Int) -> [RankChange] {
        let sorted = PerspectiveStyle.sorted(perspectives)
        guard let index = sorted.firstIndex(where: { $0.id == id }), sorted.indices.contains(index + delta) else {
            return []
        }
        let me = sorted[index]
        let other = sorted[index + delta]
        return [RankChange(id: me.id, rank: other.rank), RankChange(id: other.id, rank: me.rank)]
    }

    /// Ranks after a list drag (`List.onMove` offsets over the rank-sorted list): the existing rank values, in
    /// order, are handed out to the new order. Only perspectives whose rank changes are returned.
    public static func move(_ perspectives: [Perspective], from source: IndexSet, to destination: Int) -> [RankChange] {
        let sorted = PerspectiveStyle.sorted(perspectives)
        var reordered = sorted
        let moving = source.sorted().map { reordered[$0] }
        for index in source.sorted(by: >) { reordered.remove(at: index) }
        let insertAt = destination - source.filter { $0 < destination }.count
        reordered.insert(contentsOf: moving, at: insertAt)
        let ranks = sorted.map(\.rank)
        return zip(reordered, ranks).compactMap { perspective, rank in
            perspective.rank == rank ? nil : RankChange(id: perspective.id, rank: rank)
        }
    }

    // MARK: Options

    /// Layout choices.
    public static let layoutOptions: [RuleOption<Perspective.Presentation.Layout>] = [
        RuleOption(.projects, "Projects hierarchy"), RuleOption(.flat, "Individual actions"),
    ]

    /// Sidebar choices.
    public static let sidebarOptions: [RuleOption<Perspective.Presentation.SidebarKind>] = [
        RuleOption(.projects, "Projects"), RuleOption(.tags, "Tags"), RuleOption(.none, "None"),
    ]

    /// Group-by choices.
    public static let groupingOptions: [RuleOption<Grouping>] = [
        RuleOption(.none, "None"), RuleOption(.tag, "Tag"), RuleOption(.tagsCombined, "Tags (combined)"),
        RuleOption(.project, "Project"), RuleOption(.folder, "Folder"), RuleOption(.due, "Due date"),
        RuleOption(.defer, "Defer date"), RuleOption(.planned, "Planned date"), RuleOption(.completed, "Completed date"),
        RuleOption(.dropped, "Dropped date"), RuleOption(.added, "Added date"), RuleOption(.changed, "Changed date"),
        RuleOption(.flagged, "Flagged"),
    ]

    /// Sort-by choices.
    public static let sortingOptions: [RuleOption<Sorting>] = [
        RuleOption(.manual, "Manual"), RuleOption(.due, "Due"), RuleOption(.defer, "Defer"),
        RuleOption(.planned, "Planned"), RuleOption(.completed, "Completed"), RuleOption(.added, "Added"),
        RuleOption(.changed, "Changed"), RuleOption(.flagged, "Flagged"), RuleOption(.duration, "Duration"),
        RuleOption(.name, "Name"),
    ]

    /// Top-level aggregation choices ("Actions matching all of these rules").
    public static let aggregationOptions: [RuleOption<Aggregation>] = [
        RuleOption(.all, "all"), RuleOption(.any, "any"), RuleOption(.none, "none"),
    ]

    /// A nested group's aggregation choices.
    public static let groupAggregationOptions: [RuleOption<Aggregation>] = [
        RuleOption(.all, "All of"), RuleOption(.any, "Any of"), RuleOption(.none, "None of"),
    ]
}

/// One entry of a rule's tag or project/folder picker: a tree flattened depth first.
public struct RulePickerChoice: Sendable, Hashable, Identifiable {
    /// What the choice is, for its icon.
    public enum Kind: Sendable, Hashable {
        case tag, folder, project
    }

    public let id: String
    public let name: String
    /// Nesting depth (0 = top level).
    public let depth: Int
    public let kind: Kind

    /// Creates a choice.
    public init(id: String, name: String, depth: Int, kind: Kind) {
        self.id = id
        self.name = name
        self.depth = depth
        self.kind = kind
    }

    /// The tag tree, depth first by rank (`flattenTree(tags)`).
    public static func tags(_ tags: [Tag]) -> [RulePickerChoice] {
        flatten(tags.map { ($0.id, $0.parentId, $0.rank, $0.name) }, kind: .tag)
    }

    /// The folder tree followed by every project at depth 0, as the "within focus" picker lists them.
    public static func focus(folders: [Folder], projects: [Project]) -> [RulePickerChoice] {
        flatten(folders.map { ($0.id, $0.parentId, $0.rank, $0.name) }, kind: .folder)
            + projects.map { RulePickerChoice(id: $0.task.id, name: $0.task.name, depth: 0, kind: .project) }
    }

    /// Depth-first walk; items whose parent is missing are treated as top level.
    private static func flatten(
        _ items: [(id: String, parentId: String?, rank: Double, name: String)], kind: Kind
    ) -> [RulePickerChoice] {
        let ids = Set(items.map(\.id))
        var children: [String?: [(id: String, parentId: String?, rank: Double, name: String)]] = [:]
        for item in items {
            let parent = item.parentId.flatMap { ids.contains($0) ? $0 : nil }
            children[parent, default: []].append(item)
        }
        var out: [RulePickerChoice] = []
        func walk(_ parent: String?, _ depth: Int) {
            let siblings = children[parent, default: []].enumerated()
                .sorted { $0.element.rank != $1.element.rank ? $0.element.rank < $1.element.rank : $0.offset < $1.offset }
                .map(\.element)
            for child in siblings {
                out.append(RulePickerChoice(id: child.id, name: child.name, depth: depth, kind: kind))
                walk(child.id, depth + 1)
            }
        }
        walk(nil, 0)
        return out
    }
}

extension PerspectiveRules {
    /// A group rule's `aggregateType`; `.any` when absent.
    public static func groupAggregation(of rule: JSONValue) -> Aggregation {
        if case .string(let value) = inner(rule)["aggregateType"] { return Aggregation(rawValue: value) }
        return .any
    }

    /// Sets a group rule's `aggregateType`, keeping its children and disabled wrapper.
    public static func setGroupAggregation(_ rule: JSONValue, _ aggregation: Aggregation) -> JSONValue {
        guard case .object(var members) = inner(rule) else { return rule }
        members["aggregateType"] = .string(aggregation.rawValue)
        return replaceInner(rule, with: .object(members))
    }

    /// A string parameter of the (unwrapped) rule; empty when absent or not a string.
    public static func string(of rule: JSONValue, key: String) -> String {
        if case .string(let value) = inner(rule)[key] { return value }
        return ""
    }

    /// Replaces the inner rule with exactly `members`, keeping the disabled wrapper (the web editor's `set`).
    public static func setParameters(_ rule: JSONValue, _ members: [String: JSONValue]) -> JSONValue {
        replaceInner(rule, with: .object(members))
    }

    /// The property key of a boolean rule; "actionHasDueDate" when it has none.
    public static func booleanKey(of rule: JSONValue) -> String {
        if case .object(let members) = inner(rule), let key = members.keys.sorted().first { return key }
        return "actionHasDueDate"
    }

    /// The minutes of a duration rule; 30 when missing, zero or not a number.
    public static func durationMinutes(of rule: JSONValue) -> Int {
        if case .number(let minutes) = inner(rule)["actionWithinDuration"], minutes.isFinite, minutes != 0 {
            return Int(minutes)
        }
        return 30
    }

    /// The string ids under `key` (tags, focus); empty when not an array.
    public static func ids(of rule: JSONValue, key: String) -> [String] {
        guard case .array(let values) = inner(rule)[key] else { return [] }
        return values.compactMap { if case .string(let id) = $0 { id } else { nil } }
    }

    /// `ids` with `id` added at the end, or removed when present (a picker checkbox).
    public static func toggling(_ id: String, in ids: [String]) -> [String] {
        ids.contains(id) ? ids.filter { $0 != id } : ids + [id]
    }

    /// Sets a date spec member's `dynamic` text, keeping the rule's other members.
    public static func setDateSpec(_ rule: JSONValue, key: String, text: String) -> JSONValue {
        guard case .object(var members) = inner(rule) else { return rule }
        members[key] = .object(["dynamic": .string(text)])
        return replaceInner(rule, with: .object(members))
    }

    /// A search rule's terms joined for editing ("milk, eggs").
    public static func searchText(of rule: JSONValue) -> String {
        ids(of: rule, key: "actionMatchingSearch").joined(separator: ", ")
    }

    /// The rule as a fresh rule of `kind` (the rule-type picker), keeping its disabled wrapper; unchanged for
    /// `.unknown`.
    public static func changingKind(_ rule: JSONValue, to kind: RuleKind) -> JSONValue {
        guard let fresh = defaultRule(kind) else { return rule }
        return replaceInner(rule, with: fresh)
    }
}

/// One row of the rule editor's list: the rule tree walked depth first, with an "Add rule to group" row after each
/// group's children (the web editor's nested `RuleList` + `AddRule`).
public enum RuleEditorRow: Sendable, Hashable, Identifiable {
    /// The rule at `path`, at nesting `depth`, and whether it is first or last among its siblings.
    case rule(path: [Int], depth: Int, isFirst: Bool, isLast: Bool)
    /// "Add rule to group" for the group at `path`; `depth` is that of the group's children.
    case addToGroup(path: [Int], depth: Int)

    /// A stable id from the kind and path.
    public var id: String {
        switch self {
        case .rule(let path, _, _, _): "rule:\(path.map(String.init).joined(separator: "."))"
        case .addToGroup(let path, _): "add:\(path.map(String.init).joined(separator: "."))"
        }
    }

    /// The path of the rule (or of the group being added to).
    public var path: [Int] {
        switch self {
        case .rule(let path, _, _, _), .addToGroup(let path, _): path
        }
    }

    /// The rows for a rule list.
    public static func rows(_ rules: [JSONValue]) -> [RuleEditorRow] {
        var out: [RuleEditorRow] = []
        func walk(_ list: [JSONValue], _ parent: [Int], _ depth: Int) {
            for (index, rule) in list.enumerated() {
                let path = parent + [index]
                out.append(.rule(path: path, depth: depth, isFirst: index == 0, isLast: index == list.count - 1))
                if PerspectiveRules.kind(of: rule) == .group {
                    walk(PerspectiveRules.children(of: rule), path, depth + 1)
                    out.append(.addToGroup(path: path, depth: depth + 1))
                }
            }
        }
        walk(rules, [], 0)
        return out
    }
}

extension PerspectiveRules {
    /// The rule at `path` (through groups' `aggregateRules`, looking through disabled wrappers); nil when the path
    /// is empty or out of range.
    public static func rule(in rules: [JSONValue], at path: [Int]) -> JSONValue? {
        guard let head = path.first, rules.indices.contains(head) else { return nil }
        let rule = rules[head]
        return path.count == 1 ? rule : self.rule(in: children(of: rule), at: Array(path.dropFirst()))
    }
}
