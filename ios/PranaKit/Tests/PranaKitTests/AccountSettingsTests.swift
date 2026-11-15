// Author: John Grimes

import Foundation
import Synchronization
import Testing

@testable import PranaKit

/// Passkeys, API tokens and the last import on the settings page, against a stubbed server. These wait for the
/// server (no instant writes), as the web app's settings page does.
@MainActor
struct AccountSettingsTests {
    /// A tiny auth server: two passkeys and one token, answering the bearer-usable auth endpoints.
    final class AuthServer: Sendable {
        let passkeys = Mutex<[(id: String, name: String)]>([("k1", "MacBook"), ("k2", "iPhone")])
        let tokens = Mutex<[String]>(["t1"])
        let failNext = Mutex<StubResponse?>(nil)

        func handle(_ request: RecordedRequest) -> StubResponse {
            if let failure = failNext.withLock({ f -> StubResponse? in defer { f = nil }; return f }) { return failure }
            let path = request.url.path()
            switch (request.method, path) {
            case ("GET", "/api/v1/auth/passkeys"):
                let items = passkeys.withLock { $0 }.map {
                    #"{"id":"\#($0.id)","name":"\#($0.name)","createdAt":"2026-01-02T03:04:00.000Z","lastUsedAt":null,"deviceType":"multiDevice","backedUp":true}"#
                }
                return .json(#"{"items":[\#(items.joined(separator: ","))]}"#)
            case ("GET", "/api/v1/auth/tokens"):
                let items = tokens.withLock { $0 }.map {
                    #"{"id":"\#($0)","name":"Token \#($0)","prefix":"pb_\#($0)","createdAt":"2026-01-02T03:04:00.000Z","lastUsedAt":null}"#
                }
                return .json(#"{"items":[\#(items.joined(separator: ","))]}"#)
            case ("POST", "/api/v1/auth/tokens"):
                tokens.withLock { $0.append("t2") }
                return .json(
                    #"{"token":{"id":"t2","name":"Claude","prefix":"pb_t2","createdAt":"2026-01-02T03:04:00.000Z","lastUsedAt":null},"plaintext":"pb_t2secret"}"#,
                    status: 201)
            case ("GET", "/api/v1/import/last"):
                return .json(
                    #"{"run":{"id":1,"importedAt":"2026-01-02T03:04:00.000Z","source":"/tmp/a.ofocus","appId":null,"appVersion":"4.5","counts":{"tasks":10,"tags":3},"warnings":["w1"]}}"#)
            default:
                break
            }
            if request.method == "PATCH", path.hasPrefix("/api/v1/auth/passkeys/") {
                let id = String(path.dropFirst("/api/v1/auth/passkeys/".count))
                guard case .string(let name)? = request.json?["name"] else { return StubResponse(status: 400) }
                passkeys.withLock { list in
                    if let i = list.firstIndex(where: { $0.id == id }) { list[i].name = name }
                }
                return .json(#"{"id":"\#(id)","name":"\#(name)","createdAt":"2026-01-02T03:04:00.000Z","lastUsedAt":null,"backedUp":true}"#)
            }
            if request.method == "DELETE", path.hasPrefix("/api/v1/auth/passkeys/") {
                let id = String(path.dropFirst("/api/v1/auth/passkeys/".count))
                passkeys.withLock { $0.removeAll { $0.id == id } }
                return StubResponse(status: 204)
            }
            if request.method == "DELETE", path.hasPrefix("/api/v1/auth/tokens/") {
                let id = String(path.dropFirst("/api/v1/auth/tokens/".count))
                tokens.withLock { $0.removeAll { $0 == id } }
                return StubResponse(status: 204)
            }
            return .json(#"{"error":{"code":"not_found","message":"Not found"}}"#, status: 404)
        }
    }

    let server = AuthServer()

    func makeAccount() -> (AccountSettings, AppStore, URL) {
        let server = self.server
        let origin = StubURLProtocol.register { server.handle($0) }
        let credentials = InMemoryCredentialStore(Credentials(origin: origin, token: "pb_test"))
        let store = AppStore(credentialStore: credentials, session: StubURLProtocol.session())
        return (AccountSettings(store: store), store, origin)
    }

    @Test func loadingFetchesPasskeysTokensAndTheLastImport() async {
        let (account, _, _) = makeAccount()
        await account.load()
        #expect(account.passkeys?.map(\.name) == ["MacBook", "iPhone"])
        #expect(account.tokens?.map(\.id) == ["t1"])
        #expect(account.lastImport?.source == "/tmp/a.ofocus")
        #expect(account.lastImport?.warnings == ["w1"])
        #expect(account.importLoaded)
    }

    @Test func loadingInACancelledTaskShowsNoToast() async {
        // The settings page went away (or was replaced) while it loaded.
        let (account, store, _) = makeAccount()
        let load = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            await account.load()
        }
        await load.value
        await settle()
        #expect(store.toasts.isEmpty)
    }

    @Test func renamingAPasskeySendsTheTrimmedNameAndRefreshes() async throws {
        let (account, _, origin) = makeAccount()
        await account.load()
        let first = try #require(account.passkeys?.first)
        await account.rename(first, to: "  Work Mac  ")
        let patch = try #require(StubURLProtocol.requests(for: origin).first { $0.method == "PATCH" })
        #expect(patch.url.path() == "/api/v1/auth/passkeys/k1")
        #expect(patch.json == .object(["name": .string("Work Mac")]))
        #expect(account.passkeys?.first?.name == "Work Mac")
    }

    @Test func renamingToBlankOrTheSameNameSendsNothing() async throws {
        let (account, _, origin) = makeAccount()
        await account.load()
        let first = try #require(account.passkeys?.first)
        await account.rename(first, to: "   ")
        await account.rename(first, to: "MacBook")
        #expect(!StubURLProtocol.requests(for: origin).contains { $0.method == "PATCH" })
    }

    @Test func onlyTheLastPasskeyNeedsConfirmation() async throws {
        let (account, _, _) = makeAccount()
        await account.load()
        let first = try #require(account.passkeys?.first)
        #expect(!account.needsLastPasskeyConfirmation)
        await account.delete(first)
        #expect(account.passkeys?.map(\.id) == ["k2"])
        #expect(account.needsLastPasskeyConfirmation)
    }

    @Test func deletingAPasskeyToastsAndRefreshes() async throws {
        let (account, store, origin) = makeAccount()
        await account.load()
        let first = try #require(account.passkeys?.first)
        await account.delete(first)
        #expect(StubURLProtocol.requests(for: origin).contains { $0.method == "DELETE" && $0.url.path() == "/api/v1/auth/passkeys/k1" })
        #expect(store.toasts.map(\.message) == ["Passkey deleted"])
    }

    @Test func aFailedPasskeyDeleteToastsTheServerMessageAndStillRefreshes() async throws {
        let (account, store, _) = makeAccount()
        await account.load()
        let first = try #require(account.passkeys?.first)
        server.failNext.withLock { $0 = .json(#"{"error":{"code":"conflict","message":"Nope"}}"#, status: 409) }
        await account.delete(first)
        #expect(store.toasts.map(\.message) == ["Nope"])
        #expect(store.toasts.first?.kind == .error)
        #expect(account.passkeys?.count == 2)
    }

    @Test func creatingATokenKeepsThePlaintextToShowOnce() async throws {
        let (account, _, origin) = makeAccount()
        await account.load()
        #expect(await account.createToken(named: "  Claude ") == true)
        let post = try #require(StubURLProtocol.requests(for: origin).first { $0.method == "POST" })
        #expect(post.json == .object(["name": .string("Claude")]))
        #expect(account.created?.plaintext == "pb_t2secret")
        #expect(account.tokens?.map(\.id) == ["t1", "t2"])
        account.dismissCreated()
        #expect(account.created == nil)
    }

    @Test func aBlankTokenNameCreatesNothing() async {
        let (account, _, origin) = makeAccount()
        #expect(await account.createToken(named: "  ") == false)
        #expect(!StubURLProtocol.requests(for: origin).contains { $0.method == "POST" })
    }

    @Test func revokingATokenToastsAndRefreshes() async throws {
        let (account, store, _) = makeAccount()
        await account.load()
        let token = try #require(account.tokens?.first)
        await account.revoke(token)
        #expect(account.tokens == [])
        #expect(store.toasts.map(\.message) == ["Token revoked"])
    }
}
