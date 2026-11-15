// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Ports `src/web/lib/repeat.test.ts` so the native repeat editor reads, writes and summarises RRULEs exactly
/// like the web app (spec §3 Repeat editor).
struct RepeatEditingTests {
    // MARK: parse / build (vectors from repeat.test.ts)

    @Test func roundTripsWeeklyRulesWithWeekdaysInCalendarOrder() {
        // Arrange / Act: days given out of calendar order.
        let form = RepeatForm(rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,MO")
        // Assert: parsing keeps the given order; building sorts them Sunday-first.
        #expect(form.freq == .weekly)
        #expect(form.interval == 2)
        #expect(form.byDay == [.friday, .monday])
        #expect(form.rule == "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR")
    }

    @Test func readsNthWeekdayFromBydayPrefix() {
        let form = RepeatForm(rule: "FREQ=MONTHLY;BYDAY=2TU")
        #expect(form.monthlyMode == .nthWeekday)
        #expect(form.nth == 2)
        #expect(form.nthWeekday == .tuesday)
    }

    @Test func readsNthWeekdayFromBysetpos() {
        // BYSETPOS with a single weekday is the other way to say "last Friday".
        let form = RepeatForm(rule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1")
        #expect(form.monthlyMode == .nthWeekday)
        #expect(form.nth == -1)
        #expect(form.nthWeekday == .friday)
        // Building normalises to the BYDAY prefix form and drops BYSETPOS.
        #expect(form.rule == "FREQ=MONTHLY;BYDAY=-1FR")
    }

    @Test func keepsUnknownPartsSuchAsWkst() {
        #expect(RepeatForm(rule: "FREQ=WEEKLY;WKST=SU;BYDAY=MO").rule == "FREQ=WEEKLY;BYDAY=MO;WKST=SU")
    }

    @Test func parsesAndBuildsEndConditions() {
        #expect(RepeatForm(rule: "FREQ=DAILY;COUNT=3").end == .count(3))
        let until = RepeatForm(rule: "FREQ=DAILY;UNTIL=20261231T235959Z")
        #expect(until.end == .until("2026-12-31"))
        #expect(until.rule == "FREQ=DAILY;UNTIL=20261231T235959Z")
    }

    @Test func dropsWeeklyWeekdaysWhenFrequencyChangesToMonthlyByDayOfMonth() {
        // Arrange: the editor switches a weekly rule to "monthly on the 15th".
        var form = RepeatForm(rule: "FREQ=WEEKLY;BYDAY=MO")
        form.freq = .monthly
        form.byDay = []
        form.monthlyMode = .dayOfMonth
        form.byMonthDay = [15]
        // Act / Assert
        #expect(form.rule == "FREQ=MONTHLY;BYMONTHDAY=15")
    }

    // MARK: parse / build edge cases

    @Test func defaultsWhenRuleIsEmptyOrPrefixed() {
        // An empty rule yields the editor defaults; an `RRULE:` prefix is stripped case-insensitively.
        let empty = RepeatForm(rule: "")
        #expect(empty.freq == .weekly)
        #expect(empty.interval == 1)
        #expect(empty.end == .never)
        #expect(empty.rule == "FREQ=WEEKLY")
        #expect(RepeatForm(rule: "rrule:FREQ=daily;interval=3").rule == "FREQ=DAILY;INTERVAL=3")
    }

    @Test func clampsInvalidIntervalAndCount() {
        // Zero, negative and non-numeric values fall back to 1, as on the web.
        #expect(RepeatForm(rule: "FREQ=DAILY;INTERVAL=0").interval == 1)
        #expect(RepeatForm(rule: "FREQ=DAILY;INTERVAL=-4").interval == 1)
        #expect(RepeatForm(rule: "FREQ=DAILY;INTERVAL=abc").interval == 1)
        #expect(RepeatForm(rule: "FREQ=DAILY;COUNT=0").end == .count(1))
    }

    @Test func filtersInvalidMonthDaysAndMonths() {
        // BYMONTHDAY drops zero and non-numbers; BYMONTH keeps only 1-12 and is built sorted.
        let form = RepeatForm(rule: "FREQ=YEARLY;BYMONTH=12,0,13,3;BYMONTHDAY=0,x,1,-1")
        #expect(form.byMonth == [12, 3])
        #expect(form.byMonthDay == [1, -1])
        #expect(form.monthlyMode == .dayOfMonth)
        #expect(form.rule == "FREQ=YEARLY;BYMONTH=3,12;BYMONTHDAY=1,-1")
    }

    @Test func keepsBysetposAsExtraOutsideNthWeekdayMode() {
        // A weekly rule with BYSETPOS keeps its days and round-trips the BYSETPOS part.
        let form = RepeatForm(rule: "FREQ=WEEKLY;BYDAY=MO,TU;BYSETPOS=1")
        #expect(form.byDay == [.monday, .tuesday])
        #expect(form.monthlyMode == .none)
        #expect(form.rule == "FREQ=WEEKLY;BYDAY=MO,TU;BYSETPOS=1")
    }

    @Test func ignoresMalformedWeekdaysAndKeepsUnknownFrequency() {
        let form = RepeatForm(rule: "FREQ=SECONDLY;BYDAY=XX,12MO,TH")
        #expect(form.freq.rawValue == "SECONDLY")
        #expect(form.byDay == [.thursday])
        #expect(form.rule == "FREQ=SECONDLY")
    }

    @Test func ignoresMalformedUntil() {
        #expect(RepeatForm(rule: "FREQ=DAILY;UNTIL=2026").end == .never)
    }

    // MARK: summary (vectors from repeat.test.ts)

    @Test func summarisesScheduleAnchorAndCount() {
        let repeatRule = RepeatRule(
            rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=4", scheduleType: .fromCompletion, anchorDate: .defer,
            catchUpAutomatically: false)
        #expect(summarizeRepeat(repeatRule) == "Every 2 weeks on Monday and Friday, 4 times, after completion (defer date)")
    }

    @Test func summarisesLastDayOfMonthWithCatchUp() {
        let repeatRule = RepeatRule(
            rule: "FREQ=MONTHLY;BYMONTHDAY=-1", scheduleType: .regularly, anchorDate: .due, catchUpAutomatically: true)
        #expect(
            summarizeRepeat(repeatRule)
                == "Every month on the last day, on a fixed schedule (due date), catching up automatically")
    }

    // MARK: summary edge cases

    @Test func summarisesYearlyNthWeekdayAndUntil() {
        let repeatRule = RepeatRule(
            rule: "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;UNTIL=20301231T235959Z", scheduleType: .regularly,
            anchorDate: .planned, catchUpAutomatically: false)
        #expect(
            summarizeRepeat(repeatRule)
                == "Every year in November on the fourth Thursday, until 2030-12-31, on a fixed schedule (planned date)")
    }

