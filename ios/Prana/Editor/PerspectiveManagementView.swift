// Author: John Grimes

import PranaKit
import SwiftUI

/// Managing the perspective list (spec §4 "Custom perspectives"): every perspective in rank order, with the
/// favourite star (shows it in the perspectives bar), drag to reorder (Edit), and, for custom perspectives, Edit,
/// Duplicate and Delete (confirmed). "New Perspective" opens the editor on a draft. All changes are instant writes.
///
/// Hosts: the phone shell's More list and the iPad perspectives rail can push or present this view; it navigates
/// with `Navigator.navigate(to:)` and does not wrap itself in a `NavigationStack`.
struct PerspectiveManagementView: View {
    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    @State private var deleting: Perspective?

    private var perspectives: [Perspective] { PerspectiveStyle.sorted(store.state.perspectives ?? []) }

    var body: some View {
        List {
            ForEach(perspectives) { perspective in
                PerspectiveManagementRow(
                    perspective: perspective,
                    open: { navigator.navigate(to: PerspectiveStyle.route(of: perspective)) },
                    toggleFavourite: { toggleFavourite(perspective) }
                )
                .swipeActions(edge: .trailing) {
                    if !perspective.builtin {
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = perspective }
                        Button("Duplicate", systemImage: "plus.square.on.square") { duplicate(perspective) }
                            .tint(.indigo)
                    }
                }
                .swipeActions(edge: .leading) {
                    Button(perspective.favorite ? "Unfavourite" : "Favourite", systemImage: perspective.favorite ? "star.slash" : "star") {
                        toggleFavourite(perspective)
                    }
                    .tint(.yellow)
                }
                .contextMenu { menu(for: perspective) }
            }
            .onMove { source, destination in
                for change in PerspectiveDraft.move(perspectives, from: source, to: destination) {
                    store.patchPerspective(change.id, PerspectivePatch(rank: change.rank))
                }
            }
            Button("New Perspective", systemImage: "plus") {
                navigator.navigate(to: .perspectiveEditor(id: ShellNavigation.newPerspectiveId))
            }
            .accessibilityIdentifier("perspectives.new")
        }
        .navigationTitle("Perspectives")
        .toolbar {
            ToolbarItem(placement: .primaryAction) { EditButton().accessibilityIdentifier("perspectives.reorder") }
        }
        .alert("Delete perspective?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { perspective in
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) { delete(perspective) }
        } message: { perspective in
            Text("“\(perspective.name)” will be deleted. You can undo this.")
        }
    }

    @ViewBuilder
    private func menu(for perspective: Perspective) -> some View {
        Button(perspective.favorite ? "Remove from Favourites" : "Add to Favourites", systemImage: perspective.favorite ? "star.slash" : "star") {
            toggleFavourite(perspective)
        }
        if !perspective.builtin {
            Button("Edit Perspective", systemImage: "slider.horizontal.3") {
                navigator.navigate(to: .perspectiveEditor(id: perspective.id))
            }
            Button("Duplicate", systemImage: "plus.square.on.square") { duplicate(perspective) }
            Button("Delete", systemImage: "trash", role: .destructive) { deleting = perspective }
        }
    }

    private func toggleFavourite(_ perspective: Perspective) {
        store.patchPerspective(perspective.id, PerspectivePatch(favorite: !perspective.favorite))
    }

    private func duplicate(_ perspective: Perspective) {
        let id = ClientID.make()
        store.createPerspective(PerspectiveDraft(perspective).duplicateInput(id: id))
        navigator.navigate(to: .perspectiveEditor(id: id))
    }

    private func delete(_ perspective: Perspective) {
        store.deletePerspective(perspective.id)
        if navigator.route == .perspective(id: perspective.id) || navigator.route == .perspectiveEditor(id: perspective.id) {
            navigator.navigate(to: ShellNavigation.home(store.state.perspectives?.filter { $0.id != perspective.id }))
        }
    }
}

/// One perspective in the management list: icon, name, favourite star and, for custom ones, an edit button.
private struct PerspectiveManagementRow: View {
    let perspective: Perspective
    let open: () -> Void
    let toggleFavourite: () -> Void
    @Environment(Navigator.self) private var navigator

    var body: some View {
        HStack(spacing: 12) {
            Button(action: open) {
                Label {
                    Text(perspective.name).foregroundStyle(.primary)
                } icon: {
                    Image(systemName: PerspectiveStyle.symbol(of: perspective))
                        .foregroundStyle(PerspectiveStyle.tint(of: perspective))
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("perspectives.open.\(perspective.id)")
            if !perspective.builtin {
                Button {
                    navigator.navigate(to: .perspectiveEditor(id: perspective.id))
                } label: {
                    Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Edit \(perspective.name)")
                .accessibilityIdentifier("perspectives.edit.\(perspective.id)")
            }
            Button(action: toggleFavourite) {
                Image(systemName: perspective.favorite ? "star.fill" : "star")
                    .foregroundStyle(perspective.favorite ? .yellow : .secondary)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(perspective.favorite ? "Remove \(perspective.name) from favourites" : "Add \(perspective.name) to favourites")
            .accessibilityIdentifier("perspectives.favourite.\(perspective.id)")
        }
    }
}
