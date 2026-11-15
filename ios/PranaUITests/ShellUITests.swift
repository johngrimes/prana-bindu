// Author: John Grimes

import XCTest

/// The phone shell against a real server: switching perspectives with the tab bar of favourites and the More list.
final class ShellUITests: ServerTestCase {
    /// Tab bar → Forecast, More → Flagged (not a favourite), then back to the Inbox tab.
    @MainActor
    func testSwitchesPerspectivesWithTheTabBarAndMore() throws {
        try XCTSkipIf(!isPhone, "The tab bar is the phone layout")
        let app = launch()
        let tabs = app.tabBars.firstMatch

        // The favourites from GET /perspectives are tabs, in rank order, followed by More.
        let inbox = tabs.buttons["Inbox"]
        XCTAssertTrue(inbox.waitForExistence(timeout: 15))
        inbox.tap()
        XCTAssertTrue(inbox.isSelected)
        // The Inbox has no sidebar.
        XCTAssertFalse(app.buttons["header.sidebar"].exists)

        let forecast = tabs.buttons["Forecast"]
        forecast.tap()
        XCTAssertTrue(forecast.isSelected)
        XCTAssertTrue(app.buttons["header.sidebar"].waitForExistence(timeout: 5), "Forecast shows its calendar sidebar button")

        // Flagged is not a favourite: it opens from More, on More's stack.
        let more = tabs.buttons["More"]
        more.tap()
        let flagged = app.buttons["more.flagged"]
        XCTAssertTrue(flagged.waitForExistence(timeout: 5))
        flagged.tap()
        XCTAssertTrue(more.isSelected)
        XCTAssertTrue(app.navigationBars.buttons["More"].waitForExistence(timeout: 5), "Flagged is pushed onto More")
        XCTAssertTrue(app.buttons["header.sidebar"].waitForExistence(timeout: 5), "Flagged shows its tags sidebar button")
        XCTAssertFalse(flagged.isHittable)

        // Back to a favourite.
        inbox.tap()
        XCTAssertTrue(inbox.isSelected)
        XCTAssertFalse(app.buttons["header.sidebar"].waitForExistence(timeout: 2))
    }
}
