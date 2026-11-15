// Author: John Grimes

import PranaKit
import SwiftUI
import UIKit

/// A drop target for files dragged from other apps (Files, Photos) onto the inspector's attachments, built on UIKit's
/// `UIDropInteraction`. SwiftUI's `onDrop` and `dropDestination` inside a `List` or `Form` row only see drags that
/// start in this app: the list's own drop handling takes drags from other apps, so a SwiftUI drop target there never
/// hears of them. A drop interaction on a view inside the row is asked first, wherever the drag comes from.
struct FileDropZone: UIViewRepresentable {
    /// Whether a drag carrying files is over the zone.
    @Binding var targeted: Bool
    /// Receives the dropped providers that carry files, during `performDrop`: it must ask each of them for its file
    /// before returning (`ItemProviderFile.loadAll`), as a drag from another app gives nothing asked for later.
    let receive: @MainActor ([NSItemProvider]) -> Void

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.addInteraction(UIDropInteraction(delegate: context.coordinator))
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.zone = self
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(zone: self)
    }

    /// The drop interaction's delegate: takes drops that carry files (not text, links or dragged outline rows).
    @MainActor
    final class Coordinator: NSObject, UIDropInteractionDelegate {
        var zone: FileDropZone

        init(zone: FileDropZone) {
            self.zone = zone
        }

        private func files(_ session: UIDropSession) -> [NSItemProvider] {
            session.items.map(\.itemProvider).filter(ItemProviderFile.offersFile)
        }

        func dropInteraction(_ interaction: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
            !files(session).isEmpty
        }

        func dropInteraction(_ interaction: UIDropInteraction, sessionDidEnter session: UIDropSession) {
            zone.targeted = true
        }

        func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: UIDropSession) -> UIDropProposal {
            UIDropProposal(operation: .copy)
        }

        func dropInteraction(_ interaction: UIDropInteraction, sessionDidExit session: UIDropSession) {
            zone.targeted = false
        }

        func dropInteraction(_ interaction: UIDropInteraction, sessionDidEnd session: UIDropSession) {
            zone.targeted = false
        }

        func dropInteraction(_ interaction: UIDropInteraction, performDrop session: UIDropSession) {
            zone.targeted = false
            zone.receive(files(session))
        }
    }
}
