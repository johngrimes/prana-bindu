// Author: John Grimes

import XCTest

/// Base for the end-to-end flows against a real server. The test runner needs `PRANA_UITEST_ORIGIN` and
/// `PRANA_UITEST_TOKEN`: run `TEST_RUNNER_PRANA_UITEST_ORIGIN=… TEST_RUNNER_PRANA_UITEST_TOKEN=… xcodebuild test …`
/// (xcodebuild passes `TEST_RUNNER_`-prefixed variables to the runner without the prefix). Without them the tests are
/// skipped. Each test makes the data it needs through the API and deletes it afterwards, so tests do not depend on
/// each other or on their order.
class ServerTestCase: XCTestCase {
    /// The server the tests run against.
    private(set) var server = ServerAPI(origin: "", token: "")

    override func setUpWithError() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        guard let origin = environment["PRANA_UITEST_ORIGIN"], let token = environment["PRANA_UITEST_TOKEN"] else {
            throw XCTSkip("Set PRANA_UITEST_ORIGIN and PRANA_UITEST_TOKEN to run UI tests")
        }
        server = ServerAPI(origin: origin, token: token)
    }

    /// Launches the app signed in to the server (plus any extra launch environment), optionally opening a link.
    @MainActor
    @discardableResult
    func launch(_ link: String? = nil, environment: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["PRANA_UITEST_ORIGIN"] = server.origin
        app.launchEnvironment["PRANA_UITEST_TOKEN"] = server.token
        app.launchEnvironment.merge(environment) { _, new in new }
        app.launch()
        if let link { app.open(URL(string: link)!) }
        return app
    }

    /// Whether the tests run in the phone layout.
    @MainActor var isPhone: Bool { UIDevice.current.userInterfaceIdiom == .phone }

    /// An element with an accessibility identifier, whatever its type.
    @MainActor
    func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    /// iPad: taps a rail entry (`rail.<id>`), first showing the rail from the header when it is collapsed (portrait).
    @MainActor
    func tapRail(_ app: XCUIApplication, _ id: String) {
        let show = element(app, "header.rail")
        if show.exists {
            show.tap()
            XCTAssertTrue(show.waitForNonExistence(timeout: 5), "The rail shows")
        }
        let item = element(app, id)
        // The identifier lands on the entry's icon, which the row's cell covers for hit-testing: wait until the rail
        // has slid in, then tap the icon's position.
        let deadline = Date().addingTimeInterval(5)
        while !(item.exists && app.frame.contains(item.frame)), Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        XCTAssertTrue(item.exists && app.frame.contains(item.frame), "\(id) shows")
        item.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    // MARK: Test data

    /// Creates an inbox item at the top of the inbox with a unique name starting with `prefix`; returns its id and
    /// name. It is deleted when the test ends.
    @MainActor
    func createInboxItem(_ prefix: String) async throws -> (id: String, name: String) {
        let name = "\(prefix) \(UUID().uuidString.prefix(8))"
        let task = try await server.send("POST", "/tasks", body: ["name": name, "position": "start"]) as? [String: Any]
        let id = try XCTUnwrap(task?["id"] as? String)
        deleteAfterwards("/tasks/\(id)")
        return (id, name)
    }

    /// Creates a project due for review (its next review long past) with a unique name starting with `prefix`;
    /// returns its id. It is deleted when the test ends.
    @MainActor
    func createProjectDueForReview(_ prefix: String) async throws -> String {
        let name = "\(prefix) \(UUID().uuidString.prefix(8))"
        let project = try await server.send("POST", "/projects", body: ["name": name]) as? [String: Any]
        let id = try XCTUnwrap(project?["id"] as? String)
        deleteAfterwards("/projects/\(id)")
        try await server.send("PATCH", "/projects/\(id)", body: ["nextReview": "2020-01-01"])
        return id
    }

    /// Creates an entity with `POST /api/v1<path>` and the given body; returns its id. It is deleted when the test ends.
    @MainActor
    func create(_ path: String, _ body: [String: any Sendable]) async throws -> String {
        let created = try await server.send("POST", path, body: body) as? [String: Any]
        let id = try XCTUnwrap(created?["id"] as? String)
        deleteAfterwards("\(path)/\(id)")
        return id
    }

    /// Sends `DELETE /api/v1<path>` when the test ends.
    func deleteAfterwards(_ path: String) {
        addTeardownBlock { [server] in _ = try? await server.send("DELETE", path) }
    }

    /// Deletes the tasks named exactly `name` when the test ends (for items the test made through the app).
    func deleteTasksAfterwards(named name: String) {
        addTeardownBlock { [server] in
            for task in try await server.tasks(matching: name) where task["name"] as? String == name {
                if let id = task["id"] as? String { _ = try? await server.send("DELETE", "/tasks/\(id)") }
            }
        }
    }

    /// Polls `condition` for up to `seconds` (background writes take a moment to reach the server).
    @MainActor
    func eventually(_ seconds: Double = 10, _ condition: () async throws -> Bool) async throws -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if try await condition() { return true }
            try await Task.sleep(for: .milliseconds(250))
        }
        return try await condition()
    }
}

/// The server's REST API (`/api/v1`) with the test token. Its async methods run on the caller's actor, so the JSON
/// they return stays there.
struct ServerAPI: Sendable {
    /// The server's origin, e.g. `http://localhost:3999`.
    let origin: String
    /// An API token for the server.
    let token: String

    /// Sends a request and returns the decoded JSON body (nil for an empty body or a GET of something missing).
    @discardableResult
    func send(_ method: String = "GET", _ path: String, body: [String: Any]? = nil) async throws -> Any? {
        var request = URLRequest(url: URL(string: "\(origin)/api/v1\(path)")!)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if method == "GET" && status == 404 { return nil }
        guard (200..<300).contains(status) else {
            throw NSError(domain: "api", code: status, userInfo: [NSLocalizedDescriptionKey: String(decoding: data, as: UTF8.self)])
        }
        return data.isEmpty ? nil : try JSONSerialization.jsonObject(with: data)
    }

    /// A task as the server has it (nil once it is gone).
    func task(_ id: String) async throws -> [String: Any]? {
        try await send("GET", "/tasks/\(id)") as? [String: Any]
    }

    /// The tasks whose name or note contains `text` (any status).
    func tasks(matching text: String) async throws -> [[String: Any]] {
        var components = URLComponents()
        components.path = "/tasks"
        components.queryItems = [URLQueryItem(name: "q", value: text), URLQueryItem(name: "limit", value: "500")]
        let page = try await send("GET", components.string!) as? [String: Any]
        return page?["items"] as? [[String: Any]] ?? []
    }

    /// One field of a project.
    func project(_ id: String) async throws -> [String: Any]? {
        try await send("GET", "/projects/\(id)") as? [String: Any]
    }

    /// The settings.
    func settings() async throws -> [String: Any] {
        try await send("GET", "/settings") as? [String: Any] ?? [:]
    }
}
