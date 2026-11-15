// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Ports `src/web/lib/fuzzy.test.ts` (smart-match and Quick Open ranking) and search highlighting ranges.
struct FuzzyTests {
    // MARK: fuzzy matching (vectors from fuzzy.test.ts)

    @Test func ranksPrefixAboveWordSubstringAndSubsequenceMatches() {
        let names = ["Errands", "Home errands", "Steering", "Spare room"]
        #expect(fuzzyFilter("er", names, name: { $0 }).map(\.item) == ["Errands", "Home errands", "Steering", "Spare room"])
    }

    @Test func returnsRangesForSubsequencesAndRejectsNonMatches() {
        #expect(fuzzyScore("hme", "Home")?.ranges == [0..<1, 2..<4])
        #expect(fuzzyScore("xyz", "Home") == nil)
    }

    // MARK: fuzzy matching edge cases

    @Test func blankQueryMatchesEverythingWithZeroScore() {
        #expect(fuzzyScore("  ", "Home") == FuzzyScore(score: 0, ranges: []))
    }

    @Test func scoresByTierAndLength() {
        // Prefix 1000, word start 800, substring 600, subsequence 300 minus 5 per run, each minus the length.
        #expect(fuzzyScore("ho", "Home") == FuzzyScore(score: 996, ranges: [0..<2]))
        #expect(fuzzyScore("er", "Home errands") == FuzzyScore(score: 788, ranges: [5..<7]))
        #expect(fuzzyScore("ee", "Steering") == FuzzyScore(score: 592, ranges: [2..<4]))
        #expect(fuzzyScore("hme", "Home") == FuzzyScore(score: 286, ranges: [0..<1, 2..<4]))
    }

    @Test func trimsAndIgnoresCaseOfQuery() {
        #expect(fuzzyScore("  HO ", "home")?.ranges == [0..<2])
    }

    @Test func filterKeepsInputOrderForTiesAndHonoursLimit() {
        // Equal scores keep their input order (the web's sort is stable).
        let names = ["ab", "ac", "ad", "xyz"]
        #expect(fuzzyFilter("a", names, name: { $0 }).map(\.item) == ["ab", "ac", "ad"])
        #expect(fuzzyFilter("a", names, limit: 2, name: { $0 }).map(\.item) == ["ab", "ac"])
    }

    @Test func rangesCountCharactersNotUtf16Units() {
        // An emoji is one character, so the match starts at offset 2.
        #expect(fuzzyScore("ca", "🏠 café")?.ranges == [2..<4])
    }

    // MARK: matchRanges (vectors from fuzzy.test.ts)

    @Test func findsEveryTermCaseInsensitivelyAndMergesOverlaps() {
        #expect(matchRanges("Buy milk and Milkshake", query: "milk") == [4..<8, 13..<17])
        #expect(matchRanges("abcdef", query: "abc bcd") == [0..<4])
    }

    // MARK: matchRanges edge cases

    @Test func blankQueryHasNoRangesAndAdjacentRangesMerge() {
        #expect(matchRanges("abc", query: "   ") == [])
        // Touching ranges merge, as on the web (`start <= previous end`).
        #expect(matchRanges("abcd", query: "ab cd") == [0..<4])
        #expect(matchRanges("ab cd", query: "cd ab") == [0..<2, 3..<5])
    }
}
