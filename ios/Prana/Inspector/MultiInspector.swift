// Author: John Grimes

import PranaKit
import SwiftUI

/// Editing several selected items at once (spec §3): each change applies to all of them in one batch write, and
/// fields whose values differ show "Multiple values".
struct MultiInspector: View {
    @Environment(AppStore.self) private var store

    let ids: [String]

    @State private var askingDrop = false

    var body: some View {
        let details = ids.compactMap { store.detail($0) }
        Group {
            if details.count < ids.count {
                ContentUnavailableView("Loading…", systemImage: "square.stack")
            } else {
                form(details.map(\.task))
            }
        }
        .task(id: ids) {
            await withTaskGroup(of: Void.self) { group in
                for id in ids where store.detail(id) == nil {
                    group.addTask { await store.loadDetail(id) }
                }
            }
        }
    }

    private func form(_ tasks: [TaskItem]) -> some View {
        let tags = Entities.byId(store.state.tags)
        let flagged = InspectorModel.same(tasks, \.flagged)
        let duration = InspectorModel.same(tasks, \.estimatedMinutes)
        return Form {
            Section("Multiple selection") {
                Text("\(ids.count) items selected").font(.headline)
                    .accessibilityIdentifier("inspector.multi.count")
            }
            Section("Status") {
                SegmentedField(
                    label: "Status",
                    options: [(ActivityStatus.active, "Active"), (.completed, "Completed"), (.dropped, "Dropped")],
                    selection: InspectorModel.commonStatus(tasks)
                ) { status in
                    if status == .dropped && InspectorModel.needsDropChoice(tasks) {
                        askingDrop = true
                    } else {
                        store.setStatus(ids, status)
                    }
                }
                if InspectorModel.commonStatus(tasks) == nil {
                    Text(InspectorModel.multipleValues).font(.caption).foregroundStyle(.secondary)
                }
                Button {
                    store.apply(.flagged(!(flagged.value ?? false)), toAll: ids)
                } label: {
                    Label(flagged.label { $0 ? "Flagged" : "Unflagged" }, systemImage: flagged.value == true ? "flag.fill" : "flag")
                        .foregroundStyle(flagged.value == true ? .orange : .secondary)
                }
                .accessibilityIdentifier("inspector.multi.flag")
                LabeledContent("Project") {
                    SmartMatchField(
                        label: "Project", placeholder: "Move to project…",
                        items: Entities.projectChoices(store.state.projects, folders: store.state.folders),
                        identifier: "inspector.multi.project-input",
                        onPick: { store.setProject($0.id, forAll: tasks) })
                }
            }
            Section("Tags") {
                let presence = InspectorModel.tagPresence(tasks)
                if !presence.isEmpty {
                    TagPills(
                        pills: presence.map { TagPills.Pill(id: $0.id, name: tags[$0.id]?.name ?? $0.id, onAll: $0.onAll) },
                        removeLabel: { "Remove tag \($0.name) from all" }
                    ) { tagId in
                        store.editTags(ids, remove: [tagId])
                    }
                }
                SmartMatchField(
                    label: "Add tag to all", placeholder: "Add tag to all", items: Entities.tagChoices(store.state.tags),
                    identifier: "inspector.multi.tag-input",
                    onPick: { store.editTags(ids, add: [$0.id]) })
            }
            Section("Dates") {
                DurationField(value: duration.value ?? nil, mixed: duration.isMixed) { store.apply(.estimatedMinutes($0), toAll: ids) }
                ForEach([("Defer", DateField.defer), ("Planned", .planned), ("Due", .due)], id: \.1) { label, field in
                    let value = InspectorModel.same(tasks, keyPath(field))
                    NaturalDateField(label: label, field: field, value: value.value ?? nil, mixed: value.isMixed) {
                        store.apply(.date(field, $0), toAll: ids)
                    }
                }
            }
        }
        .accessibilityIdentifier("inspector.multi")
        .confirmationDialog("Drop repeating item", isPresented: $askingDrop, titleVisibility: .visible) {
            Button("Skip this occurrence") { store.setStatus(ids, .dropped, scope: .occurrence) }
            Button("Drop completely", role: .destructive) { store.setStatus(ids, .dropped, scope: .series) }
        } message: {
            Text(InspectorModel.multipleDropMessage)
        }
    }

    private func keyPath(_ field: DateField) -> KeyPath<TaskItem, String?> {
        switch field {
        case .defer: \.deferDate
        case .planned: \.plannedDate
        case .due: \.dueDate
        }
    }
}
