import AppKit
import Foundation
import XCTest
@testable import GDMNative

@MainActor
final class VerificationPlanFlowTests: XCTestCase {
    func testEmptyChecksNeedVerificationPlan() throws {
        let fixture = try VerificationPlanFixture()
        defer { fixture.remove() }
        let record = fixture.makeRecord(checksApprovalRequired: true)
        let task = WorkspaceTask.mapped(
            record: record,
            document: fixture.makeWork(checks: []),
            health: .ready
        )
        let store = WorkspaceStore(repositoryURL: fixture.repositoryURL)

        store.tasks = [task]
        store.selectedTaskKey = task.id

        XCTAssertEqual(store.verificationPlanState(for: task), .needsPlan)
        XCTAssertEqual(store.selectedVerificationPlanState, .needsPlan)
    }

    func testNewMappedTaskWithChecksRequiresReview() throws {
        let fixture = try VerificationPlanFixture()
        defer { fixture.remove() }
        let record = fixture.makeRecord(checksApprovalRequired: true)
        let task = WorkspaceTask.mapped(
            record: record,
            document: fixture.makeWork(
                checks: [fixture.makeCheck()],
                sourceFingerprint: fixture.sourceFingerprint
            ),
            health: .ready
        )
        let store = WorkspaceStore(repositoryURL: fixture.repositoryURL)

        store.tasks = [task]
        store.selectedTaskKey = task.id

        XCTAssertEqual(store.selectedVerificationPlanState, .reviewRequired)
        XCTAssertFalse(store.canRunVerification)
        XCTAssertFalse(store.canCompleteSelectedTask)
    }

    func testApprovingFingerprintMovesMappedTaskToApproved() async throws {
        let fixture = try VerificationPlanFixture()
        defer { fixture.remove() }
        let work = fixture.makeWork(
            checks: [fixture.makeCheck()],
            sourceFingerprint: fixture.sourceFingerprint
        )
        let fingerprint = try XCTUnwrap(work.verificationPlanFingerprint)
        try fixture.write(work)
        let record = fixture.makeRecord(checksApprovalRequired: true)
        try fixture.registry.save(WorkspaceRegistryDocument(tasks: [record]))
        let task = WorkspaceTask.mapped(record: record, document: work, health: .ready)
        let recorder = VerificationPlanGDMRecorder()
        let store = WorkspaceStore(
            repositoryURL: fixture.repositoryURL,
            commandRunner: recorder.runner,
            gdmInvocation: fixture.gdmInvocation,
            sourceFingerprintProvider: fixture.sourceProvider
        )
        store.tasks = [task]
        store.selectedTaskKey = task.id

        store.approveSelectedVerificationPlan()
        try await waitUntil(timeoutIterations: 500) {
            !store.isPlanApprovalPending
        }

        XCTAssertEqual(store.selectedVerificationPlanState, .approved)
        let persisted = try XCTUnwrap(fixture.registry.load().tasks.first)
        XCTAssertTrue(persisted.checksApprovalRequired == true)
        XCTAssertEqual(persisted.approvedChecksFingerprint, fingerprint)
        XCTAssertNotNil(persisted.checksApprovedAt)
    }

    func testApprovalFollowUpPromptUsesSemanticPasteThenSubmitsExactlyOnce() async throws {
        let fixture = try VerificationPlanFixture()
        defer { fixture.remove() }
        try fixture.write(fixture.makeWork(checks: []))
        let agentURL = try fixture.installFakeAgent(named: "codex")
        let driver = VerificationPlanRecordingDriver()
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
            homeDirectory: fixture.sandboxURL
        )
        let store = WorkspaceStore(
            repositoryURL: fixture.repositoryURL,
            terminalSessions: manager,
            commandRunner: VerificationPlanGDMRecorder().runner,
            gdmInvocation: fixture.gdmInvocation,
            sourceFingerprintProvider: fixture.sourceProvider,
            agentCatalog: catalog
        )

