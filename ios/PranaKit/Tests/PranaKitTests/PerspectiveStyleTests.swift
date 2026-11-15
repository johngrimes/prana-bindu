// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Icons, colours and ordering of perspectives, as `src/web/lib/perspectives.ts` and `PERSPECTIVE_ICONS` define them.
struct PerspectiveStyleTests {
    @Test func iconsAreTheWebAppsFixedSetInOrder() {
        #expect(
            PerspectiveStyle.icons == [
                "layers", "star", "bolt", "heart", "home", "briefcase", "book", "cart", "phone", "sun", "moon", "leaf",
                "target", "coffee", "mail", "bulb", "list", "eye", "flag", "calendar",
            ])
    }

    @Test func everyFixedIconAndBuiltinHasItsOwnSymbol() {
        let names = PerspectiveStyle.icons
        let symbols = names.map(PerspectiveStyle.symbol(forIcon:))
        #expect(Set(symbols).count == names.count)
        for builtin in ["inbox", "projects", "tags", "forecast", "flagged", "review", "completed", "changed", "search"] {
            #expect(PerspectiveStyle.symbol(forIcon: builtin) != PerspectiveStyle.symbol(forIcon: "unknown-icon"))
        }
        #expect(PerspectiveStyle.symbol(forIcon: "unknown-icon") == PerspectiveStyle.symbol(forIcon: "layers"))
    }

    @Test func builtinsUseTheirOwnIconAndCustomOnesTheirChosenIcon() {
        let inbox = Perspective(id: "inbox", builtin: true, name: "Inbox", icon: "whatever")
        let custom = Perspective(id: "abc", name: "Mine", icon: "heart")
        let blank = Perspective(id: "def", name: "Blank", icon: "")
        #expect(PerspectiveStyle.icon(of: inbox) == "inbox")
        #expect(PerspectiveStyle.icon(of: custom) == "heart")
        #expect(PerspectiveStyle.icon(of: blank) == "layers")
    }

    @Test func colourFallsBackToTheBuiltinColourThenNil() {
        #expect(PerspectiveStyle.color(of: Perspective(id: "forecast", builtin: true, name: "Forecast")) == "#c4372f")
        #expect(PerspectiveStyle.color(of: Perspective(id: "x", name: "X", color: "#123456")) == "#123456")
        #expect(PerspectiveStyle.color(of: Perspective(id: "x", name: "X")) == nil)
    }

    @Test func swatchesAreTheEditorsTenColours() {
        #expect(PerspectiveStyle.swatches.count == 10)
        #expect(PerspectiveStyle.swatches.first == "#4f6fd1")
    }

    @Test func sortedOrdersByRankKeepingTiesStable() {
        let list = [
            Perspective(id: "c", name: "C", rank: 2), Perspective(id: "a", name: "A", rank: 0),
            Perspective(id: "b1", name: "B1", rank: 1), Perspective(id: "b2", name: "B2", rank: 1),
        ]
        #expect(PerspectiveStyle.sorted(list).map(\.id) == ["a", "b1", "b2", "c"])
    }

    @Test func routesGoToBuiltinPagesOrTheCustomPerspective() {
        #expect(PerspectiveStyle.route(of: Perspective(id: "inbox", builtin: true, name: "Inbox")) == .inbox)
        #expect(
            PerspectiveStyle.route(of: Perspective(id: "projects", builtin: true, name: "Projects"))
                == .projects(project: nil, folder: nil))
        #expect(PerspectiveStyle.route(of: Perspective(id: "forecast", builtin: true, name: "F")) == .forecast(day: nil))
        #expect(PerspectiveStyle.route(of: Perspective(id: "search", builtin: true, name: "S")) == .search(query: ""))
        #expect(PerspectiveStyle.route(of: Perspective(id: "abc", name: "Mine")) == .perspective(id: "abc"))
    }

    @Test func hexColoursConvertToComponentsAndBack() throws {
        let rgb = try #require(PerspectiveStyle.rgb(hex: "#4f6fd1"))
        #expect(abs(rgb.red - 79.0 / 255) < 0.0001)
        #expect(abs(rgb.green - 111.0 / 255) < 0.0001)
        #expect(abs(rgb.blue - 209.0 / 255) < 0.0001)
        #expect(PerspectiveStyle.hex(red: rgb.red, green: rgb.green, blue: rgb.blue) == "#4f6fd1")
        #expect(PerspectiveStyle.rgb(hex: "#ABC") == nil)
        #expect(PerspectiveStyle.rgb(hex: "var(--accent)") == nil)
        #expect(PerspectiveStyle.hex(red: 1.2, green: -0.1, blue: 0.5) == "#ff0080")
    }
}
