// Author: John Grimes

import PranaKit

/// SF Symbols for sidebar and search entries (the web app's `project-parallel`, `project-sequential`,
/// `project-single`, `folder` and `tag` icons).
enum PageIcons {
    /// The icon for a project type.
    static func project(_ type: ProjectType) -> String {
        switch type {
        case .sequential: "list.number"
        case .singleActions: "checklist"
        default: "line.3.horizontal"
        }
    }
}
