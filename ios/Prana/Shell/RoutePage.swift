// Author: John Grimes

import PranaKit
import SwiftUI

/// The page for a route (the routes in `src/web/App.tsx`).
struct RoutePage: View {
    let route: Route

    var body: some View {
        switch route {
        case .forecast: ForecastPage(route: route)
        case .review: ReviewPage(route: route)
        case .search: SearchPage(route: route)
        case .perspectiveEditor: PerspectiveEditorPage(route: route)
        case .settings: SettingsPage()
        case .inbox, .projects, .tags, .flagged, .completed, .changed, .perspective: PerspectivePage(route: route)
        }
    }
}
