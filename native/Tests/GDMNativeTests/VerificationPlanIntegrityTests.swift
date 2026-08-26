import AppKit
import Foundation
import XCTest
@testable import GDMNative

@MainActor
final class VerificationPlanIntegrityTests: XCTestCase {
    func testPlanningCapturesAndPersistsSourceFingerprintBeforePrompt() async throws {
        let fixture = try VerificationIntegrityFixture()
        defer { fixture.remove() }
        try fixture.write(fixture.makeWork(checks: []))

        let events = IntegrityEventRecorder()
        let source = SequencedSourceFingerprints(
            values: [fixture.sourceA],
            events: events
        )
        let runner = VerificationIntegrityGDMRecorder(events: events)
        let driver = IntegrityTerminalDriver { specification in
            if !specification.arguments.isEmpty {
                events.append(.sessionStartedWithPrompt)
            }
        }
        let store = try fixture.makePlanningStore(
            driver: driver,
            runner: runner,
            sourceProvider: source.provider
        )

        store.startVerificationPlanning()
        try await waitUntil {
            store.selectedSession != nil || store.errorMessage != nil
        }

        XCTAssertNil(store.errorMessage)
        let persisted = try fixture.loadWork()
        XCTAssertEqual(persisted.verificationPlanSourceFingerprint, fixture.sourceA)
        XCTAssertEqual(store.selectedWork?.verificationPlanSourceFingerprint, fixture.sourceA)
        XCTAssertEqual(
            events.snapshot,
            [.sourceCaptured, .sourcePersisted, .sessionStartedWithPrompt]
        )

        let prompt = try XCTUnwrap(store.selectedSession?.specification.arguments.first)
        XCTAssertTrue(prompt.contains("\"$GIDEM_GDM_EXECUTABLE\" plan add"), prompt)
        XCTAssertTrue(driver.sentBytes.isEmpty)
        XCTAssertEqual(
            store.selectedSession?.specification.environment["GIDEM_GDM_EXECUTABLE"],
            fixture.gdmInvocation.executable
        )

        let terminated = await store.terminateAllSessions()
        XCTAssertTrue(terminated)
    }

    func testApprovalRejectsSourceMismatchWithoutImplementationPrompt() async throws {
        let fixture = try VerificationIntegrityFixture()
        defer { fixture.remove() }
        try fixture.write(fixture.makeWork(checks: []))

        let source = SequencedSourceFingerprints(values: [fixture.sourceA, fixture.sourceB])
        let runner = VerificationIntegrityGDMRecorder()
        let driver = IntegrityTerminalDriver()
        let store = try fixture.makePlanningStore(
            driver: driver,
            runner: runner,
            sourceProvider: source.provider
        )

        store.startVerificationPlanning()
        try await waitUntil { store.selectedSession != nil || store.errorMessage != nil }
        XCTAssertNil(store.errorMessage)
        XCTAssertTrue(driver.sentBytes.isEmpty)

        try fixture.write(fixture.makeWork(
            checks: [fixture.makeCheck(status: "open")],
            sourceFingerprint: fixture.sourceA
        ))
        try await waitUntil {
            store.selectedVerificationPlanState == .reviewRequired
        }

        store.approveSelectedVerificationPlan()
        try await waitUntil {
            !store.isPlanApprovalPending && store.errorMessage != nil
        }

        XCTAssertEqual(source.captureCount, 2)
        XCTAssertTrue(driver.sentBytes.isEmpty)
        XCTAssertEqual(store.selectedVerificationPlanState, .reviewRequired)
        XCTAssertTrue(
            store.errorMessage?.contains("소스 또는 Git index가 변경") == true,
            store.errorMessage ?? "missing error"
        )
        XCTAssertEqual(
            runner.calls.filter { $0.arguments.starts(with: ["plan", "source"]) }.count,
            1
        )

        let terminated = await store.terminateAllSessions()
        XCTAssertTrue(terminated)
    }

