// Author: John Grimes

import PranaKit
import SwiftUI

/// The sidebar for a route (spec §2, §4): the Projects folder tree, the Tags tree (Tags, Flagged, Completed, Changed,
/// and custom perspectives by their `sidebar` setting), the Forecast calendar, or the Review list. Empty for routes
/// with no sidebar.
struct SidebarView: View {
    /// The route whose sidebar is shown.
    let route: Route

    @Environment(AppStore.self) private var store

    var body: some View {
        switch PageSidebar(route: route, perspectives: store.state.perspectives) {
        case .projects:
            let selection: (project: String?, folder: String?) = if case .projects(let p, let f) = route { (p, f) } else { (nil, nil) }
            ProjectsSidebar(showDropped: showsDropped, selectedProject: selection.project, selectedFolder: selection.folder)
        case .tags(let perspectiveId):
            TagsSidebar(
                perspectiveId: perspectiveId, showDropped: showsDropped, allowCreate: perspectiveId == "tags",
                selected: perspectiveId == "tags" ? route.contentsKey?.tag : PagesModel.shared.tagFilter[perspectiveId])
        case .forecast:
            let day: String? = if case .forecast(let d) = route { d } else { nil }
            ForecastCalendarSidebar(selected: day)
        case .review:
            ReviewSidebar(current: route.contentsKey?.project)
        case nil:
            EmptyView()
        }
    }

    /// Dropped folders, projects and tags show with the Everything filter of the page's perspective.
    private var showsDropped: Bool {
        guard let key = route.contentsKey, let perspective = store.state.perspectives?.first(where: { $0.id == key.perspectiveId })
        else { return false }
        let contents = store.state.contents.first { $0.key.perspectiveId == key.perspectiveId }?.value
        return PageOptions.filter(perspective, contents: contents) == .all
    }
}

/// The Review sidebar: the frozen list of projects to review, flat, reviewed ones checked.
private struct ReviewSidebar: View {
    let current: String?

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator

    var body: some View {
        let items = PagesModel.shared.reviewItems(store) ?? []
        List {
            ForEach(items) { item in
                let project = item.project
                SidebarRow(
                    icon: PageIcons.project(project.type), label: project.task.name,
                    dimmed: project.effectiveStatus == .completed || project.effectiveStatus == .dropped, reviewed: item.reviewed,
                    active: current == project.id
                ) {
                    navigator.navigate(to: .review(project: project.id))
                }
                .accessibilityIdentifier("review-sidebar-\(project.id)")
            }
        }
        .listStyle(.sidebar)
        .overlay {
            if items.isEmpty { PageMessage("No projects to review") }
        }
        .accessibilityLabel("Projects to review")
    }
}
