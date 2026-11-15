// Author: John Grimes

import PranaKit
import SwiftUI

/// The phone layout (spec §2, < 768 px): a tab bar of favourite perspectives plus More, the page full width with its
/// header, the sidebar as a slide-over drawer and the inspector as a full-screen sheet.
struct PhoneShell: View {
    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    /// The route on screen (resolved: the home page when none is set).
    let route: Route

    /// A tab: a perspective, or More.
    enum TabKey: Hashable {
        case perspective(String)
        case more
    }

    @State private var selectedTab: TabKey = .more
    @State private var morePath: [Route] = []
    /// The route each perspective tab last showed. A tab's page stays mounted while another tab is picked, and keeps
    /// that route: the page sees no change, so nothing on it reacts (loads, redirects) while it is hidden.
    @State private var tabRoutes: [String: Route] = [:]

    private var perspectives: [Perspective] { store.state.perspectives ?? [] }
    private var tabs: [Perspective] {
        ShellNavigation.tabItems(perspectives, currentId: ShellNavigation.perspectiveId(of: route))
    }

    /// The tab that shows `route`: its perspective's tab, else More.
    private func tab(for route: Route) -> TabKey {
        guard let id = ShellNavigation.perspectiveId(of: route), tabs.contains(where: { $0.id == id }) else { return .more }
        return .perspective(id)
    }

    var body: some View {
        @Bindable var navigator = navigator
        TabView(selection: $selectedTab) {
            ForEach(tabs) { perspective in
                Tab(value: TabKey.perspective(perspective.id)) {
                    NavigationStack {
                        let shown = ShellNavigation.perspectiveId(of: route) == perspective.id
                            ? route : tabRoutes[perspective.id] ?? PerspectiveStyle.route(of: perspective)
                        RoutePage(route: shown)
                            .shellChrome(route: shown)
                    }
                } label: {
                    Label(perspective.name, systemImage: PerspectiveStyle.symbol(of: perspective))
                }
                .accessibilityIdentifier("tab.\(perspective.id)")
            }
            Tab("More", systemImage: "ellipsis", value: TabKey.more) {
                NavigationStack(path: $morePath) {
                    MoreList()
                        .navigationDestination(for: Route.self) { pushed in
                            // A choice within the page (sidebar, search query) updates it in place.
                            let shown = ShellNavigation.samePage(pushed, route) ? route : pushed
                            RoutePage(route: shown)
                                .shellChrome(route: shown)
                        }
                }
            }
            .accessibilityIdentifier("tab.more")
        }
        .overlay { SidebarDrawer(route: route) }
        .fullScreenCover(isPresented: $navigator.showsInspectorSheet) {
            NavigationStack {
                InspectorView(selection: navigator.selection.selection)
                    .navigationTitle(InspectorView.title(of: navigator.selection.selection))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { navigator.showsInspectorSheet = false }
                                .accessibilityIdentifier("inspector.done")
                        }
                    }
            }
        }
        .onAppear { follow(route) }
        .onChange(of: route) { follow(route) }
        .onChange(of: tabs.map(\.id)) { follow(route) }
        .onChange(of: selectedTab) { pick(selectedTab) }
        .onChange(of: morePath) {
            // More shows one page at a time: the list, then the page picked from it.
            if morePath.count > 1 { morePath = Array(morePath.suffix(1)) }
            if let last = morePath.last { navigator.navigate(to: last) }
        }
    }

    /// Selects the tab showing `route` (pushing it on More when no tab has it).
    private func follow(_ route: Route) {
        let key = tab(for: route)
        if case .perspective(let id) = key { tabRoutes[id] = route }
        if selectedTab != key { selectedTab = key }
        if key == .more, morePath.last.map({ ShellNavigation.samePage($0, route) }) != true { morePath = [route] }
    }

    /// A tab picked by the user: its perspective, or the list of all perspectives for More.
    private func pick(_ key: TabKey) {
        switch key {
        case .perspective(let id):
            guard ShellNavigation.perspectiveId(of: route) != id, let perspective = tabs.first(where: { $0.id == id }) else { return }
            navigator.navigate(to: PerspectiveStyle.route(of: perspective))
        case .more:
            // Picked from a tab's page (not followed to a page shown under More): show the list.
            if tab(for: route) != .more { morePath = [] }
        }
    }
}

/// The sidebar as a slide-over drawer from the leading edge (projects/folders, tags, forecast calendar, review list).
/// Choosing an entry navigates, which closes it.
private struct SidebarDrawer: View {
    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    let route: Route

    private var title: String {
        PageChrome(route: route, perspectives: store.state.perspectives).sidebar?.title ?? "Sidebar"
    }

    var body: some View {
        ZStack(alignment: .leading) {
            if navigator.showsDrawer {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .onTapGesture { navigator.showsDrawer = false }
                    .accessibilityLabel("Close sidebar")
                    .accessibilityAddTraits(.isButton)
                    .transition(.opacity)
                GeometryReader { geometry in
                    NavigationStack {
                        SidebarView(route: route)
                            .navigationTitle(title)
                            .navigationBarTitleDisplayMode(.inline)
                            .toolbar {
                                ToolbarItem(placement: .cancellationAction) {
                                    Button("Close", systemImage: "xmark") { navigator.showsDrawer = false }
                                        .accessibilityIdentifier("drawer.close")
                                }
                            }
                    }
                    .frame(width: min(360, geometry.size.width * 0.85))
                    .clipShape(.rect(bottomTrailingRadius: 16, topTrailingRadius: 16))
                    .shadow(radius: 12)
                    .ignoresSafeArea(edges: .bottom)
                }
                .transition(.move(edge: .leading))
                .accessibilityIdentifier("drawer")
                .accessibilityAddTraits(.isModal)
            }
        }
        .animation(.snappy, value: navigator.showsDrawer)
    }
}
