// Author: John Grimes

import Foundation

/// One suggestion of a smart-match field: an existing item (with the matched ranges to highlight) or
/// `Create "<text>"`.
public enum SmartMatchOption: Hashable, Sendable, Identifiable {
    /// An existing item; `ranges` are half-open `Character` offsets of the name that matched.
    case item(MatchItem, ranges: [Range<Int>])
    /// Create a new item with this (trimmed) name.
    case create(String)

    /// Stable identity for lists.
    public var id: String {
        switch self {
        case .item(let item, _): "item:\(item.id)"
        case .create(let name): "create:\(name)"
        }
    }

    /// The text shown: the item's name, or `Create “<name>”` (the web app's wording).
    public var label: String {
        switch self {
        case .item(let item, _): item.name
        case .create(let name): "Create “\(name)”"
        }
    }
}

/// The smart-match combobox rules of `src/web/components/SmartMatch.tsx` (project and tag fields).
public enum SmartMatch {
    /// The most matches listed.
    public static let limit = 12

    /// Fuzzy-ranked matches for `text` (every item, in order, when it is blank), followed by `Create "<text>"` when
    /// creating is allowed, the trimmed text is not empty and no item has exactly that name (ignoring case).
    public static func options(for text: String, items: [MatchItem], allowsCreate: Bool) -> [SmartMatchOption] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var options: [SmartMatchOption] = fuzzyFilter(text, items, limit: limit, name: \.name).map {
            .item($0.item, ranges: $0.ranges)
        }
        let exact = items.contains { $0.name.lowercased() == trimmed.lowercased() }
        if allowsCreate, !trimmed.isEmpty, !exact { options.append(.create(trimmed)) }
        return options
    }
}
