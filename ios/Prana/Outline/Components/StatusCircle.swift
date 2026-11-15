// Author: John Grimes

import PranaKit
import SwiftUI

/// A task's status circle (square for projects) with every state of spec §3 (port of `StatusCircle.tsx`). Tapping it
/// toggles completion.
struct StatusCircle: View {
    let task: TaskItem
    /// Projects show a rounded square.
    var isProject = false
    /// The row's title, for VoiceOver.
    var label: String
    let onToggle: () -> Void

    private var state: CircleState { CircleState(task) }

    var body: some View {
        Button(action: onToggle) {
            StatusMark(task: task, isProject: isProject)
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Complete \(label.isEmpty ? "Untitled" : label)")
        .accessibilityValue(state == .completed ? "Completed" : state.rawValue)
        .accessibilityAddTraits(state == .completed ? .isSelected : [])
        .accessibilityIdentifier("status-circle")
    }
}

/// The circle (or square) itself, without the tap target; also usable as a static status icon.
struct StatusMark: View {
    let task: TaskItem
    var isProject = false

    var body: some View {
        let state = CircleState(task)
        let shape = isProject ? AnyShape(RoundedRectangle(cornerRadius: 6)) : AnyShape(Circle())
        ZStack {
            shape.fill(fill(state))
            shape.stroke(stroke(state), style: strokeStyle(state))
            switch state {
            case .completed:
                Image(systemName: "checkmark").font(.system(size: 11, weight: .heavy)).foregroundStyle(OutlinePalette.accentText)
            case .dropped:
                Rectangle().fill(OutlinePalette.faint).frame(width: 22, height: 1.75).rotationEffect(.degrees(-45))
            case .repeating:
                Circle().fill(OutlinePalette.muted).frame(width: 6, height: 6)
            default:
                EmptyView()
            }
        }
        .frame(width: 20, height: 20)
        .opacity(state == .blocked ? 0.7 : 1)
        .overlay(alignment: .topTrailing) {
            if state.showsRepeatBadge(for: task) {
                Image(systemName: "repeat")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(OutlinePalette.muted)
                    .padding(1)
                    .background(Color(uiColor: .systemBackground), in: .circle)
                    .offset(x: 6, y: -6)
            }
        }
    }

    private func stroke(_ state: CircleState) -> Color {
        switch state {
        case .next: OutlinePalette.text
        case .blocked, .dropped: OutlinePalette.faint
        case .overdue: OutlinePalette.danger
        case .dueSoon: OutlinePalette.warn
        case .flagged: OutlinePalette.flag
        case .completed: OutlinePalette.accent
        default: OutlinePalette.muted
        }
    }

    private func fill(_ state: CircleState) -> Color {
        switch state {
        case .overdue: OutlinePalette.dangerSoft
        case .dueSoon: OutlinePalette.warnSoft
        case .completed: OutlinePalette.accent
        default: .clear
        }
    }

    private func strokeStyle(_ state: CircleState) -> StrokeStyle {
        switch state {
        case .blocked: StrokeStyle(lineWidth: 1.75, dash: [3, 2])
        case .repeating: StrokeStyle(lineWidth: 1.75, lineCap: .round, dash: [0.1, 3])
        default: StrokeStyle(lineWidth: 1.75)
        }
    }
}
