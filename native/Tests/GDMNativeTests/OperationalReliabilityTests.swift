import Foundation
import XCTest
@testable import GDMNative

@MainActor
final class OperationalReliabilityTests: XCTestCase {
    func testRegistryRejectsSymlinkedNativeStateDirectory() throws {
        let fixture = try OperationalReliabilityFixture()
        defer { fixture.remove() }
        let outside = fixture.sandboxURL.appendingPathComponent("outside", isDirectory: true)
        let gdm = fixture.repositoryURL.appendingPathComponent(".gdm", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: gdm, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: gdm.appendingPathComponent("native", isDirectory: true),
            withDestinationURL: outside
        )

        XCTAssertThrowsError(try fixture.registry.save(WorkspaceRegistryDocument()))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: outside.appendingPathComponent("workspace.json").path
        ))
    }

    func testUnavailableTaskCannotAdvertiseFocusedSessionStart() throws {
        let fixture = try OperationalReliabilityFixture()
        defer { fixture.remove() }
        let task = fixture.makeTask(document: nil)
        let workbench = WorkbenchState()
        let store = WorkspaceStore(repositoryURL: fixture.repositoryURL, workbench: workbench)
        store.tasks = [task]
        store.selectedTaskKey = task.id
        workbench.activate(task: task, persistedLayout: nil)

        let terminal = try XCTUnwrap(workbench.layout.root.leaves.first(where: {
            if case .terminal = $0.content { return true }
            return false
        }))
        store.focusPane(terminal.id)

        XCTAssertEqual(store.selectedVerificationPlanState, .unavailable)
        XCTAssertFalse(
            store.canStartFocusedSession,
            "A task without a readable checks document must not advertise a runnable terminal action"
        )
    }

    func testPlanApprovalIsIgnoredWhileAnotherWorkspaceCommandIsRunning() throws {
        let fixture = try OperationalReliabilityFixture()
        defer { fixture.remove() }
        let work = fixture.makeWork(checks: [fixture.makeCheck(desc: "displayed plan")])
        try fixture.write(work)
        let record = fixture.makeRecord(checksApprovalRequired: true)
        try fixture.registry.save(WorkspaceRegistryDocument(tasks: [record]))
        let task = WorkspaceTask.mapped(record: record, document: work, health: .ready)
        let store = WorkspaceStore(repositoryURL: fixture.repositoryURL)
        store.tasks = [task]
        store.selectedTaskKey = task.id
        store.isCommandRunning = true

        store.approveSelectedVerificationPlan()

        let persisted = try XCTUnwrap(fixture.registry.load().tasks.first)
        XCTAssertNil(
            persisted.approvedChecksFingerprint,
            "Plan approval must not race an in-flight verification or provisioning command"
        )
    }

    func testPlanApprovalRejectsDefinitionChangedOnDiskSinceReview() async throws {
        let fixture = try OperationalReliabilityFixture()
        defer { fixture.remove() }
        let displayed = fixture.makeWork(checks: [fixture.makeCheck(desc: "displayed plan")])
        let changed = fixture.makeWork(checks: [fixture.makeCheck(desc: "changed on disk")])
        try fixture.write(displayed)
        let record = fixture.makeRecord(checksApprovalRequired: true)
        try fixture.registry.save(WorkspaceRegistryDocument(tasks: [record]))
        let task = WorkspaceTask.mapped(record: record, document: displayed, health: .ready)
        let store = WorkspaceStore(repositoryURL: fixture.repositoryURL)
        store.tasks = [task]
        store.selectedTaskKey = task.id

        try fixture.write(changed)
        store.approveSelectedVerificationPlan()
        try await waitUntil {
            !store.isPlanApprovalPending && store.errorMessage != nil
        }

        let persisted = try XCTUnwrap(fixture.registry.load().tasks.first)
        XCTAssertNil(
            persisted.approvedChecksFingerprint,
            "The user must review a changed plan before its new fingerprint can be approved"
        )
        XCTAssertEqual(store.selectedWork?.verificationPlanFingerprint, changed.verificationPlanFingerprint)
        XCTAssertEqual(store.selectedVerificationPlanState, .reviewRequired)
        XCTAssertNotNil(store.errorMessage)
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
            domain: "GDMNative.OperationalReliabilityTests.Timeout",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "plan approval did not finish"]
        )
    }
}

