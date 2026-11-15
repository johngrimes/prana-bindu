// Author: John Grimes

import XCTest

/// The iPad shell in portrait (spec §2): the page shows its title (not the inspector's), and the perspectives rail is
/// collapsed, shown from the header and put away again by picking a perspective.
final class PadShellUITests: ServerTestCase {
    @MainActor
    func testPortraitShowsThePageTitleAndCollapsesTheRail() throws {
        try XCTSkipIf(isPhone, "The rail and inspector column are the iPad layout")
        XCUIDevice.shared.orientation = .portrait
        let app = launch("prana://inbox")

        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 15), "The page's title shows")
        XCTAssertFalse(app.navigationBars["Inspector"].exists, "The inspector's title does not replace the page's")

        // The rail is collapsed; the header shows it, and picking a perspective puts it away.
        XCTAssertTrue(element(app, "header.rail").waitForExistence(timeout: 5))
        let forecast = element(app, "rail.forecast")
        XCTAssertFalse(forecast.exists && forecast.isHittable, "The rail starts collapsed")
        tapRail(app, "rail.forecast")
        XCTAssertTrue(app.navigationBars["Forecast"].waitForExistence(timeout: 10))
        XCTAssertTrue(element(app, "header.rail").waitForExistence(timeout: 5), "The rail is put away after picking a perspective")
    }

    /// Pages with a sidebar column (Projects, Review) show their title in portrait too, and the review bar's
    /// "Review every …" button keeps its shape beside the sidebar.
    @MainActor
    func testPortraitShowsTheTitleOfPagesWithASidebar() async throws {
        try XCTSkipIf(isPhone, "The sidebar column is the iPad layout")
        let project = try await createProjectDueForReview("Pad title")
        let task = try await server.project(project)?["task"] as? [String: Any]
        let name = try XCTUnwrap(task?["name"] as? String)
        XCUIDevice.shared.orientation = .portrait
        let app = launch("prana://projects")
        XCTAssertTrue(element(app, "sidebarColumn").waitForExistence(timeout: 15))
        assertTitleShows(app, "Projects")

        app.open(URL(string: "prana://review?project=\(project)")!)
        XCTAssertTrue(element(app, "review-bar.\(project)").waitForExistence(timeout: 20))
        assertTitleShows(app, name)

        // With the rail shown beside the page, the narrowest the page gets.
        element(app, "header.rail").tap()
        let schedule = app.buttons["review-schedule"].firstMatch
        XCTAssertTrue(schedule.waitForExistence(timeout: 5))
        try await Task.sleep(for: .seconds(1))
        XCTAssertGreaterThan(schedule.frame.width, schedule.frame.height * 2, "The schedule button is not squashed")
        XCTAssertLessThan(schedule.frame.height, 60)
    }

    /// The page's title is drawn in the navigation bar (on screen, not only named by it).
    @MainActor
    private func assertTitleShows(_ app: XCUIApplication, _ title: String, line: UInt = #line) {
        let bar = app.navigationBars[title]
        XCTAssertTrue(bar.waitForExistence(timeout: 15), "\(title)'s navigation bar", line: line)
        let text = bar.staticTexts[title]
        XCTAssertTrue(text.waitForExistence(timeout: 5), "\(title) is drawn", line: line)
        XCTAssertTrue(text.isHittable && app.frame.contains(text.frame), "\(title) is on screen", line: line)
    }
}
