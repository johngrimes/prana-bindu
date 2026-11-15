// Author: John Grimes

import PranaKit
import SwiftUI
import UIKit

/// Receives the hardware keyboard for the outline (spec §3 Editing). List rows never become first responder, so
/// without it key presses reach no outline handler. This invisible view becomes first responder whenever `claim`
/// changes to a non-nil value (the outline appeared, the selection changed, or title editing ended) and passes each
/// key press to `handle`. Unhandled presses continue up the responder chain, and a text field that becomes first
/// responder takes the keys from it.
struct OutlineKeyCatcher: UIViewRepresentable {
    /// Changes when the outline should take the keyboard; nil while it should not (a title is being edited, a sheet
    /// is open).
    let claim: AnyHashable?
    /// Handles a key press with its modifiers; returns whether it did something.
    let handle: @MainActor (OutlineKey, UIKeyModifierFlags) -> Bool

    func makeUIView(context: Context) -> KeyCatcherView {
        let view = KeyCatcherView()
        view.handle = handle
        view.claim = claim
        return view
    }

    func updateUIView(_ view: KeyCatcherView, context: Context) {
        view.handle = handle
        guard view.claim != claim else { return }
        view.claim = claim
        if claim != nil { view.becomeFirstResponder() }
    }
}

/// The first responder behind `OutlineKeyCatcher`.
final class KeyCatcherView: UIView {
    var handle: (@MainActor (OutlineKey, UIKeyModifierFlags) -> Bool)?
    var claim: AnyHashable?
    /// Presses handled here, so their ends are not passed on either.
    private var handled = Set<UIPress>()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { nil }

    override var canBecomeFirstResponder: Bool { true }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil, claim != nil { becomeFirstResponder() }
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var rest = Set<UIPress>()
        for press in presses {
            if let key = press.key, let outlineKey = Self.outlineKey(key), handle?(outlineKey, key.modifierFlags) == true {
                handled.insert(press)
            } else {
                rest.insert(press)
            }
        }
        if !rest.isEmpty { super.pressesBegan(rest, with: event) }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let rest = presses.subtracting(handled)
        handled.subtract(presses)
        if !rest.isEmpty { super.pressesEnded(rest, with: event) }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let rest = presses.subtracting(handled)
        handled.subtract(presses)
        if !rest.isEmpty { super.pressesCancelled(rest, with: event) }
    }

    /// The outline's name for a key, or nil for keys it never handles.
    private static func outlineKey(_ key: UIKey) -> OutlineKey? {
        switch key.keyCode {
        case .keyboardUpArrow: return .up
        case .keyboardDownArrow: return .down
        case .keyboardLeftArrow: return .left
        case .keyboardRightArrow: return .right
        case .keyboardReturnOrEnter, .keypadEnter: return .return
        case .keyboardTab: return .tab
        case .keyboardEscape: return .escape
        case .keyboardDeleteOrBackspace, .keyboardDeleteForward: return .delete
        default: return key.characters.count == 1 ? .character(key.characters) : nil
        }
    }
}
