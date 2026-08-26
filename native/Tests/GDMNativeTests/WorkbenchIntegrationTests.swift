import AppKit
import Foundation
import XCTest
@testable import GDMNative

final class WorkbenchIntegrationTests: XCTestCase {
    private var roots: [URL] = []

    override func tearDownWithError() throws {
        roots.forEach { try? FileManager.default.removeItem(at: $0) }
        roots.removeAll()
    }

    func testNewTerminalLaneNeverBorrowsTheFocusedSourceSession() {
        let laneID = UUID()
        XCTAssertNil(TerminalPaneSessionResolver.resolve(
            laneID: laneID,
            laneSession: Optional<String>.none,
            selectedSession: "source-session"
        ))
        XCTAssertEqual(TerminalPaneSessionResolver.resolve(
            laneID: nil,
            laneSession: Optional<String>.none,
            selectedSession: "source-session"
        ), "source-session")
    }

    @MainActor
    func testCompactPresentationInvalidatesWideSplitMeasurements() throws {
        let workbench = WorkbenchState()
        let split = try XCTUnwrap(workbench.layout.nearestResizeSplit(direction: .right))
        workbench.recordSplitMeasurement(
            splitID: split.id,
            length: 1_000,
            displayedFraction: split.fraction
        )

        workbench.setSplitMeasurementsEnabled(false)
        XCTAssertFalse(workbench.resizeFocused(direction: .right, amount: 100))

        workbench.setSplitMeasurementsEnabled(true)
        XCTAssertFalse(
            workbench.resizeFocused(direction: .right, amount: 100),
            "Returning to wide mode must wait for fresh rendered geometry"
        )
        workbench.recordSplitMeasurement(
            splitID: split.id,
            length: 1_000,
            displayedFraction: split.fraction
        )
        XCTAssertTrue(workbench.resizeFocused(direction: .right, amount: 100))
    }

