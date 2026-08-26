import AppKit
import Foundation
import XCTest
@testable import GDMNative

final class OperationalStateBoundaryTests: XCTestCase {
    private var roots: [URL] = []

    override func tearDownWithError() throws {
        roots.forEach { try? FileManager.default.removeItem(at: $0) }
        roots.removeAll()
    }

    @MainActor
    func testStoppingOneLaneKeepsSelectedTaskRunningWhileSiblingIsActive() async throws {
        let repository = try fixture()
        let task = WorkspaceTask.legacy(runnableWork(slug: "multi-lane-stop"), root: repository)
        let manager = TerminalSessionManager(laneSessionFactory: { key, generation, specification in
            TerminalSession(
                taskID: key.taskID,
                laneID: key.laneID,
                generation: generation,
                specification: specification,
                terminalDriver: StateBoundaryTerminalDriver()
            )
        })
        let store = WorkspaceStore(repositoryURL: repository, terminalSessions: manager)
        store.tasks = [task]
        store.selectedTaskKey = task.id

        let firstLaneID = UUID()
        let secondLaneID = UUID()
        let firstKey = TerminalSessionLaneKey(
            taskID: task.id,
            laneID: firstLaneID.uuidString.lowercased()
        )
        let secondKey = TerminalSessionLaneKey(
            taskID: task.id,
            laneID: secondLaneID.uuidString.lowercased()
        )
        let specification = AgentLaunchSpecification(
            agent: .shell,
            executableURL: URL(fileURLWithPath: "/bin/zsh"),
            arguments: [],
            environment: [:],
            currentDirectory: repository
        )
        _ = try manager.start(key: firstKey, specification: specification)
        _ = try manager.start(key: secondKey, specification: specification)
        store.sessionState = .running

        store.stopSelectedSession(laneID: firstLaneID)
        try await waitUntil {
            manager.session(for: firstKey)?.state.isActive == false
        }

        XCTAssertTrue(manager.session(for: secondKey)?.state.isActive == true)
        XCTAssertEqual(store.sessionState, .running)
    }

    @MainActor
    func testRepositorySwitchIsRejectedWhileWorkspaceCommandRuns() throws {
        let firstRepository = try fixture()
        let secondRepository = try fixture()
        let store = WorkspaceStore(repositoryURL: firstRepository)
        store.isCommandRunning = true

        store.switchRepository(to: secondRepository)

        XCTAssertEqual(store.repositoryURL.standardizedFileURL, firstRepository.standardizedFileURL)
        XCTAssertNotNil(store.errorMessage)
    }

    @MainActor
    func testGlobalShortcutEligibilityFailsClosedDuringBusyAndModalStates() throws {
        let repository = try fixture()
        let workbench = WorkbenchState()
        let store = WorkspaceStore(repositoryURL: repository, workbench: workbench)

        XCTAssertTrue(store.canPresentNewTask)
        XCTAssertTrue(store.canCloseFocusedPane)

        store.isCommandRunning = true
        XCTAssertFalse(store.canPresentNewTask)
        XCTAssertFalse(store.canCloseFocusedPane)
        store.presentNewTask()
        XCTAssertFalse(store.isNewTaskPresented)

        store.isCommandRunning = false
        store.presentNewTask()
        XCTAssertTrue(store.isNewTaskPresented)
        XCTAssertFalse(store.canPresentNewTask)
        XCTAssertFalse(store.canCloseFocusedPane)

        store.isNewTaskPresented = false
        while workbench.layout.root.orderedLeafIDs.count > 1 {
            let paneID = try XCTUnwrap(workbench.layout.root.orderedLeafIDs.last)
            XCTAssertTrue(workbench.close(paneID: paneID))
        }
        XCTAssertFalse(store.canCloseFocusedPane)
    }

    private func fixture() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("gidem-state-boundary-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        roots.append(url)
        return url
    }

    private func runnableWork(slug: String) -> WorkDocument {
        WorkDocument(
            slug: slug,
            brief: "Keep operational state consistent across lanes",
            createdAt: "2026-08-10T00:00:00.000Z",
            done: false,
            doneAt: nil,
            auditRequired: false,
            audit: nil,
            delivery: nil,
            checks: [CheckRecord(
                id: "c1",
                desc: "lane state remains consistent",
                cmd: "true",
                expect: "command succeeds",
                manual: false,
                kind: "edge",
                expert: false,
                status: "open",
                redEvidence: nil,
                evidence: nil
            )],
            contract: WorkContractRecord(
                required: ["active sibling is preserved"],
                forbidden: ["cross-lane state overwrite"],
                commit: "forbidden",
                risk: "medium",
                verification: "deterministic"
            )
        )
    }

    @MainActor
    private func waitUntil(
        timeoutIterations: Int = 200,
        condition: @MainActor () -> Bool
    ) async throws {
        for _ in 0..<timeoutIterations {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw NSError(
            domain: "GDMNative.OperationalStateBoundaryTests.Timeout",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "state boundary did not settle"]
        )
    }
}

@MainActor
private final class StateBoundaryTerminalDriver: TerminalDriving {
    let hostedView = NSView(frame: .zero)
    let processIdentifier: pid_t = 93_001
    let lifecycleOwnership: TerminalLifecycleOwnership = .terminalDriver
    private(set) var isRunning = false
    var onProcessTerminated: ((Int32?) -> Void)?

    func start(_ specification: AgentLaunchSpecification) { isRunning = true }
    func terminate() { isRunning = false }
    func send(_ bytes: [UInt8]) {}
    func resize(to size: NSSize) {}
}