    func testApprovalRaceAfterRegistryWriteRollsBackApproval() async throws {
        let fixture = try VerificationIntegrityFixture()
        defer { fixture.remove() }
        let work = fixture.makeWork(
            checks: [fixture.makeCheck(status: "open")],
            sourceFingerprint: fixture.sourceA
        )
        try fixture.installMappedTask(work: work, approvedFingerprint: nil)
        let source = SequencedSourceFingerprints(values: [fixture.sourceA, fixture.sourceB])
        let runner = VerificationIntegrityGDMRecorder()
        let store = WorkspaceStore(
            repositoryURL: fixture.repositoryURL,
            commandRunner: runner.runner,
            gdmInvocation: fixture.gdmInvocation,
            sourceFingerprintProvider: source.provider
        )

        XCTAssertEqual(store.selectedVerificationPlanState, .reviewRequired)
        store.approveSelectedVerificationPlan()
        try await waitUntil {
            !store.isPlanApprovalPending && store.errorMessage != nil
        }

        let record = try XCTUnwrap(fixture.registry.load().tasks.first)
        XCTAssertNil(record.approvedChecksFingerprint)
        XCTAssertNil(record.checksApprovedAt)
        XCTAssertEqual(store.selectedVerificationPlanState, .reviewRequired)
        XCTAssertTrue(
            store.errorMessage?.contains("승인을 저장하는 동안") == true,
            store.errorMessage ?? "missing error"
        )
        XCTAssertEqual(source.captureCount, 2)
        XCTAssertEqual(
            runner.calls.filter { $0.arguments.starts(with: ["plan", "source"]) }.count,
            1
        )
    }

    func testPlanDefinitionChangeBeforePassPreventsCommandRunnerCall() async throws {
        let fixture = try VerificationIntegrityFixture()
        defer { fixture.remove() }
        let approved = fixture.makeWork(
            checks: [fixture.makeCheck(desc: "approved definition", status: "open")],
            sourceFingerprint: fixture.sourceA
        )
        try fixture.installMappedTask(
            work: approved,
            approvedFingerprint: try XCTUnwrap(approved.verificationPlanFingerprint)
        )
        let runner = VerificationIntegrityGDMRecorder()
        let store = fixture.makeMappedStore(runner: runner)
        XCTAssertTrue(store.canRunVerification)

        try fixture.writeMapped(fixture.makeWork(
            checks: [fixture.makeCheck(desc: "changed after approval", status: "open")],
            sourceFingerprint: fixture.sourceA
        ))
        store.runVerification()
        try await waitUntil { !store.isCommandRunning && store.errorMessage != nil }

        XCTAssertTrue(runner.calls.isEmpty)
        XCTAssertTrue(
            store.errorMessage?.contains("검증 계획 또는 계약이 변경") == true,
            store.errorMessage ?? "missing error"
        )
    }

    func testContractChangeBeforeDonePreventsCommandRunnerCall() async throws {
        let fixture = try VerificationIntegrityFixture()
        defer { fixture.remove() }
        let approved = fixture.makeWork(
            checks: [fixture.makeCheck(status: "proven")],
            sourceFingerprint: fixture.sourceA
        )
        try fixture.installMappedTask(
            work: approved,
            approvedFingerprint: try XCTUnwrap(approved.verificationPlanFingerprint)
        )
        let runner = VerificationIntegrityGDMRecorder()
        let store = fixture.makeMappedStore(runner: runner)
        XCTAssertTrue(store.canCompleteSelectedTask)

        try fixture.writeMapped(fixture.makeWork(
            checks: [fixture.makeCheck(status: "proven")],
            sourceFingerprint: fixture.sourceA,
            required: ["contract changed after approval"]
        ))
        store.completeSelectedTask()
        try await waitUntil { !store.isCommandRunning && store.errorMessage != nil }

        XCTAssertTrue(runner.calls.isEmpty)
        XCTAssertTrue(
            store.errorMessage?.contains("검증 계획 또는 계약이 변경") == true,
            store.errorMessage ?? "missing error"
        )
    }

    func testPassRecheckAndDoneReceiveExpectedPlanFingerprint() async throws {
        try await assertExpectedFingerprintIsForwarded(
            status: "open",
            action: { $0.runVerification() },
            command: "pass"
        )
        try await assertExpectedFingerprintIsForwarded(
            status: "proven",
            action: { $0.runVerification() },
            command: "recheck"
        )
        try await assertExpectedFingerprintIsForwarded(
            status: "proven",
            action: { $0.completeSelectedTask() },
            command: "done"
        )
    }

