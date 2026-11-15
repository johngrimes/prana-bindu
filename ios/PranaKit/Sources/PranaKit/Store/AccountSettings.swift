// Author: John Grimes

import Foundation
import Observation

/// The server-side parts of the settings page (spec §6): passkeys, API tokens and the last import. Unlike settings,
/// these wait for the server (`AppStore.send`) and refetch after every change, as the web app's settings page does.
/// Failures show the server's message as an error toast; a 401 signs out through the store.
@MainActor
@Observable
public final class AccountSettings {
    /// Registered passkeys; nil until loaded.
    public private(set) var passkeys: [Passkey]?
    /// API tokens; nil until loaded.
    public private(set) var tokens: [ApiToken]?
    /// The last import run, or nil when there has been none (see `importLoaded`).
    public private(set) var lastImport: ImportRun?
    /// Whether the last import has been fetched.
    public private(set) var importLoaded = false
    /// A token just created, with its plaintext to show once; nil once dismissed.
    public private(set) var created: ApiTokenCreated?

    private let store: AppStore

    /// Creates the model for a store.
    public init(store: AppStore) {
        self.store = store
    }

    /// Whether deleting a passkey now would delete the last one (it then needs confirmation).
    public var needsLastPasskeyConfirmation: Bool { passkeys?.count == 1 }

    /// Fetches passkeys, tokens and the last import.
    public func load() async {
        async let passkeys: Void = loadPasskeys()
        async let tokens: Void = loadTokens()
        async let lastImport: Void = loadImport()
        _ = await (passkeys, tokens, lastImport)
    }

    /// Fetches the passkeys.
    public func loadPasskeys() async {
        if let list = await quietly(Endpoints.passkeys()) { passkeys = list.items }
    }

    /// Fetches the API tokens.
    public func loadTokens() async {
        if let list = await quietly(Endpoints.tokens()) { tokens = list.items }
    }

    /// Fetches the last import run.
    public func loadImport() async {
        if let last = await quietly(Endpoints.lastImport()) {
            lastImport = last.run
            importLoaded = true
        }
    }

    /// Renames a passkey to the trimmed name; blank names and unchanged names send nothing.
    public func rename(_ passkey: Passkey, to name: String) async {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value != passkey.name else { return }
        await perform(Endpoints.renamePasskey(passkey.id, name: value), success: nil)
        await loadPasskeys()
    }

    /// Deletes a passkey (the caller confirms first when it is the last one).
    public func delete(_ passkey: Passkey) async {
        await perform(Endpoints.deletePasskey(passkey.id), success: "Passkey deleted")
        await loadPasskeys()
    }

    /// Creates a token named with the trimmed name and keeps its plaintext in `created`. False when the name is
    /// blank or the server refused.
    public func createToken(named name: String) async -> Bool {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return false }
        do {
            created = try await store.send(Endpoints.createToken(name: value))
        } catch {
            toast(error)
            return false
        }
        await loadTokens()
        return true
    }

    /// Forgets the created token's plaintext (the dialog closed).
    public func dismissCreated() {
        created = nil
    }

    /// Revokes a token.
    public func revoke(_ token: ApiToken) async {
        await perform(Endpoints.revokeToken(token.id), success: "Token revoked")
        await loadTokens()
    }

    /// Sends a request, toasting `success` or the error.
    private func perform<T: Decodable & Sendable>(_ request: APIRequest<T>, success: String?) async {
        do {
            _ = try await store.send(request)
            if let success { store.toast(success) }
        } catch {
            toast(error)
        }
    }

    /// Fetches, toasting failures other than 401 (which the store handles by signing out).
    private func quietly<T: Decodable & Sendable>(_ request: APIRequest<T>) async -> T? {
        do {
            return try await store.send(request)
        } catch {
            if case .unauthorized = error { return nil }
            toast(error)
            return nil
        }
    }

    /// Toasts the error's message, unless the request was cancelled (the page went away).
    private func toast(_ error: APIError) {
        if error == .cancelled { return }
        store.toast(error.message, kind: .error)
    }
}
