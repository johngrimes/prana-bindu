// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// JSONValue must round-trip arbitrary JSON, including keys the app does not know (spec §4.1 "Unsupported rule (kept)").
struct JSONValueTests {
    @Test func roundTripsUnknownNestedKeys() throws {
        // Arrange: a rule tree with a key the app does not understand.
        let json = #"{"aggregateType":"all","aggregateRules":[{"someFutureRule":{"x":[1,true,null,"s"]}}]}"#
        // Act
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let again = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
        // Assert
        #expect(value == again)
        #expect(value["aggregateType"] == .string("all"))
    }

    @Test func distinguishesBooleansFromNumbers() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data("[true, 1]".utf8))
        #expect(value == .array([.bool(true), .number(1)]))
    }
}
