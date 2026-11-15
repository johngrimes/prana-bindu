// Author: John Grimes

import XCTest

/// The Forecast outline against a real server (spec §3 Row, §4 Forecast): rows from `/forecast` are not greyed as
/// leaving, and a row completed there stays (struck through, leaving) until Clean Up removes it.
final class ForecastUITests: ServerTestCase {
    @MainActor
    func testCompletedRowStaysUntilCleanUp() async throws {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'23:00:00.000"
        let name = "Forecast row \(UUID().uuidString.prefix(8))"
        let id = try await create("/tasks", ["name": name, "position": "start", "dueDate": formatter.string(from: Date())])
        let app = launch("prana://forecast")

        let row = element(app, "row.\(id)")
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertFalse(leaving(app).firstMatch.exists, "No Forecast row is greyed as leaving on Clean Up")

        // Complete it: it stays, struck through and greyed, after the server's Forecast no longer lists it.
        row.buttons["status-circle"].firstMatch.tap()
        let completed = try await eventually { try await server.task(id)?["completed"] is String }
        XCTAssertTrue(completed)
        XCTAssertTrue(isLeaving(row), "The completed row is greyed as leaving")
        XCTAssertFalse(row.waitForNonExistence(timeout: 6), "The completed row stays until Clean Up")

        // Clean Up removes it at once.
        let cleanUp = element(app, "header.cleanUp")
        XCTAssertTrue(cleanUp.waitForExistence(timeout: 5))
        cleanUp.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 2), "Clean Up removes the completed row")
    }

    /// Elements marked as leaving on Clean Up.
    @MainActor
    private func leaving(_ element: XCUIElement) -> XCUIElementQuery {
        element.descendants(matching: .any).matching(NSPredicate(format: "value == %@", "Leaving on Clean Up"))
    }

    /// Whether a row (or a part of it) is marked as leaving on Clean Up.
    @MainActor
    private func isLeaving(_ row: XCUIElement) -> Bool {
        row.value as? String == "Leaving on Clean Up" || leaving(row).firstMatch.exists
    }
}
