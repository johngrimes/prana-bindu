// Author: John Grimes

import XCTest

/// Signing in and the Inbox against a real server (see `ServerTestCase` for the environment variables).
final class PranaUITests: ServerTestCase {
    /// Signing in from the launch environment shows the Inbox with an item made through the API.
    @MainActor
    func testShowsInboxRows() async throws {
        let item = try await createInboxItem("Inbox row")
        let app = launch("prana://inbox")
        let row = element(app, "row.\(item.id)")
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertEqual(row.label, item.name)
    }

    /// Completing an inbox item with a swipe reaches the server. The instant preview itself is covered by the PranaKit
    /// store tests.
    @MainActor
    func testCompletingAnInboxItemReachesTheServer() async throws {
        let item = try await createInboxItem("Complete me")
        let app = launch("prana://inbox")
        let row = element(app, "row.\(item.id)")
        XCTAssertTrue(row.waitForExistence(timeout: 15))

        row.swipeRight()
        app.buttons["Complete"].firstMatch.tap()

        let completed = try await eventually { try await server.task(item.id)?["completed"] is String }
        XCTAssertTrue(completed)
    }
}
