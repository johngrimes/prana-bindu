// Author: John Grimes

import PranaKit
import SwiftUI

/// One rule of the perspective editor (`RuleNode` in the web editor): enabled checkbox, rule type (or "Unsupported
/// rule (kept)"), a group's aggregation, move and remove, and the rule's parameters. Group children are separate rows
/// below, indented by depth.
struct RuleRowView: View {
    /// Indentation per nesting level.
    static let indent: CGFloat = 18

    let rule: JSONValue
    let path: [Int]
    let depth: Int
    let isFirst: Bool
    let isLast: Bool
    /// Applies a transform to the draft's top-level rules.
    let onRules: (([JSONValue]) -> [JSONValue]) -> Void

    private var kind: RuleKind { PerspectiveRules.kind(of: rule) }
    private var disabled: Bool { PerspectiveRules.isDisabled(rule) }
    private var identifier: String { "rule.\(path.map(String.init).joined(separator: "."))" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if kind != .group && kind != .unknown {
                RuleParametersView(rule: rule, identifier: identifier) { replace(with: $0) }
            }
        }
        .opacity(disabled ? 0.55 : 1)
        .padding(.leading, CGFloat(depth) * Self.indent)
        .overlay(alignment: .leading) {
            if depth > 0 {
                Rectangle()
                    .fill(Color.accentColor.opacity(0.4))
                    .frame(width: 2)
                    .padding(.leading, CGFloat(depth) * Self.indent - 10)
            }
        }
        .swipeActions {
            Button("Remove Rule", systemImage: "trash", role: .destructive) { replace(with: nil) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button {
                replace(with: PerspectiveRules.setEnabled(rule, disabled))
            } label: {
                Image(systemName: disabled ? "square" : "checkmark.square.fill")
                    .font(.title3)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Rule enabled")
            .accessibilityValue(disabled ? "Off" : "On")
            .accessibilityIdentifier("\(identifier).enabled")

            if kind == .unknown {
                Text(RuleKind.unknown.label)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("\(identifier).unsupported")
            } else {
                Picker(
                    "Rule type",
                    selection: Binding(
                        get: { kind },
                        set: { replace(with: PerspectiveRules.changingKind(rule, to: $0)) })
                ) {
                    ForEach(RuleKind.addable, id: \.self) { Text($0.label).tag($0) }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .accessibilityIdentifier("\(identifier).kind")
            }
            if kind == .group {
                Picker(
                    "Group matches",
                    selection: Binding(
                        get: { PerspectiveRules.groupAggregation(of: rule) },
                        set: { replace(with: PerspectiveRules.setGroupAggregation(rule, $0)) })
                ) {
                    ForEach(PerspectiveDraft.groupAggregationOptions, id: \.value) { Text($0.label).tag($0.value) }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .accessibilityIdentifier("\(identifier).aggregation")
            }
            Spacer(minLength: 0)
            Menu {
                Button("Move Rule Up", systemImage: "arrow.up") { onRules { PerspectiveRules.move($0, at: path, by: -1) } }
                    .disabled(isFirst)
                Button("Move Rule Down", systemImage: "arrow.down") { onRules { PerspectiveRules.move($0, at: path, by: 1) } }
                    .disabled(isLast)
                Button("Remove Rule", systemImage: "trash", role: .destructive) { replace(with: nil) }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Rule actions")
            .accessibilityIdentifier("\(identifier).actions")
        }
    }

    /// Replaces this rule (nil removes it).
    private func replace(with next: JSONValue?) {
        let path = path
        onRules { PerspectiveRules.update($0, at: path) { _ in next } }
    }
}

/// The parameters of a non-group rule (`RuleParams` in the web editor). `onChange` receives the whole new rule,
/// with any disabled wrapper kept.
private struct RuleParametersView: View {
    let rule: JSONValue
    let identifier: String
    let onChange: (JSONValue) -> Void

    @Environment(AppStore.self) private var store
    @State private var picking = false
    @State private var searchText = ""
    @FocusState private var searchFocused: Bool

    private var kind: RuleKind { PerspectiveRules.kind(of: rule) }
    private var inner: JSONValue { PerspectiveRules.inner(rule) }

    var body: some View {
        switch kind {
        case .availability:
            stringPicker("Availability", key: "actionAvailability", options: PerspectiveRules.availabilityOptions)
        case .status:
            stringPicker("Status", key: "actionStatus", options: PerspectiveRules.statusOptions)
        case .boolean:
            Picker(
                "Property",
                selection: Binding(
                    get: { PerspectiveRules.booleanKey(of: rule) },
                    set: { onChange(PerspectiveRules.setParameters(rule, [$0: .bool(true)])) })
            ) {
                ForEach(PerspectiveRules.booleanRules, id: \.value) { Text($0.label).tag($0.value) }
            }
            .accessibilityIdentifier("\(identifier).property")
        case .withinDuration:
            Picker(
                "Duration",
                selection: Binding(
                    get: { PerspectiveRules.durationMinutes(of: rule) },
                    set: { onChange(PerspectiveRules.setParameters(rule, ["actionWithinDuration": .number(Double($0))])) })
            ) {
                ForEach(durationOptions, id: \.value) { Text($0.label).tag($0.value) }
            }
            .accessibilityIdentifier("\(identifier).duration")
        case .date:
            dateParameters
        case .tagStatus:
            stringPicker("Tag status", key: "actionHasTagWithStatus", options: PerspectiveRules.tagStatusOptions)
        case .anyTags, .allTags:
            let key = kind == .anyTags ? "actionHasAnyOfTags" : "actionHasAllOfTags"
            idPicker(title: "Tags", key: key, choices: RulePickerChoice.tags(store.state.tags ?? []))
        case .projectStatus:
            stringPicker("Project status", key: "actionHasProjectWithStatus", options: PerspectiveRules.projectStatusOptions)
        case .focus:
            idPicker(
                title: "Projects and folders", key: "actionWithinFocus",
                choices: RulePickerChoice.focus(folders: store.state.folders ?? [], projects: store.state.projects ?? []))
        case .search:
            TextField("Terms, separated by commas", text: $searchText)
                .focused($searchFocused)
                .onSubmit(commitSearch)
                .onChange(of: searchFocused) { _, focused in if !focused { commitSearch() } }
                .onAppear { searchText = PerspectiveRules.searchText(of: rule) }
                .accessibilityLabel("Search terms")
                .accessibilityIdentifier("\(identifier).search")
        case .group, .unknown:
            EmptyView()
        }
    }

    /// The duration choices, plus the rule's own value when it is not one of them (imported rules).
    private var durationOptions: [RuleOption<Int>] {
        let current = PerspectiveRules.durationMinutes(of: rule)
        let options = PerspectiveRules.durationOptions
        return options.contains { $0.value == current } ? options : options + [RuleOption(current, "\(current) minutes")]
    }

    private func stringPicker(_ title: String, key: String, options: [RuleOption<String>]) -> some View {
        let current = PerspectiveRules.string(of: rule, key: key)
        let all = options.contains { $0.value == current } || current.isEmpty ? options : options + [RuleOption(current, current)]
        return Picker(
            title,
            selection: Binding(
                get: { current },
                set: { onChange(PerspectiveRules.setParameters(rule, [key: .string($0)])) })
        ) {
            ForEach(all, id: \.value) { Text($0.label).tag($0.value) }
        }
        .accessibilityIdentifier("\(identifier).\(key)")
    }

    @ViewBuilder
    private var dateParameters: some View {
        let condition = PerspectiveRules.dateCondition(of: rule)
        let field = PerspectiveRules.string(of: rule, key: "actionDateField").isEmpty
            ? "due" : PerspectiveRules.string(of: rule, key: "actionDateField")
        Picker(
            "Date field",
            selection: Binding(
                get: { field },
                set: { onChange(PerspectiveRules.replaceInner(rule, with: PerspectiveRules.buildDateRule(field: $0, condition: condition, previous: inner))) })
        ) {
            ForEach(PerspectiveRules.dateFields, id: \.self) { Text(PerspectiveRules.dateFieldLabel($0)).tag($0) }
        }
        .accessibilityIdentifier("\(identifier).dateField")
        Picker(
            "Date condition",
            selection: Binding(
                get: { condition },
                set: { onChange(PerspectiveRules.replaceInner(rule, with: PerspectiveRules.buildDateRule(field: field, condition: $0, previous: inner))) })
        ) {
            ForEach(DateCondition.allCases, id: \.self) { Text($0.label).tag($0) }
        }
        .accessibilityIdentifier("\(identifier).dateCondition")
        switch condition {
        case .isInThePast, .isInTheNext:
            let amount = PerspectiveRules.relativeAmount(of: rule)
            let component = PerspectiveRules.relativeComponent(of: rule)
            Stepper(
                "Amount: \(amount)",
                value: Binding(
                    get: { amount },
                    set: { onChange(PerspectiveRules.replaceInner(rule, with: PerspectiveRules.setRelative(inner, amount: max(1, $0), component: component))) }),
                in: 1...999
            )
            .accessibilityIdentifier("\(identifier).amount")
            Picker(
                "Unit",
                selection: Binding(
                    get: { component },
                    set: { onChange(PerspectiveRules.replaceInner(rule, with: PerspectiveRules.setRelative(inner, amount: amount, component: $0))) })
            ) {
                ForEach(PerspectiveRules.relativeComponents, id: \.value) { Text($0.label).tag($0.value) }
            }
            .accessibilityIdentifier("\(identifier).unit")
        case .isOnDateSpec:
            dateSpecField("Date", placeholder: "e.g. today, dec 25", key: "actionDateIsOnDateSpec")
        case .between:
            dateSpecField("From date", placeholder: "From date", key: "actionDateIsAfterDateSpec")
            Text("and").font(.callout).foregroundStyle(.secondary)
            dateSpecField("To date", placeholder: "To date", key: "actionDateIsBeforeDateSpec")
        case .isToday, .isYesterday, .isTomorrow:
            EmptyView()
        }
    }

    private func dateSpecField(_ label: String, placeholder: String, key: String) -> some View {
        LabeledContent(label) {
            TextField(
                placeholder,
                text: Binding(
                    get: { PerspectiveRules.dateSpecText(of: rule, key: key) },
                    set: { onChange(PerspectiveRules.setDateSpec(rule, key: key, text: $0)) })
            )
            .multilineTextAlignment(.trailing)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityLabel(label)
            .accessibilityIdentifier("\(identifier).\(key)")
        }
    }

    private func idPicker(title: String, key: String, choices: [RulePickerChoice]) -> some View {
        let selected = PerspectiveRules.ids(of: rule, key: key)
        let names = choices.filter { selected.contains($0.id) }.map(\.name)
        return Button {
            picking = true
        } label: {
            LabeledContent(title) {
                Text(names.isEmpty ? "None chosen" : names.joined(separator: ", "))
                    .lineLimit(2)
                    .multilineTextAlignment(.trailing)
            }
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("\(identifier).choose")
        .sheet(isPresented: $picking) {
            IdChecklistSheet(
                title: title, choices: choices,
                selected: Binding(
                    get: { PerspectiveRules.ids(of: rule, key: key) },
                    set: { ids in onChange(PerspectiveRules.setParameters(rule, [key: .array(ids.map(JSONValue.string))])) }))
        }
    }

    private func commitSearch() {
        let terms = PerspectiveRules.searchTerms(searchText)
        guard terms != PerspectiveRules.ids(of: rule, key: "actionMatchingSearch") else { return }
        onChange(PerspectiveRules.setParameters(rule, ["actionMatchingSearch": .array(terms.map(JSONValue.string))]))
    }
}

/// A checklist of tags, or of folders and projects (`IdChecklist` in the web editor), in a sheet.
struct IdChecklistSheet: View {
    let title: String
    let choices: [RulePickerChoice]
    @Binding var selected: [String]

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var shown: [RulePickerChoice] {
        query.isEmpty ? choices : choices.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            List(shown) { choice in
                let isOn = selected.contains(choice.id)
                Button {
                    selected = PerspectiveRules.toggling(choice.id, in: selected)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: symbol(choice.kind)).foregroundStyle(.secondary)
                        Text(choice.name).foregroundStyle(.primary)
                        Spacer()
                        if isOn { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                    }
                    .padding(.leading, CGFloat(choice.depth) * 14)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isOn ? .isSelected : [])
                .accessibilityIdentifier("checklist.\(choice.id)")
            }
            .overlay {
                if choices.isEmpty { ContentUnavailableView("Nothing to choose from.", systemImage: "tray") }
            }
            .searchable(text: $query)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("checklist.done")
                }
            }
        }
    }

    private func symbol(_ kind: RulePickerChoice.Kind) -> String {
        switch kind {
        case .tag: "tag"
        case .folder: "folder"
        case .project: "circle.grid.cross"
        }
    }
}
