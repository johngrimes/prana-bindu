// Author: John Grimes

import PranaKit
import SwiftUI

/// The folder and tag inspectors (spec §3): Title, Status, (tags) Mutually Exclusive children, Note, Added, Changed.
struct ContainerInspector: View {
    /// Which kind of container.
    enum Kind {
        case folder, tag
    }

    @Environment(AppStore.self) private var store

    let kind: Kind
    let id: String

    var body: some View {
        switch kind {
        case .folder:
            if let folder = store.state.folders?.first(where: { $0.id == id }) {
                folderForm(folder)
            } else {
                missing
            }
        case .tag:
            if let tag = store.state.tags?.first(where: { $0.id == id }) {
                tagForm(tag)
            } else {
                missing
            }
        }
    }

    private var missing: some View {
        ContentUnavailableView("This item no longer exists.", systemImage: "questionmark.folder")
    }

    private func folderForm(_ folder: Folder) -> some View {
        Form {
            Section("Folder") {
                CommitTextField(label: "Title", value: folder.name, font: .headline) { store.patchFolder(id, FolderPatch(name: $0)) }
                    .accessibilityIdentifier("inspector.title")
            }
            Section("Status") {
                SegmentedField(
                    label: "Folder status", options: [(FolderStatus.active, "Active"), (.dropped, "Dropped")], selection: folder.status
                ) { store.patchFolder(id, FolderPatch(status: $0)) }
            }
            noteSection(folder.note) { store.patchFolder(id, FolderPatch(note: $0)) }
            datesSection(added: folder.added, modified: folder.modified)
        }
        .accessibilityIdentifier("inspector.folder")
    }

    private func tagForm(_ tag: Tag) -> some View {
        Form {
            Section("Tag") {
                CommitTextField(label: "Title", value: tag.name, font: .headline) { store.patchTag(id, TagPatch(name: $0)) }
                    .accessibilityIdentifier("inspector.title")
            }
            Section("Status") {
                SegmentedField(
                    label: "Tag status", options: [(TagStatus.active, "Active"), (.onHold, "On Hold"), (.dropped, "Dropped")],
                    selection: tag.status
                ) { store.patchTag(id, TagPatch(status: $0)) }
                Toggle(
                    "Child tags are mutually exclusive",
                    isOn: Binding(
                        get: { tag.childrenMutuallyExclusive }, set: { store.patchTag(id, TagPatch(childrenMutuallyExclusive: $0)) }))
                    .accessibilityIdentifier("inspector.tag.exclusive")
                Text("\(tag.availableCount) available · \(tag.remainingCount) remaining")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            noteSection(tag.note) { store.patchTag(id, TagPatch(note: $0)) }
            datesSection(added: tag.added, modified: tag.modified)
        }
        .accessibilityIdentifier("inspector.tag")
    }

    private func noteSection(_ note: String, onCommit: @escaping (String) -> Void) -> some View {
        Section("Note") {
            CommitTextField(label: "Note", value: note, placeholder: "Add a note", multiline: true, onCommit: onCommit)
                .accessibilityIdentifier("inspector.note")
        }
    }

    private func datesSection(added: String, modified: String) -> some View {
        Section("Dates") {
            ReadOnlyDateRow(label: "Added", value: added)
            ReadOnlyDateRow(label: "Changed", value: modified)
        }
    }
}
