// Author: John Grimes

import Foundation
import Security
import Synchronization

/// What the app needs to talk to a server: its origin and an API token (spec §9 Auth).
public struct Credentials: Codable, Sendable, Hashable {
    /// The server origin, e.g. `https://tasks.example.org`.
    public var origin: URL
    /// The API token (`pb_…`).
    public var token: String

    /// Creates credentials.
    public init(origin: URL, token: String) {
        self.origin = origin
        self.token = token
    }

    /// The origin (scheme, host and port) in text the user typed; `https://` is assumed when no scheme is given.
    /// Nil for anything that is not an http(s) URL with a host.
    public static func origin(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let parts = URLComponents(string: withScheme), let scheme = parts.scheme?.lowercased(),
            scheme == "https" || scheme == "http", let host = parts.host, !host.isEmpty
        else { return nil }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = parts.port
        return origin.url
    }
}

/// Where credentials are kept.
public protocol CredentialStore: Sendable {
    /// The saved credentials, or nil when signed out.
    func load() -> Credentials?
    /// Saves credentials, replacing any saved before.
    func save(_ credentials: Credentials) throws
    /// Forgets the saved credentials.
    func delete()
}

/// Credentials in memory only (tests and previews).
public final class InMemoryCredentialStore: CredentialStore {
    private let value: Mutex<Credentials?>

    /// Creates a store, optionally already holding credentials.
    public init(_ credentials: Credentials? = nil) {
        value = Mutex(credentials)
    }

    /// The held credentials.
    public func load() -> Credentials? { value.withLock { $0 } }
    /// Holds `credentials`.
    public func save(_ credentials: Credentials) throws { value.withLock { $0 = credentials } }
    /// Forgets the credentials.
    public func delete() { value.withLock { $0 = nil } }
}

/// A Keychain failure.
public struct KeychainError: Error, Sendable, Equatable {
    /// The `OSStatus` the Keychain returned.
    public let status: OSStatus
}

/// Credentials in the Keychain as one generic-password item, in an access group shared by the app and its extensions
/// (widget, share extension, intents), so all of them can talk to the server.
public struct KeychainCredentialStore: CredentialStore {
    /// The app's Keychain service name.
    public static let defaultService = "au.id.grimes.prana-bindu"

    public let service: String
    /// Full access group (`TEAMID.au.id.grimes.prana-bindu`), or nil for the app's default group.
    public let accessGroup: String?
    private let account = "default"

    /// Creates a store.
    public init(service: String = defaultService, accessGroup: String? = KeychainCredentialStore.sharedAccessGroup()) {
        self.service = service
        self.accessGroup = accessGroup
    }

    /// The shared access group of this build: the `KeychainAccessGroup` Info.plist value (set from the app's
    /// `$(AppIdentifierPrefix)` at build time), or nil when absent (unsigned simulator builds, tests).
    public static func sharedAccessGroup(bundle: Bundle = .main) -> String? {
        guard let group = bundle.object(forInfoDictionaryKey: "KeychainAccessGroup") as? String,
            !group.isEmpty, !group.hasPrefix("$(")
        else { return nil }
        return group
    }

    private func query(group: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    /// The saved credentials, or nil.
    public func load() -> Credentials? {
        for group in groups {
            var query = query(group: group)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecSuccess, let data = result as? Data {
                return try? JSONDecoder().decode(Credentials.self, from: data)
            }
        }
        return nil
    }

    /// Saves (replacing) the credentials. Falls back to the default group when the build lacks the shared one.
    public func save(_ credentials: Credentials) throws {
        let data = try JSONEncoder().encode(credentials)
        var lastStatus: OSStatus = errSecSuccess
        for group in groups {
            SecItemDelete(query(group: group) as CFDictionary)
            var attributes = query(group: group)
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            lastStatus = SecItemAdd(attributes as CFDictionary, nil)
            if lastStatus == errSecSuccess { return }
            // An unsigned build is not entitled to the shared group: keep the credentials in the app's own group.
            if lastStatus != errSecMissingEntitlement { break }
        }
        throw KeychainError(status: lastStatus)
    }

    /// Deletes the credentials from every group they may be in.
    public func delete() {
        for group in groups { SecItemDelete(query(group: group) as CFDictionary) }
    }

    private var groups: [String?] { accessGroup == nil ? [nil] : [accessGroup, nil] }
}
