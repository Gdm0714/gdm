import Darwin
import Foundation
import XCTest
@testable import GDMNative

final class EditorSaveBoundaryTests: XCTestCase {
    private var roots: [URL] = []

    override func tearDownWithError() throws {
        for root in roots {
            try? FileManager.default.removeItem(at: root)
        }
        roots.removeAll()
    }

    func testIndexIsDeterministicAndExcludesMetadataSymlinksAndSpecialFiles() throws {
        let root = try makeRoot()
        try write("z", to: root.appendingPathComponent("z.swift"))
        try write("ten", to: root.appendingPathComponent("10.swift"))
        try write("two", to: root.appendingPathComponent("2.swift"))
        try write("a", to: root.appendingPathComponent("Sources/a.swift"))
        for excluded in [".git", ".gdm", ".omo", ".omx", ".build", "node_modules"] {
            try write("secret", to: root.appendingPathComponent("\(excluded)/hidden.txt"))
        }
        let outside = try makeRoot()
        try write("outside", to: outside.appendingPathComponent("outside.txt"))
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("linked"),
            withDestinationURL: outside
        )
        let fifo = root.appendingPathComponent("events.fifo")
        XCTAssertEqual(Darwin.mkfifo(fifo.path, 0o600), 0)

        let entries = try WorktreeFileService(rootURL: root).indexFiles()

