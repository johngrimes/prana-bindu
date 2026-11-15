// Author: John Grimes

import Observation
import PranaKit

/// Selected items: ids of one kind.
struct Selection: Hashable, Sendable {
    /// What kind of item is selected.
    enum Kind: Hashable, Sendable {
        case task, project, folder, tag
    }

    var ids: Set<String>
    var kind: Kind

    /// Nothing selected.
    static let none = Selection(ids: [], kind: .task)

    /// Whether nothing is selected.
    var isEmpty: Bool { ids.isEmpty }
}

/// The window's selection, shared between the outline and the inspector.
@MainActor
@Observable
final class SelectionModel {
    var selection: Selection = .none
}