        store.startVerificationPlanning()
        try await waitUntil(timeoutIterations: 500) {
            store.selectedSession != nil || store.errorMessage != nil
        }
        XCTAssertNil(store.errorMessage)

        try fixture.write(fixture.makeWork(
            checks: [fixture.makeCheck(desc: "approved plan")],
            sourceFingerprint: fixture.sourceFingerprint
        ))
        try await waitUntil(timeoutIterations: 500) {
            store.selectedVerificationPlanState == .reviewRequired
        }
        store.approveSelectedVerificationPlan()
        try await waitUntil(timeoutIterations: 500) {
            !store.isPlanApprovalPending && store.selectedVerificationPlanState == .approved
        }
        guard driver.pastedTexts.count == 1 else {
            XCTFail("Expected one semantic paste, got \(driver.pastedTexts.count)")
            let terminated = await store.terminateAllSessions()
            XCTAssertTrue(terminated)
            return
        }
        XCTAssertTrue(
            driver.pastedTexts[0]
                .contains("사용자가 검증 계획을 승인했습니다")
        )
        XCTAssertEqual(driver.sentBytes, [[0x0D]])

        let terminated = await store.terminateAllSessions()
        XCTAssertTrue(terminated)
    }

    func testDefinitionChangeRevokesApprovalAndRequiresReviewAgain() throws {
        let fixture = try VerificationPlanFixture()
        defer { fixture.remove() }
        let original = fixture.makeWork(
            checks: [fixture.makeCheck(desc: "기존 동작을 보존한다")],
            sourceFingerprint: fixture.sourceFingerprint
        )
        let approvedFingerprint = try XCTUnwrap(original.verificationPlanFingerprint)
        let record = fixture.makeRecord(
            checksApprovalRequired: true,
            approvedChecksFingerprint: approvedFingerprint
        )
        let changed = fixture.makeWork(
            checks: [fixture.makeCheck(desc: "새 동작도 검증한다")],
            sourceFingerprint: fixture.sourceFingerprint
        )
        let task = WorkspaceTask.mapped(record: record, document: changed, health: .ready)
        let store = WorkspaceStore(repositoryURL: fixture.repositoryURL)

        store.tasks = [task]
        store.selectedTaskKey = task.id

        XCTAssertNotEqual(changed.verificationPlanFingerprint, approvedFingerprint)
        XCTAssertEqual(store.selectedVerificationPlanState, .reviewRequired)
    }

    func testRuntimeStatusAndEvidenceDoNotChangePlanFingerprint() throws {
        let fixture = try VerificationPlanFixture()
        defer { fixture.remove() }
        let open = fixture.makeCheck(status: "open")
        let evidence = EvidenceRecord(
            observed: ".gdm/verification-plan/out/c1.txt",
            sha256: String(repeating: "a", count: 64),
            exitCode: 0,
            manual: false,
            note: nil,
            reviewer: nil,
            at: "2026-08-10T00:01:00.000Z"
        )
        let proven = fixture.makeCheck(status: "proven", evidence: evidence)
        let before = fixture.makeWork(
            checks: [open],
            sourceFingerprint: fixture.sourceFingerprint
        )
        let after = fixture.makeWork(
            checks: [proven],
            sourceFingerprint: fixture.sourceFingerprint
        )

        XCTAssertEqual(before.verificationPlanFingerprint, after.verificationPlanFingerprint)

        let approvedFingerprint = try XCTUnwrap(before.verificationPlanFingerprint)
        let record = fixture.makeRecord(
            checksApprovalRequired: true,
            approvedChecksFingerprint: approvedFingerprint
        )
        let task = WorkspaceTask.mapped(record: record, document: after, health: .ready)
        let store = WorkspaceStore(repositoryURL: fixture.repositoryURL)
        store.tasks = [task]
        store.selectedTaskKey = task.id

        XCTAssertEqual(store.selectedVerificationPlanState, .approved)
    }

    func testPlannerLaunchPassesPromptAsInteractiveStartupArgumentExactlyOnce() async throws {
        let fixture = try VerificationPlanFixture()
        defer { fixture.remove() }
        let work = fixture.makeWork(checks: [])
        try fixture.write(work)
        let agentURL = try fixture.installFakeAgent(named: "codex")
        let driver = VerificationPlanRecordingDriver()
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
            homeDirectory: fixture.sandboxURL
        )
        let store = WorkspaceStore(
            repositoryURL: fixture.repositoryURL,
            terminalSessions: manager,
            commandRunner: VerificationPlanGDMRecorder().runner,
            gdmInvocation: fixture.gdmInvocation,
            sourceFingerprintProvider: fixture.sourceProvider,
            agentCatalog: catalog
        )
        XCTAssertEqual(store.selectedVerificationPlanState, .needsPlan)

        store.startVerificationPlanning()
        try await waitUntil(timeoutIterations: 500) {
            store.selectedSession != nil || store.errorMessage != nil
        }

        XCTAssertNil(store.errorMessage)
        let session = try XCTUnwrap(store.selectedSession)
        XCTAssertEqual(session.specification.agent, .codex)
        XCTAssertEqual(session.specification.arguments.count, 1)
        let prompt = try XCTUnwrap(session.specification.arguments.first)
        XCTAssertTrue(prompt.contains("\"$GIDEM_GDM_EXECUTABLE\" plan add"), prompt)
        XCTAssertTrue(prompt.contains("지금은 구현이 아니라 검증 계획 수립 단계입니다."), prompt)
        XCTAssertTrue(prompt.contains("소스 코드를 수정하거나 검증을 실행하거나 커밋하지 마세요."), prompt)
        XCTAssertTrue(prompt.contains("사용자가 계획을 승인할 때까지 기다리세요."), prompt)
        XCTAssertFalse(prompt.contains("\r"))
        XCTAssertTrue(driver.sentBytes.isEmpty)

        let terminated = await store.terminateAllSessions()
        XCTAssertTrue(terminated)
    }

    func testApprovedPlanKeepsMonitoringForDefinitionChangesDuringActiveAgentSession() async throws {
        let fixture = try VerificationPlanFixture()
        defer { fixture.remove() }
        try fixture.write(fixture.makeWork(checks: []))
        let agentURL = try fixture.installFakeAgent(named: "codex")
        let driver = VerificationPlanRecordingDriver()
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
            homeDirectory: fixture.sandboxURL
        )
        let store = WorkspaceStore(
            repositoryURL: fixture.repositoryURL,
            terminalSessions: manager,
            commandRunner: VerificationPlanGDMRecorder().runner,
            gdmInvocation: fixture.gdmInvocation,
            sourceFingerprintProvider: fixture.sourceProvider,
            agentCatalog: catalog
        )
        store.startVerificationPlanning()
        try await waitUntil(timeoutIterations: 500) { store.selectedSession != nil }

        let approved = fixture.makeWork(
            checks: [fixture.makeCheck(desc: "approved plan")],
            sourceFingerprint: fixture.sourceFingerprint
        )
        try fixture.write(approved)
        try await waitUntil(timeoutIterations: 500) {
            store.selectedVerificationPlanState == .reviewRequired
        }
        store.approveSelectedVerificationPlan()
        try await waitUntil(timeoutIterations: 500) {
            !store.isPlanApprovalPending && store.selectedVerificationPlanState == .approved
        }

        let changed = fixture.makeWork(
            checks: [fixture.makeCheck(desc: "changed after approval")],
            sourceFingerprint: fixture.sourceFingerprint
        )
        try fixture.write(changed)
        try await waitUntil(timeoutIterations: 500) {
            store.selectedVerificationPlanState == .reviewRequired
        }
        XCTAssertEqual(store.selectedWork?.verificationPlanFingerprint, changed.verificationPlanFingerprint)

        let terminated = await store.terminateAllSessions()
        XCTAssertTrue(terminated)
    }

    func testPlannerPromptRemovesEmbeddedTerminalControlCharacters() async throws {
        let fixture = try VerificationPlanFixture()
        defer { fixture.remove() }
        try fixture.write(fixture.makeWork(
            checks: [],
            brief: "first command\rsecond line\nthird\u{001B}[31m"
        ))
        let agentURL = try fixture.installFakeAgent(named: "codex")
        let driver = VerificationPlanRecordingDriver()
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
            homeDirectory: fixture.sandboxURL
        )
        let store = WorkspaceStore(
            repositoryURL: fixture.repositoryURL,
            terminalSessions: manager,
            commandRunner: VerificationPlanGDMRecorder().runner,
            gdmInvocation: fixture.gdmInvocation,
            sourceFingerprintProvider: fixture.sourceProvider,
            agentCatalog: catalog
        )

        store.startVerificationPlanning()
        try await waitUntil(timeoutIterations: 500) {
            store.selectedSession != nil || store.errorMessage != nil
        }

        XCTAssertNil(store.errorMessage)
        let payload = try XCTUnwrap(store.selectedSession?.specification.arguments.first)
        XCTAssertFalse(payload.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains))
        XCTAssertTrue(payload.contains("first command second line third [31m"), payload)
        XCTAssertTrue(driver.sentBytes.isEmpty)

        let terminated = await store.terminateAllSessions()
        XCTAssertTrue(terminated)
    }

    private func waitUntil(
        timeoutIterations: Int,
        condition: @MainActor () -> Bool
    ) async throws {
        for _ in 0..<timeoutIterations {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw NSError(
            domain: "GDMNative.VerificationPlanFlowTests.Timeout",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "verification planner did not start"]
        )
    }
}

