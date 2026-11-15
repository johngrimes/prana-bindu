// Author: John Grimes

import XCTest

/// Settings against a real server: changing the date format reaches the server and re-formats the dates the app
/// shows (here the "created …" date of an API token).
final class SettingsUITests: ServerTestCase {
    /// Choosing yyyy-MM-dd shows token dates as `2026-11-04` and saves the setting; the original format is restored.
    @MainActor
    func testChangingTheDateFormatReformatsDatesAndReachesTheServer() async throws {
        let original = try await server.settings()["dateFormat"] as? String ?? "MM/dd/yyyy"
        let app = launch("prana://settings")

        let picker = element(app, "settings.dateFormat")
        XCTAssertTrue(picker.waitForExistence(timeout: 15))
        let subtitle = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'token.subtitle.'")).firstMatch
        scrollUntilHittable(app, subtitle)
        XCTAssertTrue(subtitle.waitForExistence(timeout: 15))
        let iso = NSPredicate(format: "label MATCHES %@", ".*created [A-Z][a-z]{2} \\d{4}-\\d{2}-\\d{2} .*")

        choose(app, picker: picker, option: "yyyy-MM-dd")
        scrollUntilHittable(app, subtitle)
        await fulfillment(of: [expectation(for: iso, evaluatedWith: subtitle)], timeout: 10)
        try await waitForServer(dateFormat: "yyyy-MM-dd")

        if original != "yyyy-MM-dd" {
            choose(app, picker: picker, option: original)
            scrollUntilHittable(app, subtitle)
            let notISO = NSCompoundPredicate(notPredicateWithSubpredicate: iso)
            await fulfillment(of: [expectation(for: notISO, evaluatedWith: subtitle)], timeout: 10)
            try await waitForServer(dateFormat: original)
        }
    }

    // MARK: Helpers

    @MainActor
    private func choose(_ app: XCUIApplication, picker: XCUIElement, option: String) {
        scrollUntilHittable(app, picker, down: true)
        picker.tap()
        let button = app.buttons[option].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
    }

    @MainActor
    private func scrollUntilHittable(_ app: XCUIApplication, _ element: XCUIElement, down: Bool = false) {
        for _ in 0..<10 where !(element.exists && element.isHittable) {
            if down { app.swipeDown() } else { app.swipeUp() }
        }
    }

    @MainActor
    private func waitForServer(dateFormat: String) async throws {
        let saved = try await eventually { try await server.settings()["dateFormat"] as? String == dateFormat }
        XCTAssertTrue(saved, "Server dateFormat never became \(dateFormat)")
    }
}
