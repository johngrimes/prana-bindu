// Author: John Grimes

import PranaKit
import SwiftUI

/// The inspector for one task, action group, inbox item or project (spec §3). Every edit is an instant write through
/// the store, so it shows here and in the outline at once and reverts with a toast if the server refuses it.
struct TaskInspector: View {
    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator

    let id: String

    @State private var loaded = false
    @State private var askingDrop = false

    var body: some View {
        Group {
            if let detail = store.detail(id) {
                form(detail)
            } else {
                ContentUnavailableView(loaded ? "This item no longer exists." : "Loading…", systemImage: "doc.text.magnifyingglass")
            }
        }
        .task(id: id) {
            await store.loadDetail(id)
            loaded = true
        }
    }

    private var settings: Settings { store.settings }

    private func edit(_ edit: InspectorEdit, _ detail: TaskDetail) {
        store.apply(edit, to: detail)
    }

    @ViewBuilder
    private func form(_ detail: TaskDetail) -> some View {
        Form {
            Section(InspectorModel.kindLabel(detail)) {
                CommitTextField(label: "Title", value: detail.name, placeholder: "Untitled", font: .headline) {
                    edit(.name($0), detail)
                }
                .accessibilityIdentifier("inspector.title")
            }
            statusSection(detail)
            tagsSection(detail)
            datesSection(detail)
            if let project = detail.project {
                ReviewSection(id: detail.id, project: project)
            }
            Section("Repeat") {
                RepeatEditorView(rule: detail.repeat) { edit(.repeatRule($0), detail) }
            }
            if !detail.alarms.isEmpty {
                Section("Notifications") {
                    ForEach(detail.alarms) { alarm in
                        HStack {
                            Label(InspectorModel.describe(alarm, settings: settings), systemImage: "bell")
                            Spacer()
                            if alarm.kind != .absolute, let fire = alarm.effectiveFireDate {
                                Text(DateDisplay.formatDateTime(fire, settings: settings)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            Section("Note") {
                CommitTextField(label: "Note", value: detail.note, placeholder: "Add a note", multiline: true) {
                    edit(.note($0), detail)
                }
                .accessibilityIdentifier("inspector.note")
            }
            Section("Attachments") {
                AttachmentsSection(taskId: detail.id, attachments: detail.attachments)
            }
        }
        .accessibilityIdentifier("inspector")
        .confirmationDialog("Drop repeating item", isPresented: $askingDrop, titleVisibility: .visible) {
            Button("Skip this occurrence") { store.setStatus([detail.id], .dropped, scope: .occurrence) }
            Button("Drop completely", role: .destructive) { store.setStatus([detail.id], .dropped, scope: .series) }
        } message: {
            Text(InspectorModel.dropMessage(name: detail.name))
        }
    }

    @ViewBuilder
    private func statusSection(_ detail: TaskDetail) -> some View {
        let isGroup = InspectorModel.isGroup(detail)
        Section(detail.project == nil ? "Status" : "Project") {
            if let project = detail.project {
                SegmentedField(
                    label: "Project status",
                    options: [(ProjectStatus.active, "Active"), (.onHold, "On Hold"), (.completed, "Completed"), (.dropped, "Dropped")],
                    selection: project.status
                ) { status in
                    if status == .dropped && detail.repeat != nil {
                        askingDrop = true
                    } else {
                        edit(.projectStatus(status), detail)
                    }
                }
            } else {
                SegmentedField(
                    label: "Status",
                    options: [(ActivityStatus.active, "Active"), (.completed, "Completed"), (.dropped, "Dropped")],
                    selection: InspectorModel.status(of: detail.task)
                ) { status in
                    if status == .dropped && detail.repeat != nil {
                        askingDrop = true
                    } else {
                        store.setStatus([detail.id], status)
                    }
                }
            }
            Button {
                edit(.flagged(!detail.flagged), detail)
            } label: {
                Label(InspectorModel.flagLabel(detail.task), systemImage: detail.flagged ? "flag.fill" : "flag")
                    .foregroundStyle(detail.flagged ? .orange : detail.effectiveFlagged ? .orange.opacity(0.7) : .secondary)
            }
            .accessibilityIdentifier("inspector.flag")
            .accessibilityAddTraits(detail.flagged ? .isSelected : [])
            if let project = detail.project {
                SegmentedField(
                    label: "Project type",
                    options: [(ProjectType.parallel, "Parallel"), (.sequential, "Sequential"), (.singleActions, "Single Actions")],
                    selection: project.type
                ) { edit(.projectType($0), detail) }
            }
            if isGroup {
                SegmentedField(
                    label: "Group type", options: [(false, "Parallel"), (true, "Sequential")], selection: detail.sequential
                ) { edit(.sequential($0), detail) }
            }
            if detail.project != nil || isGroup {
                Toggle(
                    "Complete with last action",
                    isOn: Binding(get: { detail.completedByChildren }, set: { edit(.completedByChildren($0), detail) }))
            }
            if let project = detail.project {
                folderPicker(project, detail)
            } else {
                projectField(detail)
            }
        }
    }

    private func folderPicker(_ project: ProjectRecord, _ detail: TaskDetail) -> some View {
        Picker("Folder", selection: Binding(get: { project.folderId ?? "" }, set: { edit(.folder($0.isEmpty ? nil : $0), detail) })) {
            Text("No folder").tag("")
            ForEach(Entities.flattenTree(store.state.folders ?? [])) { node in
                Text(String(repeating: "    ", count: node.depth) + node.item.name).tag(node.item.id)
            }
        }
        .accessibilityIdentifier("inspector.folder")
    }

    @ViewBuilder
    private func projectField(_ detail: TaskDetail) -> some View {
        let projectId = InspectorModel.shownProjectId(detail.task)
        if let projectId, let project = store.state.projects?.first(where: { $0.id == projectId }) {
            LabeledContent("Project") {
                HStack(spacing: 0) {
                    Text(project.task.name).lineLimit(1)
                        .accessibilityIdentifier("inspector.project")
                    Button {
                        navigator.navigate(to: .projects(project: project.id, folder: nil))
                    } label: {
                        Image(systemName: "arrow.right.circle").frame(width: 44, height: 44)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Go to project")
                    Button {
                        store.setProject(nil, for: detail.task)
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary).frame(width: 44, height: 44)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Clear project")
                }
            }
        } else {
            LabeledContent("Project") {
                SmartMatchField(
                    label: "Project", placeholder: detail.inInbox ? "Inbox" : "No project",
                    items: Entities.projectChoices(store.state.projects, folders: store.state.folders),
                    identifier: "inspector.project-input",
                    onPick: { store.setProject($0.id, for: detail.task) },
                    onCreate: { name in store.setProject(store.createProject(named: name), for: detail.task) })
            }
        }
    }

    private func tagsSection(_ detail: TaskDetail) -> some View {
        let tags = Entities.byId(store.state.tags)
        return Section("Tags") {
            if !detail.tagIds.isEmpty {
                TagPills(pills: detail.tagIds.map { TagPills.Pill(id: $0, name: tags[$0]?.name ?? $0) }) { tagId in
                    store.removeTag(tagId, from: detail.id)
                }
            }
            SmartMatchField(
                label: "Add tag", placeholder: "Add tag",
                items: Entities.tagChoices(store.state.tags, excluding: detail.tagIds),
                identifier: "inspector.tag-input",
                onPick: { store.addTag($0.id, to: detail.id) },
                onCreate: { store.createTag(named: $0, addingTo: detail.id) })
        }
    }

    private func datesSection(_ detail: TaskDetail) -> some View {
        Section("Dates") {
            DurationField(value: detail.estimatedMinutes) { edit(.estimatedMinutes($0), detail) }
            ForEach([("Defer", DateField.defer), ("Planned", .planned), ("Due", .due)], id: \.1) { label, field in
                NaturalDateField(
                    label: label, field: field, value: InspectorModel.dateValue(detail.task, field),
                    effective: InspectorModel.effectiveDateValue(detail.task, field)
                ) { edit(.date(field, $0), detail) }
            }
            ReadOnlyDateRow(label: "Completed", value: detail.completed)
            ReadOnlyDateRow(label: "Dropped", value: detail.dropped)
            ReadOnlyDateRow(label: "Added", value: detail.added)
            ReadOnlyDateRow(label: "Changed", value: detail.modified)
        }
    }
}

/// A project's review schedule (spec §3 Review, `ReviewSchedule.tsx`): interval steps and unit, last reviewed, next
/// review (date only) and Mark Reviewed.
struct ReviewSection: View {
    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    let id: String
    let project: ProjectRecord

    var body: some View {
        Section("Review") {
            ReadOnlyDateRow(label: "Last review", value: project.lastReview)
            Stepper(
                value: Binding(
                    get: { project.reviewInterval.steps },
                    set: { patch(.reviewInterval(ReviewInterval(steps: max(1, $0), unit: project.reviewInterval.unit))) }),
                in: 1...999
            ) {
                Text("Every \(InspectorModel.formatInterval(project.reviewInterval))")
            }
            .accessibilityIdentifier("review.steps")
            Picker(
                "Unit",
                selection: Binding(
                    get: { project.reviewInterval.unit },
                    set: { patch(.reviewInterval(ReviewInterval(steps: project.reviewInterval.steps, unit: $0))) })
            ) {
                ForEach(InspectorModel.intervalUnits, id: \.self) { unit in
                    Text(InspectorModel.unitLabel(unit, steps: project.reviewInterval.steps)).tag(unit)
                }
            }
            NaturalDateField(label: "Next review", field: .defer, value: project.nextReview, dateOnly: true) {
                patch(.nextReview($0))
            }
            Button {
                PagesModel.shared.markReviewedAndAdvance(id, store: store, navigator: navigator)
            } label: {
                Label("Mark Reviewed", systemImage: "checkmark.circle")
            }
            .accessibilityIdentifier("review.mark")
        }
    }

    private func patch(_ edit: InspectorEdit) {
        if let patch = edit.projectPatch { store.patchProject(id, patch) }
    }
}
