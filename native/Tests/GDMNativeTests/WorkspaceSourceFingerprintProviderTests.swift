import Foundation
import XCTest
@testable import GDMNative

final class WorkspaceSourceFingerprintProviderTests: XCTestCase {
    private let gdmInvocation = CommandInvocation(
        executable: "/fixture/gdm",
        prefixArguments: ["--fixture-prefix"]
    )

    func testLiveProviderAcceptsExactBoundedJSON() async throws {
        let digest = String(repeating: "a", count: 64)
        let provider = makeProvider(
            result: CommandResult(
                exitCode: 0,
                output: "{\"schemaVersion\":1,\"sha256\":\"\(digest)\",\"fileCount\":0}"
            )
        )

        let actual = try await provider.capture(at: URL(fileURLWithPath: "/fixture/worktree"))

        XCTAssertEqual(
            actual,
            WorkspaceSourceFingerprint(schemaVersion: 1, sha256: digest, fileCount: 0)
        )
    }

    func testLiveProviderRejectsCommandFailureBeforeParsingOutput() async {
        let provider = makeProvider(
            result: CommandResult(exitCode: 23, output: "bounded command failure")
        )

        await assertCaptureError(provider) {
            XCTAssertEqual(
                $0,
                .commandFailed(exitCode: 23, output: "bounded command failure")
            )
        }
    }

    func testLiveProviderRejectsMalformedJSON() async {
        let provider = makeProvider(result: CommandResult(exitCode: 0, output: "{"))

        await assertCaptureError(provider) { XCTAssertEqual($0, .malformedOutput) }
    }

    func testLiveProviderRejectsUnexpectedJSONFields() async {
        let digest = String(repeating: "d", count: 64)
        let provider = makeProvider(
            json: "{\"schemaVersion\":1,\"sha256\":\"\(digest)\",\"fileCount\":1,\"path\":\"secret\"}"
        )

        await assertCaptureError(provider) { XCTAssertEqual($0, .malformedOutput) }
    }

    func testLiveProviderRejectsUnsupportedSchema() async {
        let digest = String(repeating: "b", count: 64)
        let provider = makeProvider(
            json: "{\"schemaVersion\":2,\"sha256\":\"\(digest)\",\"fileCount\":1}"
        )

        await assertCaptureError(provider) { XCTAssertEqual($0, .unsupportedSchema(2)) }
    }

    func testLiveProviderRejectsInvalidDigest() async {
        let provider = makeProvider(
            json: "{\"schemaVersion\":1,\"sha256\":\"ABC123\",\"fileCount\":1}"
        )

        await assertCaptureError(provider) { XCTAssertEqual($0, .invalidDigest) }
    }

    func testLiveProviderRejectsInvalidFileCount() async {
        let digest = String(repeating: "c", count: 64)
        for invalidCount in [-1, 10_000_001] {
            let provider = makeProvider(
                json: "{\"schemaVersion\":1,\"sha256\":\"\(digest)\",\"fileCount\":\(invalidCount)}"
            )

            await assertCaptureError(provider) {
                XCTAssertEqual($0, .invalidFileCount(invalidCount))
            }
        }
    }

    func testLiveProviderRejectsOversizedOutputBeforeDecoding() async {
        let output = String(repeating: "x", count: 64 * 1_024 + 1)
        let provider = makeProvider(result: CommandResult(exitCode: 0, output: output))

        await assertCaptureError(provider) {
            XCTAssertEqual($0, .oversizedOutput(64 * 1_024 + 1))
        }
    }

    private func makeProvider(json: String) -> WorkspaceSourceFingerprintProvider {
        makeProvider(result: CommandResult(exitCode: 0, output: json))
    }

    private func makeProvider(result: CommandResult) -> WorkspaceSourceFingerprintProvider {
        WorkspaceSourceFingerprintProvider.live(
            invocation: gdmInvocation,
            runner: WorktreeCommandRunner { _, _, _, _ in result }
        )
    }

    private func assertCaptureError(
        _ provider: WorkspaceSourceFingerprintProvider,
        file: StaticString = #filePath,
        line: UInt = #line,
        assertion: (WorkspaceSourceFingerprintError) -> Void
    ) async {
        do {
            _ = try await provider.capture(at: URL(fileURLWithPath: "/fixture/worktree"))
            XCTFail("Expected source fingerprint capture to fail", file: file, line: line)
        } catch let error as WorkspaceSourceFingerprintError {
            assertion(error)
        } catch {
            XCTFail("Unexpected error: \(error)", file: file, line: line)
        }
    }
}
