import Darwin
import Foundation
import XCTest
@testable import GDMNative

final class CodexSmokeCLITests: XCTestCase {
    func testInvocationRecognizesOnlyExplicitSmokeFlags() {
        XCTAssertTrue(TerminalSmokeCLI.isInvocation(["gidem", "--terminal-smoke"]))
        XCTAssertTrue(TerminalSmokeCLI.isInvocation(["gidem", "--codex-smoke"]))
        XCTAssertFalse(TerminalSmokeCLI.isInvocation(["gidem", "--repo", "/tmp/example"]))
    }

    func testCodexSmokeRequiresExplicitOptInAndBoundsItsTimeout() {
        XCTAssertFalse(TerminalSmokeCLI.codexSmokeIsOptedIn(environment: [:]))
        XCTAssertFalse(TerminalSmokeCLI.codexSmokeIsOptedIn(
            environment: [TerminalSmokeCLI.codexSmokeOptInVariable: "true"]
        ))
        XCTAssertTrue(TerminalSmokeCLI.codexSmokeIsOptedIn(
            environment: [TerminalSmokeCLI.codexSmokeOptInVariable: "1"]
        ))

        XCTAssertEqual(TerminalSmokeCLI.codexSmokeTimeout(environment: [:]), 180)
        XCTAssertEqual(TerminalSmokeCLI.codexSmokeTimeout(
            environment: [TerminalSmokeCLI.codexSmokeTimeoutVariable: "1"]
        ), 15)
        XCTAssertEqual(TerminalSmokeCLI.codexSmokeTimeout(
            environment: [TerminalSmokeCLI.codexSmokeTimeoutVariable: "9999"]
        ), 600)
        XCTAssertEqual(TerminalSmokeCLI.codexSmokeTimeout(
            environment: [TerminalSmokeCLI.codexSmokeTimeoutVariable: "invalid"]
        ), 180)
    }

    func testCodexSmokeArgumentsAreReadOnlyEphemeralAndWriteOutputOutsideRepository() {
        let root = URL(fileURLWithPath: "/private/tmp/gidem-codex-smoke-fixture", isDirectory: true)
        let repository = root.appendingPathComponent("repository", isDirectory: true)
        let output = root.appendingPathComponent("last-message.txt", isDirectory: false)

        let arguments = TerminalSmokeCLI.codexSmokeArguments(outputURL: output)

        XCTAssertEqual(Array(arguments.prefix(5)), [
            "--sandbox", "read-only",
            "--ask-for-approval", "never",
            "exec"
        ])
        XCTAssertTrue(arguments.contains("--ephemeral"))
        XCTAssertTrue(arguments.contains("--ignore-user-config"))
        XCTAssertTrue(arguments.contains("--ignore-rules"))
        XCTAssertFalse(arguments.contains("--dangerously-bypass-approvals-and-sandbox"))
        XCTAssertEqual(
            arguments[arguments.firstIndex(of: "--output-last-message")! + 1],
            output.path
        )
        XCTAssertFalse(output.path.hasPrefix(repository.path + "/"))
        XCTAssertEqual(arguments.last, TerminalSmokeCLI.codexSmokePrompt())
        XCTAssertTrue(arguments.last?.contains(TerminalSmokeCLI.codexSmokeMarker) == true)
    }

    func testRepositorySnapshotDetectsContentPathAndModeMutationsWithoutFollowingSymlinks() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "gidem-codex-snapshot-\(UUID().uuidString)",
            isDirectory: true
        )
        let outside = FileManager.default.temporaryDirectory.appendingPathComponent(
            "gidem-codex-outside-\(UUID().uuidString)",
            isDirectory: false
        )
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try Data("outside".utf8).write(to: outside)
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: outside)
        }

        let tracked = root.appendingPathComponent("tracked.txt", isDirectory: false)
        let link = root.appendingPathComponent("outside-link", isDirectory: false)
        try Data("before".utf8).write(to: tracked)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)

        let before = try CodexSmokeRepositorySnapshot.capture(root: root)
        XCTAssertTrue(before.changedPaths(comparedTo: before).isEmpty)
        XCTAssertNotNil(before.entries["outside-link"])
        XCTAssertNil(before.entries["outside-link/gidem-codex-outside"])

        try Data("after".utf8).write(to: tracked)
        XCTAssertEqual(chmod(tracked.path, 0o600), 0)
        try Data("created".utf8).write(
            to: root.appendingPathComponent("created.txt", isDirectory: false)
        )

        let after = try CodexSmokeRepositorySnapshot.capture(root: root)
        XCTAssertEqual(
            after.changedPaths(comparedTo: before),
            ["created.txt", "tracked.txt"]
        )
    }
}
