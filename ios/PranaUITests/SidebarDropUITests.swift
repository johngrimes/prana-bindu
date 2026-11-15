// Author: John Grimes

import XCTest

/// Dragging outline rows onto the sidebar in the iPad layout (spec §3, §16 Row gestures) against a real server: a row
/// dropped on a project moves there, and a row dropped on a tag gains that tag.
final class SidebarDropUITests: ServerTestCase {
    @MainActor
    func testDroppingARowOnASidebarProjectMovesItAndOnATagTagsIt() async throws {
        try XCTSkipIf(isPhone, "Rows are dragged in the iPad layout")
        let suffix = UUID().uuidString.prefix(8)
        let source = try await create("/projects", ["name": "Drop source \(suffix)", "position": "start"])
        let target = try await create("/projects", ["name": "Drop target \(suffix)", "position": "start"])
        let fromTag = try await create("/tags", ["name": "Drop from \(suffix)", "position": "start"])
        let toTag = try await create("/tags", ["name": "Drop to \(suffix)", "position": "start"])
        let name = "Drop me \(suffix)"
        let task = try await create("/tasks", ["name": name, "projectId": source, "tagIds": [fromTag]])

        // A row of the source project dropped on the target project in the sidebar moves there.
        let app = launch("prana://projects?project=\(source)")
        let row = element(app, "row.\(task)")
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        let project = element(app, "sidebar-project-\(target)")
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        row.staticTexts[name].firstMatch.press(forDuration: 1, thenDragTo: project)
        let moved = try await eventually { try await server.task(task)?["projectId"] as? String == target }
        XCTAssertTrue(moved, "Dropping on a sidebar project moves the row there")

        // On the Tags page, the row dropped on another tag in the sidebar gains that tag and keeps its own.
        app.open(URL(string: "prana://tags?tag=\(fromTag)")!)
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        let tag = element(app, "sidebar-tag-\(toTag)")
        XCTAssertTrue(tag.waitForExistence(timeout: 5))
        row.staticTexts[name].firstMatch.press(forDuration: 1, thenDragTo: tag)
        let tagged = try await eventually {
            let tags = try await server.task(task)?["tagIds"] as? [String] ?? []
            return Set(tags) == [fromTag, toTag]
        }
        XCTAssertTrue(tagged, "Dropping on a sidebar tag adds the tag")
        XCTAssertTrue(app.staticTexts["Tag added"].waitForExistence(timeout: 5))
    }
}
