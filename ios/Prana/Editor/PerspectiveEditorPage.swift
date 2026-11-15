// Author: John Grimes

import PranaKit
import SwiftUI

/// The custom perspective editor (spec §4 "Custom perspectives", §4.1), port of `src/web/pages/PerspectiveEditor.tsx`.
/// `.perspectiveEditor(id: "new")` edits a draft that is stored only on Save; built-in perspectives cannot be edited.
struct PerspectiveEditorPage: View {
    /// `.perspectiveEditor(id:)`.
    let route: Route
    @Environment(AppStore.self) private var store

    private var id: String {
        if case .perspectiveEditor(let id) = route { return id }
        return ""
    }

    var body: some View {
        if id == "new" {
            PerspectiveEditorForm(perspective: nil).id("new")
        } else if let perspectives = store.state.perspectives {
            if let perspective = perspectives.first(where: { $0.id == id }) {
                if perspective.builtin {
                    ContentUnavailableView(
                        "Built-in perspectives cannot be edited.", systemImage: PerspectiveStyle.symbol(of: perspective)
                    )
                    .navigationTitle(perspective.name)
                } else {
                    PerspectiveEditorForm(perspective: perspective).id(perspective.id)
                }
            } else {
                ContentUnavailableView("Perspective not found.", systemImage: "questionmark.square.dashed")
                    .navigationTitle("Edit Perspective")
            }
        } else {
            ProgressView("Loading…")
                .navigationTitle("Edit Perspective")
        }
    }
}

/// The editor form for one perspective (or a new draft when `perspective` is nil). Edits stay in a local draft;
/// Save sends the whole draft as one instant write.
private struct PerspectiveEditorForm: View {
    /// The perspective being edited; nil for a new one.
    let perspective: Perspective?

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    @State private var draft: PerspectiveDraft
    @State private var dirty: Bool
    @State private var confirmingDelete = false

    init(perspective: Perspective?) {
        self.perspective = perspective
        _draft = State(initialValue: perspective.map(PerspectiveDraft.init) ?? .newPerspective)
        _dirty = State(initialValue: perspective == nil)
    }

    private var title: String { "Edit “\(perspective?.name ?? PerspectiveDraft.newPerspective.name)”" }