    private func assertExpectedFingerprintIsForwarded(
        status: String,
        action: (WorkspaceStore) -> Void,
        command: String
    ) async throws {
        let fixture = try VerificationIntegrityFixture()
        defer { fixture.remove() }
        let work = fixture.makeWork(
            checks: [fixture.makeCheck(status: status)],
            sourceFingerprint: fixture.sourceA
        )
        let fingerprint = try XCTUnwrap(work.verificationPlanFingerprint)
        try fixture.installMappedTask(work: work, approvedFingerprint: fingerprint)
        let runner = VerificationIntegrityGDMRecorder()
        let store = fixture.makeMappedStore(runner: runner)

        action(store)
        try await waitUntil {
            !store.isCommandRunning && !runner.calls.isEmpty
        }

        let call = try XCTUnwrap(runner.calls.first(where: {
            $0.arguments.first == command
        }))
        guard let optionIndex = call.arguments.firstIndex(of: "--expected-plan-fingerprint") else {
            return XCTFail("missing --expected-plan-fingerprint in \(call.arguments)")
        }
        XCTAssertTrue(call.arguments.indices.contains(optionIndex + 1), call.arguments.description)
        XCTAssertEqual(call.arguments[optionIndex + 1], fingerprint)
    }

    private func waitUntil(
        timeoutIterations: Int = 500,
        condition: @MainActor () -> Bool
    ) async throws {
        for _ in 0..<timeoutIterations {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw NSError(
            domain: "GDMNative.VerificationPlanIntegrityTests.Timeout",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "verification integrity condition timed out"]
        )
    }
}

private struct VerificationIntegrityFixture {
    let sandboxURL: URL
    let repositoryURL: URL
    let worktreeURL: URL
    let registry: WorkspaceRegistry
    let slug = "verification-integrity"
    let sourceA = String(repeating: "a", count: 64)
    let sourceB = String(repeating: "b", count: 64)

    var gdmInvocation: CommandInvocation {
        CommandInvocation(executable: "/fixture/gdm", prefixArguments: [])
    }

    init() throws {
        sandboxURL = FileManager.default.temporaryDirectory.appendingPathComponent(
            "gidem-verification-integrity-\(UUID().uuidString)",
            isDirectory: true
        )
        repositoryURL = sandboxURL.appendingPathComponent("repository", isDirectory: true)
        worktreeURL = sandboxURL.appendingPathComponent("worktree", isDirectory: true)
        registry = WorkspaceRegistry(repositoryURL: repositoryURL)
        try FileManager.default.createDirectory(at: repositoryURL, withIntermediateDirectories: true)
        try git(["init"])
        try git(["config", "user.name", "Gidem Integrity Tests"])
        try git(["config", "user.email", "gidem-integrity@example.invalid"])
        try Data("fixture\n".utf8).write(
            to: repositoryURL.appendingPathComponent("README.md", isDirectory: false)
        )
        try git(["add", "README.md"])
        try git(["commit", "-m", "fixture base"])
        try git(["branch", "-M", "main"])
        try git(["worktree", "add", "-b", "gdm/\(slug)", "--", worktreeURL.path, "HEAD"])
    }

    func remove() {
        try? FileManager.default.removeItem(at: sandboxURL)
    }

    func makeCheck(
        desc: String = "approved check definition",
        status: String
    ) -> CheckRecord {
        CheckRecord(
            id: "c1",
            desc: desc,
            cmd: "true",
            expect: "exit 0",
            manual: false,
            kind: "behavior",
            expert: false,
            status: status,
            redEvidence: nil,
            evidence: status == "proven" ? EvidenceRecord(
                observed: ".gdm/\(slug)/out/c1.txt",
                sha256: String(repeating: "c", count: 64),
                exitCode: 0,
                manual: false,
                note: nil,
                reviewer: nil,
                at: "2026-08-12T00:00:00.000Z"
            ) : nil
        )
    }

    func makeWork(
        checks: [CheckRecord],
        sourceFingerprint: String? = nil,
        required: [String] = ["preserve existing behavior"]
    ) -> WorkDocument {
        WorkDocument(
            slug: slug,
            brief: "protect verification plan integrity",
            createdAt: "2026-08-12T00:00:00.000Z",
            done: false,
            doneAt: nil,
            auditRequired: false,
            audit: nil,
            delivery: nil,
            checks: checks,
            contract: WorkContractRecord(
                required: required,
                forbidden: ["automatic commit"],
                commit: "forbidden",
                assumptions: ["local fixture"],
                uncertainties: [],
                allowedPaths: ["."],
                forbiddenPaths: [".git"],
                stopConditions: ["plan changed"],
                risk: "high",
                verification: "deterministic",
                simplificationRequired: true
            ),
            verificationPlanSourceFingerprint: sourceFingerprint
        )
    }

