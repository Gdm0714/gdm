import AppKit
import Foundation
import XCTest
@testable import GDMNative

final class AgentActivityIntegrationTests: XCTestCase {
    private var temporaryDirectories: [URL] = []

    override func tearDownWithError() throws {
        for directory in temporaryDirectories {
            try? FileManager.default.removeItem(at: directory)
        }
        temporaryDirectories.removeAll()
    }

    func testSharedStateVocabularyUsesExactCopyToneAndOnlyUnsettledPulse() {
        let expected: [(AgentActivityState, String, String, SignalTone, Bool)] = [
            (.unavailable, "—", "unavailable", .neutral, false),
            (.idle, "○", "idle", .neutral, false),
            (.starting, "◔", "starting…", .active, true),
            (.active, "●", "active", .active, false),
            (.waiting, "◔", "waiting for input", .attention, false),
            (.needsYou, "!", "Needs You", .attention, false),
            (.handingOff, "⇢", "handing off…", .active, true),
            (.verifying, "◐", "verifying", .active, false),
            (.stopping, "◑", "stopping…", .attention, true),
            (.interrupted, "⊘", "interrupted · not attached", .attention, false),
            (.launchFailed, "✕", "launch failed", .blocked, false),
            (.ended, "○", "ended", .neutral, false)
        ]

        for (state, glyph, label, tone, isUnsettled) in expected {
            XCTAssertEqual(state.glyph, glyph)
            XCTAssertEqual(state.label, label)
            XCTAssertEqual(state.tone.rawValue, tone.rawValue)
            XCTAssertEqual(state.isUnsettled, isUnsettled)
            XCTAssertNotEqual(state.tone.rawValue, SignalTone.proven.rawValue)
        }
        XCTAssertTrue(AgentActivityState.starting.isRunning)
        XCTAssertTrue(AgentActivityState.active.isRunning)
        XCTAssertTrue(AgentActivityState.waiting.isRunning)
        XCTAssertTrue(AgentActivityState.needsYou.isRunning)
        XCTAssertTrue(AgentActivityState.handingOff.isRunning)
        XCTAssertTrue(AgentActivityState.verifying.isRunning)
        XCTAssertTrue(AgentActivityState.stopping.isRunning)
    }

    func testElapsedClockRunsOnlyForRunningStatesAndFreezesWithRanPrefix() {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let live = makeItem(state: .active, startedAt: start, endedAt: nil)
        XCTAssertEqual(live.elapsedSeconds(at: start.addingTimeInterval(65)), 65)
        XCTAssertEqual(live.elapsedLabel(at: start.addingTimeInterval(65)), "01:05")

        let stopping = makeItem(state: .stopping, startedAt: start, endedAt: nil)
        XCTAssertEqual(stopping.elapsedLabel(at: start.addingTimeInterval(12)), "00:12")

        let ended = makeItem(
            state: .ended,
            startedAt: start,
            endedAt: start.addingTimeInterval(3_661)
        )
        XCTAssertEqual(ended.elapsedSeconds(at: start.addingTimeInterval(9_999)), 3_661)
        XCTAssertEqual(ended.elapsedLabel(at: start.addingTimeInterval(9_999)), "ran 1:01:01")

        let unknown = makeItem(state: .idle, startedAt: nil, endedAt: nil)
        XCTAssertNil(unknown.elapsedSeconds(at: start))
        XCTAssertNil(unknown.elapsedLabel(at: start))
    }

