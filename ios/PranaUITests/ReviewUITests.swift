// Author: John Grimes

import XCTest

/// The Review flow against a real server (spec §4 Review): Mark Reviewed records the review and opens the next
/// unreviewed project.
final class ReviewUITests: ServerTestCase {
    /// Mark Reviewed on a project moves on to another project, counts it as reviewed, and reaches the server.
    @MainActor
    func testMarkReviewedAdvancesToTheNextProject() async throws {
        let first = try await createProjectDueForReview("Review first")
        _ = try await createProjectDueForReview("Review second")
        let lastReview = try await server.project(first)?["lastReview"] as? String
        let app = launch("prana://review?project=\(first)")

        XCTAssertTrue(element(app, "review-bar.\(first)").waitForExistence(timeout: 20))
        let progress = app.staticTexts["review-progress"]
        let before = try XCTUnwrap(Self.left(progress.label))

        app.buttons["mark-reviewed"].firstMatch.tap()

        // The next project opens, with one fewer left to review.
        let next = NSPredicate(format: "identifier BEGINSWITH 'review-bar.' AND identifier != %@", "review-bar.\(first)")
        XCTAssertTrue(app.descendants(matching: .any).matching(next).firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(Self.left(app.staticTexts["review-progress"].label), before - 1)

        // The review reached the server.
        let reviewed = try await eventually { try await server.project(first)?["lastReview"] as? String != lastReview }
        XCTAssertTrue(reviewed)
    }

    /// iPhone: the Review tab's page stays mounted under the other tabs without pulling the app back to Review, and
    /// shows the list again (not "All projects reviewed") when the tab is picked again.
    @MainActor
    func testLeavingTheReviewTabStaysAway() async throws {
        try XCTSkipIf(!isPhone, "The tab bar is the phone layout")
        _ = try await createProjectDueForReview("Review leave first")
        _ = try await createProjectDueForReview("Review leave second")
        // Review must be a tab of its own for the whole test: the phone shows at most four favourites, so Review is
        // made one and Projects and Tags are not (each restored afterwards).
        for (id, favourite) in [("projects", false), ("tags", false), ("review", true)] {
            let perspective = try await server.send("GET", "/perspectives/\(id)") as? [String: Any]
            let was = try XCTUnwrap(perspective?["favorite"] as? Bool)
            try await server.send("PATCH", "/perspectives/\(id)", body: ["favorite": favourite])
            addTeardownBlock { [server] in _ = try? await server.send("PATCH", "/perspectives/\(id)", body: ["favorite": was]) }
        }
        var app = launch("prana://review")
        let tabs = app.tabBars.firstMatch
        let reviewTab = tabs.buttons["Review"]
        let inboxTab = tabs.buttons["Inbox"]
        let anyBar = NSPredicate(format: "identifier BEGINSWITH 'review-bar.'")

        XCTAssertTrue(app.descendants(matching: .any).matching(anyBar).firstMatch.waitForExistence(timeout: 20))
        let progress = app.staticTexts["review-progress"].label
        XCTAssertGreaterThan(try XCTUnwrap(Self.left(progress)), 0)

        // Review tab → Inbox tab.
        inboxTab.tap()
        assertStays(app, on: "Inbox", tab: inboxTab)

        // Back to Review: the list shows again with the same progress.
        reviewTab.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(anyBar).firstMatch.waitForExistence(timeout: 15))
        XCTAssertEqual(app.staticTexts["review-progress"].label, progress)
        XCTAssertFalse(element(app, "review-done").exists, "Not a false \"All projects reviewed\"")

        // Review tab → ⋯ → Settings.
        app.buttons["header.more"].firstMatch.tap()
        app.buttons["menu.settings"].firstMatch.tap()
        assertStays(app, on: "Settings", tab: tabs.buttons["More"])

        // A widget link while Review was the last page opens the Forecast.
        reviewTab.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(anyBar).firstMatch.waitForExistence(timeout: 15))
        app.open(URL(string: "prana://forecast?day=TODAY")!)
        assertStays(app, on: "Forecast", tab: tabs.buttons["Forecast"])
        XCTAssertTrue(element(app, "forecast-strip-TODAY").isSelected, "Today is picked")

        // Relaunched with Review restored, the app can still leave it.
        reviewTab.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(anyBar).firstMatch.waitForExistence(timeout: 15))
        // Scene storage is saved when the app goes to the background.
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(2))
        app.terminate()
        app = launch()
        let restored = app.descendants(matching: .any).matching(anyBar).firstMatch.waitForExistence(timeout: 20)
        if !restored { add(XCTAttachment(screenshot: app.screenshot())) }
        XCTAssertTrue(restored, "Review is restored")
        let relaunchedInbox = app.tabBars.firstMatch.buttons["Inbox"]
        relaunchedInbox.tap()
        assertStays(app, on: "Inbox", tab: relaunchedInbox)
    }

    /// The page titled `title` shows under `tab` and is still there two seconds later.
    @MainActor
    private func assertStays(_ app: XCUIApplication, on title: String, tab: XCUIElement, line: UInt = #line) {
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10), "\(title) shows", line: line)
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        XCTAssertTrue(app.navigationBars[title].exists, "Still on \(title)", line: line)
        XCTAssertTrue(tab.isSelected, "\(title)'s tab stays selected", line: line)
        XCTAssertFalse(app.buttons["mark-reviewed"].firstMatch.exists, "Not back on Review", line: line)
    }

    /// "3 of 7 left" → 3.
    private static func left(_ label: String) -> Int? {
        label.split(separator: " ").first.flatMap { Int($0) }
    }
}
