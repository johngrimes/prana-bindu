// Author: John Grimes

import Foundation

/// A partial record: field name → JSON value, as in the web client's `Partial<Task>` objects. A key that is present
/// changes that field (`.null` clears it); absent keys are untouched.
public typealias Fields = [String: JSONValue]

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
    /// A string value.
    public init(stringLiteral value: String) { self = .string(value) }
    /// A boolean value.
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    /// A number value.
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    /// A number value.
    public init(floatLiteral value: Double) { self = .number(value) }
    /// An array value.
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    /// An object value.
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }
}

/// Converts between `Codable` records and `Fields`, so previews can apply partial changes the way the web client
/// spreads objects (`{ ...task, ...changes }`).
enum JSONBridge {
    /// The JSON value `value` encodes to (`.null` if it cannot be encoded).
    static func value(_ value: some Encodable) -> JSONValue {
        guard let data = try? APIClient.encoder.encode(value),
            let json = try? APIClient.decoder.decode(JSONValue.self, from: data)
        else { return .null }
        return json
    }

    /// The JSON object `value` encodes to (empty if it is not an object).
    static func fields(_ value: some Encodable) -> Fields {
        guard case .object(let object) = self.value(value) else { return [:] }
        return object
    }

    /// Decodes `T` from a JSON object, or nil when it does not fit.
    static func decode<T: Decodable>(_ type: T.Type, from fields: Fields) -> T? {
        guard let data = try? APIClient.encoder.encode(JSONValue.object(fields)) else { return nil }
        return try? APIClient.decoder.decode(T.self, from: data)
    }

    /// `value` with `changes` merged over its top-level fields; unchanged when the result would not decode.
    static func merging<T: Codable>(_ value: T, _ changes: Fields) -> T {
        if changes.isEmpty { return value }
        let merged = fields(value).merging(changes) { _, new in new }
        return decode(T.self, from: merged) ?? value
    }

    /// The current values of `keys` in `value` (`.null` for absent ones): the fields that undo a change of `keys`.
    static func pick(_ value: some Encodable, _ keys: some Sequence<String>) -> Fields {
        let all = fields(value)
        var out: Fields = [:]
        for key in keys { out[key] = all[key] ?? .null }
        return out
    }
}
