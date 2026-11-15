// Author: John Grimes

import Foundation

/// How perspectives look and are ordered: icons, colours and rank order. Port of `src/web/lib/perspectives.ts` and
/// `PERSPECTIVE_ICONS` in `src/web/components/Icons.tsx`, with web icon names mapped to SF Symbols.
public enum PerspectiveStyle {
    /// The icons a custom perspective can use (`PERSPECTIVE_ICONS`), in picker order. Values are web icon names, as
    /// stored in `Perspective.icon`.
    public static let icons = [
        "layers", "star", "bolt", "heart", "home", "briefcase", "book", "cart", "phone", "sun", "moon", "leaf",
        "target", "coffee", "mail", "bulb", "list", "eye", "flag", "calendar",
    ]

    /// The colour swatches offered by the perspective editor (`COLORS`), as `#rrggbb`.
    public static let swatches = [
        "#4f6fd1", "#3f8a6b", "#c4372f", "#e08a12", "#8a5cb8", "#2f5d62", "#b5487a", "#56707d", "#7a6a52", "#1f8fb5",
    ]

    /// Icons of the built-in perspectives by id (`BUILTIN_ICONS`).
    public static let builtinIcons: [String: String] = [
        "inbox": "inbox", "projects": "projects", "tags": "tags", "forecast": "forecast", "flagged": "flagged",
        "review": "review", "completed": "completed", "changed": "changed", "search": "search",
    ]

    /// Colours of the built-in perspectives by id (`BUILTIN_COLORS`).
    public static let builtinColors: [String: String] = [
        "inbox": "#4a7fb5", "projects": "#3f8a6b", "tags": "#8a5cb8", "forecast": "#c4372f", "flagged": "#e08a12",
        "review": "#4f6fd1", "completed": "#5f7a46", "changed": "#7a6a52", "search": "#56707d",
    ]

    /// SF Symbols for web icon names.
    private static let symbols: [String: String] = [
        "layers": "square.3.layers.3d", "star": "star", "bolt": "bolt", "heart": "heart", "home": "house",
        "briefcase": "briefcase", "book": "book", "cart": "cart", "phone": "phone", "sun": "sun.max", "moon": "moon",
        "leaf": "leaf", "target": "target", "coffee": "cup.and.saucer", "mail": "envelope", "bulb": "lightbulb",
        "list": "list.bullet", "eye": "eye", "flag": "flag", "calendar": "calendar",
        "inbox": "tray", "projects": "folder", "tags": "tag", "forecast": "calendar.day.timeline.left",
        "flagged": "flag.fill", "review": "arrow.triangle.2.circlepath", "completed": "checkmark.circle",
        "changed": "clock.arrow.circlepath", "search": "magnifyingglass",
    ]

    /// The SF Symbol for a web icon name; unknown names get the "layers" symbol.
    public static func symbol(forIcon icon: String) -> String {
        symbols[icon] ?? symbols["layers"] ?? "square.3.layers.3d"
    }

    /// The web icon name a perspective shows (`perspectiveIcon`): built-ins have fixed icons; custom perspectives
    /// their own, or "layers" when blank.
    public static func icon(of perspective: Perspective) -> String {
        if perspective.builtin { return builtinIcons[perspective.id] ?? "layers" }
        return perspective.icon.isEmpty ? "layers" : perspective.icon
    }

    /// The SF Symbol a perspective shows.
    public static func symbol(of perspective: Perspective) -> String {
        symbol(forIcon: icon(of: perspective))
    }

    /// A perspective's colour (`perspectiveColor`): its own, else the built-in's, else nil for the accent colour.
    public static func color(of perspective: Perspective) -> String? {
        perspective.color ?? builtinColors[perspective.id]
    }

    /// Perspectives in rank order (`sortPerspectives`); equal ranks keep their order.
    public static func sorted(_ perspectives: [Perspective]) -> [Perspective] {
        perspectives.enumerated()
            .sorted { $0.element.rank != $1.element.rank ? $0.element.rank < $1.element.rank : $0.offset < $1.offset }
            .map(\.element)
    }

    /// The route that shows a perspective (`perspectivePath`): built-ins have their own routes (with no project, tag
    /// or day chosen); custom perspectives use `.perspective(id:)`.
    public static func route(of perspective: Perspective) -> Route {
        guard perspective.builtin else { return .perspective(id: perspective.id) }
        switch perspective.id {
        case "inbox": return .inbox
        case "projects": return .projects(project: nil, folder: nil)
        case "tags": return .tags(tag: nil)
        case "forecast": return .forecast(day: nil)
        case "flagged": return .flagged
        case "review": return .review(project: nil)
        case "completed": return .completed
        case "changed": return .changed
        case "search": return .search(query: "")
        default: return .perspective(id: perspective.id)
        }
    }

    /// The components (0…1) of a `#rrggbb` colour; nil for anything else.
    public static func rgb(hex: String) -> (red: Double, green: Double, blue: Double)? {
        guard hex.count == 7, hex.first == "#", let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        return (Double((value >> 16) & 0xff) / 255, Double((value >> 8) & 0xff) / 255, Double(value & 0xff) / 255)
    }

    /// `#rrggbb` for components in 0…1 (clamped), lower-case like an HTML colour input.
    public static func hex(red: Double, green: Double, blue: Double) -> String {
        func byte(_ component: Double) -> Int { Int((min(max(component, 0), 1) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", byte(red), byte(green), byte(blue))
    }
}
