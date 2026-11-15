/** Fuzzy subsequence match for smart-match fields (project/tag pickers). Prefix matches rank first. */
export interface FuzzyMatch<T> {
  item: T;
  score: number;
  /** [start, endExclusive] ranges in the name that matched. */
  ranges: Array<[number, number]>;
}

export function fuzzyScore(query: string, name: string): { score: number; ranges: Array<[number, number]> } | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, ranges: [] };
  const n = name.toLowerCase();
  if (n.startsWith(q)) return { score: 1000 - n.length, ranges: [[0, q.length]] };
  const wordStart = n.indexOf(` ${q}`);
  if (wordStart >= 0) return { score: 800 - n.length, ranges: [[wordStart + 1, wordStart + 1 + q.length]] };
  const contains = n.indexOf(q);
  if (contains >= 0) return { score: 600 - n.length, ranges: [[contains, contains + q.length]] };
  const ranges: Array<[number, number]> = [];
  let qi = 0;
  let score = 300 - n.length;
  let prev = -2;
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] !== q[qi]) continue;
    const last = ranges[ranges.length - 1];
    if (last && prev === i - 1) last[1] = i + 1;
    else {
      ranges.push([i, i + 1]);
      score -= 5;
    }
    prev = i;
    qi++;
  }
  return qi === q.length ? { score, ranges } : null;
}

export function fuzzyFilter<T>(query: string, items: T[], nameOf: (item: T) => string, limit = 20): FuzzyMatch<T>[] {
  const out: FuzzyMatch<T>[] = [];
  for (const item of items) {
    const m = fuzzyScore(query, nameOf(item));
    if (m) out.push({ item, score: m.score, ranges: m.ranges });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
/** Case-insensitive match ranges of every query term in `text`. */
export function matchRanges(text: string, query: string): Array<[number, number]> {
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const term of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(term, from);
      if (i < 0) break;
      ranges.push([i, i + term.length]);
      from = i + term.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

