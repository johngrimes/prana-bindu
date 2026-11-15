// Author: John Grimes

import Foundation

/// A string-valued enumeration that tolerates values this client does not know.
///
/// The server may add enum values in later versions; decoding an unknown value must not fail. Conforming types are
/// structs wrapping the raw string, with the known values as static constants, so `switch` statements need a `default`.
public protocol OpenEnum: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral
where RawValue == String {
    /// Creates a value from its raw string.
    init(rawValue: String)
}

extension OpenEnum {
    /// Creates a value from a string literal.
    public init(stringLiteral value: String) {
        self.init(rawValue: value)
    }

    /// Decodes the raw string, whatever its value.
    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    /// Encodes the raw string.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
