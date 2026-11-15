// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// The perspective editor's draft, saving, duplicating and reordering (port of `src/web/pages/PerspectiveEditor.tsx`).
struct PerspectiveDraftTests {
    let imported = Perspective(
        id: "p1", name: "Errands", icon: "cart", color: "#3f8a6b", favorite: false, rank: 4, aggregation: .any,
        rules: [
            .object(["actionAvailability": .string("available")]),
            .object(["disabledRule": .object(["actionStatus": .string("flagged")])]),
            .object(["someFutureKey": .number(3)]),
        ],
        presentation: Perspective.Presentation(layout: .flat, grouping: .tag, sorting: .due, sidebar: .tags))

    @Test func draftCopiesEveryEditableFieldOfThePerspective() {
        let draft = PerspectiveDraft(imported)
        #expect(draft.name == "Errands")
        #expect(draft.icon == "cart")
        #expect(draft.color == "#3f8a6b")
        #expect(draft.favorite == false)
        #expect(draft.aggregation == .any)
        #expect(draft.rules == imported.rules)
        #expect(draft.presentation == imported.presentation)
    }

    @Test func aNewPerspectiveStartsAsTheWebAppsDraft() {
        let draft = PerspectiveDraft.newPerspective
        #expect(draft.name == "New Perspective")
        #expect(draft.icon == "layers")
        #expect(draft.color == "#4f6fd1")
        #expect(draft.favorite == true)
        #expect(draft.aggregation == .all)
        #expect(draft.rules == [.object(["actionAvailability": .string("available")])])
        #expect(draft.presentation == Perspective.Presentation(layout: .projects, grouping: .none, sorting: .manual, sidebar: .projects))
    }

    @Test func savingANewDraftCreatesItWithTheGivenIdAndEveryField() {
        let input = PerspectiveDraft(imported).createInput(id: "newid")
        #expect(input.id == "newid")
        #expect(input.name == "Errands")
        #expect(input.icon == "cart")
        #expect(input.color == .some("#3f8a6b"))
        #expect(input.favorite == false)
        #expect(input.aggregation == .any)
        #expect(input.rules == imported.rules)
        #expect(input.presentation == PresentationPatch(layout: .flat, grouping: .tag, sorting: .due, sidebar: .tags))
    }

    @Test func savingAnExistingDraftPatchesEveryFieldButRank() {
        var draft = PerspectiveDraft(imported)
        draft.color = nil
        let patch = draft.patch
        #expect(patch.name == "Errands")
        #expect(patch.color == .some(nil))
        #expect(patch.rules == imported.rules)
        #expect(patch.rank == nil)
        #expect(patch.presentation == PresentationPatch(layout: .flat, grouping: .tag, sorting: .due, sidebar: .tags))
    }

    @Test func savingNeedsANonBlankName() {
        var draft = PerspectiveDraft(imported)
        #expect(draft.canSave)
        draft.name = "   "
        #expect(!draft.canSave)
    }

    @Test func duplicatingAddsCopyToTheName() {
        let input = PerspectiveDraft(imported).duplicateInput(id: "dup")
        #expect(input.id == "dup")
        #expect(input.name == "Errands copy")
        #expect(input.rules == imported.rules)
    }

    @Test func reorderingSwapsRanksWithTheNeighbourInRankOrder() {
        let list = [
            Perspective(id: "inbox", builtin: true, name: "Inbox", rank: 0),
            Perspective(id: "b", name: "B", rank: 5), Perspective(id: "a", name: "A", rank: 2),
        ]
        let up = PerspectiveDraft.reorder(list, id: "b", by: -1)
        #expect(up == [PerspectiveDraft.RankChange(id: "b", rank: 2), PerspectiveDraft.RankChange(id: "a", rank: 5)])
        let down = PerspectiveDraft.reorder(list, id: "inbox", by: 1)
        #expect(down == [PerspectiveDraft.RankChange(id: "inbox", rank: 2), PerspectiveDraft.RankChange(id: "a", rank: 0)])
        #expect(PerspectiveDraft.reorder(list, id: "b", by: 1).isEmpty)
        #expect(PerspectiveDraft.reorder(list, id: "inbox", by: -1).isEmpty)
        #expect(PerspectiveDraft.reorder(list, id: "missing", by: 1).isEmpty)
    }

