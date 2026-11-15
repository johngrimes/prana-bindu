// Author: John Grimes

import PranaKit
import SwiftUI

/// The inspector for the selection (spec §3 Inspector): one task, action group, inbox item or project; one folder or
/// tag; or several tasks and projects edited together. Hosts provide the navigation container (phone sheet with Done
/// and `title(of:)`, iPad inspector column); the inspector itself is a scrolling form. It sets no navigation title: on
/// iPad the inspector column's title would replace the page's.
struct InspectorView: View {
    let selection: Selection

    var body: some View {
        content
    }

    private var sortedIds: [String] { selection.ids.sorted() }

    @ViewBuilder
    private var content: some View {
        if selection.isEmpty {
            ContentUnavailableView("No Selection", systemImage: "sidebar.right")
                .accessibilityIdentifier("inspector.empty")
        } else if selection.ids.count == 1, let id = selection.ids.first {
            switch selection.kind {
            case .task, .project: TaskInspector(id: id).id(id)
            case .folder: ContainerInspector(kind: .folder, id: id)
            case .tag: ContainerInspector(kind: .tag, id: id)
            }
        } else {
            switch selection.kind {
            case .task, .project: MultiInspector(ids: sortedIds)
            case .folder, .tag:
                ContentUnavailableView("\(selection.ids.count) items selected", systemImage: "square.stack")
            }
        }
    }

    /// The phone sheet's title for a selection.
    static func title(of selection: Selection) -> String {
        selection.ids.count > 1 ? "\(selection.ids.count) Items" : "Inspector"
    }
}
