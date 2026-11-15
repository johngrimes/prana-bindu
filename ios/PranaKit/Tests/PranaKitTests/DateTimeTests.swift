// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Builds an instant from an ISO 8601 `…Z` string (test helper).
func instant(_ iso: String) -> Date {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: iso)!
}

/// Formats an instant as `…Z` with milliseconds, like JavaScript's `toISOString` (test helper).
func iso(_ date: Date?) -> String? {
    date.map { DateTime.formatFixed($0) }
}

/// Port of the `datetime` block of `src/shared/nlparse.test.ts` plus DST and arithmetic vectors produced by
/// running `src/shared/datetime.ts` under Node, so that native and web agree.
@Suite("DateTime")
struct DateTimeTests {
    // MARK: - DST resolution (TS vectors)

    @Test("Floating times resolve across the Sydney spring-forward transition")
    func floatingAcrossSydneyDST() {
        // Sydney DST starts 2026-10-04 02:00 → 03:00 (+10 → +11).
        #expect(iso(DateTime.dateValueToInstant("2026-10-03T09:00:00.000", timeZone: "Australia/Sydney")) == "2026-10-02T23:00:00.000Z")
        #expect(iso(DateTime.dateValueToInstant("2026-10-05T09:00:00.000", timeZone: "Australia/Sydney")) == "2026-10-04T22:00:00.000Z")
    }

    @Test("A non-existent wall time in the spring-forward gap shifts forward by the gap")
    func gapShiftsForward() {
        // 02:30 does not exist in Sydney on 2026-10-04; it becomes 03:30 (+11).
        let naive = DateTime.utcMilliseconds(year: 2026, month: 10, day: 4, hour: 2, minute: 30)
        #expect(DateTime.formatFixed(milliseconds: DateTime.naiveToInstant(naive, timeZone: "Australia/Sydney")) == "2026-10-03T16:30:00.000Z")
        // Same rule in New York (2026-03-08 02:00 → 03:00).
        let nyNaive = DateTime.utcMilliseconds(year: 2026, month: 3, day: 8, hour: 2, minute: 30)
        #expect(DateTime.formatFixed(milliseconds: DateTime.naiveToInstant(nyNaive, timeZone: "America/New_York")) == "2026-03-08T07:30:00.000Z")
    }

    @Test("An ambiguous wall time on fall-back resolves to the earlier instant")
    func ambiguousResolvesEarlier() {
        // New York 01:30 on 2026-11-01 happens twice; the EDT one comes first.
        let naive = DateTime.utcMilliseconds(year: 2026, month: 11, day: 1, hour: 1, minute: 30)
        #expect(DateTime.formatFixed(milliseconds: DateTime.naiveToInstant(naive, timeZone: "America/New_York")) == "2026-11-01T05:30:00.000Z")
        // Sydney 02:30 on 2026-04-05 happens twice; the AEDT (+11) one comes first.
        let syd = DateTime.utcMilliseconds(year: 2026, month: 4, day: 5, hour: 2, minute: 30)
        #expect(DateTime.formatFixed(milliseconds: DateTime.naiveToInstant(syd, timeZone: "Australia/Sydney")) == "2026-04-04T15:30:00.000Z")
    }

    @Test("Brisbane has a constant +10 offset")
    func brisbaneOffset() {
        #expect(DateTime.tzOffsetMilliseconds(instant("2026-01-15T00:00:00.000Z"), timeZone: "Australia/Brisbane") == 36_000_000)
        #expect(DateTime.tzOffsetMilliseconds(instant("2026-07-15T00:00:00.000Z"), timeZone: "Australia/Brisbane") == 36_000_000)
    }

    // MARK: - Day starts and day keys

    @Test("Day start instants follow the offset in force at local midnight")
    func dayStartAcrossDST() {
        #expect(iso(DateTime.dayStartInstant("2026-10-04", timeZone: "Australia/Sydney")) == "2026-10-03T14:00:00.000Z")
        #expect(iso(DateTime.dayStartInstant("2026-04-05", timeZone: "Australia/Sydney")) == "2026-04-04T13:00:00.000Z")
        #expect(iso(DateTime.dayStartInstant("2026-04-06", timeZone: "Australia/Sydney")) == "2026-04-05T14:00:00.000Z")
        #expect(iso(DateTime.dayStartInstant("2026-03-08", timeZone: "America/New_York")) == "2026-03-08T05:00:00.000Z")
        #expect(iso(DateTime.dayStartInstant("2026-11-01", timeZone: "America/New_York")) == "2026-11-01T04:00:00.000Z")
        #expect(DateTime.dayStartInstant("2026-1-4", timeZone: "Australia/Sydney") == nil)
    }

    @Test("Local day keys switch exactly at local midnight")
    func localDayKeyAtMidnight() {
        #expect(DateTime.localDayKey(instant("2026-10-03T14:00:00.000Z"), timeZone: "Australia/Sydney") == "2026-10-04")
        #expect(DateTime.localDayKey(instant("2026-10-03T13:59:59.999Z"), timeZone: "Australia/Sydney") == "2026-10-03")
    }

    @Test("Day key validation and arithmetic")
    func dayKeys() {
        #expect(DateTime.isDayKey("2026-10-31"))
        #expect(!DateTime.isDayKey("2026-10-31T00:00"))
        #expect(!DateTime.isDayKey("26-10-31"))
        #expect(DateTime.addDaysToKey("2026-12-31", 1) == "2027-01-01")
        #expect(DateTime.addDaysToKey("2024-03-01", -1) == "2024-02-29")
        #expect(DateTime.dayKeyToNaive("2026-10-31") == DateTime.utcMilliseconds(year: 2026, month: 10, day: 31))
        #expect(DateTime.dayKeyToNaive("31/10/2026") == nil)
    }