    @Test func movingFromOffsetsSwapsStepByStep() {
        let list = [
            Perspective(id: "a", name: "A", rank: 0), Perspective(id: "b", name: "B", rank: 1),
            Perspective(id: "c", name: "C", rank: 2),
        ]
        // Drag "c" to the top: ranks are reassigned to the new order using the existing rank values.
        let changes = PerspectiveDraft.move(list, from: IndexSet(integer: 2), to: 0)
        #expect(
            changes == [
                PerspectiveDraft.RankChange(id: "c", rank: 0), PerspectiveDraft.RankChange(id: "a", rank: 1),
                PerspectiveDraft.RankChange(id: "b", rank: 2),
            ])
        #expect(PerspectiveDraft.move(list, from: IndexSet(integer: 0), to: 1).isEmpty)
    }

    @Test func optionListsMatchTheWebEditor() {
        #expect(PerspectiveDraft.layoutOptions.map(\.label) == ["Projects hierarchy", "Individual actions"])
        #expect(PerspectiveDraft.sidebarOptions.map(\.label) == ["Projects", "Tags", "None"])
        #expect(
            PerspectiveDraft.groupingOptions.map(\.value.rawValue) == [
                "none", "tag", "tagsCombined", "project", "folder", "due", "defer", "planned", "completed", "dropped",
                "added", "changed", "flagged",
            ])
        #expect(PerspectiveDraft.groupingOptions[2].label == "Tags (combined)")
        #expect(
            PerspectiveDraft.sortingOptions.map(\.label) == [
                "Manual", "Due", "Defer", "Planned", "Completed", "Added", "Changed", "Flagged", "Duration", "Name",
            ])
        #expect(PerspectiveDraft.groupAggregationOptions.map(\.label) == ["All of", "Any of", "None of"])
    }
}