private struct OperationalReliabilityFixture {
    let sandboxURL: URL
    let repositoryURL: URL
    let registry: WorkspaceRegistry
    let slug = "operational-reliability"
    let sourceFingerprint = String(repeating: "a", count: 64)

    init() throws {
        sandboxURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("gidem-operational-reliability-\(UUID().uuidString)", isDirectory: true)
        repositoryURL = sandboxURL.appendingPathComponent("repository", isDirectory: true)
        registry = WorkspaceRegistry(repositoryURL: repositoryURL)
        try FileManager.default.createDirectory(at: repositoryURL, withIntermediateDirectories: true)
        try git(["init"])
        try git(["config", "user.name", "Gidem Reliability Tests"])
        try git(["config", "user.email", "gidem-reliability@example.invalid"])
        try Data("fixture\n".utf8).write(
            to: repositoryURL.appendingPathComponent("README.md", isDirectory: false)
        )
        try git(["add", "README.md"])
        try git(["commit", "-m", "fixture base"])
        try git(["branch", "-M", "gdm/\(slug)"])
    }

    func remove() {
        try? FileManager.default.removeItem(at: sandboxURL)
    }

    func makeRecord(checksApprovalRequired: Bool? = nil) -> WorkspaceRegistryRecord {
        WorkspaceRegistryRecord(
            id: UUID(),
            slug: slug,
            worktreePath: repositoryURL.path,
            branch: "refs/heads/gdm/\(slug)",
            baseOID: gitOutput(["rev-parse", "HEAD"]),
            gitCommonDirectory: repositoryURL.appendingPathComponent(".git").path,
            phase: .ready,
            selectedAgent: AgentKind.codex.rawValue,
            lastSession: nil,
            lastError: nil,
            checksApprovalRequired: checksApprovalRequired,
            approvedChecksFingerprint: nil,
            checksApprovedAt: nil,
            createdAt: "2026-08-10T00:00:00.000Z"
        )
    }

    func makeTask(document: WorkDocument?) -> WorkspaceTask {
        .mapped(record: makeRecord(), document: document, health: .ready)
    }

    func makeWork(checks: [CheckRecord]) -> WorkDocument {
        WorkDocument(
            slug: slug,
            brief: "Gidem 사용자 동작을 신뢰할 수 있게 만든다",
            createdAt: "2026-08-10T00:00:00.000Z",
            done: false,
            doneAt: nil,
            auditRequired: false,
            audit: nil,
            delivery: nil,
            checks: checks,
            contract: WorkContractRecord(
                required: ["기존 사용자 세션 보존"],
                forbidden: ["자동 커밋"],
                commit: "forbidden",
                risk: "medium",
                verification: "deterministic"
            ),
            verificationPlanSourceFingerprint: sourceFingerprint
        )
    }

    func makeCheck(desc: String) -> CheckRecord {
        CheckRecord(
            id: "c1",
            desc: desc,
            cmd: "swift test --filter OperationalReliabilityTests",
            expect: "operational flow passes",
            manual: false,
            kind: "regression",
            expert: false,
            status: "open",
            redEvidence: nil,
            evidence: nil
        )
    }

    func write(_ work: WorkDocument) throws {
        let directory = repositoryURL
            .appendingPathComponent(".gdm", isDirectory: true)
            .appendingPathComponent(slug, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var data = try JSONEncoder().encode(work)
        data.append(0x0A)
        try data.write(to: directory.appendingPathComponent("checks.json"))
    }

    private func git(_ arguments: [String]) throws {
        let result = CommandRunner.run(
            executable: "/usr/bin/git",
            arguments: arguments,
            directory: repositoryURL
        )
        guard result.exitCode == 0 else {
            throw NSError(
                domain: "GDMNative.OperationalReliabilityFixture.Git",
                code: Int(result.exitCode),
                userInfo: [NSLocalizedDescriptionKey: result.output]
            )
        }
    }

    private func gitOutput(_ arguments: [String]) -> String {
        CommandRunner.run(
            executable: "/usr/bin/git",
            arguments: arguments,
            directory: repositoryURL
        )
        .output
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
