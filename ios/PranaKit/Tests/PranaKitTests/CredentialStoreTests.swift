// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Credentials (origin + API token) are kept in the Keychain, shared with the extensions; tests and previews use an
/// in-memory store behind the same protocol.
struct CredentialStoreTests {
    let sample = Credentials(origin: URL(string: "https://tasks.example.org")!, token: "pb_abc")

    @Test func inMemoryStoreSavesLoadsAndDeletes() throws {
        // Arrange
        let store = InMemoryCredentialStore()
        #expect(store.load() == nil)
        // Act
        try store.save(sample)
        // Assert
        #expect(store.load() == sample)
        store.delete()
        #expect(store.load() == nil)
    }

    @Test func keychainStoreRoundTripsAndReplaces() throws {
        // A unique service per run keeps the test independent of anything else in the keychain.
        let store = KeychainCredentialStore(service: "au.id.grimes.prana-bindu.tests.\(UUID().uuidString)", accessGroup: nil)
        defer { store.delete() }
        #expect(store.load() == nil)
        try store.save(sample)
        #expect(store.load() == sample)
        // Saving again replaces the item rather than failing as a duplicate.
        let other = Credentials(origin: URL(string: "http://localhost:3999")!, token: "pb_other")
        try store.save(other)
        #expect(store.load() == other)
        store.delete()
        #expect(store.load() == nil)
    }

    @Test func normalisesOriginsTheUserTypes() {
        // People type bare hosts, trailing slashes and paths; the client needs a scheme and host only.
        #expect(Credentials.origin(from: "tasks.example.org")?.absoluteString == "https://tasks.example.org")
        #expect(Credentials.origin(from: " https://tasks.example.org/ ")?.absoluteString == "https://tasks.example.org")
        #expect(Credentials.origin(from: "http://localhost:3999/settings")?.absoluteString == "http://localhost:3999")
        #expect(Credentials.origin(from: "") == nil)
        #expect(Credentials.origin(from: "ftp://x.org") == nil)
    }
}
