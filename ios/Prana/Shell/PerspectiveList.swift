// Author: John Grimes

import PranaKit
import SwiftUI

/// A perspective's glyph in its colour.
struct PerspectiveGlyph: View {
    let perspective: Perspective

    var body: some View {
        Image(systemName: PerspectiveStyle.symbol(of: perspective))
            .foregroundStyle(PerspectiveStyle.tint(of: perspective))
            .frame(width: 28)
    }
}

/// The star that adds a perspective to the favourites or removes it (an instant write).
struct FavouriteToggle: View {
    @Environment(AppStore.self) private var store
    let perspective: Perspective

    var body: some View {
        Button {
            store.patchPerspective(perspective.id, PerspectivePatch(favorite: !perspective.favorite))
        } label: {
            Image(systemName: perspective.favorite ? "star.fill" : "star")
                .foregroundStyle(perspective.favorite ? Color.yellow : Color.secondary)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(perspective.favorite ? "Remove \(perspective.name) from favourites" : "Add \(perspective.name) to favourites")
        .accessibilityAddTraits(perspective.favorite ? .isSelected : [])
        .accessibilityIdentifier("favourite.\(perspective.id)")
    }
}

/// Loading and failure of the perspectives list (Nielsen #1): a spinner, or the error with Retry.
struct PerspectivesUnavailable: View {
    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator

    var body: some View {
        if navigator.sharedLoadFailed {
            ContentUnavailableView {
                Label("Couldn't load perspectives", systemImage: "wifi.exclamationmark")
            } description: {
                Text("The server could not be reached.")
            } actions: {
                Button("Try Again") {
                    Task { await navigator.loadShared(store) }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("perspectives.retry")
            }
        } else {
            ProgressView("Loading…")
                .accessibilityIdentifier("perspectives.loading")
        }
    }
}

/// The perspectives sheet (P, and "All perspectives" in the iPad rail): the management list — open, favourite,
/// reorder, edit, duplicate, delete and New Perspective. Opening a perspective navigates, which closes the sheet.
struct PerspectivesSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.state.perspectives != nil {
                    PerspectiveManagementView()
                } else {
                    PerspectivesUnavailable().navigationTitle("Perspectives")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
    }
}

/// The phone's More tab: every perspective (with favourite stars), New perspective, then Settings, Keyboard shortcuts
/// and Sign out (the web `BottomBar` "More" dialog). Rows push their page onto the More tab's stack.
struct MoreList: View {
    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator

    var body: some View {
        Group {
            if let perspectives = store.state.perspectives {
                List {
                    Section("All perspectives") {
                        ForEach(PerspectiveStyle.sorted(perspectives)) { perspective in
                            HStack {
                                NavigationLink(value: PerspectiveStyle.route(of: perspective)) {
                                    Label { Text(perspective.name) } icon: { PerspectiveGlyph(perspective: perspective) }
                                        .frame(minHeight: 44)
                                }
                                .accessibilityIdentifier("more.\(perspective.id)")
                                FavouriteToggle(perspective: perspective)
                            }
                        }
                        if perspectives.isEmpty {
                            Text("No perspectives").foregroundStyle(.secondary)
                        }
                    }
                    Section {
                        NavigationLink(value: Route.perspectiveEditor(id: ShellNavigation.newPerspectiveId)) {
                            Label("New perspective", systemImage: "plus")
                        }
                        .accessibilityIdentifier("more.newPerspective")
                        NavigationLink {
                            PerspectiveManagementView()
                        } label: {
                            Label("Manage perspectives", systemImage: "square.stack")
                        }
                        .accessibilityIdentifier("more.managePerspectives")
                        NavigationLink(value: Route.settings) {
                            Label("Settings", systemImage: "gear")
                        }
                        .accessibilityIdentifier("more.settings")
                        Button("Keyboard shortcuts", systemImage: "keyboard") { navigator.showsShortcuts = true }
                            .accessibilityIdentifier("more.shortcuts")
                        Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                            ShellActions(store: store, navigator: navigator).signOut()
                        }
                        .accessibilityIdentifier("more.signOut")
                    }
                }
            } else {
                PerspectivesUnavailable()
            }
        }
        .navigationTitle("More")
        .savingIndicator()
    }
}
