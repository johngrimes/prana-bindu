// Author: John Grimes

import PranaKit
import SwiftUI

/// PranaKit's group, not SwiftUI's disclosure `OutlineGroup`.
private typealias OutlineGroup = PranaKit.OutlineGroup

/// What an outline needs to know about where it is shown.
struct OutlineContext {
    /// The perspective shown (nil while loading).
    var perspective: Perspective?
    /// The contents being shown (set as the store's active outline for undo snapshots and previews).
    var contentsKey: ContentsKey
    /// Whether rows Clean Up will remove are greyed (spec §3).
    var greysCleanUp: Bool = true
    /// Whether rows can be dragged to reorder.
    var reorderMode: Bool = false
    /// The window's selection, shared with the inspector.
    var selection: SelectionModel
    /// Where "New item" goes when nothing is selected; nil opens Quick Entry. Defaults from the contents.
    var newItemTarget: NewItemTarget?
    /// Whether rows show their project; defaults to outside Projects, Inbox and Review.
    var showsProject: Bool
    /// The outline's name for VoiceOver.
    var label: String
    /// The server's rows when they do not come from `store.base.contents[contentsKey]` (the Forecast's days from
    /// `/forecast`). The outline previews pending writes over them, greys and keeps rows against them.
    var serverGroups: [PranaKit.OutlineGroup]?

    /// Creates a context; the new-item target and project column follow the contents unless given.
    init(
        perspective: Perspective?, contentsKey: ContentsKey, greysCleanUp: Bool = true, reorderMode: Bool = false,
        selection: SelectionModel, newItemTarget: NewItemTarget?? = nil, showsProject: Bool? = nil, label: String? = nil,
        serverGroups: [PranaKit.OutlineGroup]? = nil
    ) {
        self.perspective = perspective
        self.contentsKey = contentsKey
        self.greysCleanUp = greysCleanUp
        self.reorderMode = reorderMode
        self.selection = selection
        self.newItemTarget = newItemTarget ?? NewItemTarget(contents: contentsKey)
        self.showsProject = showsProject ?? OutlinePresentation.showsProject(contentsKey)
        self.label = label ?? perspective?.name ?? "Outline"
        self.serverGroups = serverGroups
    }
}

/// An evaluated outline with editing (spec §3 Row, Editing and Reorder mode; port of `Outline.tsx`). Shows the
/// contents with rows kept until Clean Up, greys rows Clean Up will remove, and offers every row action by tap,
/// swipe, context menu, row menu and hardware keyboard. Registers New item and Clean Up with the shell while shown.
struct OutlineView: View {
    let contents: OutlineContents
    let context: OutlineContext

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var controller: OutlineController?
    @State private var editMode: EditMode = .inactive

    var body: some View {
        Group {
            if let controller {
                outline(controller)
            } else {
                Color.clear
            }
        }
        .onAppear(perform: appear)
        .onDisappear {
            guard let controller else { return }
            controller.stop()
            navigator.withdrawOutline(ObjectIdentifier(controller))
        }
    }

    private func appear() {
        let controller = controller ?? OutlineController(store: store, contentsKey: context.contentsKey, selection: context.selection)
        controller.navigator = navigator
        controller.selectionModel = context.selection
        controller.newItemTarget = context.newItemTarget
        controller.serverOverride = context.serverGroups
        controller.start()
        self.controller = controller
        store.activeContentsKey = context.contentsKey
        navigator.outline = OutlineCommands(
            owner: ObjectIdentifier(controller),
            newItem: { [controller] in controller.newItem() },
            leaving: { [controller] in controller.leavingChanges() })
    }

