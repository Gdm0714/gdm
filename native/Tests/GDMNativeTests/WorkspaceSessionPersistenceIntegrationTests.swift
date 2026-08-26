import AppKit
import Foundation
import XCTest
@testable import GDMNative

@MainActor
final class WorkspaceSessionPersistenceIntegrationTests: XCTestCase {
    func testEndedLanePersistsBesideActiveSiblingAndPaneDisposalRemovesOnlyItsLane() async throws {
        let fixture = try SessionPersistenceFixture()
        defer { fixture.remove() }
        let drivers = SessionPersistenceDriverFixture()
        let manager = drivers.makeManager()
        let workbench = WorkbenchState()
        let store = WorkspaceStore(
            repositoryURL: fixture.repositoryURL,
            terminalSessions: manager,
            gdmInvocation: CommandInvocation(executable: "/fixture/gdm", prefixArguments: []),
            workbench: workbench
        )

        let task = try XCTUnwrap(store.selectedTask)
        let firstPane = try terminalPane(in: workbench)
        let firstLaneID = try laneID(of: firstPane)
        store.chooseAgent(.shell, laneID: firstLaneID)
        store.splitPane(firstPane.id, axis: .horizontal)
        let secondPane = try XCTUnwrap(workbench.layout.focusedLeaf)
        let secondLaneID = try laneID(of: secondPane)
        store.chooseAgent(.shell, laneID: secondLaneID)

        let firstKey = laneKey(taskID: task.id, laneID: firstLaneID)
        let secondKey = laneKey(taskID: task.id, laneID: secondLaneID)
        store.startSelectedSession(laneID: firstLaneID)
        store.startSelectedSession(laneID: secondLaneID)
        try await waitUntil {
            manager.session(for: firstKey)?.state == .running
                && manager.session(for: secondKey)?.state == .running
        }

        var persisted = try fixture.persistedRecord()
        XCTAssertEqual(persisted.sessionsByLane?.count, 2)
        XCTAssertEqual(persisted.sessionsByLane?[firstKey.laneID]?.outcome, .active)
        XCTAssertEqual(persisted.sessionsByLane?[secondKey.laneID]?.outcome, .active)

        drivers.driver(for: firstKey).complete(rawStatus: 0)
        try await waitUntil {
            manager.session(for: firstKey)?.state.isActive == false
                && (try? fixture.persistedRecord().sessionsByLane?[firstKey.laneID]?.outcome) == .ended
        }

        persisted = try fixture.persistedRecord()
        XCTAssertEqual(
            persisted.sessionsByLane?[firstKey.laneID]?.outcome,
            .ended,
            "Ending one lane must be persisted before evaluating its active sibling."
        )
        XCTAssertEqual(persisted.sessionsByLane?[secondKey.laneID]?.outcome, .active)
        XCTAssertEqual(persisted.lastSession, persisted.sessionsByLane?[secondKey.laneID])

        store.closePane(firstPane.id)
        persisted = try fixture.persistedRecord()
        XCTAssertNil(persisted.sessionsByLane?[firstKey.laneID])
        XCTAssertEqual(persisted.sessionsByLane?[secondKey.laneID]?.outcome, .active)
        XCTAssertEqual(persisted.sessionsByLane?.count, 1)

        store.splitPane(secondPane.id, axis: .horizontal)
        let replacementPane = try XCTUnwrap(workbench.layout.focusedLeaf)
        let replacementLaneID = try laneID(of: replacementPane)
        let replacementKey = laneKey(taskID: task.id, laneID: replacementLaneID)
        store.chooseAgent(.shell, laneID: replacementLaneID)
        store.startSelectedSession(laneID: replacementLaneID)
        try await waitUntil { manager.session(for: replacementKey)?.state == .running }
        drivers.driver(for: replacementKey).complete(rawStatus: 0)
        try await waitUntil {
            manager.session(for: replacementKey)?.state.isActive == false
                && (try? fixture.persistedRecord().sessionsByLane?[replacementKey.laneID]?.outcome) == .ended
        }

        store.showContent(.editor(EditorPaneState()), in: replacementPane.id)
        persisted = try fixture.persistedRecord()
        XCTAssertNil(persisted.sessionsByLane?[replacementKey.laneID])
        XCTAssertEqual(persisted.sessionsByLane?[secondKey.laneID]?.outcome, .active)
        XCTAssertEqual(persisted.sessionsByLane?.count, 1)

        drivers.driver(for: secondKey).complete(rawStatus: 0)
        try await waitUntil { manager.session(for: secondKey)?.state.isActive == false }
    }