    func write(_ work: WorkDocument) throws {
        try write(work, to: repositoryURL)
    }

    func writeMapped(_ work: WorkDocument) throws {
        try write(work, to: worktreeURL)
    }

    private func write(_ work: WorkDocument, to workspaceURL: URL) throws {
        let directory = workspaceURL.appendingPathComponent(
            ".gdm/\(slug)",
            isDirectory: true
        )
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var data = try JSONEncoder().encode(work)
        data.append(0x0A)
        try data.write(
            to: directory.appendingPathComponent("checks.json", isDirectory: false),
            options: .atomic
        )
    }

    func loadWork() throws -> WorkDocument {
        try RepositoryLoader.loadWork(slug: slug, from: repositoryURL)
    }

    @discardableResult
    func installMappedTask(
        work: WorkDocument,
        approvedFingerprint: String?
    ) throws -> WorkspaceRegistryRecord {
        try writeMapped(work)
        let record = WorkspaceRegistryRecord(
            id: UUID(),
            slug: slug,
            worktreePath: worktreeURL.path,
            branch: "refs/heads/gdm/\(slug)",
            baseOID: try gitOutput(["rev-parse", "HEAD"]),
            gitCommonDirectory: repositoryURL.appendingPathComponent(".git").path,
            phase: .ready,
            selectedAgent: AgentKind.codex.rawValue,
            lastSession: nil,
            lastError: nil,
            checksApprovalRequired: true,
            approvedChecksFingerprint: approvedFingerprint,
            checksApprovedAt: approvedFingerprint == nil ? nil : "2026-08-12T00:00:00.000Z",
            createdAt: "2026-08-12T00:00:00.000Z"
        )
        try registry.save(WorkspaceRegistryDocument(tasks: [record]))
        return record
    }

    @MainActor
    func makeMappedStore(runner: VerificationIntegrityGDMRecorder) -> WorkspaceStore {
        WorkspaceStore(
            repositoryURL: repositoryURL,
            commandRunner: runner.runner,
            gdmInvocation: gdmInvocation,
            sourceFingerprintProvider: SequencedSourceFingerprints(values: [sourceA]).provider
        )
    }

    @MainActor
    func makePlanningStore(
        driver: IntegrityTerminalDriver,
        runner: VerificationIntegrityGDMRecorder,
        sourceProvider: WorkspaceSourceFingerprintProvider
    ) throws -> WorkspaceStore {
        let agentURL = try installFakeAgent(named: "codex")
        let manager = TerminalSessionManager(laneSessionFactory: { key, generation, specification in
            TerminalSession(
                taskID: key.taskID,
                laneID: key.laneID,
                generation: generation,
                specification: specification,
                terminalDriver: driver
            )
        })
        let catalog = AgentCatalog(
            environment: ["SHELL": "/bin/zsh"],
            searchDirectories: [agentURL.deletingLastPathComponent()],
            homeDirectory: sandboxURL
        )
        return WorkspaceStore(
            repositoryURL: repositoryURL,
            terminalSessions: manager,
            commandRunner: runner.runner,
            gdmInvocation: gdmInvocation,
            sourceFingerprintProvider: sourceProvider,
            agentCatalog: catalog
        )
    }

    private func installFakeAgent(named name: String) throws -> URL {
        let directory = sandboxURL.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let executable = directory.appendingPathComponent(name, isDirectory: false)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: executable.path
        )
        return executable
    }

    private func git(_ arguments: [String]) throws {
        let result = CommandRunner.run(
            executable: "/usr/bin/git",
            arguments: arguments,
            directory: repositoryURL
        )
        guard result.exitCode == 0 else {
            throw NSError(
                domain: "GDMNative.VerificationIntegrityFixture.Git",
                code: Int(result.exitCode),
                userInfo: [NSLocalizedDescriptionKey: result.output]
            )
        }
    }

    private func gitOutput(_ arguments: [String]) throws -> String {
        let result = CommandRunner.run(
            executable: "/usr/bin/git",
            arguments: arguments,
            directory: repositoryURL
        )
        guard result.exitCode == 0 else {
            throw NSError(
                domain: "GDMNative.VerificationIntegrityFixture.Git",
                code: Int(result.exitCode),
                userInfo: [NSLocalizedDescriptionKey: result.output]
            )
        }
        return result.output.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private enum IntegrityEvent: Equatable {
    case sourceCaptured
    case sourcePersisted
    case sessionStartedWithPrompt
}

private final class IntegrityEventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [IntegrityEvent] = []

    var snapshot: [IntegrityEvent] {
        lock.withLock { events }
    }

    func append(_ event: IntegrityEvent) {
        lock.withLock { events.append(event) }
    }
}

