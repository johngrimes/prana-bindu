// Author: John Grimes

import PranaKit
import SwiftUI

/// Quick Entry (spec §4): Title, Project (smart match / create), Tags, Due (natural language, parsed on the
/// device before saving, so an unparseable date keeps the sheet open), Note and Flag. Save closes the sheet at once;
/// the item goes to the Inbox, or to the start of the chosen project.
struct QuickEntrySheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var draft = QuickEntryDraft()
    @State private var dueError: String?
    @State private var showsNote = false
    @FocusState private var titleFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        TextField("New item", text: $draft.name)
                            .font(.headline)
                            .focused($titleFocused)
                            .submitLabel(.done)
                            .onSubmit(save)
                            .accessibilityLabel("Title")
                            .accessibilityIdentifier("quickEntry.title")
                        Button {
                            draft.flagged.toggle()
                        } label: {
                            Image(systemName: draft.flagged ? "flag.fill" : "flag")
                                .foregroundStyle(draft.flagged ? .orange : .secondary)
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(draft.flagged ? "Unflag" : "Flag")
                        .accessibilityIdentifier("quickEntry.flag")
                    }
                }
                Section("Project") {
                    if let project = draft.project {
                        HStack {
                            Label(project.name, systemImage: "list.bullet.indent")
                            Spacer()
                            Button {
                                draft.project = nil
                            } label: {
                                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary).frame(width: 44, height: 44)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Clear project")
                        }
                    } else {
                        SmartMatchField(
                            label: "Project", placeholder: "Inbox",
                            items: Entities.projectChoices(store.state.projects, folders: store.state.folders),
                            identifier: "quickEntry.project",
                            onPick: { draft.project = $0 },
                            onCreate: { name in draft.project = MatchItem(id: store.createProject(named: name), name: name) })
                    }
                }
                Section("Due") {
                    TextField("e.g. fri 5pm", text: $draft.due)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityLabel("Due")
                        .accessibilityIdentifier("quickEntry.due")
                        .onChange(of: draft.due) { dueError = nil }
                    dueHint
                }
                Section("Tags") {
                    if !draft.tags.isEmpty {
                        TagPills(pills: draft.tags.map { TagPills.Pill(id: $0.id, name: $0.name) }) { draft.removeTag($0) }
                    }
                    SmartMatchField(
                        label: "Add tag", placeholder: "Add tag",
                        items: Entities.tagChoices(store.state.tags, excluding: draft.tags.map(\.id)),
                        identifier: "quickEntry.tag",
                        onPick: { draft.addTag($0) },
                        onCreate: { name in draft.addTag(MatchItem(id: store.createTag(name: name), name: name)) })
                }
                if showsNote {
                    Section("Note") {
                        TextField("Note", text: $draft.note, axis: .vertical)
                            .lineLimit(4...)
                            .accessibilityIdentifier("quickEntry.note")
                    }
                } else {
                    Button("Add note", systemImage: "plus") { showsNote = true }
                        .accessibilityIdentifier("quickEntry.addNote")
                }
            }
            .navigationTitle(draft.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("quickEntry.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .disabled(!draft.canSave)
                        .keyboardShortcut(.return, modifiers: .command)
                        .accessibilityIdentifier("quickEntry.save")
                }
            }
            .onAppear { titleFocused = true }
        }
        .accessibilityIdentifier("quickEntry")
    }

    @ViewBuilder
    private var dueHint: some View {
        if let dueError {
            Text(dueError).font(.caption).foregroundStyle(.red)
                .accessibilityIdentifier("quickEntry.dueError")
        } else {
            switch draft.duePreview(settings: store.settings, now: Date()) {
            case .none: EmptyView()
            case .parsed(let text):
                Text(text).font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("quickEntry.duePreview")
            case .invalid:
                Text(DateEntry.invalidMessage).font(.caption).foregroundStyle(.red)
                    .accessibilityIdentifier("quickEntry.dueError")
            }
        }
    }

    private func save() {
        guard draft.canSave else { return }
        switch store.save(draft) {
        case .success: dismiss()
        case .failure(let error): dueError = error.message
        }
    }
}