/// Reading and writing a rule's parameters, as the web editor's `RuleParams` does.
struct RuleParameterTests {
    @Test func groupAggregationDefaultsToAnyAndKeepsChildrenAndTheDisabledWrapper() {
        let child: JSONValue = .object(["actionStatus": .string("due")])
        let group: JSONValue = .object([
            "disabledRule": .object(["aggregateType": .string("all"), "aggregateRules": .array([child])])
        ])
        #expect(PerspectiveRules.groupAggregation(of: group) == .all)
        #expect(PerspectiveRules.groupAggregation(of: .object(["aggregateRules": .array([])])) == .any)
        let changed = PerspectiveRules.setGroupAggregation(group, .none)
        #expect(
            changed
                == .object([
                    "disabledRule": .object(["aggregateType": .string("none"), "aggregateRules": .array([child])])
                ]))
    }

    @Test func stringParameterReadsTheKeyThroughTheWrapper() {
        let rule: JSONValue = .object(["disabledRule": .object(["actionAvailability": .string("remaining")])])
        #expect(PerspectiveRules.string(of: rule, key: "actionAvailability") == "remaining")
        #expect(PerspectiveRules.string(of: rule, key: "actionStatus") == "")
    }

    @Test func settingParametersReplacesTheInnerRuleKeepingTheWrapper() {
        let rule: JSONValue = .object(["disabledRule": .object(["actionAvailability": .string("remaining")])])
        let next = PerspectiveRules.setParameters(rule, ["actionAvailability": .string("dropped")])
        #expect(next == .object(["disabledRule": .object(["actionAvailability": .string("dropped")])]))
    }

    @Test func booleanKeyIsTheRulesOnlyKey() {
        #expect(PerspectiveRules.booleanKey(of: .object(["actionIsLeaf": .bool(true)])) == "actionIsLeaf")
        #expect(PerspectiveRules.booleanKey(of: .object([:])) == "actionHasDueDate")
    }

    @Test func durationDefaultsToThirtyMinutes() {
        #expect(PerspectiveRules.durationMinutes(of: .object(["actionWithinDuration": .number(120)])) == 120)
        #expect(PerspectiveRules.durationMinutes(of: .object(["actionWithinDuration": .number(0)])) == 30)
        #expect(PerspectiveRules.durationMinutes(of: .object(["actionWithinDuration": .string("x")])) == 30)
    }

    @Test func idsAreTheArrayOfStringsUnderTheKey() {
        let rule: JSONValue = .object(["actionHasAnyOfTags": .array([.string("t1"), .string("t2")])])
        #expect(PerspectiveRules.ids(of: rule, key: "actionHasAnyOfTags") == ["t1", "t2"])
        #expect(PerspectiveRules.ids(of: .object(["actionHasAnyOfTags": .null]), key: "actionHasAnyOfTags") == [])
    }

    @Test func togglingAnIdAddsOrRemovesItInOrder() {
        #expect(PerspectiveRules.toggling("b", in: ["a"]) == ["a", "b"])
        #expect(PerspectiveRules.toggling("a", in: ["a", "b"]) == ["b"])
    }

    @Test func dateSpecTextIsSetKeepingTheOtherKeys() {
        let rule: JSONValue = .object([
            "actionDateField": .string("due"),
            "actionDateIsAfterDateSpec": .object(["dynamic": .string("today")]),
            "actionDateIsBeforeDateSpec": .object(["dynamic": .string("next week")]),
        ])
        let next = PerspectiveRules.setDateSpec(rule, key: "actionDateIsBeforeDateSpec", text: "dec 25")
        #expect(PerspectiveRules.dateSpecText(of: next, key: "actionDateIsBeforeDateSpec") == "dec 25")
        #expect(PerspectiveRules.dateSpecText(of: next, key: "actionDateIsAfterDateSpec") == "today")
        #expect(next["actionDateField"] == .string("due"))
    }

    @Test func searchTextJoinsTermsWithCommas() {
        let rule: JSONValue = .object(["actionMatchingSearch": .array([.string("milk"), .string("eggs")])])
        #expect(PerspectiveRules.searchText(of: rule) == "milk, eggs")
        #expect(PerspectiveRules.searchText(of: .object([:])) == "")
    }

    @Test func changingKindReplacesTheRuleButKeepsItDisabled() {
        let rule: JSONValue = .object(["disabledRule": .object(["actionStatus": .string("due")])])
        let next = PerspectiveRules.changingKind(rule, to: .tagStatus)
        #expect(next == .object(["disabledRule": .object(["actionHasTagWithStatus": .string("active")])]))
        #expect(PerspectiveRules.changingKind(rule, to: .unknown) == rule)
    }

    @Test func pickerChoicesFlattenTreesDepthFirstByRank() {
        let tags = [
            Tag(id: "b", name: "B", parentId: nil, rank: 2), Tag(id: "a", name: "A", parentId: nil, rank: 1),
            Tag(id: "a1", name: "A1", parentId: "a", rank: 1),
        ]
        let choices = RulePickerChoice.tags(tags)
        #expect(choices.map(\.id) == ["a", "a1", "b"])
        #expect(choices.map(\.depth) == [0, 1, 0])
    }

    @Test func editorRowsWalkTheTreeWithAnAddRowAfterEachGroupsChildren() {
        let rules: [JSONValue] = [
            .object(["actionStatus": .string("due")]),
            .object([
                "disabledRule": .object([
                    "aggregateType": .string("any"),
                    "aggregateRules": .array([
                        .object(["actionIsLeaf": .bool(true)]),
                        .object(["aggregateType": .string("all"), "aggregateRules": .array([])]),
                    ]),
                ])
            ]),
            .object(["mystery": .bool(true)]),
        ]
        let rows = RuleEditorRow.rows(rules)
        let expected: [RuleEditorRow] = [
            .rule(path: [0], depth: 0, isFirst: true, isLast: false),
            .rule(path: [1], depth: 0, isFirst: false, isLast: false),
            .rule(path: [1, 0], depth: 1, isFirst: true, isLast: false),
            .rule(path: [1, 1], depth: 1, isFirst: false, isLast: true),
            .addToGroup(path: [1, 1], depth: 2),
            .addToGroup(path: [1], depth: 1),
            .rule(path: [2], depth: 0, isFirst: false, isLast: true),
        ]
        #expect(rows == expected)
        #expect(rows[2].id == "rule:1.0")
        #expect(rows[4].id == "add:1.1")
        #expect(rows[2].path == [1, 0])
    }

    @Test func ruleAtPathLooksThroughDisabledGroups() {
        let child: JSONValue = .object(["actionIsLeaf": .bool(true)])
        let rules: [JSONValue] = [
            .object(["disabledRule": .object(["aggregateType": .string("any"), "aggregateRules": .array([child])])])
        ]
        #expect(PerspectiveRules.rule(in: rules, at: [0, 0]) == child)
        #expect(PerspectiveRules.rule(in: rules, at: [0, 3]) == nil)
        #expect(PerspectiveRules.rule(in: rules, at: []) == nil)
    }
}
