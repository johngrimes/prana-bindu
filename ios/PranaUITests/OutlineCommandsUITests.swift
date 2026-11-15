// Author: John Grimes

import XCTest

/// The header's outline commands after switching pages (spec §2, §3): the outline on screen stays connected to the
/// header, so Reorder is offered and New item adds a row inline rather than opening Quick Entry.
final class OutlineCommandsUITests: ServerTestCase {
    @MainActor
    func testHeaderKeepsTheOutlineAfterSwitchingPages() async throws {
        _ = try await createInboxItem("Commands anchor")
        let app = launch("prana://inbox")

        // Inbox → Forecast → Inbox (tab bar on phones, the rail on iPad, shown first when it is collapsed).
        XCTAssertTrue(element(app, "outline").waitForExistence(timeout: 15))
        open(app, rail: "rail.forecast", tab: "Forecast")
        XCTAssertTrue(element(app, "forecast-strip-PAST").waitForExistence(timeout: 10), "The Forecast shows")
        open(app, rail: "rail.inbox", tab: "Inbox")
        XCTAssertTrue(element(app, "outline").waitForExistence(timeout: 10))

        // Reorder is in the menu (phone: More; iPad: the app menu).
        let menu = element(app, isPhone ? "header.more" : "header.appMenu")
        XCTAssertTrue(menu.waitForExistence(timeout: 5))
        menu.tap()
        XCTAssertTrue(app.buttons["header.reorder"].firstMatch.waitForExistence(timeout: 5), "Reorder is offered after switching pages")

        // New item adds a row inline (phone: from the More menu; iPad: the header button).
        if !isPhone {
            app.buttons["header.reorder"].firstMatch.tap()
            XCTAssertTrue(element(app, "header.reorderDone").waitForExistence(timeout: 5), "Reorder mode starts")
            element(app, "header.reorderDone").tap()
        }
        app.buttons["header.newItem"].firstMatch.tap()
        let editor = app.textFields["row-title-input"].firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5), "New item edits a new row inline")
        XCTAssertFalse(element(app, "quickEntry.title").exists, "New item does not open Quick Entry")
        let name = "Commands new \(UUID().uuidString.prefix(8))"
        deleteTasksAfterwards(named: name)
        editor.typeText(name)
        if isPhone { app.buttons["keyboard-done"].firstMatch.tap() } else { app.typeKey("\n", modifierFlags: .shift) }
        let saved = try await eventually { try await server.tasks(matching: name).contains { $0["inInbox"] as? Bool == true } }
        XCTAssertTrue(saved, "The new item reaches the inbox")
    }

    /// Opens a perspective from the tab bar (phone) or the rail (iPad).
    @MainActor
    private func open(_ app: XCUIApplication, rail: String, tab: String) {
        if isPhone { app.tabBars.buttons[tab].tap() } else { tapRail(app, rail) }
    }
}
