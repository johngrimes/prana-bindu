// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Ports `src/web/lib/rules.test.ts` (custom perspective rule editing, spec §4.1) plus the editor behaviour of
/// `src/web/pages/PerspectiveEditor.tsx` that does not depend on SwiftUI.
struct PerspectiveRulesTests {
    /// Decodes a JSON literal so vectors read exactly like the TypeScript tests.
    private func json(_ text: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    // MARK: rule kinds (vectors from rules.test.ts)

    @Test func classifiesRuleKeysIncludingDisabledWrappers() {
        #expect(PerspectiveRules.kind(of: json(#"{"actionAvailability":"available"}"#)) == .availability)
        #expect(PerspectiveRules.kind(of: json(#"{"actionHasDueDate":true}"#)) == .boolean)
        #expect(PerspectiveRules.kind(of: json(#"{"disabledRule":{"actionHasAnyOfTags":["t1"]}}"#)) == .anyTags)
        #expect(PerspectiveRules.kind(of: json(#"{"aggregateType":"any","aggregateRules":[]}"#)) == .group)
        #expect(PerspectiveRules.kind(of: json(#"{"someFutureRule":1}"#)) == .unknown)
    }

    @Test func togglesDisabledWrapperWithoutLosingRule() {
        let rule = json(#"{"actionStatus":"flagged"}"#)
        let off = PerspectiveRules.setEnabled(rule, false)
        #expect(off == .object(["disabledRule": rule]))
        // Disabling twice does not double-wrap; enabling unwraps.
        #expect(PerspectiveRules.setEnabled(off, false) == off)
        #expect(PerspectiveRules.setEnabled(off, true) == rule)
    }

    // MARK: rule kinds edge cases

    @Test func classifiesEveryKnownKind() {
        // Each default rule must classify as the kind that created it.
        for kind in RuleKind.addable {
            #expect(PerspectiveRules.kind(of: PerspectiveRules.defaultRule(kind)!) == kind)
        }
        #expect(PerspectiveRules.defaultRule(.unknown) == nil)
    }

    @Test func booleanRuleNeedsExactlyOneKnownKey() {
        // A boolean key alongside another key is not a boolean rule: it is kept as unsupported.
        #expect(PerspectiveRules.kind(of: json(#"{"actionRepeats":true,"extra":1}"#)) == .unknown)
        #expect(PerspectiveRules.kind(of: json(#"{"actionIsLeaf":false}"#)) == .boolean)
    }

    @Test func nullDisabledRuleIsNotADisabledWrapper() {
        let rule = json(#"{"disabledRule":null}"#)
        #expect(!PerspectiveRules.isDisabled(rule))
        #expect(PerspectiveRules.inner(rule) == rule)
        #expect(PerspectiveRules.kind(of: rule) == .unknown)
    }

    @Test func replaceInnerKeepsDisabledWrapper() {
        let off = json(#"{"disabledRule":{"actionStatus":"due"}}"#)
        let next = json(#"{"actionStatus":"flagged"}"#)
        #expect(PerspectiveRules.replaceInner(off, with: next) == .object(["disabledRule": next]))
        #expect(PerspectiveRules.replaceInner(next, with: off) == off)
    }

    @Test func unknownRulesAreLabelledAsKept() {
        #expect(RuleKind.unknown.label == "Unsupported rule (kept)")
        #expect(RuleKind.group.label == "Group of rules")
        #expect(RuleKind.addable.first == .availability)
        #expect(RuleKind.addable.last == .group)
        #expect(!RuleKind.addable.contains(.unknown))
    }

    // MARK: date rules (vectors from rules.test.ts)

    @Test func carriesRelativeAmountAcrossPastAndNextAndKeepsField() {
        let past = PerspectiveRules.buildDateRule(
            field: "due", condition: .isInThePast,
            previous: json(#"{"actionDateIsInTheNext":{"relativeAfterAmount":3,"relativeComponent":"day"}}"#))
        #expect(
            past
                == json(#"{"actionDateField":"due","actionDateIsInThePast":{"relativeBeforeAmount":3,"relativeComponent":"day"}}"#))
        #expect(PerspectiveRules.dateCondition(of: past) == .isInThePast)
    }

    @Test func buildsBetweenRangeFromTwoDateSpecs() {
        let between = PerspectiveRules.buildDateRule(field: "added", condition: .between, previous: json("{}"))
        #expect(between["actionDateField"] == .string("added"))
        #expect(between["actionDateIsAfterDateSpec"] == json(#"{"dynamic":"today"}"#))
        #expect(between["actionDateIsBeforeDateSpec"] == json(#"{"dynamic":"next week"}"#))
        #expect(PerspectiveRules.dateCondition(of: between) == .between)
    }

    // MARK: date rules edge cases

    @Test func buildsSimpleAndOnDateConditions() {
        let empty = json("{}")
        #expect(
            PerspectiveRules.buildDateRule(field: "defer", condition: .isTomorrow, previous: empty)
                == json(#"{"actionDateField":"defer","actionDateIsTomorrow":true}"#))
        #expect(
            PerspectiveRules.buildDateRule(field: "due", condition: .isInTheNext, previous: empty)
                == json(#"{"actionDateField":"due","actionDateIsInTheNext":{"relativeAfterAmount":1,"relativeComponent":"week"}}"#))
        // The on-date spec carries over its previous text.
        #expect(
            PerspectiveRules.buildDateRule(
                field: "due", condition: .isOnDateSpec, previous: json(#"{"actionDateIsOnDateSpec":{"dynamic":"dec 25"}}"#))
                == json(#"{"actionDateField":"due","actionDateIsOnDateSpec":{"dynamic":"dec 25"}}"#))
    }

    @Test func dateConditionDefaultsToToday() {
        #expect(PerspectiveRules.dateCondition(of: json(#"{"actionDateField":"due"}"#)) == .isToday)
        #expect(PerspectiveRules.dateCondition(of: json(#"{"actionDateField":"due","actionDateIsBeforeDateSpec":{}}"#)) == .between)
        #expect(
            PerspectiveRules.dateCondition(of: json(#"{"disabledRule":{"actionDateField":"due","actionDateIsYesterday":true}}"#))
                == .isYesterday)
    }

    @Test func relativeParametersReadAndWrite() {
        // Arrange: a "next 3 days" rule.
        let rule = json(#"{"actionDateField":"due","actionDateIsInTheNext":{"relativeAfterAmount":3,"relativeComponent":"day"}}"#)
        // Act / Assert: read the parameters back, and rewrite them for the same condition.
        #expect(PerspectiveRules.relativeAmount(of: rule) == 3)
        #expect(PerspectiveRules.relativeComponent(of: rule) == "day")
        #expect(
            PerspectiveRules.setRelative(rule, amount: 2, component: "month")
                == json(#"{"actionDateField":"due","actionDateIsInTheNext":{"relativeAfterAmount":2,"relativeComponent":"month"}}"#))
        // Defaults when there are no relative parameters.
        #expect(PerspectiveRules.relativeAmount(of: json("{}")) == 1)
        #expect(PerspectiveRules.relativeComponent(of: json("{}")) == "week")
    }

    @Test func dateSpecTextReadsDynamicValue() {
        let rule = json(#"{"actionDateIsOnDateSpec":{"dynamic":"today"}}"#)
        #expect(PerspectiveRules.dateSpecText(of: rule, key: "actionDateIsOnDateSpec") == "today")
        #expect(PerspectiveRules.dateSpecText(of: rule, key: "actionDateIsAfterDateSpec") == "")
    }

    @Test func dateFieldLabelsAreCapitalised() {
        #expect(PerspectiveRules.dateFields.map(PerspectiveRules.dateFieldLabel) == [
            "Due date", "Defer date", "Planned date", "Completed date", "Dropped date", "Added date", "Changed date",
        ])
    }

    @Test func searchTermsSplitOnCommas() {
        #expect(PerspectiveRules.searchTerms(" milk, ,eggs ,") == ["milk", "eggs"])
    }

    @Test func durationLabelsMatchWeb() {
        #expect(PerspectiveRules.durationOptions.map(\.label) == [
            "5 minutes", "15 minutes", "30 minutes", "1 hour", "2 hours", "4 hours",
        ])
    }

    // MARK: tree edits (vectors from rules.test.ts)

    private var rules: [JSONValue] {
        [
            json(#"{"actionAvailability":"available"}"#),
            json(#"{"disabledRule":{"aggregateType":"any","aggregateRules":[{"actionHasDueDate":true},{"actionStatus":"flagged"}]}}"#),
        ]
    }

    @Test func updatesRuleNestedInsideDisabledGroup() {
        let original = rules
        let next = PerspectiveRules.update(original, at: [1, 0]) { _ in json(#"{"actionHasDeferDate":true}"#) }
        #expect(
            next[1]
                == json(#"{"disabledRule":{"aggregateType":"any","aggregateRules":[{"actionHasDeferDate":true},{"actionStatus":"flagged"}]}}"#))
        // The input is a value and stays unchanged.
        #expect(
            original[1]
                == json(#"{"disabledRule":{"aggregateType":"any","aggregateRules":[{"actionHasDueDate":true},{"actionStatus":"flagged"}]}}"#))
    }

    @Test func removesRuleWhenUpdaterReturnsNil() {
        #expect(PerspectiveRules.update(rules, at: [0]) { _ in nil }.count == 1)
    }

    @Test func reordersWithinNestedGroupAndIgnoresMovesPastTheEnds() {
        let moved = PerspectiveRules.move(rules, at: [1, 1], by: -1)
        #expect(
            moved[1]
                == json(#"{"disabledRule":{"aggregateType":"any","aggregateRules":[{"actionStatus":"flagged"},{"actionHasDueDate":true}]}}"#))
        #expect(PerspectiveRules.move(rules, at: [0], by: -1) == rules)
    }

    // MARK: tree edits edge cases

    @Test func emptyOrOutOfRangePathsLeaveRulesUnchanged() {
        #expect(PerspectiveRules.update(rules, at: []) { _ in nil } == rules)
        #expect(PerspectiveRules.update(rules, at: [5]) { _ in nil } == rules)
        #expect(PerspectiveRules.move(rules, at: [1], by: 1) == rules)
    }

    @Test func movesTopLevelRulesDown() {
        let moved = PerspectiveRules.move(rules, at: [0], by: 1)
        #expect(moved == [rules[1], rules[0]])
    }

    @Test func updatingIntoNonGroupCreatesChildList() {
        // Descending into a rule without aggregateRules treats it as an empty group, as the web does.
        let next = PerspectiveRules.update(rules, at: [0, 0]) { _ in nil }
        #expect(next[0] == json(#"{"actionAvailability":"available","aggregateRules":[]}"#))
    }

    @Test func appendsChildToGroup() {
        let next = PerspectiveRules.appendChild(json(#"{"actionAvailability":"remaining"}"#), to: rules[1])
        #expect(
            next
                == json(#"{"disabledRule":{"aggregateType":"any","aggregateRules":[{"actionHasDueDate":true},{"actionStatus":"flagged"},{"actionAvailability":"remaining"}]}}"#))
        #expect(PerspectiveRules.children(of: next).count == 3)
    }

    @Test func unknownRulesRoundTripThroughEdits() throws {
        // Arrange: an imported tree with an unknown rule inside a group, edited elsewhere.
        let imported = json(#"[{"aggregateType":"all","aggregateRules":[{"someFutureRule":{"x":[1,true,null,"s"]}},{"actionStatus":"due"}]}]"#)
        guard case .array(let list) = imported else { Issue.record("not an array"); return }
        // Act: change the known sibling, then encode and decode.
        let edited = PerspectiveRules.update(list, at: [0, 1]) { _ in json(#"{"actionStatus":"flagged"}"#) }
        let decoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(JSONValue.array(edited)))
        // Assert: the unknown rule is untouched.
        #expect(PerspectiveRules.children(of: edited[0])[0] == json(#"{"someFutureRule":{"x":[1,true,null,"s"]}}"#))
        #expect(decoded == .array(edited))
    }
}
