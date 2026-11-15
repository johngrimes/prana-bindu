// Author: John Grimes

import Foundation
import Synchronization
import Testing

@testable import PranaKit

/// Views of projects, folders, tags and perspectives created on this device (port of `useContents` in
/// `src/web/api/queries.ts`): a placeholder shows while the create has not landed, then the view loads from the server.
@MainActor
struct AppStorePendingContentsTests {
    /// Answers the shared lists from fixtures, holds creates until `release()`, and answers contents with one task row.
    final class GatedServer: Sendable {
        let gate = DispatchSemaphore(value: 0)
        let createStatus = Mutex(201)
        let createBody = Mutex(Data("{}".utf8))
        let counts = Mutex<[String: Int]>([:])

        func count(_ key: String) -> Int { counts.withLock { $0[key] ?? 0 } }

        func release() { gate.signal() }

        func handle(_ request: RecordedRequest) -> StubResponse {
            let path = request.url.path()
            counts.withLock { $0["\(request.method) \(path)", default: 0] += 1 }
            if request.method == "POST" {
                _ = gate.wait(timeout: .now() + 5)
                let status = createStatus.withLock { $0 }
                if status >= 400 { return .json(#"{"error":{"code":"invalid","message":"Nope"}}"#, status: status) }
                return StubResponse(status: status, headers: ["Content-Type": "application/json"], body: createBody.withLock { $0 })
            }
            if path.hasSuffix("/contents") {
                let contents = OutlineContents(
                    perspectiveId: "projects",
                    groups: [OutlineGroup(key: "g", title: "G", kind: .project, rows: [
                        OutlineRow(kind: .task, id: "srvTask0001", depth: 0, task: TaskItem(id: "srvTask0001", name: "From the server")),
                    ])])
                return StubResponse(
                    status: 200, headers: ["Content-Type": "application/json"], body: (try? APIClient.encoder.encode(contents)) ?? Data())
            }
            let name: String? =
                switch path {
                case "/api/v1/settings": "settings"
                case "/api/v1/perspectives": "perspectives"
                case "/api/v1/folders": "folders"
                case "/api/v1/tags": "tags"
                case "/api/v1/projects": "projects"
                case "/api/v1/history": "history"
                default: nil
                }
            if let name, let data = try? fixture(name) {
                return StubResponse(status: 200, headers: ["Content-Type": "application/json"], body: data)
            }
            return .json(#"{"error":{"code":"not_found","message":"Not found"}}"#, status: 404)
        }
    }

    let server = GatedServer()

    func makeStore() async -> AppStore {
        let server = self.server
        let origin = StubURLProtocol.register { server.handle($0) }
        let store = AppStore(
            credentialStore: InMemoryCredentialStore(Credentials(origin: origin, token: "pb_test")), session: StubURLProtocol.session())
        await store.loadShared()
        return store
    }

    func rowIds(_ store: AppStore, _ key: ContentsKey) -> [String] {
        store.state.contents[key]?.groups.flatMap { $0.rows.map(\.id) } ?? []
    }

    @Test func aProjectCreatedHereShowsAPlaceholderRowThenLoadsOnceSaved() async throws {
        let store = await makeStore()
        let id = store.createProject(named: "Garden")
        let draft = try #require(store.state.projects?.first { $0.id == id })
        server.createBody.withLock { $0 = (try? APIClient.encoder.encode(draft)) ?? Data() }
        let key = ContentsKey(perspectiveId: "projects", project: id)

        let loading = Task { await store.load(key) }
        // While the create is in flight: the project's own row, and no request for a view the server lacks.
        await until("placeholder") { rowIds(store, key) == [id] }
        #expect(store.state.contents[key]?.groups.first?.title == "Garden")
        #expect(server.count("GET /api/v1/perspectives/projects/contents") == 0)

        server.release()
        await loading.value
        #expect(rowIds(store, key) == ["srvTask0001"])
        #expect(server.count("GET /api/v1/perspectives/projects/contents") >= 1)
    }

    @Test func aFolderCreatedHereShowsAnEmptyViewThenLoadsOnceSaved() async throws {
        let store = await makeStore()
        let id = store.createFolder(name: "Home")
        let draft = try #require(store.state.folders?.first { $0.id == id })
        server.createBody.withLock { $0 = (try? APIClient.encoder.encode(draft)) ?? Data() }
        let key = ContentsKey(perspectiveId: "projects", folder: id)

        let loading = Task { await store.load(key) }
        await until("placeholder") { store.state.contents[key] != nil }
        #expect(rowIds(store, key).isEmpty)
        #expect(server.count("GET /api/v1/perspectives/projects/contents") == 0)

        server.release()
        await loading.value
        #expect(rowIds(store, key) == ["srvTask0001"])
    }

    @Test func aDiscardedCreateDropsThePlaceholderAndFetchesNothing() async {
        let store = await makeStore()
        server.createStatus.withLock { $0 = 422 }
        let id = store.createTag(name: "Errands")
        let key = ContentsKey(perspectiveId: "tags", tag: id)

        let loading = Task { await store.load(key) }
        await until("placeholder") { store.state.contents[key] != nil }
        server.release()
        await loading.value
        #expect(store.state.contents[key] == nil)
        #expect(server.count("GET /api/v1/perspectives/tags/contents") == 0)
    }
}
