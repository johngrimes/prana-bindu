// Author: John Grimes

import Foundation

/// The WatchConnectivity application context through which the phone gives the watch its server and token (the
/// watch then sends requests itself). The phone sends a new context whenever it signs in or out.
public enum CredentialSync {
    /// What a received context asks the watch to do.
    public enum Update: Sendable, Hashable {
        case signedIn(Credentials)
        case signedOut

        /// Saves or deletes the credentials in `store`.
        public func apply(to store: some CredentialStore) {
            switch self {
            case .signedIn(let credentials): try? store.save(credentials)
            case .signedOut: store.delete()
            }
        }
    }

    private static let originKey = "origin"
    private static let tokenKey = "token"
    private static let signedOutKey = "signedOut"

    /// The context the phone sends: the origin and token, or a signed-out marker.
    public static func context(for credentials: Credentials?) -> [String: Any] {
        guard let credentials else { return [signedOutKey: true] }
        return [originKey: credentials.origin.absoluteString, tokenKey: credentials.token]
    }

    /// The update a received context asks for, or nil when it carries neither credentials nor a sign-out.
    public static func update(from context: [String: Any]) -> Update? {
        if context[signedOutKey] as? Bool == true { return .signedOut }
        guard let originText = context[originKey] as? String, let token = context[tokenKey] as? String, !token.isEmpty,
            originText.contains("://"), let origin = Credentials.origin(from: originText)
        else { return nil }
        return .signedIn(Credentials(origin: origin, token: token))
    }
}