    var body: some View {
        Form {
            identitySection
            iconSection
            colourSection
            Section {
                Toggle(isOn: binding(\.favorite)) {
                    Label {
                        Text("Show in the perspectives bar (favourite)")
                    } icon: {
                        Image(systemName: draft.favorite ? "star.fill" : "star").foregroundStyle(.yellow)
                    }
                }
                .accessibilityIdentifier("editor.favourite")
            }
            rulesSection
            presentationSection
            if let perspective { actionsSection(perspective) }
        }
        .navigationTitle(title)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save)
                    .disabled(!dirty || !draft.canSave)
                    .accessibilityIdentifier("editor.save")
            }
            if perspective == nil {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { navigator.navigate(to: navigator.home) }
                        .accessibilityIdentifier("editor.cancel")
                }
            }
        }
        .alert("Delete perspective?", isPresented: $confirmingDelete, presenting: perspective) { perspective in
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                store.deletePerspective(perspective.id)
                navigator.navigate(to: ShellNavigation.home(store.state.perspectives?.filter { $0.id != perspective.id }))
            }
        } message: { perspective in
            Text("“\(perspective.name)” will be deleted. You can undo this.")
        }
    }

    // MARK: Sections

    private var identitySection: some View {
        Section("Name") {
            TextField("Perspective name", text: binding(\.name))
                .accessibilityIdentifier("editor.name")
        }
    }

    private var iconSection: some View {
        Section("Icon") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 6)], spacing: 6) {
                ForEach(PerspectiveStyle.icons, id: \.self) { icon in
                    let selected = draft.icon == icon
                    Button {
                        update { $0.icon = icon }
                    } label: {
                        Image(systemName: PerspectiveStyle.symbol(forIcon: icon))
                            .font(.title3)
                            .foregroundStyle(Color(hex: draft.color) ?? .accentColor)
                            .frame(width: 44, height: 44)
                            .background(selected ? Color.accentColor.opacity(0.15) : .clear, in: .rect(cornerRadius: 8))
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(selected ? Color.accentColor : Color.secondary.opacity(0.3), lineWidth: selected ? 2 : 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(icon)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("editor.icon.\(icon)")
                }
            }
            .padding(.vertical, 4)
        }
    }

    private var colourSection: some View {
        Section("Colour") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 6)], spacing: 6) {
                ForEach(PerspectiveStyle.swatches, id: \.self) { swatch in
                    let selected = draft.color == swatch
                    Button {
                        update { $0.color = swatch }
                    } label: {
                        Circle()
                            .fill(Color(hex: swatch) ?? .accentColor)
                            .frame(width: 36, height: 36)
                            .padding(3)
                            .overlay(Circle().stroke(selected ? Color.primary : .clear, lineWidth: 2))
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(swatch)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("editor.colour.\(swatch)")
                }
            }
            .padding(.vertical, 4)
            ColorPicker(
                "Custom colour",
                selection: Binding(
                    get: { Color(hex: draft.color) ?? Color(hex: "#4f6fd1") ?? .accentColor },
                    set: { colour in update { $0.color = colour.hexString } }),
                supportsOpacity: false
            )
            .accessibilityIdentifier("editor.customColour")
        }
    }

    private var rulesSection: some View {
        Section {
            HStack(spacing: 6) {
                Text("Actions matching").fontWeight(.semibold)
                Picker("Top-level aggregation", selection: binding(\.aggregation)) {
                    ForEach(PerspectiveDraft.aggregationOptions, id: \.value) { Text($0.label).tag($0.value) }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .fixedSize()
                .accessibilityIdentifier("editor.aggregation")
                Text("of these rules").fontWeight(.semibold)
            }
            if draft.rules.isEmpty {
                Text("No rules: the perspective shows all remaining actions.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(RuleEditorRow.rows(draft.rules)) { row in
                switch row {
                case .rule(let path, let depth, let isFirst, let isLast):
                    if let rule = PerspectiveRules.rule(in: draft.rules, at: path) {
                        RuleRowView(
                            rule: rule, path: path, depth: depth, isFirst: isFirst, isLast: isLast, onRules: editRules)
                    }
                case .addToGroup(let path, let depth):
                    AddRuleMenu(title: "Add rule to group", identifier: "editor.addToGroup.\(row.id)") { child in
                        editRules { PerspectiveRules.update($0, at: path) { PerspectiveRules.appendChild(child, to: $0) } }
                    }
                    .padding(.leading, CGFloat(depth) * RuleRowView.indent)
                }
            }
            AddRuleMenu(title: "Add rule", identifier: "editor.addRule") { rule in
                update { $0.rules.append(rule) }
            }
        } header: {
            Text("Rules")
        }
    }

    private var presentationSection: some View {
        Section("Presentation") {
            Picker("Layout", selection: binding(\.presentation.layout)) {
                ForEach(PerspectiveDraft.layoutOptions, id: \.value) { Text($0.label).tag($0.value) }
            }
            .accessibilityIdentifier("editor.layout")
            Picker("Sidebar", selection: binding(\.presentation.sidebar)) {
                ForEach(PerspectiveDraft.sidebarOptions, id: \.value) { Text($0.label).tag($0.value) }
            }
            .accessibilityIdentifier("editor.sidebar")
            Picker("Group by", selection: binding(\.presentation.grouping)) {
                ForEach(PerspectiveDraft.groupingOptions, id: \.value) { Text($0.label).tag($0.value) }
            }
            .accessibilityIdentifier("editor.grouping")
            Picker("Sort by", selection: binding(\.presentation.sorting)) {
                ForEach(PerspectiveDraft.sortingOptions, id: \.value) { Text($0.label).tag($0.value) }
            }
            .accessibilityIdentifier("editor.sorting")
        }
    }

    private func actionsSection(_ perspective: Perspective) -> some View {
        Section {
            Button("View", systemImage: "eye") { navigator.navigate(to: .perspective(id: perspective.id)) }
                .accessibilityIdentifier("editor.view")
            Button("Duplicate", systemImage: "plus.square.on.square", action: duplicate)
                .accessibilityIdentifier("editor.duplicate")
            Button("Move Perspective Up", systemImage: "arrow.up") { reorder(-1) }
                .accessibilityIdentifier("editor.moveUp")
            Button("Move Perspective Down", systemImage: "arrow.down") { reorder(1) }
                .accessibilityIdentifier("editor.moveDown")
            Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = true }
                .accessibilityIdentifier("editor.delete")
        }
    }

    // MARK: Editing

    /// A binding into the draft that marks it dirty when set.
    private func binding<Value>(_ keyPath: WritableKeyPath<PerspectiveDraft, Value>) -> Binding<Value> {
        Binding(get: { draft[keyPath: keyPath] }, set: { value in update { $0[keyPath: keyPath] = value } })
    }

    private func update(_ change: (inout PerspectiveDraft) -> Void) {
        change(&draft)
        dirty = true
    }

    private func editRules(_ transform: ([JSONValue]) -> [JSONValue]) {
        update { $0.rules = transform($0.rules) }
    }

    private func save() {
        guard let perspective else {
            let id = ClientID.make()
            store.createPerspective(draft.createInput(id: id))
            store.toast("Perspective saved")
            navigator.navigate(to: .perspectiveEditor(id: id))
            return
        }
        store.patchPerspective(perspective.id, draft.patch)
        dirty = false
        store.toast("Perspective saved")
    }

    private func duplicate() {
        let id = ClientID.make()
        store.createPerspective(draft.duplicateInput(id: id))
        navigator.navigate(to: .perspectiveEditor(id: id))
    }

    private func reorder(_ delta: Int) {
        guard let perspective else { return }
        for change in PerspectiveDraft.reorder(store.state.perspectives ?? [], id: perspective.id, by: delta) {
            store.patchPerspective(change.id, PerspectivePatch(rank: change.rank))
        }
    }
}

/// "+ Add rule…": a picker of the rule kinds a user can add that always shows its prompt (the web editor's `AddRule`
/// select); choosing a kind adds a new rule of that kind.
struct AddRuleMenu: View {
    let title: String
    let identifier: String
    let onAdd: (JSONValue) -> Void

    var body: some View {
        Picker(
            title,
            selection: Binding<RuleKind?>(
                get: { nil },
                set: { kind in
                    if let kind, let rule = PerspectiveRules.defaultRule(kind) { onAdd(rule) }
                })
        ) {
            Label("\(title)…", systemImage: "plus.circle").tag(RuleKind?.none)
            ForEach(RuleKind.addable, id: \.self) { kind in
                Text(kind.label).tag(Optional(kind))
            }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .accessibilityIdentifier(identifier)
    }
}