    @MainActor
    func testManagerSnapshotAggregatesAllTasksWithoutRuntimeSecretsAndKeepsOneGeneration() throws {
        let fixture = ActivityManagerFixture()
        let manager = fixture.makeManager()
        let worktree = try makeTemporaryDirectory()

        _ = try manager.start(
            taskID: "task-codex",
            specification: makeSpecification(agent: .codex, directory: worktree)
        )
        _ = try manager.start(
            taskID: "task-claude-starting",
            specification: makeSpecification(agent: .claude, directory: worktree)
        )

        XCTAssertThrowsError(
            try manager.start(
                taskID: "task-codex",
                specification: makeSpecification(agent: .gemini, directory: worktree)
            )
        ) {
            XCTAssertEqual(
                $0 as? TerminalSessionManagerError,
                .sessionAlreadyActive("task-codex")
            )
        }

        let snapshots = manager.snapshot()
        XCTAssertEqual(snapshots.map(\.taskID), ["task-claude-starting", "task-codex"])
        XCTAssertEqual(snapshots.map(\.generation), [1, 1])
        XCTAssertEqual(snapshots.map(\.agent), [.claude, .codex])
        XCTAssertEqual(snapshots.map(\.state), [.starting, .running])

        for snapshot in snapshots {
            let fields = Set(Mirror(reflecting: snapshot).children.compactMap(\.label))
            XCTAssertEqual(fields, ["id", "taskID", "generation", "agent", "state", "startedAt"])
            XCTAssertTrue(fields.isDisjoint(with: [
                "pid", "processIdentifier", "prompt", "command", "arguments", "environment", "transcript"
            ]))
        }
    }

    @MainActor
    func testEndedSessionReplacementLeavesOnlyTheNewGenerationInSnapshot() throws {
        var creation = 0
        let worktree = try makeTemporaryDirectory()
        let manager = TerminalSessionManager { taskID, generation, specification in
            creation += 1
            let driver = ActivityTerminalDriver(pid: creation == 1 ? 0 : 8_200)
            return TerminalSession(
                taskID: taskID,
                generation: generation,
                specification: specification,
                terminalDriver: driver,
                processGroupResolver: ActivityGroupResolver(matchesChild: true),
                clock: ActivityClock()
            )
        }

        let first = try manager.start(
            taskID: "task-a",
            specification: makeSpecification(agent: .codex, directory: worktree)
        )
        XCTAssertEqual(first.state, .ended(.launchFailed("terminal backend did not create a PTY child")))
        let second = try manager.start(
            taskID: "task-a",
            specification: makeSpecification(agent: .gemini, directory: worktree)
        )

        XCTAssertEqual(second.generation, 2)
        XCTAssertEqual(manager.snapshot().count, 1)
        XCTAssertEqual(manager.snapshot().first?.generation, 2)
        XCTAssertEqual(manager.snapshot().first?.agent, .gemini)
        XCTAssertEqual(manager.snapshot().first?.state, .running)
    }