    private func terminalPane(in workbench: WorkbenchState) throws -> PaneLeafRecord {
        try XCTUnwrap(workbench.layout.root.leaves.first {
            if case .terminal = $0.content { return true }
            return false
        })
    }

    private func laneID(of pane: PaneLeafRecord) throws -> UUID {
        guard case .terminal(let terminal) = pane.content else {
            throw SessionPersistenceTestError.expectedTerminalPane
        }
        return terminal.laneID
    }

    private func laneKey(taskID: String, laneID: UUID) -> TerminalSessionLaneKey {
        TerminalSessionLaneKey(taskID: taskID, laneID: laneID.uuidString.lowercased())
    }

    private func waitUntil(
        timeoutIterations: Int = 500,
        condition: @MainActor () -> Bool
    ) async throws {
        for _ in 0..<timeoutIterations {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw SessionPersistenceTestError.timeout
    }
}

private enum SessionPersistenceTestError: Error {
    case expectedTerminalPane
    case timeout
}

private struct SessionPersistenceFixture {
    let sandboxURL: URL
    let repositoryURL: URL
    let worktreeURL: URL
    let registry: WorkspaceRegistry
    let recordID: UUID
    let slug = "session-persistence"

    init() throws {
        sandboxURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("gidem-session-persistence-\(UUID().uuidString)", isDirectory: true)
        repositoryURL = sandboxURL.appendingPathComponent("repository", isDirectory: true)
        worktreeURL = sandboxURL.appendingPathComponent("worktree", isDirectory: true)
        registry = WorkspaceRegistry(repositoryURL: repositoryURL)
        recordID = UUID()

        try FileManager.default.createDirectory(at: repositoryURL, withIntermediateDirectories: true)
        try Self.git(["init"], at: repositoryURL)
        try Self.git(["config", "user.name", "Gidem Session Tests"], at: repositoryURL)
        try Self.git(
            ["config", "user.email", "gidem-session@example.invalid"],
            at: repositoryURL
        )
        try Data("fixture\n".utf8).write(
            to: repositoryURL.appendingPathComponent("README.md", isDirectory: false)
        )
        try Self.git(["add", "README.md"], at: repositoryURL)
        try Self.git(["commit", "-m", "fixture base"], at: repositoryURL)
        try Self.git(["branch", "-M", "main"], at: repositoryURL)
        let baseOID = try Self.gitOutput(["rev-parse", "HEAD"], at: repositoryURL)
        try Self.git(
            ["worktree", "add", "-b", "gdm/\(slug)", "--", worktreeURL.path, baseOID],
            at: repositoryURL
        )

        let work = WorkDocument(
            slug: slug,
            brief: "Preserve independent terminal lane history",
            createdAt: "2026-08-12T00:00:00.000Z",
            done: false,
            doneAt: nil,
            auditRequired: false,
            audit: nil,
            delivery: nil,
            checks: [CheckRecord(
                id: "c1",
                desc: "session lanes persist independently",
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
                required: ["preserve every lane"],
                forbidden: ["overwrite a sibling lane"],
                commit: "forbidden",
                risk: "medium",
                verification: "deterministic"
            )
        )
        let stateDirectory = worktreeURL
            .appendingPathComponent(".gdm", isDirectory: true)
            .appendingPathComponent(slug, isDirectory: true)
        try FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true)
        var encoded = try JSONEncoder().encode(work)
        encoded.append(0x0A)
        try encoded.write(to: stateDirectory.appendingPathComponent("checks.json"))

        let record = WorkspaceRegistryRecord(
            id: recordID,
            slug: slug,
            worktreePath: worktreeURL.path,
            branch: "refs/heads/gdm/\(slug)",
            baseOID: baseOID,
            gitCommonDirectory: repositoryURL.appendingPathComponent(".git", isDirectory: true).path,
            phase: .ready,
            selectedAgent: AgentKind.shell.rawValue,
            lastSession: nil,
            sessionsByLane: nil,
            lastError: nil,
            checksApprovalRequired: false,
            createdAt: "2026-08-12T00:00:00.000Z"
        )
        try registry.save(WorkspaceRegistryDocument(
            selectedTaskKey: WorkspaceRegistry.taskKey(for: recordID),
            tasks: [record]
        ))
    }

