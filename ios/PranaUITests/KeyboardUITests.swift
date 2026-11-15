// Author: John Grimes

import XCTest

/// iPad hardware keyboard shortcuts in the outline (spec §3 Editing) against a real server: `]` indents the selected
/// row, Return adds an item below it, Shift-Return stops editing and `[` outdents. The keys are sent as hardware key
/// events. (XCUITest on the iOS simulator does not deliver Delete or Escape key events to an app without a text field
/// in focus, so those keys are not covered here.)
final class KeyboardUITests: ServerTestCase {
    @MainActor
    func testIndentNewItemAndOutdentFromTheKeyboard() async throws {
        try XCTSkipIf(isPhone, "Hardware keyboard shortcuts are tested in the iPad layout")
        let child = try await createInboxItem("Keys child")
        let parent = try await createInboxItem("Keys parent")
        let app = launch("prana://inbox")

        // Select the child (the second row; a first tap on an iPad row selects it).
        let childRow = element(app, "row.\(child.id)")
        XCTAssertTrue(childRow.waitForExistence(timeout: 15))
        childRow.staticTexts[child.name].firstMatch.tap()
        XCTAssertTrue(childRow.buttons["row-title"].waitForExistence(timeout: 5), "The tapped row is selected")

        // ] indents it under the row above.
        try await press(app, "]") { try await self.server.task(child.id)?["parentId"] as? String == parent.id }

        // Return adds an item below it and edits its title; Shift-Return stops editing. (XCUITest sends Return for
        // "\n"; its `.return` key is not delivered.)
        let editor = app.textFields["row-title-input"].firstMatch
        try await press(app, "\n") { editor.exists }
        XCTAssertTrue(editor.exists, "Return starts a new item")
        let name = "Keys new \(UUID().uuidString.prefix(8))"
        editor.typeText(name)
        app.typeKey("\n", modifierFlags: .shift)
        XCTAssertTrue(editor.waitForNonExistence(timeout: 5), "Shift-Return stops editing")
        var newId: String?
        let added = try await eventually {
            let created = try await server.tasks(matching: name).first { $0["name"] as? String == name }
            newId = created?["id"] as? String
            return created?["parentId"] as? String == parent.id
        }
        XCTAssertTrue(added, "Return adds a sibling below the selected row")
        deleteAfterwards("/tasks/\(try XCTUnwrap(newId))")

        // The new row stays selected: [ outdents it back to the inbox's top level.
        try await press(app, "[") { try await self.server.task(newId!)?["parentId"] is NSNull }
    }

    /// Sends a hardware key until `landed` holds, at most three times. On a simulator that has not seen a hardware
    /// keyboard before, the first key presses can be lost before they reach the app (the system may show a one-time
    /// "… Keyboard Detected" prompt), so the key is sent again, after dismissing that prompt if it is still showing.
    @MainActor
    private func press(
        _ app: XCUIApplication, _ key: String, line: UInt = #line, landed: () async throws -> Bool
    ) async throws {
        let label = key == "\n" ? "Return" : key
        for attempt in 1...3 {
            app.typeKey(key, modifierFlags: [])
            if try await eventually(5, landed) {
                if attempt > 1 { print("KeyboardUITests: \(label) landed on attempt \(attempt)") }
                return
            }
            let notNow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Not Now"]
            if notNow.waitForExistence(timeout: 1) { notNow.tap() }
        }
        XCTFail("\(label) had no effect", line: line)
    }
}
