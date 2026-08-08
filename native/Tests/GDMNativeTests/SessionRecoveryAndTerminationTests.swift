import AppKit
import Darwin
import Foundation
import XCTest
@testable import GDMNative

@MainActor
final class SessionRecoveryAndTerminationTests: XCTestCase {
    func testPersistedRegistryOmitsRuntimeProcessAndTerminalState() throws {
        let root = try makeRepositoryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let registry = WorkspaceRegistry(repositoryURL: root)
        let record = makeRegistryRecord(outcome: .active)

        try registry.save(WorkspaceRegistryDocument(tasks: [record]))

        let data = try Data(contentsOf: registry.registryURL)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let tasks = try XCTUnwrap(object["tasks"] as? [[String: Any]])
        let persisted = try XCTUnwrap(tasks.first)
        let session = try XCTUnwrap(persisted["lastSession"] as? [String: Any])

        XCTAssertEqual(Set(session.keys), ["kind", "outcome", "startedAt"])
        XCTAssertNil(persisted["pid"])
        XCTAssertNil(persisted["pgid"])
        XCTAssertNil(persisted["environment"])
        XCTAssertNil(persisted["transcript"])

        let json = String(decoding: data, as: UTF8.self).lowercased()
        XCTAssertFalse(json.contains("\"pid\""))
        XCTAssertFalse(json.contains("\"pgid\""))
        XCTAssertFalse(json.contains("\"environment\""))
        XCTAssertFalse(json.contains("\"transcript\""))
    }

    func testRecoveryMarksActiveSessionInterruptedWithoutTouchingLiveProcesses() throws {
        let root = try makeRepositoryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let registry = WorkspaceRegistry(repositoryURL: root)
        try registry.save(WorkspaceRegistryDocument(tasks: [makeRegistryRecord(outcome: .active)]))

        let unrelatedProbe = Process()
        unrelatedProbe.executableURL = URL(fileURLWithPath: "/bin/sleep")
        unrelatedProbe.arguments = ["10"]
        try unrelatedProbe.run()
        defer {
            if unrelatedProbe.isRunning { unrelatedProbe.terminate() }
            unrelatedProbe.waitUntilExit()
        }
        XCTAssertTrue(unrelatedProbe.isRunning)

        let recoveryDate = Date(timeIntervalSince1970: 1_700_000_000)
        let recovered = try registry.recoverInterruptedSessions(at: recoveryDate)

        XCTAssertTrue(unrelatedProbe.isRunning, "Recovery must not scan, attach, or signal processes.")
        XCTAssertEqual(recovered.tasks.first?.lastSession?.outcome, .interrupted)
        XCTAssertNil(
            recovered.tasks.first?.lastSession?.endedAt,
            "App launch is not evidence of when the detached session ended."
        )
    }

    func testTaskSwitchPreservesSessionViewAndProcessIdentity() throws {
        let fixture = ManagerFixture()
        let manager = fixture.makeManager()
        let specification = makeSpecification()

        let sessionA = try manager.start(taskID: "task-a", specification: specification)
        let viewA = sessionA.terminalView
        let pidA = sessionA.processIdentifier
        _ = try manager.start(taskID: "task-b", specification: specification)

        let restoredA = try XCTUnwrap(manager.session(for: "task-a"))
        XCTAssertTrue(restoredA === sessionA)
        XCTAssertTrue(restoredA.terminalView === viewA)
        XCTAssertEqual(restoredA.processIdentifier, pidA)
        restoredA.send(text: "still connected")
        XCTAssertEqual(fixture.drivers["task-a"]?.last?.sentBytes, [Array("still connected".utf8)])
    }