    // MARK: - Parsing and formatting

    @Test("Normalises ISO input to canonical stored form")
    func normalise() {
        #expect(DateTime.normaliseIsoDate("2026-11-03T09:00") == "2026-11-03T09:00:00.000")
        #expect(DateTime.normaliseIsoDate("2026-11-03T09:00:00+10:00") == "2026-11-02T23:00:00.000Z")
        #expect(DateTime.normaliseIsoDate("2026-11-02T23:00:00Z") == "2026-11-02T23:00:00.000Z")
        #expect(DateTime.normaliseIsoDate("tomorrow") == nil)
        // Additional vectors from Node.
        #expect(DateTime.normaliseIsoDate("  2026-11-03T09:00:00.5 ") == "2026-11-03T09:00:00.500")
        #expect(DateTime.normaliseIsoDate("2026-11-03T09:00:00+1000") == "2026-11-02T23:00:00.000Z")
        #expect(DateTime.normaliseIsoDate("2026-11-03T09:00:00.123-05:30") == "2026-11-03T14:30:00.123Z")
        // JavaScript's Date.parse rolls day 30 of February over into March but rejects month 13.
        #expect(DateTime.normaliseIsoDate("2026-02-30T00:00:00Z") == "2026-03-02T00:00:00.000Z")
        #expect(DateTime.normaliseIsoDate("2026-13-01T00:00Z") == nil)
        #expect(DateTime.normaliseIsoDate("2026-11-03") == nil)
    }

    @Test("Floating detection and parsing")
    func floating() {
        #expect(DateTime.isFloating("2026-11-03T09:00"))
        #expect(DateTime.isFloating("2026-11-03T09:00:00.000"))
        #expect(!DateTime.isFloating("2026-11-03T09:00:00.000Z"))
        #expect(!DateTime.isFloating("2026-11-03"))
        // Out-of-range days roll over like Date.UTC.
        #expect(DateTime.parseFloating("2026-02-30T09:00") == 1_772_442_000_000)
        #expect(DateTime.formatFloating(1_772_442_000_000) == "2026-03-02T09:00:00.000")
        #expect(DateTime.parseFloating("nope") == nil)
    }

    @Test("Wall parts of naive milliseconds, including weekday")
    func wallParts() {
        let parts = DateTime.wallParts(DateTime.utcMilliseconds(year: 2026, month: 10, day: 31, hour: 14, minute: 20, second: 5, millisecond: 7))
        #expect(parts == DateTime.WallParts(year: 2026, month: 10, day: 31, hour: 14, minute: 20, second: 5, millisecond: 7, weekday: 6))
        // Before the epoch, floor division must still produce valid parts.
        let early = DateTime.wallParts(DateTime.utcMilliseconds(year: 1969, month: 12, day: 31, hour: 23, minute: 59, second: 59, millisecond: 999))
        #expect(early == DateTime.WallParts(year: 1969, month: 12, day: 31, hour: 23, minute: 59, second: 59, millisecond: 999, weekday: 3))
    }

    @Test("Converting between stored values and naive wall time")
    func storedValues() {
        let naive = DateTime.utcMilliseconds(year: 2026, month: 10, day: 4, hour: 9)
        #expect(DateTime.naiveToDateValue(naive, floating: false, timeZone: "Australia/Sydney") == "2026-10-03T22:00:00.000Z")
        #expect(DateTime.naiveToDateValue(naive, floating: true, timeZone: "Australia/Sydney") == "2026-10-04T09:00:00.000")
        let fromFixed = DateTime.dateValueToNaive("2026-10-04T00:00:00.000Z", timeZone: "Australia/Sydney")
        #expect(fromFixed.map(DateTime.formatFloating) == "2026-10-04T11:00:00.000")
        #expect(DateTime.dateValueToInstant("garbage", timeZone: "Australia/Sydney") == nil)
    }

    @Test("Calendar arithmetic clamps months and years to the month's length")
    func addToNaive() {
        let jan31 = DateTime.utcMilliseconds(year: 2024, month: 1, day: 31, hour: 9, minute: 30)
        #expect(DateTime.formatFloating(DateTime.addToNaive(jan31, 1, .month)) == "2024-02-29T09:30:00.000")
        let leap = DateTime.utcMilliseconds(year: 2024, month: 2, day: 29)
        #expect(DateTime.formatFloating(DateTime.addToNaive(leap, 1, .year)) == "2025-02-28T00:00:00.000")
        let mid = DateTime.utcMilliseconds(year: 2026, month: 1, day: 15)
        #expect(DateTime.formatFloating(DateTime.addToNaive(mid, -2, .month)) == "2025-11-15T00:00:00.000")
        #expect(DateTime.formatFloating(DateTime.addToNaive(mid, 90, .minute)) == "2026-01-15T01:30:00.000")
        #expect(DateTime.formatFloating(DateTime.addToNaive(mid, 2, .week)) == "2026-01-29T00:00:00.000")
    }

    @Test("Time zone validity")
    func validZones() {
        #expect(DateTime.isValidTimeZone("Australia/Brisbane"))
        #expect(!DateTime.isValidTimeZone("Mars/Olympus_Mons"))
    }
}
