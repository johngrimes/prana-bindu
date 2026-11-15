// Author: John Grimes

import PranaKit
import SwiftUI

/// The shell's global commands (`src/web/lib/commands.ts` and `useGlobalShortcuts`), shared by the header, the
/// menus and the keyboard shortcuts.
@MainActor
struct ShellActions {
    let store: AppStore
    let navigator: Navigator

    /// The route on screen (the home page when none is set).
    var route: Route { ShellNavigation.resolve(navigator.route, perspectives: store.state.perspectives) }

    /// What the page on screen offers.
    var chrome: PageChrome { PageChrome(route: route, perspectives: store.state.perspectives ?? []) }

    /// Whether Reorder applies: the page has an outline that is on screen.
    var canReorder: Bool { chrome.canReorder && navigator.outline != nil }

    /// Runs a command as its keyboard shortcut does.
    func run(_ command: ShellCommand) {
        switch command {
        case .quickEntry: navigator.showsQuickEntry = true
        case .newItem: newItem()
        case .quickOpen: navigator.showsQuickOpen = true
        case .perspectives: navigator.showsPerspectives = true
        case .viewOptions: if chrome.hasViewOptions { navigator.showsViewOptions = true }
        case .cleanUp: cleanUp()
        case .refresh: Task { await store.refresh(announce: true) }
        case .search: navigator.navigate(to: .search(query: ""))
        case .undo: store.undo()
        case .redo: store.redo()
        case .toggleSidebar: navigator.toggleSidebar()
        case .toggleInspector: navigator.toggleInspector()
        case .shortcuts: navigator.showsShortcuts = true
        }
    }

    /// New item: in the outline on screen, else Quick Entry.
    func newItem() {
        if let outline = navigator.outline { outline.newItem() } else { navigator.showsQuickEntry = true }
    }

    /// Clean Up: the greyed rows leave the outline at once.
    func cleanUp() {
        store.cleanUp(rows: navigator.outline?.leaving() ?? [])
    }

    /// Toggles reorder mode.
    func toggleReorder() {
        navigator.reordering.toggle()
    }

    /// Signs out once unsent changes have gone (the store waits for them).
    func signOut() {
        navigator.signingOut = true
        Task {
            await store.signOut()
            navigator.signingOut = false
        }
    }
}