    func testEndedSessionRestartUsesNewGenerationAndStaleCallbackIsNoOp() throws {
        let fixture = ManagerFixture()
        let manager = fixture.makeManager()
        let specification = makeSpecification()
        let first = try manager.start(taskID: "task-a", specification: specification)
        let firstDriver = try XCTUnwrap(fixture.drivers["task-a"]?.first)
        let staleCallback = firstDriver.onProcessTerminated
        firstDriver.complete(rawStatus: 0)
        XCTAssertEqual(first.state, .ended(.exited(0)))

        let second = try manager.start(taskID: "task-a", specification: specification)
        XCTAssertEqual(first.generation, 1)
        XCTAssertEqual(second.generation, 2)
        XCTAssertNotEqual(first.id, second.id)
        XCTAssertFalse(first.terminalView === second.terminalView)
        XCTAssertEqual(second.state, .running)

        staleCallback?(9)
        XCTAssertEqual(second.state, .running)
        XCTAssertEqual(second.generation, 2)
    }

    func testManagerEnforcesOneActiveSessionPerTaskAndStopAllReturnsReapProof() async throws {
        let fixture = ManagerFixture()
        let manager = fixture.makeManager()
        let specification = makeSpecification()
        _ = try manager.start(taskID: "task-a", specification: specification)
        _ = try manager.start(taskID: "task-b", specification: specification)

        XCTAssertThrowsError(try manager.start(taskID: "task-a", specification: specification)) {
            XCTAssertEqual($0 as? TerminalSessionManagerError, .sessionAlreadyActive("task-a"))
        }

        let results = await manager.stopAll()
        XCTAssertEqual(Set(results.keys), ["task-a", "task-b"])
        XCTAssertTrue(results.values.allSatisfy(\.cleanlyReaped))
        XCTAssertFalse(manager.hasActiveSessions)
        XCTAssertEqual(fixture.drivers.values.flatMap { $0 }.map(\.terminateCount), [1, 1])
    }

    func testQuitCoordinatorCoalescesDuplicateRequestsAndRepliesExactlyOnce() async {
        let coordinator = ApplicationTerminationCoordinator()
        var terminationCount = 0
        var replyValues: [Bool] = []

        let first = coordinator.requestTermination(
            hasActiveSessions: true,
            terminateAll: {
                terminationCount += 1
                await Task.yield()
                return true
            },
            reply: { replyValues.append($0) }
        )
        let duplicate = coordinator.requestTermination(
            hasActiveSessions: true,
            terminateAll: { terminationCount += 100; return true },
            reply: { replyValues.append($0) }
        )

        XCTAssertEqual(first, .terminateLater)
        XCTAssertEqual(duplicate, .terminateLater)
        for _ in 0..<100 where replyValues.isEmpty {
            await Task.yield()
        }
        XCTAssertEqual(terminationCount, 1)
        XCTAssertEqual(replyValues, [true])

        let afterReply = coordinator.requestTermination(
            hasActiveSessions: true,
            terminateAll: { terminationCount += 100; return true },
            reply: { replyValues.append($0) }
        )
        XCTAssertEqual(afterReply, .terminateLater)
        XCTAssertEqual(terminationCount, 1)
        XCTAssertEqual(replyValues, [true])
    }

    func testQuitDuringInFlightStopWaitsForTheSameReaperBeforeReplying() async throws {
        let reaper = BlockingRecoveryReaper()
        let driver = RecoveryTerminalDriver(pid: 5_900)
        let manager = TerminalSessionManager { taskID, generation, specification in
            TerminalSession(
                taskID: taskID,
                generation: generation,
                specification: specification,
                terminalDriver: driver,
                signaler: RecoverySignaler(),
                childReaper: reaper,
                processGroupResolver: RecoveryGroupResolver(group: driver.processIdentifier),
                clock: RecoveryClock(),
                stopPolicy: TerminalStopPolicy(
                    gracePeriodNanoseconds: 1,
                    pollIntervalNanoseconds: 1,
                    postKillReapTimeoutNanoseconds: 1
                )
            )
        }
        _ = try manager.start(taskID: "task-a", specification: makeSpecification())

        let userStop = Task { await manager.stop(taskID: "task-a") }
        for _ in 0..<100 where !(await reaper.hasPendingPoll()) {
            await Task.yield()
        }
        let didStartPolling = await reaper.hasPendingPoll()
        XCTAssertTrue(didStartPolling)

        let coordinator = ApplicationTerminationCoordinator()
        var quitResults: [String: TerminalStopResult]?
        var replyCount = 0
        let decision = coordinator.requestTermination(
            hasActiveSessions: manager.hasActiveSessions,
            terminateAll: {
                quitResults = await manager.stopAll()
                return quitResults?.values.allSatisfy(\.cleanlyReaped) == true
            },
            reply: { _ in replyCount += 1 }
        )
        XCTAssertEqual(decision, .terminateLater)

        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(replyCount, 0, "terminate-later must not reply while the owned child is unreaped.")
        XCTAssertNil(quitResults)
        let pollCountBeforeReap = await reaper.pollCount()
        XCTAssertEqual(pollCountBeforeReap, 1, "Duplicate Stop must join, not start a second waitpid loop.")

        await reaper.resolve(.reaped(rawStatus: 0))
        let userStopResult = await userStop.value
        XCTAssertEqual(userStopResult, .reaped(.exited(0)))
        for _ in 0..<100 where replyCount == 0 { await Task.yield() }

        XCTAssertEqual(quitResults?["task-a"], .reaped(.exited(0)))
        XCTAssertEqual(replyCount, 1)
        XCTAssertEqual(driver.terminateCount, 1)
    }

