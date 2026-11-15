// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// The smart-match combobox options of `src/web/components/SmartMatch.tsx`: fuzzy-ranked matches (prefix first, at
/// most 12) followed by `Create "<text>"` unless the text names an existing item exactly.
struct SmartMatchTests {
    private let items = [
        MatchItem(id: "1", name: "Bread"),
        MatchItem(id: "2", name: "Home Renovation"),
        MatchItem(id: "3", name: "Read more"),
        MatchItem(id: "4", name: "Renew passport"),
    ]

    @Test func ranksPrefixMatchesBeforeWordStartsAndThenCreates() {
        let options = SmartMatch.options(for: "re", items: items, allowsCreate: true)
        #expect(
            options.map(\.label) == ["Read more", "Renew passport", "Home Renovation", "Bread", "Create “re”"])
    }

    @Test func emptyTextListsEveryItemAndOffersNoCreate() {
        let options = SmartMatch.options(for: "  ", items: items, allowsCreate: true)
        #expect(options.map(\.label) == items.map(\.name))
    }

    @Test func exactNameCaseInsensitiveSuppressesCreate() {
        let options = SmartMatch.options(for: " bread ", items: items, allowsCreate: true)
        #expect(options.map(\.label) == ["Bread"])
    }

    @Test func createIsOnlyOfferedWhenAllowed() {
        let options = SmartMatch.options(for: "zzz", items: items, allowsCreate: false)
        #expect(options.isEmpty)
        #expect(SmartMatch.options(for: "zzz", items: items, allowsCreate: true) == [.create("zzz")])
    }

    @Test func createUsesTheTrimmedText() {
        #expect(SmartMatch.options(for: "  New list ", items: [], allowsCreate: true) == [.create("New list")])
    }

    @Test func matchesAreCappedAtTwelve() {
        let many = (1...20).map { MatchItem(id: "\($0)", name: "Item \($0)") }
        let options = SmartMatch.options(for: "item", items: many, allowsCreate: true)
        #expect(options.count == 13)
        #expect(options.last == .create("item"))
    }

    @Test func matchesCarryHighlightRanges() {
        let options = SmartMatch.options(for: "ren", items: items, allowsCreate: false)
        guard case .item(let item, let ranges) = options.first else {
            Issue.record("expected a match")
            return
        }
        #expect(item.name == "Renew passport")
        #expect(ranges == [0..<3])
    }
}
