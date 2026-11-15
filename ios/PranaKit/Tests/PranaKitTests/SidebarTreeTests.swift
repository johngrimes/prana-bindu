// Author: John Grimes

import Testing

@testable import PranaKit

/// Sidebar trees and moves (`ProjectsSidebar` and `TagsSidebar` in `src/web/components/Sidebars.tsx`).
@Suite struct SidebarTreeTests {
    private func project(_ id: String, folder: String? = nil, rank: Double, status: ProjectStatus = .active) -> Project {
        Project(
            record: ProjectRecord(id: id, folderId: folder, status: status, effectiveStatus: status),
            task: TaskItem(id: id, name: id, isProject: true, rank: rank))
    }

    private let folders = [
        Folder(id: "f1", name: "Work", rank: 2),
        Folder(id: "f2", name: "Old", rank: 0, status: .dropped, effectiveActive: false),
        Folder(id: "f3", name: "Sub", parentId: "f1", rank: 1),
    ]

    private var projects: [Project] {
        [
            project("p1", rank: 1), project("p2", folder: "f1", rank: 0), project("p3", folder: "f3", rank: 0),
            project("p4", folder: "f1", rank: 5, status: .dropped), project("p5", rank: 3, status: .onHold),
            project("p6", folder: "f2", rank: 0),
        ]
    }

    private func labels(_ entries: [SidebarTree.ProjectsEntry]) -> [String] {
        entries.map { entry in
            switch entry {
            case .folder(let f, let depth): "\(depth)F\(f.id)"
            case .project(let p, let depth): "\(depth)P\(p.id)"
            }
        }
    }

    @Test func projectsTreeInterleavesFoldersAndProjectsByRankAndHidesDroppedAndCompleted() {
        let entries = SidebarTree.projectEntries(folders: folders, projects: projects, showDropped: false)
        #expect(labels(entries) == ["0Pp1", "0Ff1", "1Pp2", "1Ff3", "2Pp3", "0Pp5"])
    }

    @Test func projectsTreeShowsDroppedWithEverything() {
        let entries = SidebarTree.projectEntries(folders: folders, projects: projects, showDropped: true)
        #expect(labels(entries) == ["0Ff2", "1Pp6", "0Pp1", "0Ff1", "1Pp2", "1Ff3", "2Pp3", "1Pp4", "0Pp5"])
    }

    @Test func tagTreeIsDepthFirstByRankAndTreatsMissingParentsAsTopLevel() {
        let tags = [
            Tag(id: "b", name: "B", rank: 2), Tag(id: "a", name: "A", rank: 1), Tag(id: "a2", name: "A2", parentId: "a", rank: 2),
            Tag(id: "a1", name: "A1", parentId: "a", rank: 1), Tag(id: "orphan", name: "O", parentId: "hidden", rank: 3),
            Tag(id: "x", name: "X", rank: 0, status: .dropped, effectiveStatus: .dropped),
        ]
        let tree = SidebarTree.tagEntries(tags, showDropped: false)
        #expect(tree.map { "\($0.depth)\($0.tag.id)" } == ["0a", "1a1", "1a2", "0b", "0orphan"])
        #expect(SidebarTree.tagEntries(tags, showDropped: true).first?.tag.id == "x")
    }

    @Test func movingBeforeAnEntryTakesItsParent() {
        let entries = SidebarTree.projectEntries(folders: folders, projects: projects, showDropped: false)
        // ["p1", "f1", "p2", "f3", "p3", "p5"]: drop p5 between p2 and f3 → into f1 before f3.
        let move = SidebarTree.projectsMove(entries, from: 5, to: 3, folders: folders)
        #expect(move == SidebarTree.ContainerMove(id: "p5", isFolder: false, parentId: "f1", position: .before("f3")))
        // To the very end: after the last entry, in its parent.
        let end = SidebarTree.projectsMove(entries, from: 0, to: 6, folders: folders)
        #expect(end == SidebarTree.ContainerMove(id: "p1", isFolder: false, parentId: nil, position: .after("p5")))
    }

    @Test func aFolderCannotMoveIntoItself() {
        let entries = SidebarTree.projectEntries(folders: folders, projects: projects, showDropped: false)
        // Drop f1 before p3 (inside f3, inside f1): refused.
        #expect(SidebarTree.projectsMove(entries, from: 1, to: 4, folders: folders) == nil)
        // Drop f3 before p1: top level.
        #expect(
            SidebarTree.projectsMove(entries, from: 3, to: 0, folders: folders)
                == SidebarTree.ContainerMove(id: "f3", isFolder: true, parentId: nil, position: .before("p1")))
    }

    @Test func noMoveWhenDroppedInPlace() {
        let entries = SidebarTree.projectEntries(folders: folders, projects: projects, showDropped: false)
        #expect(SidebarTree.projectsMove(entries, from: 2, to: 2, folders: folders) == nil)
        #expect(SidebarTree.projectsMove(entries, from: 2, to: 3, folders: folders) == nil)
    }

    @Test func tagMovesFollowTheSameRules() {
        let tags = [
            Tag(id: "a", name: "A", rank: 1), Tag(id: "a1", name: "A1", parentId: "a", rank: 1), Tag(id: "b", name: "B", rank: 2),
        ]
        let tree = SidebarTree.tagEntries(tags, showDropped: false)
        #expect(SidebarTree.tagMove(tree, from: 2, to: 1, tags: tags) == SidebarTree.ContainerMove(id: "b", isFolder: false, parentId: "a", position: .before("a1")))
        #expect(SidebarTree.tagMove(tree, from: 0, to: 2, tags: tags) == nil)
        #expect(SidebarTree.tagMove(tree, from: 1, to: 0, tags: tags) == SidebarTree.ContainerMove(id: "a1", isFolder: false, parentId: nil, position: .before("a")))
    }

    @Test func folderDescendantsIncludeTheFolderItself() {
        #expect(SidebarTree.isDescendant("f3", of: "f1", parents: SidebarTree.parents(of: folders)))
        #expect(SidebarTree.isDescendant("f1", of: "f1", parents: SidebarTree.parents(of: folders)))
        #expect(!SidebarTree.isDescendant("f1", of: "f3", parents: SidebarTree.parents(of: folders)))
    }

    @Test func folderPathJoinsAncestorNames() {
        #expect(SidebarTree.folderPath("f3", folders: folders) == "Work : Sub")
        #expect(SidebarTree.folderPath(nil, folders: folders) == "")
    }
}
