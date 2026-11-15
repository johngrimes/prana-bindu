// Author: John Grimes

import PranaKit
import SwiftUI

/// Toasts over the bottom of the window, non-blocking (`Toasts.tsx`): errors in red, an optional action button
/// (e.g. Undo), and a dismiss button. They dismiss themselves after 5 s (errors 7 s).
struct ToastOverlay: View {
    @Environment(AppStore.self) private var store
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        VStack(spacing: 8) {
            ForEach(store.toasts) { toast in
                ToastView(toast: toast)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .padding(.leading, 12)
        // On phones, clear of the floating Quick Entry "+" in the trailing corner.
        .padding(.trailing, sizeClass == .compact ? 84 : 12)
        // Above the phone tab bar; near the bottom edge on iPad.
        .padding(.bottom, sizeClass == .compact ? 64 : 24)
        .animation(.default, value: store.toasts)
        .accessibilityElement(children: .contain)
        .onChange(of: store.toasts.last?.id) {
            if let toast = store.toasts.last { AccessibilityNotification.Announcement(toast.message).post() }
        }
    }
}

/// One toast.
private struct ToastView: View {
    @Environment(AppStore.self) private var store
    let toast: Toast

    private var isError: Bool { toast.kind == .error }

    var body: some View {
        HStack(spacing: 4) {
            Text(toast.message)
                .font(.callout)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("toast")
            if let action = toast.action {
                Button(action.label) {
                    switch action {
                    case .undo: store.undo()
                    }
                    store.dismissToast(toast.id)
                }
                .font(.callout.weight(.semibold))
                .frame(minWidth: 44, minHeight: 44)
                .accessibilityIdentifier("toast.action")
            }
            Button {
                store.dismissToast(toast.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Dismiss")
            .opacity(0.8)
        }
        .padding(.leading, 16)
        .padding(.trailing, 4)
        .foregroundStyle(isError ? Color.white : Color.primary)
        .background(isError ? AnyShapeStyle(Color.red.gradient) : AnyShapeStyle(.regularMaterial), in: .rect(cornerRadius: 14))
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        .frame(maxWidth: 480)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.updatesFrequently)
    }
}