    @ViewBuilder private func outline(_ controller: OutlineController) -> some View {
        let snapshot = controller.snapshot(context.serverGroups.map(controller.previewed) ?? contents.groups)
        let selectedKeys = Set(context.selection.selection.ids.map { id in
            switch context.selection.selection.kind {
            case .folder: "folder:\(id)"
            case .tag: "tag:\(id)"
            default: id
            }
        })
        let selection = Binding<Set<String>>(
            get: { Set(snapshot.flat.filter { selectedKeys.contains(OutlineRowKey.key($0.row)) }.map(\.id)) },
            set: { ids in
                let keys = snapshot.flat.filter { ids.contains($0.id) }.map { OutlineRowKey.key($0.row) }
                var seen = Set<String>()
                let unique = keys.filter { seen.insert($0).inserted }
                if unique != controller.selectedKeys {
                    controller.editingId = nil
                    controller.select(unique)
                    if unique.count == 1, editMode == .inactive, navigator.isCompact { navigator.showInspector() }
                }
            })
        // Reorder mode is the list's own move mode: drag handles at the trailing edge of action rows, a drag from a
        // handle starts at once, and dropping between rows reorders or re-parents (before the row below).
        List(selection: context.reorderMode ? nil : selection) {
            ForEach(snapshot.display) { group in
                if !group.rows.isEmpty {
                    Section {
                        ForEach(group.rows) { row in
                            rowView(row, controller: controller, snapshot: snapshot, selectedKeys: selectedKeys, group: group.group)
                                .moveDisabled(row.row.kind != .task || AppStore.isOccurrenceStandIn(row.row.id))
                        }
                        .onMove(perform: context.reorderMode ? { from, to in
                            controller.moveRows(from, to: to, rows: group.rows)
                        } : nil)
                    } header: {
                        if showsHeader(group.group, count: snapshot.display.count) { header(group.group) }
                    }
                }
            }
        }
        .listStyle(.plain)
        .environment(\.editMode, context.reorderMode ? .constant(.active) : $editMode)
        .accessibilityLabel(context.label)
        .accessibilityIdentifier("outline")
        .overlay {
            if snapshot.flat.isEmpty {
                ContentUnavailableView(OutlinePresentation.emptyText(contents), systemImage: "checkmark.circle")
                    .accessibilityIdentifier("empty-state")
            }
        }
        .toolbar { editModeToolbar(controller) }
        // The phone's tab bar would cover the selection's bottom bar (Complete … Inspect, Delete).
        .toolbar(editMode.isEditing ? .hidden : .automatic, for: .tabBar)
        .background {
            OutlineKeyCatcher(claim: keyboardClaim(controller)) { key, modifiers in
                handleKey(key, modifiers: modifiers, controller: controller)
            }
        }
        .onChange(of: context.contentsKey, initial: false) { _, key in
            controller.show(key)
            store.activeContentsKey = key
        }
        .onChange(of: store.base.contents[context.contentsKey]?.groups) { controller.serverChanged() }
        .onChange(of: context.serverGroups) { _, groups in
            controller.serverOverride = groups
            controller.serverChanged()
        }
        .onChange(of: store.stickyEpoch) { controller.syncEpochs() }
        .onChange(of: store.journalEpoch) { controller.syncEpochs() }
        .onChange(of: context.newItemTarget) { _, target in controller.newItemTarget = target }
    }

    // MARK: Rows

