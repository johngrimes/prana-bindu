// Author: John Grimes

import PranaKit
import SwiftUI

/// The Tags sidebar (spec §4 Tags): All Tags, the tag tree and Untagged. On Tags, a tag is the route's `?tag=`; on
/// Flagged, Completed, Changed and custom perspectives it filters the page's contents. Tags can be renamed, re-ordered
/// and nested; Tags itself offers New Tag.
struct TagsSidebar: View {
    /// The perspective whose contents the tag filters.
    let perspectiveId: String
    let showDropped: Bool
    let allowCreate: Bool
    /// The selected tag id (`untagged` for Untagged).
    let selected: String?

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    @State private var renaming: RenameTarget?
    @State private var renameText = ""
    @State private var editMode: EditMode = .inactive

    private var tags: [PranaKit.Tag] { store.state.tags ?? [] }

    var body: some View {
        let entries = SidebarTree.tagEntries(tags, showDropped: showDropped)
        List {
            Section {
                SidebarRow(icon: "tag.square", label: "All Tags", active: selected == nil) { choose(nil) }
                    .accessibilityIdentifier("sidebar-all-tags")
            }
            Section {
                ForEach(entries) { entry in
                    let tag = entry.tag
                    SidebarRow(
                        icon: "tag", label: tag.name, depth: entry.depth, dimmed: tag.effectiveStatus != .active,
                        onHold: tag.effectiveStatus == .onHold, count: tag.availableCount, active: selected == tag.id
                    ) {
                        choose(tag.id)
                        navigator.selection.selection = Selection(ids: [tag.id], kind: .tag)
                    }
                    .contextMenu { menu(tag) }
                    .taskDropTarget { ids in store.tagDraggedTasks(ids, tagId: tag.id) }
                    .accessibilityIdentifier("sidebar-tag-\(tag.id)")
                }
                .onMove { from, to in
                    guard let index = from.first, let move = SidebarTree.tagMove(entries, from: index, to: to, tags: tags) else { return }
                    store.moveTag(move.id, parentId: move.parentId, position: move.position)
                }
            }
            Section {
                SidebarRow(icon: "tag.slash", label: "Untagged", active: selected == "untagged") { choose("untagged") }
                    .accessibilityIdentifier("sidebar-untagged")
            }
        }
        .listStyle(.sidebar)
        .environment(\.editMode, $editMode)
        .safeAreaInset(edge: .bottom) { bottomBar }
        .renameAlert($renaming, text: $renameText) { target, name in
            store.patchTag(target.id, TagPatch(name: name))
        }
        .accessibilityIdentifier("tags-sidebar")
    }

    @ViewBuilder private func menu(_ tag: PranaKit.Tag) -> some View {
        Button("Inspect", systemImage: "info.circle") { navigator.inspect(tag.id, kind: .tag) }
        Button("Rename", systemImage: "pencil") { rename(RenameTarget(kind: .tag, id: tag.id, name: tag.name)) }
        Menu("Move to", systemImage: "tag") {
            Button("Top Level") { store.moveTag(tag.id, parentId: nil, position: .end) }
            let parents = SidebarTree.parents(of: tags)
            ForEach(tags.filter { $0.effectiveStatus != .dropped && !SidebarTree.isDescendant($0.id, of: tag.id, parents: parents) }) { parent in
                Button(parent.name) { store.moveTag(tag.id, parentId: parent.id, position: .end) }
            }
        }
    }

    private var bottomBar: some View {
        HStack {
            if allowCreate {
                Button("New Tag", systemImage: "plus", action: newTag)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("new-tag")
            }
            Spacer()
            Button(editMode.isEditing ? "Done" : "Reorder") {
                withAnimation { editMode = editMode.isEditing ? .inactive : .active }
            }
            .frame(minHeight: 44)
            .accessibilityIdentifier("sidebar-reorder")
        }
        .padding(.horizontal, 16)
        .background(.bar)
    }

    /// Shows a tag's items: the route on Tags, the page's tag filter elsewhere.
    private func choose(_ tag: String?) {
        if perspectiveId == "tags" {
            navigator.navigate(to: .tags(tag: tag))
        } else {
            PagesModel.shared.tagFilter[perspectiveId] = tag
            navigator.selection.selection = .none
            navigator.showsDrawer = false
        }
    }

    private func rename(_ target: RenameTarget) {
        renameText = target.name
        renaming = target
    }

    private func newTag() {
        let id = store.createTag(name: "Untitled Tag")
        rename(RenameTarget(kind: .tag, id: id, name: "Untitled Tag"))
    }
}