        XCTAssertEqual(
            entries.map(\.relativePath),
            ["10.swift", "2.swift", "Sources", "Sources/a.swift", "z.swift"]
        )
        XCTAssertFalse(entries.contains { $0.relativePath.contains("hidden") })
        XCTAssertFalse(entries.contains { $0.relativePath == "linked" || $0.relativePath == "events.fifo" })
    }

    func testExcludedMetadataNamesAreRejectedCaseInsensitively() throws {
        let root = try makeRoot()
        try write("metadata", to: root.appendingPathComponent(".GiT/config"))
        try write("dependency", to: root.appendingPathComponent("Node_Modules/pkg/index.js"))
        let service = try WorktreeFileService(rootURL: root)

        XCTAssertTrue(try service.indexFiles().isEmpty)
        for path in [".GiT/config", "Node_Modules/pkg/index.js"] {
            XCTAssertThrowsError(try service.openFile(at: path)) { error in
                XCTAssertEqual(
                    error as? WorktreeFileServiceError,
                    .excludedPath(path.split(separator: "/").first.map(String.init) ?? path)
                )
            }
        }
    }

    func testIndexEntryAndDepthBudgetsFailClosed() throws {
        let root = try makeRoot()
        try write("a", to: root.appendingPathComponent("a.txt"))
        try write("b", to: root.appendingPathComponent("b.txt"))

        XCTAssertThrowsError(
            try WorktreeFileService(rootURL: root, maximumEntries: 1).indexFiles()
        ) { error in
            XCTAssertEqual(error as? WorktreeFileServiceError, .entryLimitExceeded(1))
        }

        let deepRoot = try makeRoot()
        try write("deep", to: deepRoot.appendingPathComponent("one/two.txt"))
        XCTAssertThrowsError(
            try WorktreeFileService(rootURL: deepRoot, maximumDepth: 1).indexFiles()
        ) { error in
            XCTAssertEqual(error as? WorktreeFileServiceError, .depthLimitExceeded(1))
        }
    }

    func testTraversalAbsoluteAndExcludedPathsNeverReadOutsideRoot() throws {
        let root = try makeRoot()
        let outside = try makeRoot()
        try write("outside", to: outside.appendingPathComponent("secret.txt"))
        try write("metadata", to: root.appendingPathComponent(".git/config"))
        let service = try WorktreeFileService(rootURL: root)

        for path in ["../secret.txt", "/etc/passwd", "nested/../../secret", "a//b"] {
            XCTAssertThrowsError(try service.openFile(at: path), path) { error in
                guard case .invalidRelativePath = error as? WorktreeFileServiceError else {
                    return XCTFail("unexpected error for \(path): \(error)")
                }
            }
        }
        XCTAssertThrowsError(try service.openFile(at: ".git/config")) { error in
            XCTAssertEqual(error as? WorktreeFileServiceError, .excludedPath(".git"))
        }
        XCTAssertEqual(try String(contentsOf: outside.appendingPathComponent("secret.txt")), "outside")
    }

    func testFinalAndIntermediateSymlinksAreRejectedWithoutReadingTarget() throws {
        let root = try makeRoot()
        let outside = try makeRoot()
        let target = outside.appendingPathComponent("secret.txt")
        try write("outside-secret", to: target)
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("file-link.txt"),
            withDestinationURL: target
        )
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("dir-link"),
            withDestinationURL: outside
        )
        let service = try WorktreeFileService(rootURL: root)

        for path in ["file-link.txt", "dir-link/secret.txt"] {
            XCTAssertThrowsError(try service.openFile(at: path), path) { error in
                guard case .symbolicLink = error as? WorktreeFileServiceError else {
                    return XCTFail("unexpected error for \(path): \(error)")
                }
            }
        }
        XCTAssertEqual(try String(contentsOf: target), "outside-secret")
    }

    func testBinaryAndOversizedFilesAreRejected() throws {
        let root = try makeRoot()
        try Data([0x66, 0x80, 0x6f]).write(to: root.appendingPathComponent("binary.dat"))
        try write("12345", to: root.appendingPathComponent("large.txt"))
        let service = try WorktreeFileService(rootURL: root, maximumFileSize: 4)

        XCTAssertThrowsError(try service.openFile(at: "binary.dat")) { error in
            XCTAssertEqual(error as? WorktreeFileServiceError, .invalidUTF8("binary.dat"))
        }
        XCTAssertThrowsError(try service.openFile(at: "large.txt")) { error in
            XCTAssertEqual(
                error as? WorktreeFileServiceError,
                .fileTooLarge(path: "large.txt", limit: 4)
            )
        }
    }

    func testSHAConflictDoesNotOverwriteExternalModificationAndExplicitOverwriteDoes() throws {
        let root = try makeRoot()
        let file = root.appendingPathComponent("note.txt")
        try write("alpha", to: file)
        let service = try WorktreeFileService(rootURL: root)
        let baseline = try service.openFile(at: "note.txt")

        // Keep every disk-revision field identical so only the SHA-256 gate can
        // detect this in-place, same-length external edit.
        try writeInPlacePreservingTimes("bravo", to: file)
        let externallyChanged = try service.openFile(at: "note.txt")
        XCTAssertEqual(externallyChanged.revision.disk, baseline.revision.disk)
        XCTAssertNotEqual(externallyChanged.revision.sha256, baseline.revision.sha256)
        XCTAssertThrowsError(
            try service.saveFile(at: "note.txt", text: "editor", baseline: baseline.revision)
        ) { error in
            XCTAssertEqual(error as? WorktreeFileServiceError, .externalModification("note.txt"))
        }
        XCTAssertEqual(try String(contentsOf: file), "bravo")

        let overwritten = try service.saveFile(
            at: "note.txt",
            text: "editor",
            baseline: baseline.revision,
            overwrite: true
        )
        XCTAssertEqual(overwritten.text, "editor")
        XCTAssertEqual(try String(contentsOf: file), "editor")
    }

    func testDiskRevisionDetectsAtomicReplacementEvenWhenSHAIsUnchanged() throws {
        let root = try makeRoot()
        let file = root.appendingPathComponent("same.txt")
        try write("same", to: file)
        let service = try WorktreeFileService(rootURL: root)
        let baseline = try service.openFile(at: "same.txt")
        let replacement = root.appendingPathComponent("replacement.txt")
        try write("same", to: replacement)
        XCTAssertEqual(Darwin.rename(replacement.path, file.path), 0)

        let current = try service.openFile(at: "same.txt")
        XCTAssertEqual(current.revision.sha256, baseline.revision.sha256)
        XCTAssertNotEqual(current.revision.disk, baseline.revision.disk)
        XCTAssertThrowsError(
            try service.saveFile(at: "same.txt", text: "mine", baseline: baseline.revision)
        ) { error in
            XCTAssertEqual(error as? WorktreeFileServiceError, .externalModification("same.txt"))
        }
    }

    func testParentSymlinkSwapBeforeSaveCannotTouchOutsideRoot() throws {
        let root = try makeRoot()
        let outside = try makeRoot()
        let safeDirectory = root.appendingPathComponent("safe", isDirectory: true)
        let originalDirectory = root.appendingPathComponent("safe-original", isDirectory: true)
        try write("baseline", to: safeDirectory.appendingPathComponent("file.txt"))
        try write("outside", to: outside.appendingPathComponent("file.txt"))
        let service = try WorktreeFileService(rootURL: root)
        let baseline = try service.openFile(at: "safe/file.txt")

        try FileManager.default.moveItem(at: safeDirectory, to: originalDirectory)
        try FileManager.default.createSymbolicLink(at: safeDirectory, withDestinationURL: outside)

        XCTAssertThrowsError(
            try service.saveFile(at: "safe/file.txt", text: "attack", baseline: baseline.revision)
        ) { error in
            guard case .symbolicLink = error as? WorktreeFileServiceError else {
                return XCTFail("unexpected error: \(error)")
            }
        }
        XCTAssertEqual(try String(contentsOf: outside.appendingPathComponent("file.txt")), "outside")
        XCTAssertEqual(try String(contentsOf: originalDirectory.appendingPathComponent("file.txt")), "baseline")
    }

    func testAtomicSaveReplacesInodePreservesPermissionsAndCleansTemporaryFile() throws {
        let root = try makeRoot()
        let file = root.appendingPathComponent("script.sh")
        try write("#!/bin/sh\necho old\n", to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        let beforeInode = try inode(of: file)
        let service = try WorktreeFileService(rootURL: root)
        let baseline = try service.openFile(at: "script.sh")

        let saved = try service.saveFile(
            at: "script.sh",
            text: "#!/bin/sh\necho new\n",
            baseline: baseline.revision
        )

        XCTAssertEqual(try String(contentsOf: file), "#!/bin/sh\necho new\n")
        XCTAssertNotEqual(try inode(of: file), beforeInode)
        XCTAssertEqual(saved.permissions, 0o755)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.uint16Value, 0o755)
        XCTAssertFalse(
            try FileManager.default.contentsOfDirectory(atPath: root.path)
                .contains(where: { $0.hasPrefix(".gidem-save-") })
        )
    }

    @MainActor
    func testEditorBufferKeepsUnsavedTextAcrossConflictThenSupportsReloadAndOverwrite() throws {
        let root = try makeRoot()
        let file = root.appendingPathComponent("buffer.txt")
        try write("base", to: file)
        let store = EditorBufferStore(fileService: try WorktreeFileService(rootURL: root))
        try store.open(relativePath: "buffer.txt")
        store.updateText("mine")
        try write("theirs", to: file)

        XCTAssertThrowsError(try store.save())
        XCTAssertEqual(store.activeBuffer?.text, "mine")
        XCTAssertNotNil(store.activeBuffer?.conflictMessage)

        let reloaded = try store.reload()
        XCTAssertEqual(reloaded.text, "theirs")
        XCTAssertFalse(reloaded.isDirty)

        store.updateText("final")
        try write("changed-again", to: file)
        XCTAssertThrowsError(try store.save())
        let overwritten = try store.save(overwrite: true)
        XCTAssertEqual(overwritten.text, "final")
        XCTAssertFalse(overwritten.isDirty)
        XCTAssertEqual(try String(contentsOf: file), "final")
    }

    private func makeRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gidem-editor-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        roots.append(root)
        return root
    }

    private func write(_ text: String, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(text.utf8).write(to: url)
    }

    private func inode(of url: URL) throws -> UInt64 {
        var info = stat()
        guard url.path.withCString({ Darwin.lstat($0, &info) }) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        return UInt64(info.st_ino)
    }

    private func writeInPlacePreservingTimes(_ text: String, to url: URL) throws {
        var original = stat()
        guard url.path.withCString({ Darwin.lstat($0, &original) }) == 0 else {
            throw currentPOSIXError()
        }
        let descriptor = url.path.withCString {
            Darwin.open($0, O_WRONLY | O_CLOEXEC)
        }
        guard descriptor >= 0 else { throw currentPOSIXError() }
        defer { Darwin.close(descriptor) }

        let data = Data(text.utf8)
        guard Darwin.ftruncate(descriptor, off_t(data.count)) == 0,
              Darwin.lseek(descriptor, 0, SEEK_SET) == 0 else {
            throw currentPOSIXError()
        }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                guard let baseAddress = bytes.baseAddress else { return }
                let count = Darwin.write(
                    descriptor,
                    baseAddress.advanced(by: offset),
                    bytes.count - offset
                )
                guard count > 0 else { throw currentPOSIXError() }
                offset += count
            }
        }

        var times = [original.st_atimespec, original.st_mtimespec]
        let timeStatus = times.withUnsafeMutableBufferPointer {
            Darwin.futimens(descriptor, $0.baseAddress)
        }
        guard timeStatus == 0, Darwin.fsync(descriptor) == 0 else {
            throw currentPOSIXError()
        }
    }

    private func currentPOSIXError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}
