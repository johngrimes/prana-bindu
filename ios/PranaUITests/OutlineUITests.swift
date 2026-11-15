// Author: John Grimes

import XCTest

/// The outline's main editing flow against a real server (spec §3 Editing): Return adds an item below the one being
/// edited, it is named, renamed and indented, and the server ends up with the renamed item under its new parent.
final class OutlineUITests: ServerTestCase {
    @MainActor
    func testAddRenameAndIndentAnItem() async throws {
        try XCTSkipIf(!isPhone, "Touch editing with the keyboard toolbar is the phone flow (iPad: KeyboardUITests)")
        let anchor = try await createInboxItem("Outline anchor")
        let name = "UI test \(UUID().uuidString.prefix(8))"
        deleteTasksAfterwards(named: "\(name) renamed")
        let app = launch("prana://inbox")

        // Edit the anchor row's title, then Return adds a sibling below it and edits that.
        let anchorRow = element(app, "row.\(anchor.id)")
        XCTAssertTrue(anchorRow.waitForExistence(timeout: 20))
        anchorRow.buttons["row-title"].firstMatch.tap()
        let editor = app.textFields["row-title-input"].firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        // The floating "+" makes way for the keyboard toolbar while a title is edited.
        XCTAssertTrue(element(app, "quickEntry.fab").waitForNonExistence(timeout: 5), "The + hides while the keyboard is up")
        editor.typeText("\n")

        // Name the new item, then stop editing; the "+" returns.
        let newEditor = app.textFields["row-title-input"].firstMatch
        XCTAssertTrue(newEditor.waitForExistence(timeout: 5))
        newEditor.typeText(name)
        app.buttons["keyboard-done"].firstMatch.tap()
        XCTAssertTrue(app.buttons[name].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "quickEntry.fab").waitForExistence(timeout: 5), "The + returns when the keyboard goes")

        // Rename it inline.
        app.buttons[name].firstMatch.tap()
        let renameEditor = app.textFields["row-title-input"].firstMatch
        XCTAssertTrue(renameEditor.waitForExistence(timeout: 5))
        renameEditor.typeText(" renamed")
        // Indent it under the row above from the keyboard toolbar (this also saves the new title).
        app.buttons["keyboard-indent"].firstMatch.tap()
        if app.buttons["keyboard-done"].firstMatch.exists { app.buttons["keyboard-done"].firstMatch.tap() }

        // The server has the renamed item under the anchor row.
        let indented = try await eventually {
            try await server.tasks(matching: "\(name) renamed").contains { $0["parentId"] as? String == anchor.id }
        }
        XCTAssertTrue(indented)
    }
}
