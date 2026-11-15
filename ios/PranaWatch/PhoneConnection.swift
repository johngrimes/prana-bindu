// Author: John Grimes

import PranaKit
import SwiftUI
import WatchConnectivity

/// The watch's side of WatchConnectivity: receives the phone's credentials (or its sign-out) and keeps them in the
/// watch's own Keychain.
@MainActor @Observable
final class PhoneConnection: NSObject, WCSessionDelegate {
    static let shared = PhoneConnection()

    /// The saved credentials, nil until the phone has sent them.
    private(set) var credentials: Credentials?
    @ObservationIgnored private let store = KeychainCredentialStore()

    override init() {
        super.init()
        credentials = store.load()
    }

    /// Starts the session; the last context the phone sent is applied once it is active.
    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    private func apply(_ update: CredentialSync.Update) {
        update.apply(to: store)
        switch update {
        case .signedIn(let sent): credentials = sent
        case .signedOut: credentials = nil
        }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard let update = CredentialSync.update(from: session.receivedApplicationContext) else { return }
        Task { @MainActor in self.apply(update) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let update = CredentialSync.update(from: applicationContext) else { return }
        Task { @MainActor in self.apply(update) }
    }
}
