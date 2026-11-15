// Author: John Grimes

import Observation
import PranaKit

/// Commands the mounted outline offers the shell (`OutlineCommands` in `src/web/lib/ui.ts`): New item from the
/// header and the rows Clean Up removes.
struct OutlineCommands {
    /// The outline that registered them: when pages switch, the incoming page registers before the outgoing one
    /// disappears, so an outline only withdraws its own commands.
    var owner: ObjectIdentifier
    /// Adds a new item in the current location (the N shortcut and "New item").
    var newItem: @MainActor () -> Void
    /// The greyed rows Clean Up removes from the view, as row changes for `AppStore.cleanUp(rows:)`.
    var leaving: @MainActor () -> [Change]
}

/// The window's navigation and panel state (`ui` in `src/web/lib/ui.ts`): the route shown, the open sheets and panels,
/// reorder mode, the shared selection and the mounted outline's commands. `prana://` links land here.
@MainActor
@Observable
final class Navigator {
    /// The route shown; nil shows the home page (the first favourite perspective).
    var route: Route?
    /// Whether the Quick Entry sheet is open.
    var showsQuickEntry = false
    /// Whether Quick Open (O) is open.
    var showsQuickOpen = false
    /// Whether the keyboard shortcuts sheet is open.
    var showsShortcuts = false
    /// Whether the perspectives list (P) is open.
    var showsPerspectives = false
    /// Whether the page's view options panel is open; the page presents it.
    var showsViewOptions = false
    /// Phone: the full-screen inspector sheet is up.
    var showsInspectorSheet = false
    /// iPad: the inspector column is shown (kept across navigation, as the web's desktop panels).
    var showsInspectorColumn = true
    /// Phone: the sidebar drawer is open.
    var showsDrawer = false
    /// iPad: the sidebar column is shown.
    var showsSidebarColumn = true
    /// Whether the window is in the phone (compact width) layout; set by `RootView`.
    var isCompact = true
    /// Reorder mode (spec §3): action rows show drag grips. Navigation ends it.
    var reordering = false
    /// Sign out is waiting for unsent changes.
    var signingOut = false
    /// The home page (the first favourite perspective); `RootView` keeps it current. A link without a path opens it.
    var home: Route = .inbox
    /// The last load of the perspectives list failed (the shell shows the error with Retry).
    var sharedLoadFailed = false
    /// The window's selection, shared by the outline and the inspector.
    let selection = SelectionModel()
    /// The mounted outline's commands (set by `OutlineView` while it is on screen).
    var outline: OutlineCommands?

    /// Withdraws the outline commands registered by `owner`, leaving another outline's in place.
    func withdrawOutline(_ owner: ObjectIdentifier) {
        if outline?.owner == owner { outline = nil }
    }

    /// Called on every navigation (the shell resets the store's kept rows here).
    @ObservationIgnored var onNavigate: (@MainActor () -> Void)?

    /// Shows a route. Like the web shell on a path change: clears the selection, ends reorder mode and closes the
    /// overlays (drawer, view options, Quick Open, perspectives list).
    func navigate(to route: Route) {
        guard route != self.route else {
            closeOverlays()
            return
        }
        self.route = route
        selection.selection = .none
        reordering = false
        closeOverlays()
        onNavigate?()
    }

    /// Opens a parsed link: its route (a link without a path opens the home page, as `/` redirects there) and Quick
    /// Entry when asked for.
    func open(_ link: DeepLink) {
        navigate(to: link.route ?? home)
        if link.quickEntry { showsQuickEntry = true }
    }

    /// Loads the shared lists (settings, perspectives, folders, projects, tags, history), noting a failure.
    func loadShared(_ store: AppStore) async {
        sharedLoadFailed = false
        await store.loadShared()
        sharedLoadFailed = store.isSignedIn && store.state.perspectives == nil
    }

    /// Reveals the inspector (phone: full-screen sheet; iPad: inspector column), as `showInspector` in the web app.
    func showInspector() {
        if isCompact { showsInspectorSheet = true } else { showsInspectorColumn = true }
    }

    /// Selects a sidebar folder, project or tag and reveals its inspector ("Inspect" in the sidebar's context menus),
    /// closing the phone's drawer so the sheet shows.
    func inspect(_ id: String, kind: Selection.Kind) {
        selection.selection = Selection(ids: [id], kind: kind)
        showsDrawer = false
        showInspector()
    }

    /// Toggles the sidebar: the drawer on phones, the column on iPad (⇧S).
    func toggleSidebar() {
        if isCompact { showsDrawer.toggle() } else { showsSidebarColumn.toggle() }
    }

    /// Toggles the inspector: the sheet on phones, the column on iPad (⇧I).
    func toggleInspector() {
        if isCompact { showsInspectorSheet.toggle() } else { showsInspectorColumn.toggle() }
    }

    /// True when a sheet or popover is up (single-key shortcuts are suspended, as `overlayOpen` in the web app).
    var overlayOpen: Bool {
        showsQuickEntry || showsQuickOpen || showsShortcuts || showsPerspectives || showsViewOptions || showsDrawer
            || showsInspectorSheet
    }

    private func closeOverlays() {
        showsQuickOpen = false
        showsShortcuts = false
        showsPerspectives = false
        showsViewOptions = false
        showsDrawer = false
        showsInspectorSheet = false
    }
}