    @MainActor
    func testStoreAggregatesLiveAndPersistedSessionsByAgentAndTreatsRestartActiveAsInterrupted() throws {
        let root = try makeTemporaryDirectory()
        let bin = root.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        for agent in [AgentKind.codex, .claude, .gemini] {
            let executable = bin.appendingPathComponent(agent.rawValue)
            try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o755],
                ofItemAtPath: executable.path
            )
        }
        let catalog = AgentCatalog(
            environment: ["SHELL": "/bin/zsh"],
            searchDirectories: [bin],
            homeDirectory: root
        )
        let fixture = ActivityManagerFixture()
        let manager = fixture.makeManager()
        let codexTask = makeTask(
            id: "task-codex",
            slug: "codex-live",
            agent: .codex,
            worktree: root.appendingPathComponent("codex-live", isDirectory: true),
            session: nil
        )
        let claudeTask = makeTask(
            id: "task-claude-starting",
            slug: "claude-starting",
            agent: .claude,
            worktree: root.appendingPathComponent("claude-starting", isDirectory: true),
            session: nil
        )
        let interruptedTask = makeTask(
            id: "task-gemini",
            slug: "gemini-before-restart",
            agent: .gemini,
            worktree: root.appendingPathComponent("gemini-before-restart", isDirectory: true),
            session: PersistedSessionRecord(
                kind: AgentKind.gemini.rawValue,
                startedAt: "2026-08-07T11:00:00Z",
                endedAt: nil,
                outcome: .active
            )
        )
        let shellTask = makeTask(
            id: "task-shell",
            slug: "shell-ended",
            agent: .shell,
            worktree: root.appendingPathComponent("shell-ended", isDirectory: true),
            session: PersistedSessionRecord(
                kind: AgentKind.shell.rawValue,
                startedAt: "2026-08-07T10:00:00Z",
                endedAt: "2026-08-07T10:05:00Z",
                outcome: .ended
            )
        )

        _ = try manager.start(
            taskID: codexTask.id,
            specification: makeSpecification(agent: .codex, directory: codexTask.workingDirectory)
        )
        _ = try manager.start(
            taskID: claudeTask.id,
            specification: makeSpecification(agent: .claude, directory: claudeTask.workingDirectory)
        )

        let store = WorkspaceStore(
            repositoryURL: root,
            terminalSessions: manager,
            agentCatalog: catalog
        )
        store.tasks = [codexTask, claudeTask, interruptedTask, shellTask]
        store.refreshAgentActivity()

        XCTAssertEqual(store.agentActivityLiveCount, 2)
        XCTAssertEqual(store.agentActivitySummary(for: .codex).state, .active)
        XCTAssertEqual(store.agentActivitySummary(for: .codex).runningCount, 1)
        XCTAssertEqual(store.agentActivitySummary(for: .claude).state, .starting)
        XCTAssertEqual(store.agentActivitySummary(for: .gemini).state, .interrupted)
        XCTAssertEqual(store.agentActivitySummary(for: .shell).state, .ended)

        let gemini = try XCTUnwrap(
            store.agentActivityItems.first(where: { $0.agent == .gemini })
        )
        XCTAssertEqual(gemini.taskSlug, "gemini-before-restart")
        XCTAssertEqual(gemini.branch, "refs/heads/gdm/gemini-before-restart")
        XCTAssertEqual(gemini.worktreePath, interruptedTask.workingDirectory.path)
        XCTAssertEqual(gemini.state.label, "interrupted · not attached")
        XCTAssertNil(gemini.elapsedLabel(), "Unknown interruption time must not become a fake duration.")

        for item in store.agentActivityItems {
            let fields = Set(Mirror(reflecting: item).children.compactMap(\.label))
            XCTAssertEqual(fields, [
                "taskID", "laneID", "agent", "state", "taskSlug", "branch", "worktreePath", "startedAt", "endedAt"
            ])
            XCTAssertTrue(fields.isDisjoint(with: [
                "pid", "processIdentifier", "prompt", "command", "arguments", "environment", "transcript"
            ]))
        }

        store.selectedTaskKey = codexTask.id
        store.selectedAgent = .gemini
        store.startSelectedSession()
        XCTAssertEqual(store.agentActivitySummary(for: .codex).state, .active)
        XCTAssertTrue(store.agentActivitySummary(for: .gemini).items.contains {
            $0.taskID == interruptedTask.id && $0.state == .interrupted
        })
        XCTAssertTrue(store.errorMessage?.contains("이미 active agent session") == true)
    }

    @MainActor
    func testDemoActivityRowsAreDeterministicAndNeverStartSessions() {
        var launchCount = 0
        let manager = TerminalSessionManager { _, _, _ in
            launchCount += 1
            fatalError("Demo activity must not construct a terminal session")
        }
        let store = WorkspaceStore(
            repositoryURL: URL(fileURLWithPath: "/tmp/gdm-demo", isDirectory: true),
            demoState: "activity-interrupted",
            isDemo: true,
            terminalSessions: manager
        )

        XCTAssertEqual(launchCount, 0)
        XCTAssertTrue(manager.snapshot().isEmpty)
        XCTAssertEqual(store.agentActivitySummary(for: .claude).state, .interrupted)
        XCTAssertEqual(store.agentActivitySummary(for: .codex).state, .ended)
        XCTAssertEqual(store.agentActivitySummary(for: .shell).state, .active)
        XCTAssertEqual(store.agentActivitySummary(for: .gemini).state, .idle)
    }

    @MainActor
    func testAgentOperationsDemoBuildsFourTerminalLanesWithExplicitOwnership() {
        var launchCount = 0
        let manager = TerminalSessionManager { _, _, _ in
            launchCount += 1
            fatalError("Agent Operations demo must never launch a terminal process")
        }
        let store = WorkspaceStore(
            repositoryURL: URL(fileURLWithPath: "/tmp/gdm-demo", isDirectory: true),
            demoState: "agent-operations",
            isDemo: true,
            terminalSessions: manager
        )

        let terminalPanes = store.workbench.layout.root.leaves.compactMap { leaf -> TerminalPaneState? in
            guard case .terminal(let terminal) = leaf.content else { return nil }
            return terminal
        }
        XCTAssertEqual(launchCount, 0)
        XCTAssertTrue(manager.snapshot().isEmpty)
        XCTAssertEqual(terminalPanes.count, 4)
        XCTAssertEqual(Set(terminalPanes.map(\.agent)), Set(AgentKind.allCases))
        XCTAssertEqual(store.agentActivityItems.count, 4)
        XCTAssertEqual(store.agentActivityLiveCount, 4)
        XCTAssertEqual(store.agentActivitySummary(for: .codex).state, .needsYou)
        XCTAssertEqual(store.agentActivitySummary(for: .claude).state, .active)
        XCTAssertEqual(store.agentActivitySummary(for: .gemini).state, .verifying)
        XCTAssertEqual(store.agentActivitySummary(for: .shell).state, .handingOff)

        let coordination = store.agentActivityItems.compactMap(store.coordinationStatus(for:))
        XCTAssertEqual(coordination.filter { $0.coordinationRole == .primary }.count, 1)
        XCTAssertEqual(coordination.filter { $0.coordinationRole == .secondary }.count, 3)
        XCTAssertEqual(coordination.filter(\.ownsInput).count, 1)
        XCTAssertTrue(store.terminalTranscript(laneID: terminalPanes.first {
            $0.agent == .codex
        }?.laneID).contains("NEEDS YOU"))
    }

    @MainActor
    func testAgentOperationsActionsFocusHandoffAndOpenDiffProofWithoutLaunchingProcesses() throws {
        var launchCount = 0
        let manager = TerminalSessionManager { _, _, _ in
            launchCount += 1
            fatalError("Agent Operations actions must not launch a demo process")
        }
        let store = WorkspaceStore(
            repositoryURL: URL(fileURLWithPath: "/tmp/gdm-demo", isDirectory: true),
            demoState: "agent-operations",
            isDemo: true,
            terminalSessions: manager
        )
        let codex = try XCTUnwrap(store.agentActivityItems.first { $0.agent == .codex })
        let claude = try XCTUnwrap(store.agentActivityItems.first { $0.agent == .claude })
        let initialDiff = store.diffText

        store.focusAgentActivityItem(claude)
        let focusedLane = try XCTUnwrap(store.workbench.layout.focusedLeaf).content
        guard case .terminal(let focusedTerminal) = focusedLane else {
            return XCTFail("Focus must reveal the selected terminal lane")
        }
        XCTAssertEqual(focusedTerminal.laneID.uuidString.lowercased(), claude.laneID)
        XCTAssertTrue(store.coordinationStatus(for: claude)?.ownsInput == true)
        XCTAssertEqual(
            store.diffText,
            initialDiff,
            "Focusing an item in the selected task must not synchronously reload its repository details."
        )

        let target = try XCTUnwrap(store.handoffTargets(for: codex).first {
            $0.identity.laneID == claude.laneID
        })
        XCTAssertEqual(store.handoffTargetLabel(target), "Claude")
        store.handoffAgentActivityItem(codex, to: target.identity)
        let refreshedClaude = try XCTUnwrap(store.agentActivityItems.first { $0.agent == .claude })
        XCTAssertEqual(store.coordinationStatus(for: refreshedClaude)?.coordinationRole, .primary)

        store.showDiff(for: refreshedClaude)
        guard case .diff = store.workbench.layout.focusedLeaf?.content else {
            return XCTFail("Diff action must reveal and focus a Diff pane")
        }
        store.showProof(for: refreshedClaude)
        guard case .proof = store.workbench.layout.focusedLeaf?.content else {
            return XCTFail("Proof action must reveal and focus a Proof pane")
        }
        XCTAssertEqual(store.diffText, initialDiff)

        store.stopAgentActivityItem(refreshedClaude)
        XCTAssertEqual(launchCount, 0)
        XCTAssertTrue(manager.snapshot().isEmpty)
    }

    @MainActor
    func testUnknownHistoricalAgentStringsFallBackToShellAndDoNotCreateActivity() throws {
        let root = try makeTemporaryDirectory()
        let worktree = root.appendingPathComponent("legacy-agent", isDirectory: true)
        try FileManager.default.createDirectory(at: worktree, withIntermediateDirectories: true)
        let record = WorkspaceRegistryRecord(
            id: UUID(),
            slug: "legacy-agent",
            worktreePath: worktree.path,
            branch: "refs/heads/gdm/legacy-agent",
            baseOID: "base",
            gitCommonDirectory: root.path,
            phase: .ready,
            selectedAgent: "retired-agent",
            lastSession: PersistedSessionRecord(
                kind: "retired-agent",
                startedAt: "2026-08-07T12:00:00Z",
                endedAt: "2026-08-07T12:00:01Z",
                outcome: .ended
            ),
            lastError: nil,
            createdAt: "2026-08-07T10:00:00Z"
        )
        let encoded = try JSONEncoder().encode(record)
        let decoded = try JSONDecoder().decode(WorkspaceRegistryRecord.self, from: encoded)
        XCTAssertEqual(decoded.selectedAgent, "retired-agent")
        XCTAssertEqual(decoded.lastSession?.kind, "retired-agent")

        let task = WorkspaceTask(
            id: "task-legacy-agent",
            slug: decoded.slug,
            document: nil,
            location: .worktree(record: decoded, verifiedURL: worktree),
            health: .ready,
            statusMessage: nil
        )
        let store = WorkspaceStore(repositoryURL: root)

        store.tasks = [task]
        store.select(task)
        store.refreshAgentActivity()

        XCTAssertEqual(store.selectedAgent, .shell)
        XCTAssertTrue(store.agentActivityItems.isEmpty)
        XCTAssertEqual(store.agentActivitySummaries.map(\.agent), AgentKind.allCases)
    }

    @MainActor
    func testDetachedLiveSessionRemainsVisibleAndCanBeStopped() async throws {
        let root = try makeTemporaryDirectory()
        let fixture = ActivityManagerFixture()
        let manager = fixture.makeManager()
        let key = TerminalSessionLaneKey(taskID: "missing-task", laneID: UUID().uuidString.lowercased())
        _ = try manager.start(
            key: key,
            specification: makeSpecification(agent: .codex, directory: root)
        )
        let store = WorkspaceStore(repositoryURL: root, terminalSessions: manager)
        store.tasks = []

        store.refreshAgentActivity()

        XCTAssertEqual(store.agentActivityLiveCount, 1)
        let detached = try XCTUnwrap(store.agentActivityItems.first)
        XCTAssertEqual(detached.taskSlug, "Detached session")
        XCTAssertFalse(store.isAgentActivityItemAttached(detached))

        let otherRepository = try makeTemporaryDirectory()
        store.switchRepository(to: otherRepository)

        XCTAssertEqual(store.repositoryURL.standardizedFileURL, root.standardizedFileURL)
        XCTAssertTrue(store.errorMessage?.contains("session 1개") == true)
        XCTAssertTrue(store.errorMessage?.contains("Codex") == true)
        XCTAssertEqual(store.agentActivityLiveCount, 1)

        store.stopAgentActivityItem(detached)
        try await waitUntil { !manager.hasActiveSessions }

        XCTAssertEqual(store.agentActivityLiveCount, 0)
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("gdm-activity-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        temporaryDirectories.append(directory)
        return directory
    }

    private func makeSpecification(
        agent: AgentKind,
        directory: URL
    ) -> AgentLaunchSpecification {
        AgentLaunchSpecification(
            agent: agent,
            executableURL: URL(fileURLWithPath: "/bin/zsh"),
            arguments: [],
            environment: ["TERM": "xterm-256color"],
            currentDirectory: directory
        )
    }

    private func makeItem(
        state: AgentActivityState,
        startedAt: Date?,
        endedAt: Date?
    ) -> AgentActivityItem {
        AgentActivityItem(
            taskID: "task",
            agent: .codex,
            state: state,
            taskSlug: "task",
            branch: "refs/heads/gdm/task",
            worktreePath: "/tmp/task",
            startedAt: startedAt,
            endedAt: endedAt
        )
    }

    private func makeTask(
        id: String,
        slug: String,
        agent: AgentKind,
        worktree: URL,
        session: PersistedSessionRecord?
    ) -> WorkspaceTask {
        let record = WorkspaceRegistryRecord(
            id: UUID(),
            slug: slug,
            worktreePath: worktree.path,
            branch: "refs/heads/gdm/\(slug)",
            baseOID: "base",
            gitCommonDirectory: worktree.deletingLastPathComponent().path,
            phase: .ready,
            selectedAgent: agent.rawValue,
            lastSession: session,
            lastError: nil,
            createdAt: "2026-08-07T10:00:00Z"
        )
        return WorkspaceTask(
            id: id,
            slug: slug,
            document: WorkDocument(
                slug: slug,
                brief: "Agent activity fixture",
                createdAt: "2026-08-07T10:00:00Z",
                done: false,
                doneAt: nil,
                auditRequired: false,
                audit: nil,
                delivery: nil,
                checks: [CheckRecord(
                    id: "c1",
                    desc: "activity fixture remains runnable",
                    cmd: "true",
                    expect: "command succeeds",
                    manual: false,
                    kind: "behavior",
                    expert: false,
                    status: "open",
                    redEvidence: nil,
                    evidence: nil
                )],
                contract: WorkContractRecord(
                    required: ["preserve activity"],
                    forbidden: ["duplicate session"],
                    commit: "forbidden",
                    risk: "low",
                    verification: "deterministic"
                )
            ),
            location: .worktree(record: record, verifiedURL: worktree),
            health: .ready,
            statusMessage: nil
        )
    }

    @MainActor
    private func waitUntil(
        timeoutIterations: Int = 500,
        condition: @MainActor () -> Bool
    ) async throws {
        for _ in 0..<timeoutIterations {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw AgentActivityTestError.timeout
    }
}

private enum AgentActivityTestError: Error {
    case timeout
}

@MainActor
private final class ActivityManagerFixture {
    private var nextPID: pid_t = 8_000

    func makeManager() -> TerminalSessionManager {
        TerminalSessionManager { [weak self] taskID, generation, specification in
            guard let self else { fatalError("ActivityManagerFixture released") }
            nextPID += 1
            let shouldRemainStarting = taskID.contains("starting")
            return TerminalSession(
                taskID: taskID,
                generation: generation,
                specification: specification,
                terminalDriver: ActivityTerminalDriver(pid: nextPID),
                signaler: ActivitySignaler(),
                childReaper: ActivityReaper(),
                processGroupResolver: ActivityGroupResolver(matchesChild: !shouldRemainStarting),
                clock: ActivityClock(),
                stopPolicy: TerminalStopPolicy(
                    gracePeriodNanoseconds: 0,
                    pollIntervalNanoseconds: 0,
                    postKillReapTimeoutNanoseconds: 1,
                    ownershipStabilizationTimeoutNanoseconds: 0,
                    ownershipPollIntervalNanoseconds: 0
                )
            )
        }
    }
}

@MainActor
private final class ActivityTerminalDriver: TerminalDriving {
    let hostedView = NSView(frame: .zero)
    let processIdentifier: pid_t
    var isRunning = false
    var onProcessTerminated: ((Int32?) -> Void)?

    init(pid: pid_t) {
        processIdentifier = pid
    }

    func start(_ specification: AgentLaunchSpecification) { isRunning = processIdentifier > 1 }
    func terminate() { isRunning = false }
    func send(_ bytes: [UInt8]) {}
    func resize(to size: NSSize) {}
}

private struct ActivityGroupResolver: ProcessGroupResolving {
    let matchesChild: Bool

    func processGroupIdentifier(for processIdentifier: pid_t) -> pid_t? {
        matchesChild ? processIdentifier : nil
    }
}

private struct ActivityClock: StopClock {
    func nowNanoseconds() -> UInt64 { 0 }
    func sleep(nanoseconds: UInt64) async { await Task.yield() }
}

private actor ActivityReaper: ChildReaping {
    func poll(processIdentifier: pid_t) async -> ChildWaitResult {
        .reaped(rawStatus: 0)
    }
}

private struct ActivitySignaler: ProcessSignaling, @unchecked Sendable {
    func sendToProcessGroup(_ processGroup: pid_t, signal: Int32) -> POSIXSignalResult { .success }
    func sendToProcess(_ processIdentifier: pid_t, signal: Int32) -> POSIXSignalResult { .success }
}
