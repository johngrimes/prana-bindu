// Author: John Grimes

import Testing

@testable import PranaKit

/// Toasts as `toast()` in `src/web/components/Toasts.tsx`: an optional action, and at most four on screen.
@MainActor
struct ToastTests {
    private func makeStore() -> AppStore {
        AppStore(credentialStore: InMemoryCredentialStore(), sleep: { _ in try? await Task.sleep(for: .seconds(3600)) })
    }

    @Test func carriesItsAction() {
        // Arrange
        let store = makeStore()

        // Act
        store.toast("Deleted 1 item", action: .undo)

        // Assert
        #expect(store.toasts.map(\.action) == [.undo])
        #expect(ToastAction.undo.label == "Undo")
    }

    @Test func keepsTheNewestFour() {
        // Arrange
        let store = makeStore()

        // Act
        for n in 1...6 { store.toast("Toast \(n)") }

        // Assert
        #expect(store.toasts.map(\.message) == ["Toast 3", "Toast 4", "Toast 5", "Toast 6"])
        #expect(store.toasts.allSatisfy { $0.action == nil })
    }
}
