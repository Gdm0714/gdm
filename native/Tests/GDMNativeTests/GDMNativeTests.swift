import Foundation
import XCTest
@testable import GDMNative

final class GDMNativeTests: XCTestCase {
    func testDemoVerificationExposesEveryUnprovenCheckAsABlocker() throws {
        let workspace = DemoData.workspace(state: "verifying")
        let work = try XCTUnwrap(workspace.works.first)

        XCTAssertEqual(work.slug, "fix-login-regression")
        XCTAssertEqual(work.provenCount, 1)
        XCTAssertEqual(work.blockers.map(\.message), [
            "c1 로그인 회귀 재현 — 증거 없음",
            "c3 전체 CLI 테스트 — 증거 없음",
            "c4 범위 밖 변경 없음 — 증거 없음"
        ])
        XCTAssertFalse(work.canComplete)
    }

    func testAllProvenStateCanCompleteWithoutAudit() throws {
        let workspace = DemoData.workspace(state: "all-proven")
        let work = try XCTUnwrap(workspace.works.first)

        XCTAssertTrue(work.allChecksProven)
        XCTAssertTrue(work.canComplete)
        XCTAssertTrue(work.blockers.isEmpty)
    }

    func testRejectedAuditRemainsAFirstClassBlocker() throws {
        let workspace = DemoData.workspace(state: "audit-rejected")
        let work = try XCTUnwrap(workspace.works.first)

        XCTAssertEqual(work.audit?.result, "fail")
        XCTAssertTrue(work.blockers.contains { $0.message.contains("독립 검수 반려") })
        XCTAssertFalse(work.canComplete)
    }

    func testRepositoryLoaderReadsOnlyChecksDocuments() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let work = try XCTUnwrap(DemoData.workspace(state: "all-proven").works.first)
        let workDirectory = root.appendingPathComponent(".gdm/\(work.slug)", isDirectory: true)
        let ignoredDirectory = root.appendingPathComponent(".gdm/habits", isDirectory: true)
        try FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: ignoredDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let data = try JSONEncoder().encode(work)
        try data.write(to: workDirectory.appendingPathComponent("checks.json"))
        try Data("{}".utf8).write(to: ignoredDirectory.appendingPathComponent("ledger.json"))

        let loaded = try RepositoryLoader.loadWorks(from: root)
        XCTAssertEqual(loaded, [work])
    }

    func testRepositoryLoaderRejectsDirectoryAndDocumentSlugMismatch() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let mismatchedDirectory = root.appendingPathComponent(".gdm/wrong-slug", isDirectory: true)
        try FileManager.default.createDirectory(
            at: mismatchedDirectory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: root) }

        let work = try XCTUnwrap(DemoData.workspace(state: "all-proven").works.first)
        try JSONEncoder().encode(work).write(
            to: mismatchedDirectory.appendingPathComponent("checks.json")
        )

        XCTAssertTrue(try RepositoryLoader.loadWorks(from: root).isEmpty)
    }

    func testCanonicalTokensAreBundledAndCorrectedForContrast() {
        XCTAssertEqual(DesignTokens.raw("--text-tertiary"), "#7B858D")
        XCTAssertEqual(DesignTokens.raw("--compact-breakpoint"), "1280px")
        XCTAssertEqual(DesignTokens.raw("--agent-activity-breakpoint"), "1200px")
        XCTAssertEqual(DesignTokens.raw("--agent-activity-popover-width"), "352px")
        XCTAssertGreaterThan(DesignTokens.proofRailWidth, DesignTokens.taskRailWidth)
    }

    func testSessionStateVariantsRemainDistinct() {
        XCTAssertEqual(DemoData.workspace(state: "waiting-input").sessionState.label, "waiting for input")
        XCTAssertEqual(DemoData.workspace(state: "disconnected").sessionState.label, "disconnected")
        XCTAssertEqual(DemoData.workspace(state: "reconnecting").sessionState.label, "reconnecting")
    }

    @MainActor
    func testWorktreeLoopDemoIsStaticAndNeverStartsAnAgentSession() throws {
        var launchCount = 0
        let manager = TerminalSessionManager { _, _, _ in
            launchCount += 1
            fatalError("demo and screenshot paths must not create terminal sessions")
        }
        let store = WorkspaceStore(
            repositoryURL: URL(fileURLWithPath: "/tmp/gdm", isDirectory: true),
            demoState: "worktree-loop",
            isDemo: true,
            terminalSessions: manager
        )

        XCTAssertEqual(launchCount, 0)
        XCTAssertTrue(manager.sessions.isEmpty)
        XCTAssertEqual(store.selectedAgent, .claude)
        XCTAssertEqual(store.selectedTask?.branch, "refs/heads/gdm/native-agent-loop")
        XCTAssertEqual(store.selectedTask?.location.registryRecord?.lastSession?.outcome, .active)
    }

    @MainActor
    func testAgentActivityScreenshotDemoStatesNeverStartSessions() {
        let states = [
            "activity-popover",
            "activity-starting",
            "activity-waiting",
            "activity-interrupted",
            "activity-launch-failed",
            "activity-stopping",
            "activity-ended"
        ]

        for state in states {
            var launchCount = 0
            let manager = TerminalSessionManager { _, _, _ in
                launchCount += 1
                fatalError("screenshot demo paths must never launch an agent")
            }
            let store = WorkspaceStore(
                repositoryURL: URL(fileURLWithPath: "/tmp/gdm", isDirectory: true),
                demoState: state,
                isDemo: true,
                terminalSessions: manager
            )

            XCTAssertEqual(launchCount, 0, state)
            XCTAssertTrue(manager.sessions.isEmpty, state)
            XCTAssertEqual(store.agentActivitySummaries.count, AgentKind.allCases.count, state)
            XCTAssertFalse(store.agentActivityItems.isEmpty, state)
        }
    }

    @MainActor
    func testAgentActivityDemoElapsedClockIsDeterministic() throws {
        let store = WorkspaceStore(
            repositoryURL: URL(fileURLWithPath: "/tmp/gdm", isDirectory: true),
            demoState: "activity-popover",
            isDemo: true
        )
        let claude = try XCTUnwrap(store.agentActivitySummary(for: .claude).primaryItem)
        let codex = try XCTUnwrap(store.agentActivitySummary(for: .codex).primaryItem)

        XCTAssertEqual(claude.elapsedLabel(at: DemoData.agentActivityReferenceDate), "1:00:00")
        XCTAssertEqual(codex.elapsedLabel(at: DemoData.agentActivityReferenceDate), "ran 41:08")
    }
}
