// Author: John Grimes

import PranaKit
import SwiftUI

/// One outline row (port of `Row.tsx`, spec §3 Row): disclosure, status circle, title (or its inline editor), project,
/// tag pills, date chips, indicators, flag toggle and the "•••" menu. In reorder mode the list adds its drag handles.
struct OutlineRowView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.horizontalSizeClass) private var sizeClass

    let row: DisplayRow
    let controller: OutlineController
    /// Folder path shown before a project header's title.
    var subtitle: String?
    var selected: Bool
    var editing: Bool
    var disclosureColumn: Bool
    /// Reorder mode: the list's move handles take the trailing edge, so the "•••" menu steps aside.
    var reordering: Bool
    /// Clean Up will remove this row from the view; it is greyed out until then.
    var leaving: Bool
    var collapsed: Bool
    var showProject: Bool
    /// Edit mode (multi-select): taps select the row instead of reaching its controls.
    var selecting = false

    private var outlineRow: OutlineRow { row.row }
    private var task: TaskItem? { OutlineController.task(of: outlineRow) }
    private var title: String { OutlineController.title(of: outlineRow) }
    private var isProject: Bool { outlineRow.kind == .project }
    private var isFolder: Bool { outlineRow.kind == .folder }
    private var done: Bool { task.map { $0.completed != nil || $0.dropped != nil } ?? false }

    var body: some View {
        if canDrag {
            columns.draggable(TaskDragItem(ids: controller.dragIds(for: row), label: title)) { dragPreview }
        } else {
            columns
        }
    }

    private var columns: some View {
        HStack(alignment: .top, spacing: 2) {
            Color.clear.frame(width: CGFloat(min(outlineRow.depth, 12)) * 18)
            if disclosureColumn { disclosure }
            leading.opacity(leaving ? 0.5 : 1)
            content
                .opacity(leaving ? 0.5 : 1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 10)
            if let task { flagButton(task).opacity(leaving ? 0.5 : 1) }
            if sizeClass == .regular && !reordering { moreMenu }
        }
        .frame(minHeight: 48)
        .allowsHitTesting(!selecting)
        .accessibilityValue(leaving ? "Leaving on Clean Up" : "")
    }

    // MARK: Parts

    private var disclosure: some View {
        ZStack {
            if row.hasChildren {
                Button {
                    controller.setCollapsed(row, !collapsed)
                } label: {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(OutlinePalette.muted)
                        .frame(width: 22, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(collapsed ? "Expand \(title)" : "Collapse \(title)")
                .accessibilityIdentifier("disclosure")
            }
        }
        .frame(width: 20, height: 44)
    }

    @ViewBuilder private var leading: some View {
        if let task {
            StatusCircle(task: task, isProject: isProject, label: title) { controller.toggleComplete(outlineRow) }
        } else {
            Image(systemName: isFolder ? "folder" : "tag")
                .foregroundStyle(OutlinePalette.muted)
                .frame(width: 44, height: 44)
        }
    }

    @ViewBuilder private var content: some View {
        VStack(alignment: .leading, spacing: 4) {
            if editing {
                TitleEditor(initial: title, label: "Title of \(title.isEmpty ? "new item" : title)") { text, then in
                    controller.commitEdit(outlineRow, text: text, then: then)
                } operation: { op in
                    controller.outlineOperation(op)
                }
            } else {
                titleLine
            }
            if let task { details(task) }
        }
    }

    private var titleLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let subtitle {
                Text("\(subtitle) :").font(.subheadline).foregroundStyle(OutlinePalette.muted).lineLimit(1)
            }
            // Phones edit a tapped title at once; on iPad (pointer) the first tap selects the row and a tap on the
            // selected row's title edits it. A plain button keeps the rest of the row for list selection and the
            // title in the label colour rather than the tint.
            if sizeClass == .compact || selected {
                Button {
                    controller.startEditing(row)
                } label: {
                    titleText
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("row-title")
            } else {
                titleText.accessibilityIdentifier("row-title")
            }
        }
    }

    private var titleText: some View {
        Text(title.isEmpty ? "Untitled" : title)
            .fontWeight(isProject || isFolder ? .semibold : task != nil && row.hasChildren ? .medium : .regular)
            .italic(title.isEmpty)
            .strikethrough(done)
            .multilineTextAlignment(.leading)
            .foregroundStyle(
                done || title.isEmpty || (task?.status == .blocked && !isProject) ? AnyShapeStyle(OutlinePalette.muted) : AnyShapeStyle(.primary)
            )
    }

    @ViewBuilder private func details(_ task: TaskItem) -> some View {
        let badges = RowBadges(task)
        let tags = task.tagIds.compactMap { id in store.state.tags?.first { $0.id == id } }
        let projectLabel = showProject && !isProject && (task.projectName != nil || task.inInbox)
        let summary = isProject ? outlineRow.project.map(RowBadges.projectSummary) : nil
        if projectLabel || !tags.isEmpty || badges.due != nil || badges.deferUntil != nil || badges.repeats || badges.hasNote
            || badges.attachmentCount > 0 || summary != nil
        {
            FlowLayout(spacing: 6, lineSpacing: 4) {
                if projectLabel {
                    Label(task.inInbox ? "Inbox" : task.projectName ?? "", systemImage: task.inInbox ? "tray" : "circle.grid.2x1")
                        .labelStyle(.chip)
                        .font(.caption)
                        .foregroundStyle(OutlinePalette.muted)
                        .lineLimit(1)
                        .accessibilityIdentifier("row-project")
                }
                ForEach(tags) { tag in
                    TagPill(name: tag.name, rowTitle: title) { controller.removeTag(tag.id, from: outlineRow) }
                }
                if let due = badges.due {
                    DateChipView(chip: due, label: "Due", systemImage: "clock", settings: store.settings)
                        .accessibilityIdentifier("due-chip")
                }
                if let deferUntil = badges.deferUntil {
                    DateChipView(chip: deferUntil, label: "Deferred until", systemImage: "calendar", settings: store.settings)
                        .accessibilityIdentifier("defer-chip")
                }
                if badges.repeats { indicator("repeat", "Repeats") }
                if badges.hasNote { indicator("note.text", "Has note") }
                if badges.attachmentCount > 0 { indicator("paperclip", "\(badges.attachmentCount) attachments") }
                if let summary, let project = outlineRow.project {
                    Label(summary, systemImage: project.type == .sequential ? "arrow.down.to.line" : project.type == .singleActions ? "list.bullet" : "circle.grid.2x1")
                        .labelStyle(.chip)
                        .font(.caption)
                        .foregroundStyle(OutlinePalette.muted)
                }
            }
        }
    }

    private func indicator(_ systemImage: String, _ label: String) -> some View {
        Image(systemName: systemImage)
            .font(.caption)
            .foregroundStyle(OutlinePalette.muted)
            .accessibilityLabel(label)
    }

    @ViewBuilder private func flagButton(_ task: TaskItem) -> some View {
        let badges = RowBadges(task)
        // Unflagged rows show the toggle on iPad (pointer) and when selected; implied flags show as an outline.
        if badges.flag != .none || selected || sizeClass == .regular {
            Button {
                controller.toggleFlag(outlineRow)
            } label: {
                Image(systemName: badges.flag == .own ? "flag.fill" : "flag")
                    .foregroundStyle(badges.flag == .none ? OutlinePalette.faint : OutlinePalette.flag)
                    .opacity(badges.flag == .implied ? 0.8 : 1)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(task.flagged ? "Unflag \(title)" : "Flag \(title)")
            .accessibilityValue(badges.flag == .implied ? "Flagged by its container" : "")
            .accessibilityIdentifier("flag-toggle")
        }
    }

    private var moreMenu: some View {
        Menu {
            OutlineRowMenu(row: row, controller: controller)
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(OutlinePalette.muted)
                .frame(width: 40, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("More actions for \(title)")
        .accessibilityIdentifier("row-menu")
    }

    /// iPad: an action row drags to sidebar projects, tags and the inbox (the dragged selection's ids).
    private var canDrag: Bool {
        !reordering && !selecting && outlineRow.kind == .task && sizeClass == .regular && !AppStore.isOccurrenceStandIn(outlineRow.id)
    }

    private var dragPreview: some View {
        let ids = controller.dragIds(for: row)
        let name = title.isEmpty ? "Untitled" : title
        return Text(ids.count > 1 ? "\(name) (+\(ids.count - 1))" : name)
            .font(.subheadline)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .foregroundStyle(OutlinePalette.accentText)
            .background(OutlinePalette.accent, in: .rect(cornerRadius: 10))
    }
}

/// The row's actions, shared by the "•••" menu and the context menu (touch equivalents of the editing keys).
struct OutlineRowMenu: View {
    let row: DisplayRow
    let controller: OutlineController

    var body: some View {
        let outlineRow = row.row
        let task = OutlineController.task(of: outlineRow)
        if let task {
            Button(task.completed == nil ? "Complete" : "Mark Incomplete", systemImage: "checkmark.circle") {
                controller.toggleComplete(outlineRow)
            }
            Button(task.flagged ? "Unflag" : "Flag", systemImage: task.flagged ? "flag.slash" : "flag") {
                controller.toggleFlag(outlineRow)
            }
            Button("New Action", systemImage: "plus") {
                controller.createItem(relativeTo: row, outlineRow.kind == .project ? .child : .after)
            }
        }
        if outlineRow.kind == .task {
            Section {
                Button("Indent", systemImage: "increase.indent") { run(.indent) }
                Button("Outdent", systemImage: "decrease.indent") { run(.outdent) }
                Button("Move Up", systemImage: "arrow.up") { run(.moveUp) }
                Button("Move Down", systemImage: "arrow.down") { run(.moveDown) }
                Button("Group", systemImage: "folder.badge.plus") { run(.group) }
                if row.hasChildren { Button("Ungroup", systemImage: "folder.badge.minus") { run(.ungroup) } }
            }
        }
        Section {
            Button(Self.deleteLabel(outlineRow.kind), systemImage: "trash", role: .destructive) {
                controller.deleteKeys([OutlineRowKey.key(outlineRow)])
            }
        }
    }

    /// Runs an outline operation on this row (or the selection when the row is part of it).
    private func run(_ op: OutlineOperation) {
        if !controller.selectedKeys.contains(row.row.id) { controller.select([row.row.id]) }
        controller.outlineOperation(op)
    }

    static func deleteLabel(_ kind: RowKind) -> String {
        switch kind {
        case .project: "Delete Project"
        case .folder: "Delete Folder"
        case .tag: "Delete Tag"
        default: "Delete"
        }
    }
}

/// The inline title editor (`TitleEditor` in `Row.tsx`). Return adds a sibling below; Shift-Return, Escape and
/// leaving the field stop editing; Tab / Shift-Tab indent / outdent and keep editing. The keyboard toolbar offers the
/// same restructuring by touch.
struct TitleEditor: View {
    let initial: String
    let label: String
    let onCommit: (String, OutlineController.EditThen) -> Void
    let operation: (OutlineOperation) -> Void

    @State private var text: String
    @State private var done = false
    @FocusState private var focused: Bool

    init(
        initial: String, label: String, onCommit: @escaping (String, OutlineController.EditThen) -> Void,
        operation: @escaping (OutlineOperation) -> Void
    ) {
        self.initial = initial
        self.label = label
        self.onCommit = onCommit
        self.operation = operation
        _text = State(initialValue: initial)
    }

    var body: some View {
        TextField("Title", text: $text)
            .textFieldStyle(.plain)
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(OutlinePalette.accent, lineWidth: 2))
            .focused($focused)
            .submitLabel(.next)
            .accessibilityLabel(label)
            .accessibilityIdentifier("row-title-input")
            .onAppear { focused = true }
            .onSubmit { commit(.after) }
            .onKeyPress(.return, phases: .down) { press in
                guard press.modifiers.contains(.shift) || press.modifiers.contains(.command) else { return .ignored }
                commit(.stop)
                return .handled
            }
            .onKeyPress(.escape) {
                commit(.stop)
                return .handled
            }
            .onKeyPress(.tab, phases: .down) { press in
                commit(press.modifiers.contains(.shift) ? .outdent : .indent)
                return .handled
            }
            .onChange(of: focused) { _, isFocused in
                if !isFocused { commit(.stop) }
            }
            .toolbar {
                if focused {
                    ToolbarItemGroup(placement: .keyboard) {
                        Button("Outdent", systemImage: "decrease.indent") { commit(.outdent) }
                            .accessibilityIdentifier("keyboard-outdent")
                        Button("Indent", systemImage: "increase.indent") { commit(.indent) }
                            .accessibilityIdentifier("keyboard-indent")
                        Button("Move Up", systemImage: "arrow.up") { operation(.moveUp) }
                        Button("Move Down", systemImage: "arrow.down") { operation(.moveDown) }
                        Spacer()
                        Button("Done") { commit(.stop) }
                            .accessibilityIdentifier("keyboard-done")
                    }
                }
            }
    }

    private func commit(_ then: OutlineController.EditThen) {
        guard !done else { return }
        // Indent/outdent keep editing the same row, so the editor stays live for the next commit.
        if then != .indent && then != .outdent { done = true }
        onCommit(text, then)
    }
}
