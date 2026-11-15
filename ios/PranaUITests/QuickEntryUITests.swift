// Author: John Grimes

import XCTest

/// Quick Entry end to end (spec §4): the due text is parsed on the device and the new inbox item reaches the server
/// with it.
final class QuickEntryUITests: ServerTestCase {
    /// "tomorrow 5pm" in Quick Entry creates an inbox item due tomorrow at 17:00 (in the server's time zone setting).
    @MainActor
    func testQuickEntryCreatesAnItemDueTomorrowAtFive() async throws {
        let name = "Quick entry \(UUID().uuidString.prefix(8))"
        deleteTasksAfterwards(named: name)
        let app = launch("prana://inbox?quickEntry=1")

        let title = app.textFields["quickEntry.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        title.tap()
        title.typeText(name)
        let due = app.textFields["quickEntry.due"]
        due.tap()
        due.typeText("tomorrow 5pm")
        XCTAssertTrue(app.staticTexts["quickEntry.duePreview"].waitForExistence(timeout: 5))
        app.buttons["quickEntry.save"].tap()
        // Save closes the sheet at once.
        XCTAssertTrue(title.waitForNonExistence(timeout: 5))

        let expected = try await tomorrowAtFive()
        var dueDate: String?
        _ = try await eventually {
            dueDate = try await server.tasks(matching: name).first { $0["name"] as? String == name }?["dueDate"] as? String
            return dueDate != nil
        }
        XCTAssertEqual(dueDate, expected)
    }

    /// `YYYY-MM-DDT17:00:00.000` for tomorrow in the server's time zone setting.
    @MainActor
    private func tomorrowAtFive() async throws -> String {
        let settings = try await server.settings()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: settings["timeZone"] as? String ?? "UTC") ?? .gmt
        let tomorrow = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: Date()))
        let parts = calendar.dateComponents([.year, .month, .day], from: tomorrow)
        return String(format: "%04d-%02d-%02dT17:00:00.000", parts.year!, parts.month!, parts.day!)
    }
}
