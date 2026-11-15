// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Outline drops onto sidebar projects, the inbox and tags (`dropTasks` in `Outline.tsx`).
@MainActor
struct AppStoreOutlineTests {
    let server = AppStoreTests.FakeServer()
    let credentials = InMemoryCredentialStore()

    func makeStore() async -> AppStore {
        let server = self.server
        let origin = StubURLProtocol.register { server.handle($0) }
        try? credentials.save(Credentials(origin: origin, token: "pb_test"))
        let store = AppStore(credentialStore: credentials, session: StubURLProtocol.session())
        await store.loadShared()
        await store.load(.inbox)
        store.activeContentsKey = .inbox
        return store
    }

    @Test func droppingOnAProjectMovesTheRowsOutOfTheInboxAtOnce() async {
        let store = await makeStore()
        store.moveDraggedTasks(["inbx0000001"], toProject: "prjSingle01")
        let ids = store.state.contents[.inbox]?.groups.flatMap { $0.rows.map(\.id) } ?? []
        #expect(!ids.contains("inbx0000001"))
        #expect(store.writes.entries.last?.spec.label == "Move")
    }

    @Test func droppingOnATagAddsItAndSaysSo() async {
        let store = await makeStore()
        store.tagDraggedTasks(["inbx0000001", "inbx0000002"], tagId: "tagX")
        #expect(store.toasts.last?.message == "Tag added to 2 items")
        let task = store.state.contents[.inbox]?.groups.first?.rows.first?.task
        #expect(task?.tagIds.contains("tagX") == true)
    }
}