private struct VerificationPlanFixture {
    let sandboxURL: URL
    let repositoryURL: URL
    let registry: WorkspaceRegistry
    let slug = "verification-plan"
    let sourceFingerprint = String(repeating: "a", count: 64)

    var gdmInvocation: CommandInvocation {
        CommandInvocation(executable: "/fixture/gdm", prefixArguments: [])
    }

    var sourceProvider: WorkspaceSourceFingerprintProvider {
        let sourceFingerprint = sourceFingerprint
        return WorkspaceSourceFingerprintProvider { _ in
            WorkspaceSourceFingerprint(
                schemaVersion: 1,
                sha256: sourceFingerprint,
                fileCount: 1
            )
        }
    }

    init() throws {
        sandboxURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("gidem-verification-plan-\(UUID().uuidString)", isDirectory: true)
        repositoryURL = sandboxURL.appendingPathComponent("repository", isDirectory: true)
        registry = WorkspaceRegistry(repositoryURL: repositoryURL)
        try FileManager.default.createDirectory(at: repositoryURL, withIntermediateDirectories: true)
        try Self.git(["init"], at: repositoryURL)
        try Self.git(["config", "user.name", "Gidem Verification Tests"], at: repositoryURL)
        try Self.git(
            ["config", "user.email", "gidem-verification@example.invalid"],
            at: repositoryURL
        )
        try Data("fixture\n".utf8).write(
            to: repositoryURL.appendingPathComponent("README.md", isDirectory: false)
        )
        try Self.git(["add", "README.md"], at: repositoryURL)
        try Self.git(["commit", "-m", "fixture base"], at: repositoryURL)
        try Self.git(["branch", "-M", "gdm/\(slug)"], at: repositoryURL)
    }

