// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Ports `src/web/lib/entities.ts` (there is no TS test file): paths, smart-match choices, tree order and sizes.
struct EntitiesTests {
    private let folders = [
        Folder(id: "f1", name: "Work", rank: 2),
        Folder(id: "f2", name: "Clients", parentId: "f1", rank: 1),
        Folder(id: "f3", name: "Home", rank: 1),
    ]

    private let tags = [
        Tag(id: "t1", name: "Contexts", rank: 1),
        Tag(id: "t2", name: "Office", parentId: "t1", rank: 1),
        Tag(id: "t3", name: "Old", rank: 2, status: .dropped, effectiveStatus: .dropped),
        Tag(id: "t4", name: "Waiting", rank: 3, status: .onHold, effectiveStatus: .onHold),
    ]

    private func project(_ id: String, _ name: String, folder: String?, status: ProjectStatus) -> Project {
        Project(
            record: ProjectRecord(id: id, folderId: folder, status: status, effectiveStatus: status),
            task: TaskItem(id: id, name: name, isProject: true))
    }

    @Test func folderPathJoinsAncestorsWithColons() {
        let map = Entities.byId(folders)
        #expect(Entities.folderPath("f2", folders: map) == "Work : Clients")
        #expect(Entities.folderPath("f3", folders: map) == "Home")
        #expect(Entities.folderPath(nil, folders: map) == "")
        #expect(Entities.folderPath("missing", folders: map) == "")
    }

    @Test func tagPathJoinsAncestorsWithColons() {
        let map = Entities.byId(tags)
        #expect(Entities.tagPath(tags[1], tags: map) == "Contexts : Office")
        #expect(Entities.tagPath(tags[0], tags: map) == "Contexts")
    }

    @Test func projectChoicesOfferRemainingProjectsWithTheirFolderPath() {
        let projects = [
            project("p1", "Launch", folder: "f2", status: .active),
            project("p2", "Paused", folder: nil, status: .onHold),
            project("p3", "Done", folder: "f1", status: .completed),
            project("p4", "Gone", folder: nil, status: .dropped),
        ]
        let choices = Entities.projectChoices(projects, folders: folders)
        #expect(
            choices == [
                MatchItem(id: "p1", name: "Launch", detail: "Work : Clients"),
                MatchItem(id: "p2", name: "Paused", detail: nil),
            ])
        #expect(Entities.projectChoices(nil, folders: nil).isEmpty)
    }

    @Test func tagChoicesSkipDroppedAndExcludedTagsAndShowTheParentPath() {
        let choices = Entities.tagChoices(tags, excluding: ["t4"])
        #expect(
            choices == [
                MatchItem(id: "t1", name: "Contexts", detail: nil),
                MatchItem(id: "t2", name: "Office", detail: "Contexts"),
            ])
        #expect(Entities.tagChoices(tags).map(\.id) == ["t1", "t2", "t4"])
    }

    @Test func flattenTreeOrdersDepthFirstByRank() {
        let nodes = Entities.flattenTree(folders)
        #expect(nodes.map(\.item.id) == ["f3", "f1", "f2"])
        #expect(nodes.map(\.depth) == [0, 0, 1])
    }

    @Test func flattenTreeTreatsMissingParentsAsTopLevel() {
        let nodes = Entities.flattenTree([Folder(id: "a", name: "A", parentId: "gone", rank: 1), Folder(id: "b", name: "B", rank: 0)])
        #expect(nodes.map(\.item.id) == ["b", "a"])
        #expect(nodes.map(\.depth) == [0, 0])
    }

    @Test(arguments: [
        (0, "0 B"), (512, "512 B"), (1023, "1023 B"), (1024, "1.0 KB"), (1536, "1.5 KB"), (10239, "10.0 KB"),
        (10240, "10 KB"), (204_800, "200 KB"), (1_048_576, "1.0 MB"), (5_452_595, "5.2 MB"), (1_073_741_824, "1.0 GB"),
        (3_221_225_472, "3.0 GB"),
    ])
    func formatBytes(size: Int, expected: String) {
        #expect(Entities.formatBytes(size) == expected)
    }
}
