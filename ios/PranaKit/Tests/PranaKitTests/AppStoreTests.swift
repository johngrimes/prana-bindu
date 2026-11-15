// Author: John Grimes

import Foundation
import Synchronization
import Testing

@testable import PranaKit

/// The store end to end against a stubbed server: sign-in, loading, instant writes with previews, refresh after the
/// queue drains, undo, and the 401 sign-out flow.
@MainActor
struct AppStoreTests {
    /// A fake server answering from fixtures; counts requests per "METHOD path".
    final class FakeServer: Sendable {
        let counts = Mutex<[String: Int]>([:])
        let overrides = Mutex<[String: StubResponse]>([:])
        let undoHeaders = Mutex<[String: String]>([:])

        func count(_ key: String) -> Int { counts.withLock { $0[key] ?? 0 } }

        func handle(_ request: RecordedRequest) -> StubResponse {
            let key = "\(request.method) \(request.url.path())"
            counts.withLock { $0[key, default: 0] += 1 }
            if let override = overrides.withLock({ $0[key] }) { return override }
            let fixtureName: String? =
                switch key {
                case "GET /api/v1/settings": "settings"
                case "GET /api/v1/perspectives": "perspectives"
                case "GET /api/v1/folders": "folders"
                case "GET /api/v1/tags": "tags"
                case "GET /api/v1/projects": "projects"
                case "GET /api/v1/history": "history"
                case "GET /api/v1/perspectives/inbox/contents": "inbox_contents"
                default: nil
                }
            if let fixtureName, let data = try? fixture(fixtureName) {
                return StubResponse(status: 200, headers: ["Content-Type": "application/json"], body: data)
            }
            let headers = undoHeaders.withLock { $0 }
            if key == "POST /api/v1/undo" {
                return .json(#"{"canUndo":false,"canRedo":true,"undoLabel":null,"redoLabel":"Edit Action","undoId":null,"redoId":7}"#, headers: headers)
            }
            if request.method == "POST" && key.hasSuffix("/complete") { return .json(#"{"changed":[]}"#, headers: headers) }
            if request.method == "POST" && key == "POST /api/v1/tasks" {
                var task = TaskItem(id: "x", name: "x")
                if case .string(let id)? = request.json?["id"] { task.id = id }
                let body = String(decoding: (try? APIClient.encoder.encode(task)) ?? Data(), as: UTF8.self)
                return .json(body, status: 201, headers: headers)
            }
            if request.method == "PATCH" {
                let body = String(decoding: (try? APIClient.encoder.encode(TaskItem(id: "x", name: "x"))) ?? Data(), as: UTF8.self)
                return .json(body, headers: headers)
            }
            return StubResponse(status: 404, body: Data(#"{"error":{"code":"not_found","message":"Not found"}}"#.utf8))
        }
    }

    let server = FakeServer()
    let credentials = InMemoryCredentialStore()

    func makeStore(signedIn: Bool = true) -> (AppStore, URL) {
        let server = self.server
        let origin = StubURLProtocol.register { server.handle($0) }
        if signedIn { try? credentials.save(Credentials(origin: origin, token: "pb_test")) }
        let store = AppStore(credentialStore: credentials, session: StubURLProtocol.session())
        return (store, origin)
    }

    func inboxTaskIds(_ store: AppStore) -> [String] {
        store.state.contents[.inbox]?.groups.flatMap { $0.rows.map(\.id) } ?? []
    }

    @Test func signInValidatesTheTokenWithSettingsAndSavesIt() async throws {
        // Arrange
        let (store, origin) = makeStore(signedIn: false)
        #expect(!store.isSignedIn)
        // Act
        try await store.signIn(origin: origin, token: "pb_test")
        // Assert
        #expect(store.isSignedIn)
        #expect(credentials.load() == Credentials(origin: origin, token: "pb_test"))
        #expect(server.count("GET /api/v1/settings") >= 1)
        #expect(store.state.settings != nil)
    }

    @Test func signInWithARejectedTokenSavesNothing() async {
        let (store, origin) = makeStore(signedIn: false)
        server.overrides.withLock { $0["GET /api/v1/settings"] = .json(#"{"error":{"code":"invalid_token","message":"The bearer token is invalid or revoked"}}"#, status: 401) }
        await #expect(throws: APIError.self) { try await store.signIn(origin: origin, token: "pb_bad") }
        #expect(!store.isSignedIn)
        #expect(credentials.load() == nil)
    }

    @Test func loadsInboxContents() async {
        let (store, _) = makeStore()
        await store.load(.inbox)
        #expect(inboxTaskIds(store).count == 3)
    }

    @Test func completingShowsAtOnceSendsWithAKeyAndRefreshesAfterTheQueueDrains() async throws {
        // Arrange
        let (store, origin) = makeStore()
        await store.load(.inbox)
        store.activeContentsKey = .inbox
        let id = try #require(inboxTaskIds(store).first)
        let loads = server.count("GET /api/v1/perspectives/inbox/contents")
        // Act
        store.complete([id])
        // Assert: the row shows completed before the server has answered.
        let row = store.state.contents[.inbox]?.groups.first?.rows.first { $0.id == id }
        #expect(row?.task?.status == .completed)
        #expect(row?.task?.completed != nil)
        await until { server.count("POST /api/v1/tasks/\(id)/complete") == 1 }
        let sent = try #require(StubURLProtocol.requests(for: origin).first { $0.url.path().hasSuffix("/complete") })
        #expect(sent.headers["Idempotency-Key"]?.isEmpty == false)
        #expect(sent.json == .object(["completed": true]))
        // After the queue drains, the shown queries are refetched and the previews released.
        await until { server.count("GET /api/v1/perspectives/inbox/contents") > loads }
        await until { store.writes.entries.isEmpty }
    }

    @Test func createTaskReturnsAClientIdAndShowsTheRowAtOnce() async {
        let (store, origin) = makeStore()
        await store.load(.inbox)
        store.activeContentsKey = .inbox
        let id = store.createTask(TaskCreate(name: "Buy milk", inbox: true))
        #expect(id.count == 11)
        #expect(inboxTaskIds(store).last == id)
        #expect(store.state.contents[.inbox]?.groups.first?.rows.last?.task?.name == "Buy milk")
        await until { server.count("POST /api/v1/tasks") == 1 }
        let sent = StubURLProtocol.requests(for: origin).first { $0.method == "POST" && $0.url.path() == "/api/v1/tasks" }
        #expect(sent?.json?["id"] == .string(id))
        #expect(sent?.json?["name"] == "Buy milk")
    }

    @Test func aRejectedWriteRevertsAndToasts() async throws {
        let (store, _) = makeStore()
        await store.load(.inbox)
        let id = try #require(inboxTaskIds(store).first)
        server.overrides.withLock { $0["PATCH /api/v1/tasks/\(id)"] = .json(#"{"error":{"code":"invalid","message":"Bad date."}}"#, status: 422) }
        store.patchTask(id, TaskPatch(name: "Renamed"))
        #expect(store.state.contents[.inbox]?.groups.first?.rows.first?.task?.name == "Renamed")
        await until { store.toasts.contains { $0.message == "Couldn't save: Bad date." } }
        #expect(store.state.contents[.inbox]?.groups.first?.rows.first?.task?.name != "Renamed")
    }

    @Test func aCancelledLoadShowsNoToastAndDoesNotCountAsRefreshed() async {
        let (store, _) = makeStore()
        await store.load(.inbox)
        server.overrides.withLock { $0["GET /api/v1/perspectives/inbox/contents"] = StubResponse(failure: .cancelled) }
        await store.load(.inbox)
        let refreshed = await store.refresh()
        #expect(store.toasts.isEmpty)
        #expect(!refreshed)
        #expect(inboxTaskIds(store).count == 3)
    }

    @Test func aLoadInACancelledTaskShowsNoToast() async {
        let (store, _) = makeStore()
        let load = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            await store.load(.inbox)
        }
        await load.value
        await settle()
        #expect(store.toasts.isEmpty)
    }

    @Test func unauthorisedSignsOutWithTokenRejected() async throws {
        let (store, _) = makeStore()
        await store.load(.inbox)
        let id = try #require(inboxTaskIds(store).first)
        server.overrides.withLock { $0["PATCH /api/v1/tasks/\(id)"] = .json(#"{"error":{"code":"invalid_token","message":"The bearer token is invalid or revoked"}}"#, status: 401) }
        store.patchTask(id, TaskPatch(flagged: true))
        await until { !store.isSignedIn }
        #expect(store.signInMessage == "Token rejected")
        #expect(credentials.load() == nil)
        #expect(store.state.contents.isEmpty)
    }

    @Test func keepsTheServerButNotTheTokenAfterTheTokenIsRejected() async throws {
        // The sign-in screen offers the server that was in use, not the default.
        let (store, origin) = makeStore()
        #expect(store.lastOrigin == origin)
        server.overrides.withLock { $0["GET /api/v1/perspectives/inbox/contents"] = .json(#"{"error":{"code":"invalid_token","message":"Revoked"}}"#, status: 401) }
        await store.load(.inbox)
        #expect(!store.isSignedIn)
        #expect(store.lastOrigin == origin)
        #expect(store.credentials == nil)
        #expect(credentials.load() == nil)
    }

    @Test func undoShowsTheSnapshotAtOnceAndSendsUndo() async throws {
        let (store, _) = makeStore()
        await store.loadShared()
        await store.load(.inbox)
        store.activeContentsKey = .inbox
        let id = try #require(inboxTaskIds(store).first)
        let original = store.state.contents[.inbox]?.groups.first?.rows.first?.task?.name
        server.undoHeaders.withLock { $0 = ["X-Undo-Steps": "1", "X-Undo-Step": "7", "X-Undo-Previous": "0"] }
        store.patchTask(id, TaskPatch(name: "Renamed"))
        #expect(store.canUndo)
        #expect(store.undoLabel == "Edit Action")
        await until { store.writes.entries.allSatisfy { $0.state == .done } }
        // Act
        store.undo()
        // Assert: the old name shows before the server answers, with a toast naming the step.
        #expect(store.state.contents[.inbox]?.groups.first?.rows.first?.task?.name == original)
        #expect(store.toasts.contains { $0.message == "Undid Edit Action" })
        await until { server.count("POST /api/v1/undo") == 1 }
    }

    @Test func signOutForgetsCredentialsAndCaches() async {
        let (store, _) = makeStore()
        await store.load(.inbox)
        await store.signOut()
        #expect(!store.isSignedIn)
        #expect(credentials.load() == nil)
        #expect(store.state.contents.isEmpty)
        #expect(store.signInMessage == nil)
    }
}