    func remove() {
        try? FileManager.default.removeItem(at: sandboxURL)
    }

    func makeRecord(
        checksApprovalRequired: Bool?,
        approvedChecksFingerprint: String? = nil
    ) -> WorkspaceRegistryRecord {
        WorkspaceRegistryRecord(
            id: UUID(),
            slug: slug,
            worktreePath: repositoryURL.path,
            branch: "refs/heads/gdm/\(slug)",
            baseOID: Self.gitOutput(["rev-parse", "HEAD"], at: repositoryURL),
            gitCommonDirectory: repositoryURL.appendingPathComponent(".git").path,
            phase: .ready,
            selectedAgent: AgentKind.codex.rawValue,
            lastSession: nil,
            lastError: nil,
            checksApprovalRequired: checksApprovalRequired,
            approvedChecksFingerprint: approvedChecksFingerprint,
            checksApprovedAt: approvedChecksFingerprint == nil ? nil : "2026-08-10T00:00:00.000Z",
            createdAt: "2026-08-10T00:00:00.000Z"
        )
    }

    func makeWork(
        checks: [CheckRecord],
        brief: String = "검증 계획 승인 흐름을 구현한다",
        sourceFingerprint: String? = nil
    ) -> WorkDocument {
        WorkDocument(
            slug: slug,
            brief: brief,
            createdAt: "2026-08-10T00:00:00.000Z",
            done: false,
            doneAt: nil,
            auditRequired: false,
            audit: nil,
            delivery: nil,
            checks: checks,
            contract: WorkContractRecord(
                required: ["기존 동작 보존"],
                forbidden: ["자동 커밋"],
                commit: "forbidden",
                risk: "medium",
                verification: "deterministic"
            ),
            verificationPlanSourceFingerprint: sourceFingerprint
        )
    }

