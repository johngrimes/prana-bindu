// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// The settings page's choices and texts (port of `src/web/pages/SettingsPage.tsx`).
struct SettingsOptionsTests {
    @Test func dueSoonOffersTodayThenOneToSixDaysAndAWeek() {
        #expect(SettingsOptions.dueSoon.map(\.value) == [0, 86_400, 172_800, 259_200, 345_600, 432_000, 518_400, 604_800])
        #expect(
            SettingsOptions.dueSoon.map(\.label) == [
                "Today", "24 hours", "2 days", "3 days", "4 days", "5 days", "6 days", "1 week",
            ])
    }

    @Test func weekdaysAreNumberedFromSundayAsOne() {
        #expect(SettingsOptions.weekdays.first == RuleOption(1, "Sunday"))
        #expect(SettingsOptions.weekdays.last == RuleOption(7, "Saturday"))
        #expect(SettingsOptions.weekdays.count == 7)
    }

    @Test func dateFormatsAreTheFourPatterns() {
        #expect(SettingsOptions.dateFormats.map(\.rawValue) == ["MM/dd/yyyy", "dd/MM/yyyy", "yyyy/MM/dd", "yyyy-MM-dd"])
    }

    @Test func timeZonesAreSortedAndIncludeTheCurrentOneFirstWhenUnknown() {
        let zones = SettingsOptions.timeZones(including: "Australia/Brisbane")
        #expect(zones.contains("Australia/Brisbane"))
        #expect(zones == zones.sorted())
        let odd = SettingsOptions.timeZones(including: "Mars/Olympus")
        #expect(odd.first == "Mars/Olympus")
        #expect(odd.count == zones.count + 1)
    }

    @Test func timesConvertBetweenHHMMAndComponents() {
        #expect(SettingsOptions.hhmm(hour: 9, minute: 5) == "09:05")
        #expect(SettingsOptions.hhmm(hour: 17, minute: 0) == "17:00")
        let date = SettingsOptions.date(fromHHMM: "17:30")
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        #expect(parts.hour == 17 && parts.minute == 30)
        #expect(SettingsOptions.hhmm(from: date) == "17:30")
    }

    @Test func passkeySubtitleShowsCreatedAndLastUse() throws {
        let used = try decode(Passkey.self, #"{"id":"k","name":"Mac","createdAt":"2026-01-02T03:04:00.000Z","lastUsedAt":"2026-02-03T04:05:00.000Z","deviceType":null,"backedUp":true}"#)
        let unused = try decode(Passkey.self, #"{"id":"k","name":"Mac","createdAt":"2026-01-02T03:04:00.000Z","lastUsedAt":null,"backedUp":false}"#)
        #expect(SettingsOptions.subtitle(of: used, settings: testSettings) == "Created Fri 02/01/2026 3:04 AM · last used Tue 03/02/2026 4:05 AM")
        #expect(SettingsOptions.subtitle(of: unused, settings: testSettings) == "Created Fri 02/01/2026 3:04 AM · never used")
    }

    @Test func tokenSubtitleShowsPrefixCreatedAndLastUse() throws {
        let token = try decode(ApiToken.self, #"{"id":"t","name":"CLI","prefix":"pb_AbC1","createdAt":"2026-01-02T03:04:00.000Z","lastUsedAt":null}"#)
        #expect(SettingsOptions.subtitle(of: token, settings: testSettings) == "pb_AbC1… · created Fri 02/01/2026 3:04 AM · never used")
    }

    @Test func lastPasskeyWarningNamesThePasskeyAndTheEnrolCommand() {
        #expect(
            SettingsOptions.lastPasskeyWarning(name: "Mac")
                == "After deleting “Mac” no passkey can sign in. You will need a new enrollment link from the CLI (prana-bindu passkey enroll) to sign in again.")
    }

    @Test func passkeySetupPageIsTheOriginsSettings() {
        #expect(SettingsOptions.passkeySetupURL(origin: URL(string: "https://tasks.example.com")!).absoluteString == "https://tasks.example.com/settings")
        #expect(SettingsOptions.passkeySetupURL(origin: URL(string: "http://localhost:4005/")!).absoluteString == "http://localhost:4005/settings")
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try APIClient.decoder.decode(type, from: Data(json.utf8))
    }
}
