// Author: John Grimes

import PranaKit
import SwiftUI

/// The Prana app: the sign-in screen until credentials are present, then the shell.
@main
struct PranaApp: App {
    @State private var store: AppStore
    @State private var navigator = Navigator()

    init() {
        _store = State(initialValue: AppStore(credentialStore: KeychainCredentialStore()))
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if store.isSignedIn {
                    RootView()
                } else {
                    SignInView()
                }
            }
            .overlay(alignment: .bottom) { ToastOverlay() }
            #if DEBUG
                .overlay(alignment: .bottomLeading) { UITestDragSource() }
            #endif
            .syncsExtensions()
            .preferredColorScheme(store.settings.theme.colorScheme)
            .environment(store)
            .environment(navigator)
            .task { await signInForUITests() }
            .onOpenURL { url in
                switch OpenedURL(url) {
                case .app(let link): navigator.open(link)
                case .browser(let url): UIApplication.shared.open(url)
                case nil: break
                }
            }
        }
        .commands { ShellCommands(store: store, navigator: navigator) }
    }

    /// UI tests pass a server and token in the launch environment so each run starts signed in (debug builds only).
    private func signInForUITests() async {
        #if DEBUG
            let environment = ProcessInfo.processInfo.environment
            guard let originText = environment["PRANA_UITEST_ORIGIN"], let token = environment["PRANA_UITEST_TOKEN"],
                let origin = Credentials.origin(from: originText)
            else { return }
            try? await store.signIn(origin: origin, token: token)
        #endif
    }
}

extension Settings.Theme {
    /// The colour scheme for this theme (nil follows the system).
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
