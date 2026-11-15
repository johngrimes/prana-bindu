// Author: John Grimes

import UIKit
import XCTest

/// Dropping a file on the inspector's attachments in the iPad layout uploads it with its name and size (spec §3
/// "upload via picker or drag-drop"), against a real server. A UI test can't put Files beside the app in Split View,
/// so the app's debug drag source offers the file as Files does (`PRANA_UITEST_DRAG_FILE`).
final class AttachmentDropUITests: ServerTestCase {
    @MainActor
    func testDroppingAnImageOnTheAttachmentsUploadsIt() async throws {
        try XCTSkipIf(isPhone, "Files are dragged onto the inspector in the iPad layout")
        let item = try await createInboxItem("Drop an attachment")
        let name = "Dropped \(UUID().uuidString.prefix(8)).png"
        let image = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 48)).pngData { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        }
        let file = FileManager.default.temporaryDirectory.appending(path: name)
        try image.write(to: file)
        addTeardownBlock { try? FileManager.default.removeItem(at: file) }

        let app = launch("prana://inbox", environment: ["PRANA_UITEST_DRAG_FILE": file.path])
        let row = element(app, "row.\(item.id)")
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.staticTexts[item.name].firstMatch.tap()
        let inspector = element(app, "inspector.title")
        if !inspector.waitForExistence(timeout: 3) {
            element(app, "header.inspector").tap()
        }
        XCTAssertTrue(inspector.waitForExistence(timeout: 10), "The inspector shows")
        // The attachments are the inspector's last section, made once scrolled to.
        let target = element(app, "attachments.drop")
        for _ in 0..<8 where !(target.exists && target.isHittable) {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.7))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.2)))
        }
        XCTAssertTrue(target.exists && target.isHittable, "The inspector shows the drop zone")
        let source = element(app, "uitest.drag-file")
        XCTAssertTrue(source.waitForExistence(timeout: 5))

        source.press(forDuration: 1.5, thenDragTo: target)

        var found: [[String: Any]] = []
        let uploaded = try await eventually(15) {
            let attachments = try await server.send("GET", "/tasks/\(item.id)/attachments") as? [String: Any]
            found = attachments?["items"] as? [[String: Any]] ?? []
            return found.contains { $0["name"] as? String == name && $0["size"] as? Int == image.count }
        }
        let names = found.map { "\($0["name"] ?? "?") (\($0["size"] ?? "?") bytes)" }
        XCTAssertTrue(uploaded, "The dropped file is uploaded as \(name) (\(image.count) bytes); the task has \(names)")
        XCTAssertTrue(app.staticTexts[name].waitForExistence(timeout: 10), "The inspector lists it")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Inspector with the dropped attachment"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
