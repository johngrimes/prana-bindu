// Author: John Grimes

import Foundation
import Testing
import UniformTypeIdentifiers

@testable import PranaKit

/// Files read from drag and drop or the share sheet for upload as attachments (spec §3 "upload via picker or
/// drag-drop").
@MainActor
struct ItemProviderFileTests {
    private static let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4])

    @Test func readsAnImageWithItsNameAndType() async {
        let provider = NSItemProvider(item: Self.png as NSData, typeIdentifier: UTType.png.identifier)
        provider.suggestedName = "Sketch"
        #expect(ItemProviderFile.offersFile(provider))
        let outcome = await ItemProviderFile.load(provider)
        #expect(outcome == .file(UploadFile(name: "Sketch.png", contentType: "image/png", data: Self.png)))
    }

    @Test func readsAFileByItsName() async throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "notes-\(UUID().uuidString).txt")
        try Data("hello".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let provider = try #require(NSItemProvider(contentsOf: url))
        provider.suggestedName = "notes.txt"
        #expect(ItemProviderFile.offersFile(provider))
        let outcome = await ItemProviderFile.load(provider)
        #expect(outcome == .file(UploadFile(name: "notes.txt", contentType: "text/plain", data: Data("hello".utf8))))
    }

    @Test func refusesAFileOverTheLimitWithoutReadingIt() async {
        let provider = NSItemProvider(item: Self.png as NSData, typeIdentifier: UTType.png.identifier)
        provider.suggestedName = "Huge"
        #expect(await ItemProviderFile.load(provider, maxBytes: 4) == .tooLarge(name: "Huge.png"))
        #expect(UploadFile.maxBytes == 100 * 1024 * 1024)
    }

    @Test func asksEveryDroppedProviderForItsFileAtOnce() async throws {
        // A drop from another app hands over only the files asked for during `performDrop`: every provider is asked
        // before `loadAll` returns, not one after another as each file arrives.
        let gate = FileGate()
        let files = [("a.txt", "a.txt"), ("large.txt", "far too large"), ("b.txt", "b.txt")]
        var urls: [URL] = []
        defer { for url in urls { try? FileManager.default.removeItem(at: url) } }
        let providers = try files.map { name, text in
            let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString)-\(name)")
            try Data(text.utf8).write(to: url)
            urls.append(url)
            let provider = NSItemProvider()
            provider.suggestedName = name
            provider.registerFileRepresentation(for: .plainText, visibility: .all, openInPlace: false) { completion in
                gate.park { completion(url, false, nil) }
                return nil
            }
            return provider
        }

        let loading = ItemProviderFile.loadAll(providers, maxBytes: 5)
        #expect(await gate.waitUntilParked(files.count) == files.count)
        gate.release()

        #expect(
            await loading.value == [
                .file(UploadFile(name: "a.txt", contentType: "text/plain", data: Data("a.txt".utf8))),
                .tooLarge(name: "large.txt"),
                .file(UploadFile(name: "b.txt", contentType: "text/plain", data: Data("b.txt".utf8))),
            ])
    }

    @Test func draggedTextIsNotAFile() {
        // Selected text and outline rows (`prana-tasks:` text) drag as plain text without a file name.
        let text = NSItemProvider(object: "prana-tasks:abc" as NSString)
        #expect(!ItemProviderFile.offersFile(text))
        let link = NSItemProvider(object: URL(string: "https://example.com")! as NSURL)
        #expect(!ItemProviderFile.offersFile(link))
    }
}

/// Holds back file representations until released, counting the ones asked for.
private final class FileGate: @unchecked Sendable {
    private let lock = NSLock()
    private var parked: [() -> Void] = []
    private var released = false

    /// Runs `deliver` once released (at once if already released).
    func park(_ deliver: @escaping () -> Void) {
        lock.lock()
        if released {
            lock.unlock()
            deliver()
            return
        }
        parked.append(deliver)
        lock.unlock()
    }

    /// Waits up to five seconds for `count` parked deliveries; returns how many there are.
    func waitUntilParked(_ count: Int) async -> Int {
        let deadline = Date().addingTimeInterval(5)
        while parkedCount < count, Date() < deadline { try? await Task.sleep(for: .milliseconds(20)) }
        return parkedCount
    }

    /// Delivers the parked files and any asked for later.
    func release() {
        lock.lock()
        released = true
        let deliveries = parked
        parked = []
        lock.unlock()
        for deliver in deliveries { deliver() }
    }

    private var parkedCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return parked.count
    }
}
