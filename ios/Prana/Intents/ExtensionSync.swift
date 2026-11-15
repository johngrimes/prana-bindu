// Author: John Grimes

import PranaKit
import SwiftUI
import UIKit
import WatchConnectivity
import WidgetKit

/// Keeps the app's extensions in step with it: sends the credentials to the watch on sign-in and sign-out, and reloads
/// the Forecast widget after sign-in, sign-out and whenever the write queue drains.
struct ExtensionSync: ViewModifier {
    @Environment(AppStore.self) private var store

    func body(content: Content) -> some View {
        content
            .task {
                WatchCredentialSender.shared.activate(sending: store.credentials)
                PranaShortcuts.updateAppShortcutParameters()
                // The server may have changed since the widget last loaded.
                WidgetCenter.shared.reloadAllTimelines()
            }
            #if DEBUG
                .task(id: store.isSignedIn) {
                    await addToInboxForUITests()
                    await shareForUITests()
                }
            #endif
            .onChange(of: store.credentials) { _, credentials in
                WatchCredentialSender.shared.send(credentials)
                if credentials == nil { ForecastWidgetCacheStore.shared().delete() }
                WidgetCenter.shared.reloadAllTimelines()
            }
            .onChange(of: store.writes.busy) { wasBusy, busy in
                if wasBusy && !busy { WidgetCenter.shared.reloadAllTimelines() }
            }
    }

    #if DEBUG
        /// UI tests can't run the App Shortcut in an unsigned simulator build (`linkd` rejects apps without a team), so
        /// they pass `PRANA_UITEST_ADD_TO_INBOX` and the app runs the intent's body once signed in, showing Siri's
        /// answer as a toast.
        private func addToInboxForUITests() async {
            guard store.isSignedIn, let text = ProcessInfo.processInfo.environment["PRANA_UITEST_ADD_TO_INBOX"] else { return }
            store.toast(await AddToInboxIntent.add(text))
        }

        /// UI tests share through the share extension from a share sheet the app presents itself, with the URL in
        /// `PRANA_UITEST_SHARE_URL`, so they don't depend on another app's UI (Safari's toolbar changes between iOS
        /// releases).
        private func shareForUITests() async {
            guard store.isSignedIn, let text = ProcessInfo.processInfo.environment["PRANA_UITEST_SHARE_URL"],
                let url = URL(string: text)
            else { return }
            // Let the shell settle before presenting over it.
            try? await Task.sleep(for: .seconds(1))
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            guard var top = scene?.keyWindow?.rootViewController else { return }
            while let presented = top.presentedViewController { top = presented }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = top.view
            sheet.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
            top.present(sheet, animated: true)
        }
    #endif
}

extension View {
    /// Keeps the watch's credentials and the Forecast widget in step with the app.
    func syncsExtensions() -> some View { modifier(ExtensionSync()) }
}

/// The phone's side of WatchConnectivity: the latest credentials (or a sign-out) as the application context.
@MainActor
final class WatchCredentialSender: NSObject, WCSessionDelegate {
    static let shared = WatchCredentialSender()

    /// Sent once the session is active.
    private var pending: Credentials??

    /// Activates the session and sends `credentials` once it is active.
    func activate(sending credentials: Credentials?) {
        guard WCSession.isSupported() else { return }
        pending = .some(credentials)
        let session = WCSession.default
        session.delegate = self
        if session.activationState == .activated { flush() } else { session.activate() }
    }

    /// Sends `credentials` (nil = signed out) to the watch.
    func send(_ credentials: Credentials?) {
        guard WCSession.isSupported() else { return }
        pending = .some(credentials)
        if WCSession.default.activationState == .activated { flush() }
    }

    private func flush() {
        guard case .some(let credentials) = pending else { return }
        let session = WCSession.default
        guard session.isPaired, session.isWatchAppInstalled else { return }
        do {
            // WatchConnectivity drops a context equal to the last one, which would never reach a reinstalled watch app.
            var context = CredentialSync.context(for: credentials)
            context["sentAt"] = Date.now.timeIntervalSince1970
            try session.updateApplicationContext(context)
            pending = nil
        } catch {
            // Kept pending: sent again on the next activation or change.
        }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in self.flush() }
    }

    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in self.flush() }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        // A different watch was paired: activate again for it.
        session.activate()
    }
}
