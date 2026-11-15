import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore, matchRanges } from "./fuzzy";

describe("fuzzy matching", () => {
  it("ranks prefix matches above word, substring and subsequence matches", () => {
    const names = ["Errands", "Home errands", "Steering", "Spare room"];
    expect(fuzzyFilter("er", names, (n) => n).map((m) => m.item)).toEqual(["Errands", "Home errands", "Steering", "Spare room"]);
  });

  it("returns matched ranges for subsequences and rejects non-matches", () => {
    expect(fuzzyScore("hme", "Home")?.ranges).toEqual([
      [0, 1],
      [2, 4],
    ]);
    expect(fuzzyScore("xyz", "Home")).toBeNull();
  });
});

describe("matchRanges", () => {
  it("finds every term case-insensitively and merges overlaps", () => {
    expect(matchRanges("Buy milk and Milkshake", "milk")).toEqual([
      [4, 8],
      [13, 17],
    ]);
    expect(matchRanges("abcdef", "abc bcd")).toEqual([[0, 4]]);
  });
});
