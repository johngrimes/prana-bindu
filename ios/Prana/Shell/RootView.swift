// Author: John Grimes

import PranaKit
import SwiftUI

/// The signed-in shell (spec §2, `Shell.tsx`): the phone layout in compact width, the iPad layout otherwise, plus the
/// window's sheets (Quick Entry, Quick Open, keyboard shortcuts, perspectives). Restores the last route on launch.
struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// The route shown when the app was last used (its `prana://` link).
    @SceneStorage("route") private var storedRoute = ""

    /// The route on screen: the home page (first favourite) when none is set.
    private var route: Route { ShellNavigation.resolve(navigator.route, perspectives: store.state.perspectives) }

    var body: some View {
        @Bindable var navigator = navigator
        Group {
            if sizeClass == .compact {
                if store.state.perspectives == nil {
                    NavigationStack {
                        PerspectivesUnavailable()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .navigationTitle("Prana")
                    }
                } else {
                    PhoneShell(route: route)
                }
            } else {
                PadShell(route: route)
            }
        }
        .overlay {
            if navigator.signingOut {
                ProgressView("Signing out…")
                    .padding(24)
                    .background(.regularMaterial, in: .rect(cornerRadius: 16))
                    .accessibilityIdentifier("signingOut")
            }
        }
        .sheet(isPresented: $navigator.showsQuickEntry) { QuickEntrySheet() }
        .sheet(isPresented: $navigator.showsQuickOpen) { QuickOpenSheet() }
        .sheet(isPresented: $navigator.showsShortcuts) { ShortcutsSheet() }
        .sheet(isPresented: $navigator.showsPerspectives) { PerspectivesSheet() }
        .onAppear { navigator.isCompact = sizeClass == .compact }
        .onChange(of: sizeClass) { navigator.isCompact = sizeClass == .compact }
        .onChange(of: store.state.perspectives) { navigator.home = ShellNavigation.home(store.state.perspectives) }
        .onChange(of: navigator.route) { storedRoute = ShellNavigation.storedValue(navigator.route) }
        .task {
            // A link that opened the app wins over the restored route.
            if navigator.route == nil { navigator.route = ShellNavigation.restoredRoute(storedRoute) }
            navigator.onNavigate = { [store] in store.resetSticky() }
            await navigator.loadShared(store)
        }
    }
}
