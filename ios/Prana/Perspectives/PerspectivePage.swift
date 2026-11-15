// Author: John Grimes

import PranaKit
import SwiftUI

/// A perspective's page: Inbox, Projects, Tags, Flagged, Completed, Changed or a custom perspective (spec §4). Shows
/// the evaluated contents for the route (and the tag picked in its sidebar) in the outline.
struct PerspectivePage: View {
    /// The route shown (its perspective and sidebar selection).
    let route: Route

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator

    private var perspectiveId: String { route.contentsKey?.perspectiveId ?? "inbox" }

    var body: some View {
        if let perspective = store.state.perspectives?.first(where: { $0.id == perspectiveId }) {
            PerspectiveContentView(perspective: perspective, key: contentsKey(perspective))
                .id(perspective.id)
        } else {
            PageMessage(store.state.perspectives == nil ? "Loading…" : "Perspective not found.", busy: store.state.perspectives == nil)
                .navigationTitle("")
        }
    }

    /// The route's contents, with the sidebar tag of perspectives whose route carries none.
    private func contentsKey(_ perspective: Perspective) -> ContentsKey {
        var key = route.contentsKey ?? ContentsKey(perspectiveId: perspective.id)
        if key.tag == nil, PageOptions.sidebar(perspective) == .tags, perspective.id != "tags" {
            key.tag = PagesModel.shared.tagFilter[perspective.id]
        }
        return key
    }
}

/// The loaded perspective: title, outline (or loading/error/empty state), view options and the editor link.
private struct PerspectiveContentView: View {
    let perspective: Perspective
    let key: ContentsKey

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    @State private var finishedKey: ContentsKey?

    private var contents: OutlineContents? { store.state.contents[key] }

    var body: some View {
        @Bindable var navigator = navigator
        content
            .navigationTitle(
                PageOptions.title(
                    perspective, key: key, projects: store.state.projects ?? [], folders: store.state.folders ?? [],
                    tags: store.state.tags ?? [])
            )
            .toolbar {
                if !perspective.builtin {
                    ToolbarItem(placement: .secondaryAction) {
                        Button("Edit perspective", systemImage: "pencil") {
                            navigator.navigate(to: .perspectiveEditor(id: perspective.id))
                        }
                        .accessibilityIdentifier("edit-perspective")
                    }
                }
            }
            .viewOptions(isPresented: $navigator.showsViewOptions, enabled: PageOptions.hasViewOptions(perspective)) {
                ViewOptionsPanel(perspective: perspective)
            }
            .task(id: key) {
                await store.load(key)
                finishedKey = key
            }
    }

    @ViewBuilder private var content: some View {
        if let contents {
            OutlineView(
                contents: contents,
                context: OutlineContext(
                    perspective: perspective, contentsKey: key, reorderMode: navigator.reordering, selection: navigator.selection)
            )
            .overlay {
                if contents.groups.allSatisfy(\.rows.isEmpty) {
                    PageMessage(PageOptions.emptyText(perspectiveId: perspective.id, contents: contents))
                        .allowsHitTesting(false)
                }
            }
        } else if finishedKey == key {
            PageMessage("This perspective could not be loaded.")
        } else {
            PageMessage("Loading…", busy: true)
        }
    }
}

/// A centred, muted page message: loading, errors and empty states.
struct PageMessage: View {
    let text: String
    var busy = false

    init(_ text: String, busy: Bool = false) {
        self.text = text
        self.busy = busy
    }

    var body: some View {
        VStack(spacing: 12) {
            if busy { ProgressView() }
            Text(text)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("page-message")
    }
}
