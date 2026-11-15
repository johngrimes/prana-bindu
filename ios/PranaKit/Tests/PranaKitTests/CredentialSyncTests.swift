// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// The phone sends its credentials to the watch as a WatchConnectivity application context; the watch keeps them in
/// its own Keychain and forgets them when the phone signs out.
struct CredentialSyncTests {
    private let credentials = Credentials(origin: URL(string: "https://tasks.example.com")!, token: "pb_watch")

    @Test func signedInContextRoundTrips() {
        let context = CredentialSync.context(for: credentials)
        #expect(CredentialSync.update(from: context) == .signedIn(credentials))
    }

    @Test func signedOutContextClearsTheWatch() {
        let context = CredentialSync.context(for: nil)
        #expect(CredentialSync.update(from: context) == .signedOut)
    }

    @Test func anUnrelatedContextChangesNothing() {
        #expect(CredentialSync.update(from: [:]) == nil)
        #expect(CredentialSync.update(from: ["origin": "not a url", "token": "pb_x"]) == nil)
    }

    @Test func applyingAnUpdateSavesOrDeletes() throws {
        let store = InMemoryCredentialStore()
        CredentialSync.Update.signedIn(credentials).apply(to: store)
        #expect(store.load() == credentials)
        CredentialSync.Update.signedOut.apply(to: store)
        #expect(store.load() == nil)
    }
}