    func makeCheck(
        desc: String = "승인된 검증 계획만 실행한다",
        status: String = "open",
        evidence: EvidenceRecord? = nil
    ) -> CheckRecord {
        CheckRecord(
            id: "c1",
            desc: desc,
            cmd: "swift test --filter VerificationPlanFlowTests",
            expect: "선택한 테스트가 통과한다",
            manual: false,
            kind: "behavior",
            expert: false,
            status: status,
            redEvidence: nil,
            evidence: evidence
        )
    }

    func write(_ work: WorkDocument) throws {
        let directory = repositoryURL
            .appendingPathComponent(".gdm", isDirectory: true)
            .appendingPathComponent(work.slug, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var data = try JSONEncoder().encode(work)
        data.append(0x0A)
        try data.write(to: directory.appendingPathComponent("checks.json"))
    }

    func installFakeAgent(named name: String) throws -> URL {
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

    private static func git(_ arguments: [String], at repositoryURL: URL) throws {
        let result = CommandRunner.run(
            executable: "/usr/bin/git",
            arguments: arguments,
            directory: repositoryURL
        )
        guard result.exitCode == 0 else {
            throw NSError(
                domain: "GDMNative.VerificationPlanFixture.Git",
                code: Int(result.exitCode),
                userInfo: [NSLocalizedDescriptionKey: result.output]
            )
        }
    }

    private static func gitOutput(_ arguments: [String], at repositoryURL: URL) -> String {
        CommandRunner.run(
            executable: "/usr/bin/git",
            arguments: arguments,
            directory: repositoryURL
        )
        .output
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private final class VerificationPlanGDMRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedArguments: [[String]] = []

    var arguments: [[String]] {
        lock.withLock { recordedArguments }
    }

    var runner: WorktreeCommandRunner {
        WorktreeCommandRunner { [self] _, arguments, directory, _ in
            lock.withLock { recordedArguments.append(arguments) }
            guard arguments.starts(with: ["plan", "source"]),
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
                return CommandResult(exitCode: 0, output: "source fingerprint saved")
            } catch {
                return CommandResult(exitCode: 74, output: error.localizedDescription)
            }
        }
    }

    private static func value(after option: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: option),
              arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }
}

@MainActor
private final class VerificationPlanRecordingDriver: TerminalDriving {
    let hostedView = NSView(frame: .zero)
    let processIdentifier: pid_t = 91_001
    let lifecycleOwnership: TerminalLifecycleOwnership = .terminalDriver
    private(set) var isRunning = false
    var onProcessTerminated: ((Int32?) -> Void)?
    private(set) var sentBytes: [[UInt8]] = []
    private(set) var pastedTexts: [String] = []

    func start(_ specification: AgentLaunchSpecification) {
        isRunning = true
    }

    func terminate() {
        isRunning = false
    }

    func send(_ bytes: [UInt8]) {
        sentBytes.append(bytes)
    }

    func sendPaste(_ text: String) {
        pastedTexts.append(text)
    }

    func resize(to size: NSSize) {}
}