    func testQuitWithoutActiveSessionsTerminatesImmediatelyWithoutAsyncReply() {
        let coordinator = ApplicationTerminationCoordinator()
        var called = false
        let result = coordinator.requestTermination(
            hasActiveSessions: false,
            terminateAll: { called = true; return true },
            reply: { _ in called = true }
        )

        XCTAssertEqual(result, .terminateNow)
        XCTAssertFalse(called)
    }

    func testFailedCleanupRepliesFalseAndCanBeRetried() async {
        let coordinator = ApplicationTerminationCoordinator()
        var replies: [Bool] = []

        XCTAssertEqual(
            coordinator.requestTermination(
                hasActiveSessions: true,
                terminateAll: { false },
                reply: { replies.append($0) }
            ),
            .terminateLater
        )
        for _ in 0..<100 where replies.isEmpty { await Task.yield() }
        XCTAssertEqual(replies, [false])

        XCTAssertEqual(
            coordinator.requestTermination(
                hasActiveSessions: true,
                terminateAll: { true },
                reply: { replies.append($0) }
            ),
            .terminateLater
        )
        for _ in 0..<100 where replies.count < 2 { await Task.yield() }
        XCTAssertEqual(replies, [false, true])
    }

    func testQuitRetriesKeepFailedCleanupActiveUntilFreshWaitpidReapsChild() async throws {
        let reaper = SequencedRecoveryReaper(results: [
            .failed(EIO),
            .failed(EIO),
            .reaped(rawStatus: 0)
        ])
        let signaler = RecordingRecoverySignaler()
        let driver = RecoveryTerminalDriver(pid: 5_901)
        let manager = TerminalSessionManager { taskID, generation, specification in
            TerminalSession(
                taskID: taskID,
                generation: generation,
                specification: specification,
                terminalDriver: driver,
                signaler: signaler,
                childReaper: reaper,
                processGroupResolver: RecoveryGroupResolver(group: driver.processIdentifier),
                clock: RecoveryClock(),
                stopPolicy: TerminalStopPolicy(
                    gracePeriodNanoseconds: 1,
                    pollIntervalNanoseconds: 1,
                    postKillReapTimeoutNanoseconds: 1
                )
            )
        }
        let session = try manager.start(taskID: "task-a", specification: makeSpecification())
        let coordinator = ApplicationTerminationCoordinator()
        var cleanupResults: [[String: TerminalStopResult]] = []
        var replies: [Bool] = []

        let firstDecision = coordinator.requestTermination(
            hasActiveSessions: manager.hasActiveSessions,
            terminateAll: {
                let results = await manager.stopAll()
                cleanupResults.append(results)
                return results.values.allSatisfy(\.cleanlyReaped)
            },
            reply: { replies.append($0) }
        )
        XCTAssertEqual(firstDecision, .terminateLater)
        for _ in 0..<100 where replies.count < 1 { await Task.yield() }

        XCTAssertEqual(replies, [false])
        XCTAssertEqual(cleanupResults.first?["task-a"], .waitFailed(EIO))
        XCTAssertEqual(session.state, .stopping)
        XCTAssertTrue(manager.hasActiveSessions)
        XCTAssertThrowsError(
            try manager.start(taskID: "task-a", specification: makeSpecification())
        ) {
            XCTAssertEqual($0 as? TerminalSessionManagerError, .sessionAlreadyActive("task-a"))
        }

        let retryDecision = coordinator.requestTermination(
            hasActiveSessions: manager.hasActiveSessions,
            terminateAll: {
                let results = await manager.stopAll()
                cleanupResults.append(results)
                return results.values.allSatisfy(\.cleanlyReaped)
            },
            reply: { replies.append($0) }
        )
        XCTAssertEqual(retryDecision, .terminateLater)
        for _ in 0..<100 where replies.count < 2 { await Task.yield() }

        XCTAssertEqual(replies, [false, false])
        XCTAssertEqual(cleanupResults.count, 2)
        XCTAssertEqual(cleanupResults[1]["task-a"], .waitFailed(EIO))
        XCTAssertEqual(session.state, .stopping)
        XCTAssertTrue(manager.hasActiveSessions)
        XCTAssertEqual(driver.terminateCount, 1)
        XCTAssertEqual(signaler.groupSignals, [SIGTERM])
        XCTAssertTrue(signaler.processSignals.isEmpty)

        let recoveryDecision = coordinator.requestTermination(
            hasActiveSessions: manager.hasActiveSessions,
            terminateAll: {
                let results = await manager.stopAll()
                cleanupResults.append(results)
                return results.values.allSatisfy(\.cleanlyReaped)
            },
            reply: { replies.append($0) }
        )
        XCTAssertEqual(recoveryDecision, .terminateLater)
        for _ in 0..<100 where replies.count < 3 { await Task.yield() }

        XCTAssertEqual(replies, [false, false, true])
        XCTAssertEqual(cleanupResults.count, 3)
        XCTAssertEqual(cleanupResults[2]["task-a"], .reaped(.exited(0)))
        XCTAssertEqual(session.state, .ended(.exited(0)))
        XCTAssertFalse(manager.hasActiveSessions)
        XCTAssertEqual(driver.terminateCount, 1)
        XCTAssertEqual(signaler.groupSignals, [SIGTERM])
        XCTAssertTrue(signaler.processSignals.isEmpty)
    }

