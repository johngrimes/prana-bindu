// Author: John Grimes

import PranaKit
import SwiftUI

/// The iPad layout (spec §2, ≥ 768 px): perspectives rail, sidebar, page and inspector side by side; the sidebar
/// (⇧S) and inspector (⇧I) are toggleable. Narrower windows (portrait) collapse the rail, which the header's rail
/// button shows over the page, and start with the inspector closed.
struct PadShell: View {
    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    /// The route on screen (resolved: the home page when none is set).
    let route: Route

    /// `.automatic` lets the split view collapse the rail in portrait; the rail button sets `.all` to show it.
    @State private var columns: NavigationSplitViewVisibility = .automatic
    @State private var wide = true

    private var chrome: PageChrome { PageChrome(route: route, perspectives: store.state.perspectives ?? []) }

    /// From this window width the rail stays beside the page and the inspector starts open (⇧I toggles it).
    nonisolated private static let wideFrom: CGFloat = 1100

    var body: some View {
        @Bindable var navigator = navigator
        NavigationSplitView(columnVisibility: $columns) {
            PerspectiveRail(route: route)
                .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 300)
        } detail: {
            HStack(spacing: 0) {
                if chrome.sidebar != nil, navigator.showsSidebarColumn {
                    SidebarView(route: route)
                        .frame(width: 256)
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel(chrome.sidebar?.title ?? "Sidebar")
                        .accessibilityIdentifier("sidebarColumn")
                    Divider()
                }
                RoutePage(route: route)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .shellChrome(route: route)
            .toolbar {
                if !wide, columns != .all {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Show perspectives", systemImage: "sidebar.squares.leading") { withAnimation { columns = .all } }
                            .accessibilityIdentifier("header.rail")
                    }
                }
            }
            // Its own stack, so pushed pickers stay in the inspector's column. The inspector sets no title: the
            // column's would replace the page's.
            .inspector(isPresented: inspectorShown) {
                NavigationStack {
                    InspectorView(selection: navigator.selection.selection)
                }
                .inspectorColumnWidth(min: 320, ideal: 360, max: 440)
                .accessibilityIdentifier("inspectorColumn")
            }
        }
        // Side by side when wide; in portrait the rail is collapsed and shows over the page.
        .navigationSplitViewStyle(.automatic)
        .onGeometryChange(for: Bool.self) { $0.size.width >= Self.wideFrom } action: { isWide in
            wide = isWide
            navigator.showsInspectorColumn = isWide
            columns = .automatic
        }
        .onChange(of: route) {
            // Picking a perspective from the revealed rail puts it away again.
            if !wide { columns = .automatic }
        }
    }

    /// The inspector column, on pages that have one.
    private var inspectorShown: Binding<Bool> {
        Binding(
            get: { chrome.hasInspector && navigator.showsInspectorColumn },
            set: { navigator.showsInspectorColumn = $0 })
    }
}

/// The perspectives rail: favourites in rank order (plus the current perspective when it is not one), then Settings.
private struct PerspectiveRail: View {
    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    let route: Route

    /// The rail entry for the route on screen.
    private var selectedId: String? { route == .settings ? "settings" : ShellNavigation.perspectiveId(of: route) }

    private var selection: Binding<String?> {
        Binding(
            get: { selectedId },
            set: { id in
                guard let id, id != selectedId else { return }
                if id == "settings" {
                    navigator.navigate(to: .settings)
                } else if let perspective = store.state.perspectives?.first(where: { $0.id == id }) {
                    navigator.navigate(to: PerspectiveStyle.route(of: perspective))
                }
            })
    }

    var body: some View {
        Group {
            if let perspectives = store.state.perspectives {
                let current = ShellNavigation.perspectiveId(of: route)
                List(selection: selection) {
                    Section("Favourites") {
                        ForEach(ShellNavigation.railItems(perspectives, currentId: current)) { perspective in
                            Label { Text(perspective.name) } icon: { PerspectiveGlyph(perspective: perspective) }
                                .opacity(perspective.favorite ? 1 : 0.7)
                                .tag(perspective.id)
                                .accessibilityIdentifier("rail.\(perspective.id)")
                        }
                        if !perspectives.contains(where: \.favorite) {
                            Text("No favourites").foregroundStyle(.secondary)
                        }
                    }
                    Section {
                        Button("All perspectives", systemImage: "square.stack") { navigator.showsPerspectives = true }
                            .accessibilityIdentifier("rail.all")
                        Label("Settings", systemImage: "gear")
                            .tag("settings")
                            .accessibilityIdentifier("rail.settings")
                    }
                }
            } else {
                PerspectivesUnavailable()
            }
        }
        .navigationTitle("Prana")
    }
}