    @Test func summarisesOrdinalsListsAndSingularCount() {
        let repeatRule = RepeatRule(
            rule: "FREQ=MONTHLY;BYMONTHDAY=1,2,3,11,12,13,21,22,23;COUNT=1", scheduleType: .fromCompletion,
            anchorDate: .due, catchUpAutomatically: true)
        // Catch-up is only mentioned for fixed schedules.
        #expect(
            summarizeRepeat(repeatRule)
                == "Every month on the 1st, the 2nd, the 3rd, the 11th, the 12th, the 13th, the 21st, the 22nd and the 23rd, 1 time, after completion (due date)"
        )
    }

    @Test func summarisesUnknownFrequencyAsTimes() {
        let repeatRule = RepeatRule(
            rule: "FREQ=SECONDLY;INTERVAL=5", scheduleType: .regularly, anchorDate: .due, catchUpAutomatically: false)
        #expect(summarizeRepeat(repeatRule) == "Every 5 times, on a fixed schedule (due date)")
    }

    @Test func ordinalWordsFallBackToTh() {
        #expect(repeatOrdinal(-1) == "last")
        #expect(repeatOrdinal(1) == "first")
        #expect(repeatOrdinal(5) == "fifth")
        #expect(repeatOrdinal(6) == "6th")
    }

    @Test func defaultRepeatIsWeeklyOnFixedScheduleFromDue() {
        #expect(
            RepeatRule.defaultRepeat
                == RepeatRule(rule: "FREQ=WEEKLY", scheduleType: .regularly, anchorDate: .due, catchUpAutomatically: false))
    }
}