    private func makeRepositoryDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gdm-recovery-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func makeRegistryRecord(outcome: PersistedSessionOutcome) -> WorkspaceRegistryRecord {
        WorkspaceRegistryRecord(
            id: UUID(),
            slug: "recovery-test",
            worktreePath: "/tmp/gdm-recovery-test",
            branch: "gdm/recovery-test",
            baseOID: "0123456789abcdef",
            gitCommonDirectory: "/tmp/gdm-recovery-common",
            phase: .ready,
            selectedAgent: AgentKind.codex.rawValue,
            lastSession: PersistedSessionRecord(
                kind: AgentKind.codex.rawValue,
                startedAt: "2026-08-07T00:00:00.000Z",
                endedAt: nil,
                outcome: outcome
            ),
            lastError: nil,
            createdAt: "2026-08-07T00:00:00.000Z"
        )
    }

    private func makeSpecification() -> AgentLaunchSpecification {
        AgentLaunchSpecification(
            agent: .shell,
            executableURL: URL(fileURLWithPath: "/bin/zsh"),
            arguments: ["-l"],
            environment: ["TERM": "xterm-256color"],
            currentDirectory: URL(fileURLWithPath: "/tmp", isDirectory: true)
        )
    }
}

@MainActor
private final class ManagerFixture {
    private var nextPID: pid_t = 5_000
    private(set) var drivers: [String: [RecoveryTerminalDriver]] = [:]

