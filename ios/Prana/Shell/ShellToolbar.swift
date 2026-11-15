// Author: John Grimes

import PranaKit
import SwiftUI

extension View {
    /// The page header of `Workspace.tsx` (spec §2) for the page showing `route`: phone or iPad actions, "Saving…",
    /// the reorder Done button, and the floating Quick Entry button on phones.
    func shellChrome(route: Route) -> some View {
        modifier(ShellChrome(route: route))
    }
}

/// Header actions and the floating "+" for one page.
private struct ShellChrome: ViewModifier {
    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    let route: Route

    private var actions: ShellActions { ShellActions(store: store, navigator: navigator) }
    private var chrome: PageChrome { PageChrome(route: route, perspectives: store.state.perspectives ?? []) }

    func body(content: Content) -> some View {
        content
            .toolbar {
                if navigator.isCompact { phone } else { pad }
            }
            .savingIndicator()
            .overlay(alignment: .bottomTrailing) {
                if navigator.isCompact && QuickEntryButtonPlacement(route: route) == .floating { QuickEntryButton() }
            }
    }

    // MARK: Phone

    /// Phone header: sidebar, then Clean Up, Search, View options (Done while reordering) and the More menu.
    @ToolbarContentBuilder private var phone: some ToolbarContent {
        if let sidebar = chrome.sidebar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Show \(sidebar.title)", systemImage: "sidebar.left") { navigator.showsDrawer = true }
                    .accessibilityIdentifier("header.sidebar")
            }
        }
        if navigator.reordering {
            ToolbarItem(placement: .topBarTrailing) { reorderDone }
        } else {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if chrome.canCleanUp { cleanUpButton }
                searchButton
                if chrome.hasViewOptions { viewOptionsButton }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Section {
                    if chrome.canCreate { newItemButton }
                    undoButton
                    redoButton
                    if actions.canReorder { reorderButton }
                }
                Section { appMenuItems }
            } label: {
                Label("More actions", systemImage: "ellipsis")
            }
            .accessibilityIdentifier("header.more")
        }
    }

    // MARK: iPad

    /// iPad header: sidebar and Perspectives, view actions, Quick Entry and New item, then Undo, Redo, Search,
    /// the inspector and the app menu.
    @ToolbarContentBuilder private var pad: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarLeading) {
            if chrome.sidebar != nil {
                Button("Toggle sidebar", systemImage: "sidebar.left") { navigator.toggleSidebar() }
                    .accessibilityIdentifier("header.sidebar")
            }
            Button("Perspectives", systemImage: "square.stack") { navigator.showsPerspectives = true }
                .accessibilityIdentifier("header.perspectives")
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if navigator.reordering { reorderDone }
            if chrome.hasViewOptions { viewOptionsButton }
            if chrome.canCleanUp { cleanUpButton }
            Button("Quick Entry", systemImage: "plus") { navigator.showsQuickEntry = true }
                .accessibilityIdentifier("header.quickEntry")
            if chrome.canCreate { newItemButton }
        }
        ToolbarSpacer(.fixed, placement: .topBarTrailing)
        ToolbarItemGroup(placement: .topBarTrailing) {
            undoButton
            redoButton
            searchButton
            if chrome.hasInspector {
                Button("Toggle inspector", systemImage: "sidebar.right") { navigator.toggleInspector() }
                    .accessibilityIdentifier("header.inspector")
            }
            Menu {
                if actions.canReorder { Section { reorderButton } }
                Section { appMenuItems }
            } label: {
                Label("App menu", systemImage: "ellipsis")
            }
            .accessibilityIdentifier("header.appMenu")
        }
    }

    // MARK: Buttons

    private var cleanUpButton: some View {
        Button("Clean Up", systemImage: "wand.and.sparkles") { actions.cleanUp() }
            .accessibilityIdentifier("header.cleanUp")
    }

    private var searchButton: some View {
        Button("Search", systemImage: "magnifyingglass") { actions.run(.search) }
            .accessibilityIdentifier("header.search")
    }

    private var viewOptionsButton: some View {
        Button("View options", systemImage: "slider.horizontal.3") { navigator.showsViewOptions = true }
            .accessibilityIdentifier("header.viewOptions")
    }

    private var newItemButton: some View {
        Button("New item", systemImage: "square.and.pencil") { actions.newItem() }
            .accessibilityIdentifier("header.newItem")
    }

    private var undoButton: some View {
        Button(store.undoLabel.map { "Undo \($0)" } ?? "Undo", systemImage: "arrow.uturn.backward") { store.undo() }
            .disabled(!store.canUndo)
            .accessibilityIdentifier("header.undo")
    }

    private var redoButton: some View {
        Button(store.redoLabel.map { "Redo \($0)" } ?? "Redo", systemImage: "arrow.uturn.forward") { store.redo() }
            .disabled(!store.canRedo)
            .accessibilityIdentifier("header.redo")
    }

    private var reorderButton: some View {
        Button(navigator.reordering ? "Done Reordering" : "Reorder", systemImage: "line.3.horizontal") { actions.toggleReorder() }
            .accessibilityIdentifier("header.reorder")
    }

    private var reorderDone: some View {
        Button("Done") { navigator.reordering = false }
            .buttonStyle(.borderedProminent)
            .accessibilityLabel("Done reordering")
            .accessibilityIdentifier("header.reorderDone")
    }

    @ViewBuilder private var appMenuItems: some View {
        Button("Settings", systemImage: "gear") { navigator.navigate(to: .settings) }
            .accessibilityIdentifier("menu.settings")
        Button("Keyboard shortcuts", systemImage: "keyboard") { navigator.showsShortcuts = true }
            .accessibilityIdentifier("menu.shortcuts")
        Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") { actions.signOut() }
            .accessibilityIdentifier("menu.signOut")
    }
}

extension View {
    /// "Saving…" under the header's title once writes have been retrying for 2 s (spec §2).
    func savingIndicator() -> some View {
        modifier(SavingIndicator())
    }
}

/// Shows "Saving…" as the navigation subtitle while the store is saving.
private struct SavingIndicator: ViewModifier {
    @Environment(AppStore.self) private var store

    func body(content: Content) -> some View {
        // One branch, so the page keeps its identity (and state) when saving starts and stops.
        content.navigationSubtitle(store.isSaving ? "Saving…" : "")
    }
}

/// The floating "+" that opens Quick Entry on phones (placed per `QuickEntryButtonPlacement`). It is hidden while the
/// keyboard is up, where it would cover the keyboard toolbar (Done, row actions) and the row being edited.
struct QuickEntryButton: View {
    @Environment(Navigator.self) private var navigator
    @State private var keyboardShown = false

    var body: some View {
        // The stack stays when the button goes, so the keyboard notifications keep arriving.
        ZStack {
            if !keyboardShown {
                Button {
                    navigator.showsQuickEntry = true
                } label: {
                    Image(systemName: "plus")
                        .font(.title2.weight(.semibold))
                        .frame(width: 56, height: 56)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Quick Entry")
                .accessibilityIdentifier("quickEntry.fab")
                .padding(.trailing, 16)
                .padding(.bottom, 16)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardShown = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardShown = false
        }
    }
}
