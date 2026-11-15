// Author: John Grimes

import Foundation

/// A task's repetition (spec §1.2 RepeatRule). Mirrors `RepeatRule` in `src/shared/schemas.ts`.
public struct RepeatRule: Codable, Sendable, Hashable {
    public enum ScheduleType: String, Codable, Sendable, CaseIterable {
        case regularly, fromCompletion
    }

    public enum AnchorDate: String, Codable, Sendable, CaseIterable {
        case due, `defer`, planned
    }

    /// RFC 5545 RRULE body without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO`.
    public var rule: String
    public var scheduleType: ScheduleType
    public var anchorDate: AnchorDate
    public var catchUpAutomatically: Bool

    public init(rule: String, scheduleType: ScheduleType, anchorDate: AnchorDate, catchUpAutomatically: Bool) {
        self.rule = rule
        self.scheduleType = scheduleType
        self.anchorDate = anchorDate
        self.catchUpAutomatically = catchUpAutomatically
    }
}