    func makeManager() -> TerminalSessionManager {
        TerminalSessionManager { [weak self] taskID, generation, specification in
            guard let self else { fatalError("ManagerFixture released") }
            nextPID += 1
            let driver = RecoveryTerminalDriver(pid: nextPID)
            drivers[taskID, default: []].append(driver)
            return TerminalSession(
                taskID: taskID,
                generation: generation,
                specification: specification,
                terminalDriver: driver,
                signaler: RecoverySignaler(),
                childReaper: RecoveryReaper(),
                processGroupResolver: RecoveryGroupResolver(group: nextPID),
                clock: RecoveryClock(),
                stopPolicy: TerminalStopPolicy(
                    gracePeriodNanoseconds: 0,
                    pollIntervalNanoseconds: 0,
                    postKillReapTimeoutNanoseconds: 1
                )
            )
        }
    }
}

@MainActor
private final class RecoveryTerminalDriver: TerminalDriving {
    let hostedView = NSView(frame: .zero)
    let processIdentifier: pid_t
    var isRunning = false
    var onProcessTerminated: ((Int32?) -> Void)?
    private(set) var terminateCount = 0
    private(set) var sentBytes: [[UInt8]] = []

    init(pid: pid_t) {
        processIdentifier = pid
    }

    func start(_ specification: AgentLaunchSpecification) { isRunning = true }
    func terminate() {
        terminateCount += 1
        isRunning = false
    }
    func send(_ bytes: [UInt8]) { sentBytes.append(bytes) }
    func resize(to size: NSSize) {}

    func complete(rawStatus: Int32?) {
        isRunning = false
        onProcessTerminated?(rawStatus)
    }
}

private struct RecoveryGroupResolver: ProcessGroupResolving {
    let group: pid_t
    func processGroupIdentifier(for processIdentifier: pid_t) -> pid_t? { group }
}

private final class RecoverySignaler: ProcessSignaling, @unchecked Sendable {
    func sendToProcessGroup(_ processGroup: pid_t, signal: Int32) -> POSIXSignalResult { .success }
    func sendToProcess(_ processIdentifier: pid_t, signal: Int32) -> POSIXSignalResult { .success }
}

private final class RecordingRecoverySignaler: ProcessSignaling, @unchecked Sendable {
    private let lock = NSLock()
    private var storedGroupSignals: [Int32] = []
    private var storedProcessSignals: [Int32] = []

    var groupSignals: [Int32] { lock.withLock { storedGroupSignals } }
    var processSignals: [Int32] { lock.withLock { storedProcessSignals } }

    func sendToProcessGroup(_ processGroup: pid_t, signal: Int32) -> POSIXSignalResult {
        lock.withLock { storedGroupSignals.append(signal) }
        return .success
    }

    func sendToProcess(_ processIdentifier: pid_t, signal: Int32) -> POSIXSignalResult {
        lock.withLock { storedProcessSignals.append(signal) }
        return .success
    }
}

private actor RecoveryReaper: ChildReaping {
    func poll(processIdentifier: pid_t) async -> ChildWaitResult {
        .reaped(rawStatus: 0)
    }
}

private actor SequencedRecoveryReaper: ChildReaping {
    private var results: [ChildWaitResult]

    init(results: [ChildWaitResult]) {
        self.results = results
    }

    func poll(processIdentifier: pid_t) async -> ChildWaitResult {
        guard !results.isEmpty else { return .failed(EIO) }
        return results.removeFirst()
    }
}

private actor BlockingRecoveryReaper: ChildReaping {
    private var continuation: CheckedContinuation<ChildWaitResult, Never>?
    private var calls = 0

    func poll(processIdentifier: pid_t) async -> ChildWaitResult {
        calls += 1
        return await withCheckedContinuation { continuation = $0 }
    }

    func hasPendingPoll() -> Bool { continuation != nil }
    func pollCount() -> Int { calls }

    func resolve(_ result: ChildWaitResult) {
        continuation?.resume(returning: result)
        continuation = nil
    }
}

private struct RecoveryClock: StopClock {
    func nowNanoseconds() -> UInt64 { 0 }
    func sleep(nanoseconds: UInt64) async { await Task.yield() }
}
