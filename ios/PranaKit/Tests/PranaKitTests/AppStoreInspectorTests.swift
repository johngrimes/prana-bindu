// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// The inspector's and Quick Entry's writes against a stubbed server: which endpoint each field edit uses.
@MainActor
struct AppStoreInspectorTests {
    let server = AppStoreTests.FakeServer()
    let credentials = InMemoryCredentialStore()

    func makeStore() -> (AppStore, URL) {
        let server = self.server
        let origin = StubURLProtocol.register { server.handle($0) }
        try? credentials.save(Credentials(origin: origin, token: "pb_test"))
        return (AppStore(credentialStore: credentials, session: StubURLProtocol.session()), origin)
    }

    func sent(_ origin: URL, _ method: String, _ suffix: String) -> RecordedRequest? {
        StubURLProtocol.requests(for: origin).first { $0.method == method && $0.url.path().hasSuffix(suffix) }
    }

    @Test func taskEditsPatchTheTaskAndProjectEditsPatchTheProject() async throws {
        let (store, origin) = makeStore()
        store.apply(.date(.due, "tomorrow"), to: TaskDetail(task: TaskItem(id: "t1")))
        store.apply(.projectType(.sequential), to: TaskDetail(task: TaskItem(id: "p1", isProject: true), project: ProjectRecord(id: "p1")))
        await until { sent(origin, "PATCH", "/projects/p1") != nil }
        #expect(sent(origin, "PATCH", "/tasks/t1")?.json == .object(["dueDate": .string("tomorrow")]))
        #expect(sent(origin, "PATCH", "/projects/p1")?.json == .object(["type": .string("sequential")]))
    }

    @Test func multipleSelectionEditsUseOneBatchRequest() async throws {
        let (store, origin) = makeStore()
        store.apply(.flagged(true), toAll: ["a", "b"])
        await until { sent(origin, "POST", "/tasks/batch") != nil }
        #expect(sent(origin, "POST", "/tasks/batch")?.json == .object(["ids": .array([.string("a"), .string("b")]), "patch": .object(["flagged": .bool(true)])]))
    }

    @Test func choosingAProjectAssignsInboxItemsAndMovesOthers() async throws {
        let (store, origin) = makeStore()
        server.overrides.withLock {
            $0["POST /api/v1/tasks/batch"] = .json(#"{"changed":[]}"#)
            $0["POST /api/v1/tasks/move"] = .json(#"{"changed":[]}"#)
        }
        store.setProject("p1", forAll: [TaskItem(id: "i", inInbox: true), TaskItem(id: "a", projectId: "p0"), TaskItem(id: "b")])
        await until { sent(origin, "POST", "/tasks/move") != nil }
        let batch = try #require(sent(origin, "POST", "/tasks/batch")?.json)
        #expect(batch == .object(["ids": .array([.string("i")]), "patch": .object(["assignedProjectId": .string("p1")])]))
        let move = try #require(sent(origin, "POST", "/tasks/move")?.json)
        #expect(move["ids"] == .array([.string("a"), .string("b")]))
        #expect(move["projectId"] == .string("p1"))
    }

    @Test func quickEntrySavesAParsedDueDateAndKeepsUnparseableOnesBack() async throws {
        let (store, origin) = makeStore()
        var draft = QuickEntryDraft()
        draft.name = "Call Sam"
        draft.due = "nonsense words"
        #expect(store.save(draft) == .failure(.unparseableDue))
        draft.due = "2026-12-01T17:00:00.000"
        let id = try store.save(draft).get()
        await until { sent(origin, "POST", "/tasks") != nil }
        let body = try #require(sent(origin, "POST", "/tasks")?.json)
        #expect(body["id"] == .string(id))
        #expect(body["dueDate"] == .string("2026-12-01T17:00:00.000"))
        #expect(body["inbox"] == .bool(true))
        #expect(store.toasts.contains { $0.message == "Added to Inbox" })
    }
}