    @MainActor
    func testFileTreeOpenEditSaveFlowUsesRevisionBoundary() throws {
        let root = try fixture()
        try write("alpha\n", to: root.appendingPathComponent("README.md"))
        let service = try WorktreeFileService(rootURL: root)
        let entries = try service.indexFiles()
        XCTAssertTrue(entries.contains { $0.relativePath == "README.md" && $0.kind == .file })

        let editor = EditorBufferStore(fileService: service)
        let opened = try editor.open(relativePath: "README.md")
        editor.updateText(opened.text + "beta\n")
        XCTAssertTrue(editor.activeBuffer?.isDirty == true)
        _ = try editor.save()

        XCTAssertFalse(editor.activeBuffer?.isDirty ?? true)
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("README.md")), "alpha\nbeta\n")
    }

    func testPaneLayoutRoundTripPreservesSplitAndFocusBoundary() throws {
        var layout = PaneLayoutRecord.defaultLayout()
        let originalFocus = layout.focusedPaneID
        let newPane = UUID()
        XCTAssertTrue(layout.split(paneID: originalFocus, axis: .horizontal, newPaneID: newPane, content: .editor(EditorPaneState())))
        layout.focus(newPane)
        let restored = try JSONDecoder().decode(PaneLayoutRecord.self, from: JSONEncoder().encode(layout))
        XCTAssertEqual(restored, layout)
        XCTAssertEqual(restored.focusedPaneID, newPane)
    }

    @MainActor
    func testDirtyBufferProtectionSurvivesExternalRepositoryChange() throws {
        let root = try fixture()
        let file = root.appendingPathComponent("note.txt")
        try write("one", to: file)
        let editor = EditorBufferStore(fileService: try WorktreeFileService(rootURL: root))
        _ = try editor.open(relativePath: "note.txt")
        editor.updateText("unsaved")
        XCTAssertTrue(editor.buffers.values.contains(where: \.isDirty))
        try write("other", to: file)
        XCTAssertThrowsError(try editor.save()) { error in
            XCTAssertEqual(error as? WorktreeFileServiceError, .externalModification("note.txt"))
        }
        XCTAssertEqual(editor.activeBuffer?.text, "unsaved")
    }

    @MainActor
    func testRefreshAndTaskSwitchNeverDiscardUnsavedEditorText() throws {
        let firstRoot = try fixture()
        let secondRoot = try fixture()
        try write("baseline", to: firstRoot.appendingPathComponent("note.txt"))
        let first = mappedTask(slug: "first", root: firstRoot)
        let second = mappedTask(slug: "second", root: secondRoot)
        let workbench = WorkbenchState()
        let store = WorkspaceStore(repositoryURL: firstRoot, workbench: workbench)
        store.tasks = [first, second]
        store.selectedTaskKey = first.id
        workbench.activate(task: first, persistedLayout: nil)
        workbench.openFile(relativePath: "note.txt")
        workbench.updateEditorText("unsaved", path: "note.txt")
        let editorIdentity = ObjectIdentifier(try XCTUnwrap(workbench.editorStore))

        workbench.activate(task: first, persistedLayout: nil)
        XCTAssertEqual(ObjectIdentifier(try XCTUnwrap(workbench.editorStore)), editorIdentity)
        XCTAssertEqual(workbench.editorStore?.buffers["note.txt"]?.text, "unsaved")

        store.select(second)
        XCTAssertEqual(store.selectedTaskKey, first.id)
        XCTAssertEqual(workbench.editorStore?.buffers["note.txt"]?.text, "unsaved")
        XCTAssertNotNil(store.errorMessage)
    }

    @MainActor
    func testMappedTaskPaneLayoutPersistsThroughRegistry() async throws {
        let repository = try fixture()
        let worktree = try fixture()
        let task = mappedTask(slug: "layout", root: worktree)
        let record = try XCTUnwrap(task.location.registryRecord)
        let registry = WorkspaceRegistry(repositoryURL: repository)
        try registry.save(WorkspaceRegistryDocument(
            selectedTaskKey: task.id,
            tasks: [record]
        ))

        let workbench = WorkbenchState()
        let store = WorkspaceStore(repositoryURL: repository, workbench: workbench)
        store.tasks = [task]
        store.selectedTaskKey = task.id
        workbench.activate(task: task, persistedLayout: nil)
        let originalCount = workbench.layout.root.orderedLeafIDs.count
        store.splitPane(workbench.focusedPaneID, axis: .horizontal)

        try await Task.sleep(for: .milliseconds(350))
        let persisted = try XCTUnwrap(registry.load().tasks.first?.layout)
        XCTAssertEqual(persisted.root.orderedLeafIDs.count, originalCount + 1)
        XCTAssertEqual(persisted.focusedPaneID, workbench.focusedPaneID)
    }

    @MainActor
    func testFocusedTerminalStartShortcutEligibilityIsLaneScoped() throws {
        let repository = try fixture()
        let worktree = try fixture()
        let task = mappedTask(
            slug: "keyboard-start",
            root: worktree,
            document: runnableWork(slug: "keyboard-start")
        )
        let manager = TerminalSessionManager { taskID, generation, specification in
            TerminalSession(
                taskID: taskID,
                generation: generation,
                specification: specification,
                terminalDriver: ShortcutTerminalDriver()
            )
        }
        let workbench = WorkbenchState()
        let store = WorkspaceStore(
            repositoryURL: repository,
            terminalSessions: manager,
            workbench: workbench
        )
        store.tasks = [task]
        store.selectedTaskKey = task.id
        workbench.activate(task: task, persistedLayout: nil)

        XCTAssertNil(store.focusedTerminalLaneID)
        XCTAssertFalse(store.canStartFocusedSession)

        let firstTerminal = try XCTUnwrap(workbench.layout.root.leaves.first(where: {
            if case .terminal = $0.content { return true }
            return false
        }))
        guard case .terminal(let firstTerminalState) = firstTerminal.content else {
            return XCTFail("expected terminal pane")
        }
        store.focusPane(firstTerminal.id)

        XCTAssertEqual(store.focusedTerminalLaneID, firstTerminalState.laneID)
        XCTAssertTrue(store.canStartFocusedSession)

        let specification = AgentLaunchSpecification(
            agent: .shell,
            executableURL: URL(fileURLWithPath: "/bin/zsh"),
            arguments: [],
            environment: [:],
            currentDirectory: worktree
        )
        _ = try manager.start(
            taskID: task.id,
            laneID: firstTerminalState.laneID.uuidString.lowercased(),
            specification: specification
        )

        XCTAssertFalse(store.canStartFocusedSession)

        let paneCountBeforeProtectedClose = workbench.layout.root.leaves.count
        XCTAssertTrue(store.handleTerminalHostAction(.closePane, paneID: firstTerminal.id))
        XCTAssertEqual(workbench.layout.root.leaves.count, paneCountBeforeProtectedClose)
        XCTAssertNotNil(store.errorMessage, "Ghostty close must retain an active agent pane")
        store.errorMessage = nil

        store.splitPane(firstTerminal.id, axis: .horizontal)
        let secondLaneID = try XCTUnwrap(store.focusedTerminalLaneID)
        XCTAssertNotEqual(secondLaneID, firstTerminalState.laneID)
        XCTAssertTrue(store.canStartFocusedSession)

        let filesPane = try XCTUnwrap(workbench.layout.root.leaves.first(where: {
            if case .files = $0.content { return true }
            return false
        }))
        store.focusPane(filesPane.id)
        XCTAssertNil(store.focusedTerminalLaneID)
        XCTAssertFalse(store.canStartFocusedSession)
    }

    @MainActor
    func testTaskSwitchClearsStaleFileRowsBeforeTheNextIndexCompletes() async throws {
        let firstRoot = try fixture()
        let secondRoot = try fixture()
        try write("first", to: firstRoot.appendingPathComponent("only-first.txt"))
        try write("second", to: secondRoot.appendingPathComponent("only-second.txt"))
        let first = mappedTask(slug: "files-first", root: firstRoot)
        let second = mappedTask(slug: "files-second", root: secondRoot)
        let workbench = WorkbenchState()

        workbench.activate(task: first, persistedLayout: nil)
        try await waitUntil { workbench.fileEntries.contains { $0.relativePath == "only-first.txt" } }

        workbench.activate(task: second, persistedLayout: nil)
        XCTAssertTrue(workbench.fileEntries.isEmpty)
        try await waitUntil { workbench.fileEntries.contains { $0.relativePath == "only-second.txt" } }
        XCTAssertFalse(workbench.fileEntries.contains { $0.relativePath == "only-first.txt" })
    }

    @MainActor
    func testRepositoryResetClearsIndexingAndSameIDTransientLayouts() throws {
        let firstRoot = try fixture()
        let secondRoot = try fixture()
        let first = WorkspaceTask.legacy(runnableWork(slug: "same-task"), root: firstRoot)
        let second = WorkspaceTask.legacy(runnableWork(slug: "same-task"), root: secondRoot)
        let workbench = WorkbenchState()
        workbench.activate(task: first, persistedLayout: nil)
        let defaultCount = workbench.layout.root.leaves.count
        _ = workbench.split(
            paneID: workbench.focusedPaneID,
            axis: .horizontal,
            content: .terminal(TerminalPaneState(agent: .codex))
        )
        XCTAssertEqual(workbench.layout.root.leaves.count, defaultCount + 1)
        XCTAssertTrue(workbench.isIndexingFiles)

        workbench.resetRepository()
        XCTAssertFalse(workbench.isIndexingFiles)
        workbench.activate(task: second, persistedLayout: nil)

        XCTAssertEqual(workbench.layout.root.leaves.count, defaultCount)
    }

    @MainActor
    func testRefreshRetainsMissingTaskWhenItOwnsUnsavedTextAndAnActiveLane() throws {
        let repository = try fixture()
        let work = runnableWork(slug: "refresh-retained")
        try writeWork(work, to: repository)
        try write("baseline", to: repository.appendingPathComponent("note.txt"))
        let manager = TerminalSessionManager(laneSessionFactory: { key, generation, specification in
            TerminalSession(
                taskID: key.taskID,
                laneID: key.laneID,
                generation: generation,
                specification: specification,
                terminalDriver: ShortcutTerminalDriver()
            )
        })
        let workbench = WorkbenchState()
        let store = WorkspaceStore(
            repositoryURL: repository,
            terminalSessions: manager,
            workbench: workbench
        )
        let task = try XCTUnwrap(store.selectedTask)
        workbench.openFile(relativePath: "note.txt")
        workbench.updateEditorText("unsaved", path: "note.txt")
        let terminal = try XCTUnwrap(workbench.layout.root.leaves.first(where: {
            if case .terminal = $0.content { return true }
            return false
        }))
        guard case .terminal(let terminalState) = terminal.content else {
            return XCTFail("expected terminal pane")
        }
        _ = try manager.start(
            key: TerminalSessionLaneKey(
                taskID: task.id,
                laneID: terminalState.laneID.uuidString.lowercased()
            ),
            specification: AgentLaunchSpecification(
                agent: .shell,
                executableURL: URL(fileURLWithPath: "/bin/zsh"),
                arguments: [],
                environment: [:],
                currentDirectory: repository
            )
        )

        try FileManager.default.removeItem(
            at: repository.appendingPathComponent(".gdm/\(work.slug)", isDirectory: true)
        )
        store.refresh()

        XCTAssertEqual(store.selectedTask?.id, task.id)
        XCTAssertEqual(store.selectedTask?.health, .disconnected)
        XCTAssertEqual(workbench.editorStore?.buffers["note.txt"]?.text, "unsaved")
        XCTAssertNotNil(store.selectedSession)
    }

    private func fixture() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("gdm-workbench-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        roots.append(url); return url
    }

    private func write(_ text: String, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func writeWork(_ work: WorkDocument, to root: URL) throws {
        let directory = root
            .appendingPathComponent(".gdm", isDirectory: true)
            .appendingPathComponent(work.slug, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var data = try JSONEncoder().encode(work)
        data.append(0x0A)
        try data.write(to: directory.appendingPathComponent("checks.json"))
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
        throw NSError(
            domain: "GDMNative.WorkbenchIntegrationTests.Timeout",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "workbench condition did not become true"]
        )
    }

    private func mappedTask(
        slug: String,
        root: URL,
        document: WorkDocument? = nil
    ) -> WorkspaceTask {
        let record = WorkspaceRegistryRecord(
            id: UUID(),
            slug: slug,
            worktreePath: root.path,
            branch: "refs/heads/gdm/\(slug)",
            baseOID: "base",
            gitCommonDirectory: root.appendingPathComponent(".git").path,
            phase: .ready,
            selectedAgent: AgentKind.shell.rawValue,
            lastSession: nil,
            lastError: nil,
            createdAt: "2026-08-08T00:00:00.000Z"
        )
        return .mapped(record: record, document: document, health: .ready)
    }

    private func runnableWork(slug: String) -> WorkDocument {
        WorkDocument(
            slug: slug,
            brief: "terminal shortcut eligibility",
            createdAt: "2026-08-08T00:00:00.000Z",
            done: false,
            doneAt: nil,
            auditRequired: false,
            audit: nil,
            delivery: nil,
            checks: [CheckRecord(
                id: "c1",
                desc: "terminal lane remains startable",
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
                required: ["lane-scoped start"],
                forbidden: ["cross-lane stop"],
                commit: "forbidden",
                risk: "medium",
                verification: "deterministic"
            )
        )
    }

}

@MainActor
private final class ShortcutTerminalDriver: TerminalDriving {
    let hostedView = NSView(frame: .zero)
    let processIdentifier: pid_t = 9_100
    var isRunning = false
    let lifecycleOwnership: TerminalLifecycleOwnership = .terminalDriver
    var onProcessTerminated: ((Int32?) -> Void)?

    func start(_ specification: AgentLaunchSpecification) { isRunning = true }
    func terminate() { isRunning = false }
    func send(_ bytes: [UInt8]) {}
    func resize(to size: NSSize) {}
}
