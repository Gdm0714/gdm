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

    func testEmptyCheckSetIsAnExplicitCompletionBlocker() throws {
        let workspace = DemoData.workspace(state: "no-checks")
        let work = try XCTUnwrap(workspace.works.first)

        XCTAssertTrue(work.checks.isEmpty)
        XCTAssertFalse(work.allChecksProven)
        XCTAssertFalse(work.canComplete)
        XCTAssertEqual(workspace.taskStates[work.slug], .needsPlan)
        XCTAssertEqual(work.blockers, [
            ProofBlocker(
                glyph: "○",
                message: "검증 항목이 아직 정의되지 않았습니다.",
                tone: .attention
            )
        ])
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
            "activity-ended",
            "agent-operations",
            "agent-operations-popover",
            "no-checks",
            "no-checks-proof",
            "review-plan",
            "review-plan-proof",
            "split-overflow"
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
    func testNewTaskProvisioningDemoIsStaticAndShowsTheBoundedSheetState() {
        var launchCount = 0
        let manager = TerminalSessionManager { _, _, _ in
            launchCount += 1
            fatalError("New Task screenshot demos must never launch a terminal session")
        }
        let store = WorkspaceStore(
            repositoryURL: URL(fileURLWithPath: "/tmp/gdm", isDirectory: true),
            demoState: "new-task-provisioning",
            isDemo: true,
            terminalSessions: manager
        )

        XCTAssertEqual(launchCount, 0)
        XCTAssertTrue(manager.sessions.isEmpty)
        XCTAssertTrue(store.presentsNewTaskProvisioningInDemo)
        XCTAssertTrue(store.isNewTaskPresented)
        XCTAssertTrue(store.isProvisioning)
        XCTAssertEqual(store.provisioningStep, .gdmContract)
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

final class CommandPaletteNavigationTests: XCTestCase {
    func testArrowNavigationWrapsAndRecoversFromAStaleSelection() {
        let ids = ["command:run", "task:alpha", "file:README.md"]

        XCTAssertEqual(
            CommandPaletteNavigation.move(selection: nil, orderedIDs: ids, direction: .next),
            "command:run"
        )
        XCTAssertEqual(
            CommandPaletteNavigation.move(selection: "file:README.md", orderedIDs: ids, direction: .next),
            "command:run"
        )
        XCTAssertEqual(
            CommandPaletteNavigation.move(selection: "command:run", orderedIDs: ids, direction: .previous),
            "file:README.md"
        )
        XCTAssertEqual(
            CommandPaletteNavigation.move(selection: "removed", orderedIDs: ids, direction: .previous),
            "file:README.md"
        )
        XCTAssertNil(
            CommandPaletteNavigation.move(selection: "removed", orderedIDs: [], direction: .next)
        )
    }

    func testTaskSlugValidationMatchesTheCreationBoundary() {
        XCTAssertFalse(WorktreeService.isValidSlug("a"))
        XCTAssertTrue(WorktreeService.isValidSlug("a1"))
        XCTAssertTrue(WorktreeService.isValidSlug(String(repeating: "a", count: 51)))
        XCTAssertFalse(WorktreeService.isValidSlug(String(repeating: "a", count: 52)))
        XCTAssertFalse(WorktreeService.isValidSlug("Fix-login"))
        XCTAssertFalse(WorktreeService.isValidSlug("fix login"))
        XCTAssertFalse(WorktreeService.isValidSlug("fix_login"))
    }

    func testWorkbenchUsesTabsBeforePaneContentBecomesUnreadable() {
        XCTAssertTrue(WorkbenchPresentation.shouldUseTabs(
            compact: false,
            availableWidth: 519,
            availableHeight: 700,
            requiredWidth: 520,
            requiredHeight: 300
        ))
        XCTAssertFalse(WorkbenchPresentation.shouldUseTabs(
            compact: false,
            availableWidth: 520,
            availableHeight: 700,
            requiredWidth: 520,
            requiredHeight: 300
        ))
        XCTAssertTrue(WorkbenchPresentation.shouldUseTabs(
            compact: true,
            availableWidth: 1200,
            availableHeight: 900,
            requiredWidth: 520,
            requiredHeight: 300
        ))
    }

    @MainActor
    func testVisiblePaneCloseUsesTheSameBusyGuardAsKeyboardCommands() throws {
        let repository = FileManager.default.temporaryDirectory
            .appendingPathComponent("gidem-close-guard-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repository, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repository) }

        let store = WorkspaceStore(repositoryURL: repository)
        let paneID = try XCTUnwrap(store.workbench.layout.root.orderedLeafIDs.last)
        let initialCount = store.workbench.layout.root.orderedLeafIDs.count
        XCTAssertGreaterThan(initialCount, 1)

        store.isCommandRunning = true
        store.closePane(paneID)
        XCTAssertEqual(store.workbench.layout.root.orderedLeafIDs.count, initialCount)

        store.isCommandRunning = false
        store.closePane(paneID)
        XCTAssertEqual(store.workbench.layout.root.orderedLeafIDs.count, initialCount - 1)
    }
}
