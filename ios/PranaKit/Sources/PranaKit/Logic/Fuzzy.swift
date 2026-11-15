// Author: John Grimes

import Foundation

// Port of `src/web/lib/fuzzy.ts`: fuzzy matching for smart-match fields and Quick Open, and search
// highlighting. Offsets count `Character`s of the original text, so they can index highlights directly; matching
// is case-insensitive per character.

/// A fuzzy match score and the matched ranges of the name (half-open `Character` offsets).
public struct FuzzyScore: Hashable, Sendable {
    /// Higher is better: prefix 1000, word start 800, substring 600, subsequence 300 minus 5 per matched run; each
    /// minus the name's length.
    public let score: Int
    /// Matched ranges in the name, in order.
    public let ranges: [Range<Int>]

    /// Creates a score.
    public init(score: Int, ranges: [Range<Int>]) {
        self.score = score
        self.ranges = ranges
    }
}

/// An item that matched a fuzzy query.
public struct FuzzyMatch<Item> {
    /// The matched item.
    public let item: Item
    /// Its score; higher ranks first.
    public let score: Int
    /// Matched ranges in the item's name (half-open `Character` offsets).
    public let ranges: [Range<Int>]
}

extension FuzzyMatch: Sendable where Item: Sendable {}
extension FuzzyMatch: Equatable where Item: Equatable {}
extension FuzzyMatch: Hashable where Item: Hashable {}

/// Scores `name` against `query` (trimmed, case-insensitive). Prefix matches rank first, then matches at a word
/// start, then substrings, then in-order subsequences. A blank query matches with score 0 and no ranges; nil when
/// the query is not a subsequence of the name.
public func fuzzyScore(_ query: String, _ name: String) -> FuzzyScore? {
    let q = folded(query.trimmingCharacters(in: .whitespacesAndNewlines))
    if q.isEmpty { return FuzzyScore(score: 0, ranges: []) }
    let n = folded(name)
    if n.starts(with: q) { return FuzzyScore(score: 1000 - n.count, ranges: [0..<q.count]) }
    if let wordStart = firstIndex(of: [" "] + q, in: n, from: 0) {
        return FuzzyScore(score: 800 - n.count, ranges: [(wordStart + 1)..<(wordStart + 1 + q.count)])
    }
    if let contains = firstIndex(of: q, in: n, from: 0) {
        return FuzzyScore(score: 600 - n.count, ranges: [contains..<(contains + q.count)])
    }
    var ranges: [Range<Int>] = []
    var qi = 0
    var score = 300 - n.count
    var previous = -2
    for (i, character) in n.enumerated() where qi < q.count {
        guard character == q[qi] else { continue }
        if let last = ranges.last, previous == i - 1 {
            ranges[ranges.count - 1] = last.lowerBound..<(i + 1)
        } else {
            ranges.append(i..<(i + 1))
            score -= 5
        }
        previous = i
        qi += 1
    }
    return qi == q.count ? FuzzyScore(score: score, ranges: ranges) : nil
}

/// The items whose names fuzzy-match `query`, best first (ties keep input order), at most `limit`.
public func fuzzyFilter<Item>(
    _ query: String, _ items: [Item], limit: Int = 20, name: (Item) -> String
) -> [FuzzyMatch<Item>] {
    let matches = items.enumerated().compactMap { offset, item -> (offset: Int, match: FuzzyMatch<Item>)? in
        guard let scored = fuzzyScore(query, name(item)) else { return nil }
        return (offset, FuzzyMatch(item: item, score: scored.score, ranges: scored.ranges))
    }
    let sorted = matches.sorted { a, b in
        a.match.score != b.match.score ? a.match.score > b.match.score : a.offset < b.offset
    }
    return sorted.prefix(max(0, limit)).map(\.match)
}

/// Case-insensitive ranges of every whitespace-separated query term in `text`, sorted, with overlapping or touching
/// ranges merged (half-open `Character` offsets). Used to highlight search results.
public func matchRanges(_ text: String, query: String) -> [Range<Int>] {
    let lower = folded(text)
    var ranges: [Range<Int>] = []
    for term in query.split(whereSeparator: { $0.isWhitespace }) {
        let needle = folded(String(term))
        var from = 0
        while let i = firstIndex(of: needle, in: lower, from: from) {
            ranges.append(i..<(i + needle.count))
            from = i + needle.count
        }
    }
    var merged: [Range<Int>] = []
    for range in ranges.sorted(by: { $0.lowerBound < $1.lowerBound }) {
        if let last = merged.last, range.lowerBound <= last.upperBound {
            merged[merged.count - 1] = last.lowerBound..<max(last.upperBound, range.upperBound)
        } else {
            merged.append(range)
        }
    }
    return merged
}

/// Lower-cases each character on its own, so offsets stay aligned with the original text.
private func folded(_ text: String) -> [String] {
    text.map { $0.lowercased() }
}

/// The first offset at or after `from` where `needle` occurs in `haystack`.
private func firstIndex(of needle: [String], in haystack: [String], from: Int) -> Int? {
    guard !needle.isEmpty, haystack.count >= needle.count, from <= haystack.count - needle.count else { return nil }
    for start in from...(haystack.count - needle.count)
    where haystack[start..<(start + needle.count)].elementsEqual(needle) {
        return start
    }
    return nil
}