    func persistedRecord() throws -> WorkspaceRegistryRecord {
        try XCTUnwrap(registry.load().tasks.first(where: { $0.id == recordID }))
    }

    func remove() {
        try? FileManager.default.removeItem(at: sandboxURL)
    }

    private static func git(_ arguments: [String], at directory: URL) throws {
        let result = try runGit(arguments, at: directory)
        guard result.exitCode == 0 else {
            throw NSError(
                domain: "GDMNative.WorkspaceSessionPersistenceIntegrationTests.Git",
                code: Int(result.exitCode),
                userInfo: [NSLocalizedDescriptionKey: result.output]
            )
        }
    }

    private static func gitOutput(_ arguments: [String], at directory: URL) throws -> String {
        let result = try runGit(arguments, at: directory)
        guard result.exitCode == 0 else {
            throw NSError(
                domain: "GDMNative.WorkspaceSessionPersistenceIntegrationTests.Git",
                code: Int(result.exitCode),
                userInfo: [NSLocalizedDescriptionKey: result.output]
            )
        }
        return result.output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func runGit(_ arguments: [String], at directory: URL) throws -> CommandResult {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = arguments
        process.currentDirectoryURL = directory
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        let output = String(
            data: pipe.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        return CommandResult(exitCode: process.terminationStatus, output: output)
    }
}

@MainActor
private final class SessionPersistenceDriverFixture {
    private var nextPID: pid_t = 96_000
    private var drivers: [TerminalSessionLaneKey: SessionPersistenceTerminalDriver] = [:]

    func makeManager() -> TerminalSessionManager {
        TerminalSessionManager(laneSessionFactory: { [weak self] key, generation, specification in
            guard let self else { fatalError("SessionPersistenceDriverFixture released") }
            nextPID += 1
            let driver = SessionPersistenceTerminalDriver(pid: nextPID)
            drivers[key] = driver
            return TerminalSession(
                taskID: key.taskID,
                laneID: key.laneID,
                generation: generation,
                specification: specification,
                terminalDriver: driver
            )
        })
    }

    func driver(for key: TerminalSessionLaneKey) -> SessionPersistenceTerminalDriver {
        guard let driver = drivers[key] else { fatalError("Missing driver for \(key.id)") }
        return driver
    }
}

@MainActor
private final class SessionPersistenceTerminalDriver: TerminalDriving {
    let hostedView = NSView(frame: .zero)
    let processIdentifier: pid_t
    let lifecycleOwnership: TerminalLifecycleOwnership = .terminalDriver
    private(set) var isRunning = false
    var onProcessTerminated: ((Int32?) -> Void)?

    init(pid: pid_t) {
        processIdentifier = pid
    }

    func start(_ specification: AgentLaunchSpecification) { isRunning = true }
    func terminate() { isRunning = false }
    func send(_ bytes: [UInt8]) {}
    func resize(to size: NSSize) {}

    func complete(rawStatus: Int32?) {
        isRunning = false
        onProcessTerminated?(rawStatus)
    }
}
