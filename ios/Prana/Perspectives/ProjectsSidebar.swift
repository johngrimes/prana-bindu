// Author: John Grimes

import PranaKit
import SwiftUI

/// The Projects sidebar (spec §4 Projects): Inbox, All Projects and the folder tree with projects (type icons, on hold
/// dimmed with a badge, dropped shown only with Everything). Selecting a folder or project filters the content. Rename
/// from the context menu; Reorder (or "Move to") re-orders and re-parents; "New" adds projects and folders.
struct ProjectsSidebar: View {
    let showDropped: Bool
    let selectedProject: String?
    let selectedFolder: String?

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    @State private var renaming: RenameTarget?
    @State private var renameText = ""
    @State private var editMode: EditMode = .inactive

    private var folders: [Folder] { store.state.folders ?? [] }

    private var entries: [SidebarTree.ProjectsEntry] {
        SidebarTree.projectEntries(folders: folders, projects: store.state.projects ?? [], showDropped: showDropped)
    }

    var body: some View {
        let entries = entries
        List {
            Section {
                SidebarRow(icon: "tray", label: "Inbox") { navigator.navigate(to: .inbox) }
                    .taskDropTarget { ids in store.moveDraggedTasks(ids, toProject: nil) }
                    .accessibilityIdentifier("sidebar-inbox")
                SidebarRow(icon: "folder.badge.gearshape", label: "All Projects", active: selectedProject == nil && selectedFolder == nil) {
                    navigator.navigate(to: .projects(project: nil, folder: nil))
                }
                .accessibilityIdentifier("sidebar-all-projects")
            }
            Section {
                ForEach(entries) { entry in row(entry) }
                    .onMove { from, to in
                        guard let index = from.first,
                            let move = SidebarTree.projectsMove(entries, from: index, to: to, folders: folders)
                        else { return }
                        apply(move)
                    }
            }
        }
        .listStyle(.sidebar)
        .environment(\.editMode, $editMode)
        .safeAreaInset(edge: .bottom) { bottomBar }
        .renameAlert($renaming, text: $renameText) { target, name in
            if target.kind == .folder {
                store.patchFolder(target.id, FolderPatch(name: name))
            } else {
                store.patchProject(target.id, ProjectPatch(name: name))
            }
        }
        .accessibilityIdentifier("projects-sidebar")
    }

    @ViewBuilder private func row(_ entry: SidebarTree.ProjectsEntry) -> some View {
        switch entry {
        case .folder(let folder, let depth):
            SidebarRow(icon: "folder", label: folder.name, depth: depth, dimmed: !folder.effectiveActive, active: selectedFolder == folder.id) {
                navigator.navigate(to: .projects(project: nil, folder: folder.id))
                navigator.selection.selection = Selection(ids: [folder.id], kind: .folder)
            }
            .contextMenu { menu(id: folder.id, name: folder.name, isFolder: true) }
            .accessibilityIdentifier("sidebar-folder-\(folder.id)")
        case .project(let project, let depth):
            SidebarRow(
                icon: PageIcons.project(project.type), label: project.task.name, depth: depth,
                dimmed: project.effectiveStatus != .active, onHold: project.effectiveStatus == .onHold, count: project.availableCount,
                active: selectedProject == project.id
            ) {
                navigator.navigate(to: .projects(project: project.id, folder: nil))
            }
            .contextMenu { menu(id: project.id, name: project.task.name, isFolder: false) }
            .taskDropTarget { ids in store.moveDraggedTasks(ids, toProject: project.id) }
            .accessibilityIdentifier("sidebar-project-\(project.id)")
        }
    }

    @ViewBuilder private func menu(id: String, name: String, isFolder: Bool) -> some View {
        Button("Inspect", systemImage: "info.circle") { navigator.inspect(id, kind: isFolder ? .folder : .project) }
        Button("Rename", systemImage: "pencil") { rename(RenameTarget(kind: isFolder ? .folder : .project, id: id, name: name)) }
        Menu("Move to", systemImage: "folder") {
            Button("Top Level") { move(id, isFolder: isFolder, into: nil) }
            let parents = SidebarTree.parents(of: folders)
            ForEach(folders.filter { $0.effectiveActive && !(isFolder && SidebarTree.isDescendant($0.id, of: id, parents: parents)) }) { folder in
                Button(SidebarTree.folderPath(folder.id, folders: folders)) { move(id, isFolder: isFolder, into: folder.id) }
            }
        }
    }

    private var bottomBar: some View {
        HStack {
            Menu {
                Button("New Parallel Project", systemImage: PageIcons.project(.parallel)) { newProject(.parallel) }
                    .accessibilityIdentifier("new-parallel-project")
                Button("New Sequential Project", systemImage: PageIcons.project(.sequential)) { newProject(.sequential) }
                    .accessibilityIdentifier("new-sequential-project")
                Button("New Single Action List", systemImage: PageIcons.project(.singleActions)) { newProject(.singleActions) }
                    .accessibilityIdentifier("new-single-action-list")
                Button("New Folder", systemImage: "folder.badge.plus", action: newFolder)
                    .accessibilityIdentifier("new-folder")
            } label: {
                Label("New", systemImage: "plus").frame(minHeight: 44)
            }
            .accessibilityIdentifier("sidebar-new")
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

    private func rename(_ target: RenameTarget) {
        renameText = target.name
        renaming = target
    }

    private func apply(_ move: SidebarTree.ContainerMove) {
        if move.isFolder {
            store.moveFolder(move.id, parentId: move.parentId, position: move.position)
        } else {
            store.moveProject(move.id, parentId: move.parentId, position: move.position)
        }
    }

    private func move(_ id: String, isFolder: Bool, into parentId: String?) {
        apply(SidebarTree.ContainerMove(id: id, isFolder: isFolder, parentId: parentId, position: .end))
    }

    private func newProject(_ type: ProjectType) {
        let id = store.createProject(ProjectCreate(name: "Untitled Project", type: type, folderId: .some(selectedFolder)))
        navigator.navigate(to: .projects(project: id, folder: nil))
        navigator.selection.selection = Selection(ids: [id], kind: .project)
    }

    private func newFolder() {
        let id = store.createFolder(name: "Untitled Folder", parentId: selectedFolder)
        rename(RenameTarget(kind: .folder, id: id, name: "Untitled Folder"))
    }
}