private final class SequencedSourceFingerprints: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String]
    private var captures = 0
    private let events: IntegrityEventRecorder?

    init(values: [String], events: IntegrityEventRecorder? = nil) {
        precondition(!values.isEmpty)
        self.values = values
        self.events = events
    }

    var captureCount: Int {
        lock.withLock { captures }
    }

    var provider: WorkspaceSourceFingerprintProvider {
        WorkspaceSourceFingerprintProvider { [self] _ in
            let value = lock.withLock { () -> String in
                let index = min(captures, values.count - 1)
                captures += 1
                return values[index]
            }
            events?.append(.sourceCaptured)
            return WorkspaceSourceFingerprint(schemaVersion: 1, sha256: value, fileCount: 1)
        }
    }
}

private struct VerificationIntegrityGDMCall: Equatable, Sendable {
    let executable: String
    let arguments: [String]
    let directory: String
}

private final class VerificationIntegrityGDMRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedCalls: [VerificationIntegrityGDMCall] = []
    private let events: IntegrityEventRecorder?

    init(events: IntegrityEventRecorder? = nil) {
        self.events = events
    }

    var calls: [VerificationIntegrityGDMCall] {
        lock.withLock { recordedCalls }
    }

    var runner: WorktreeCommandRunner {
        WorktreeCommandRunner { [self] executable, arguments, directory, _ in
            lock.withLock {
                recordedCalls.append(VerificationIntegrityGDMCall(
                    executable: executable,
                    arguments: arguments,
                    directory: directory.path
                ))
            }
            guard Self.commandArguments(arguments).starts(with: ["plan", "source"]),
                  let slug = Self.value(after: "--slug", in: arguments),
                  let fingerprint = Self.value(after: "--fingerprint", in: arguments) else {
                return CommandResult(exitCode: 0, output: "ok")
            }
            do {
                let file = directory.appendingPathComponent(
                    ".gdm/\(slug)/checks.json",
                    isDirectory: false
                )
                var work = try JSONDecoder().decode(
                    WorkDocument.self,
                    from: Data(contentsOf: file)
                )
                work.verificationPlanSourceFingerprint = fingerprint
                var data = try JSONEncoder().encode(work)
                data.append(0x0A)
                try data.write(to: file, options: .atomic)
                events?.append(.sourcePersisted)
                return CommandResult(exitCode: 0, output: "source fingerprint saved")
            } catch {
                return CommandResult(exitCode: 74, output: error.localizedDescription)
            }
        }
    }

    private static func commandArguments(_ arguments: [String]) -> ArraySlice<String> {
        guard arguments.first == "--fixture-prefix" else { return arguments[...] }
        return arguments.dropFirst()
    }

    private static func value(after option: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: option),
              arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }
}

@MainActor
private final class IntegrityTerminalDriver: TerminalDriving {
    let hostedView = NSView(frame: .zero)
    let processIdentifier: pid_t = 92_001
    let lifecycleOwnership: TerminalLifecycleOwnership = .terminalDriver
    private(set) var isRunning = false
    var onProcessTerminated: ((Int32?) -> Void)?
    private(set) var sentBytes: [[UInt8]] = []
    private let onStart: (AgentLaunchSpecification) -> Void

    init(onStart: @escaping (AgentLaunchSpecification) -> Void = { _ in }) {
        self.onStart = onStart
    }

    func start(_ specification: AgentLaunchSpecification) {
        onStart(specification)
        isRunning = true
    }

    func terminate() {
        isRunning = false
    }

    func send(_ bytes: [UInt8]) {
        sentBytes.append(bytes)
    }

    func resize(to size: NSSize) {}
}