    @ViewBuilder
    private func rowView(
        _ row: DisplayRow, controller: OutlineController, snapshot: OutlineController.Snapshot, selectedKeys: Set<String>, group: OutlineGroup
    ) -> some View {
        let key = OutlineRowKey.key(row.row)
        let selected = selectedKeys.contains(key)
        let standIn = AppStore.isOccurrenceStandIn(row.row.id)
        let task = OutlineController.task(of: row.row)
        OutlineRowView(
            row: row, controller: controller, subtitle: projectFolderPrefix(row, group: group), selected: selected,
            editing: controller.editingId == row.row.id && (selected || selectedKeys.isEmpty),
            disclosureColumn: snapshot.disclosureColumn, reordering: context.reorderMode,
            leaving: context.greysCleanUp && snapshot.leaving.contains(row.id), collapsed: controller.isCollapsed(row),
            showProject: context.showsProject, selecting: editMode.isEditing
        )
        .tag(row.id)
        .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
        .listRowBackground(rowBackground(row, selected: selected))
        // A finished occurrence's stand-in cannot be used until the server's copy replaces it.
        .disabled(standIn)
        .selectionDisabled(standIn)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if let task {
                Button {
                    controller.toggleComplete(row.row)
                } label: {
                    Label(task.completed == nil ? "Complete" : "Incomplete", systemImage: "checkmark")
                }
                .tint(OutlinePalette.accent)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                controller.deleteKeys([key])
            } label: {
                Label("Delete", systemImage: "trash")
            }
            if let task {
                Button {
                    controller.toggleFlag(row.row)
                } label: {
                    Label(task.flagged ? "Unflag" : "Flag", systemImage: "flag")
                }
                .tint(OutlinePalette.flag)
            }
        }
        // While reordering, a long press starts the list's move rather than the menu.
        .contextMenu { if !context.reorderMode { OutlineRowMenu(row: row, controller: controller) } }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(OutlineController.title(of: row.row).isEmpty ? "Untitled" : OutlineController.title(of: row.row))
        .accessibilityIdentifier("row.\(row.row.id)")
    }

    private func rowBackground(_ row: DisplayRow, selected: Bool) -> some View {
        selected ? OutlinePalette.select : Color(uiColor: .systemBackground)
    }

    /// The folder path before a project group's header row (from the cached folders, so renames show at once).
    private func projectFolderPrefix(_ row: DisplayRow, group: OutlineGroup) -> String? {
        guard group.kind == .project, row.row.kind == .project else { return nil }
        guard let folders = store.state.folders else {
            guard let range = group.title.range(of: " : ", options: .backwards) else { return nil }
            return String(group.title[..<range.lowerBound])
        }
        var names: [String] = []
        var id = row.row.project?.folderId
        var seen = Set<String>()
        while let current = id, seen.insert(current).inserted, let folder = folders.first(where: { $0.id == current }) {
            names.insert(folder.name, at: 0)
            id = folder.parentId
        }
        return names.isEmpty ? nil : names.joined(separator: " : ")
    }

    // MARK: Group headers

    private func showsHeader(_ group: OutlineGroup, count: Int) -> Bool {
        !group.title.isEmpty && group.kind != .project && !(count == 1 && group.kind == .none)
    }

    private func header(_ group: OutlineGroup) -> some View {
        let title = group.kind == .tag ? (store.state.tags?.first { $0.id == group.key }?.name ?? group.title) : group.title
        return HStack(spacing: 6) {
            if group.kind == .tag { Image(systemName: "tag").foregroundStyle(OutlinePalette.muted) }
            if group.kind == .date { Image(systemName: "calendar").foregroundStyle(OutlinePalette.muted) }
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
        }
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("group-header")
        .dropDestination(for: TaskDragItem.self) { items, _ in
            guard group.kind == .tag, group.key != "untagged" else { return false }
            store.tagDraggedTasks(items.flatMap(\.ids), tagId: group.key)
            return true
        }
    }

    // MARK: Multi-select (Edit mode)

    @ToolbarContentBuilder
    private func editModeToolbar(_ controller: OutlineController) -> some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button(editMode.isEditing ? "Done" : "Select") {
                controller.editingId = nil
                withAnimation { editMode = editMode.isEditing ? .inactive : .active }
            }
            .accessibilityIdentifier("outline-select")
        }
        if editMode.isEditing {
            ToolbarItemGroup(placement: .bottomBar) {
                Button("Complete", systemImage: "checkmark.circle") { controller.completeSelection() }
                Button("Flag", systemImage: "flag") { controller.flagSelection() }
                Button("Outdent", systemImage: "decrease.indent") { controller.outlineOperation(.outdent) }
                Button("Indent", systemImage: "increase.indent") { controller.outlineOperation(.indent) }
                Button("Group", systemImage: "folder.badge.plus") { controller.outlineOperation(.group) }
                Button("Inspect", systemImage: "info.circle") { navigator.showInspector() }
                Button("Delete", systemImage: "trash", role: .destructive) { controller.deleteSelection() }
            }
        }
    }

    // MARK: Keyboard (spec §2)

    /// When the outline takes the hardware keyboard: whenever the selection changes or title editing ends, unless a
    /// title is being edited or a sheet is open.
    private func keyboardClaim(_ controller: OutlineController) -> AnyHashable? {
        guard controller.editingId == nil, !navigator.overlayOpen else { return nil }
        return AnyHashable(controller.selectedKeys)
    }

    private func handleKey(_ key: OutlineKey, modifiers: UIKeyModifierFlags, controller: OutlineController) -> Bool {
        guard controller.editingId == nil, !navigator.overlayOpen else { return false }
        let hasSelection = !controller.selectedKeys.isEmpty
        if key == .escape, !hasSelection, navigator.reordering {
            navigator.reordering = false
            return true
        }
        guard
            let command = OutlineKeyCommand.command(
                for: key, shift: modifiers.contains(.shift), alt: modifiers.contains(.alternate),
                command: modifiers.contains(.command), hasSelection: hasSelection)
        else { return false }
        controller.perform(command)
        return true
    }
}
