// Author: John Grimes

import XCTest

/// End-to-end flows of the app's extensions against a real server: sharing a link through the share extension, and
/// "Add to Inbox". Set `PRANA_UITEST_SHOTS` to a directory to save screenshots of each step.
final class ExtensionsUITests: ServerTestCase {
    /// Saves a screenshot named `name` when `PRANA_UITEST_SHOTS` is set.
    @MainActor
    private func shoot(_ name: String) {
        guard let directory = ProcessInfo.processInfo.environment["PRANA_UITEST_SHOTS"] else { return }
        let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
    }

    /// The inbox items' ids, names and notes, from the API.
    @MainActor
    private func inbox() async throws -> [(id: String, name: String, note: String)] {
        let page = try await server.send("GET", "/tasks?inbox=true&limit=500") as? [String: Any]
        let items = page?["items"] as? [[String: Any]] ?? []
        return items.map { ($0["id"] as? String ?? "", $0["name"] as? String ?? "", $0["note"] as? String ?? "") }
    }

    /// Sharing a link opens the compose sheet with the link as the name (a bare link has no page title); Post adds the
    /// item to the inbox. The app presents the system share sheet itself (a debug-only launch hook), so the test
    /// doesn't depend on Safari's UI, which changes between iOS releases.
    @MainActor
    func testSharingALinkAddsAnInboxItem() async throws {
        let shared = "\(server.origin)/settings?shared=\(UUID().uuidString.prefix(8))"
        let app = launch(environment: ["PRANA_UITEST_SHARE_URL": shared])

        let prana = app.cells.matching(identifier: "shareCell").matching(NSPredicate(format: "label == 'Prana'")).firstMatch
        XCTAssertTrue(prana.waitForExistence(timeout: 20), app.debugDescription)
        shoot("share-1-sheet")
        prana.tap()

        let post = app.buttons["share.post"]
        XCTAssertTrue(post.waitForExistence(timeout: 15))
        let name = app.descendants(matching: .any).matching(identifier: "share.name").firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        // The extension reads the shared items after its sheet shows.
        let filled = expectation(for: NSPredicate(format: "value == %@", shared), evaluatedWith: name)
        await fulfillment(of: [filled], timeout: 10)
        shoot("share-2-compose")
        let before = Set(try await inbox().map(\.id))
        post.tap()
        XCTAssertTrue(post.waitForNonExistence(timeout: 15))

        var added: [String] = []
        _ = try await eventually {
            added = try await inbox().filter { !before.contains($0.id) && $0.name == shared }.map(\.id)
            return !added.isEmpty
        }
        for id in added { deleteAfterwards("/tasks/\(id)") }
        XCTAssertFalse(added.isEmpty)
    }

    /// "Add to Inbox" adds the text verbatim and answers as the Siri Shortcut does. The App Shortcut is listed in the
    /// Shortcuts app, but an unsigned simulator build can't run it (`linkd` rejects apps without a team), so the app
    /// runs the intent's body from the launch environment.
    @MainActor
    func testAddToInboxAddsTheTextVerbatim() async throws {
        let name = "Buy milk tomorrow #errands \(UUID().uuidString.prefix(6))"
        deleteTasksAfterwards(named: name)
        let app = launch(environment: ["PRANA_UITEST_ADD_TO_INBOX": name])

        let confirmation = app.staticTexts["Added \"\(name)\" to your inbox."]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 15))
        shoot("intent-added")
        // The answer can show before the write lands on the server.
        let added = try await eventually { try await inbox().contains { $0.name == name } }
        XCTAssertTrue(added)
    }
}
