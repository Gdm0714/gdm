import AppKit
import Darwin
import Foundation
import Dispatch
import XCTest
@testable import GDMNative

final class WorktreeProofLoopIntegrationTests: XCTestCase {
    @MainActor
    func testCleanupPendingStopRemainsRunningVisibleAndPersistedActive() async throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }
        let service = WorktreeService(repositoryURL: fixture.repositoryURL)
        let record = try service.provision(
            WorktreeProvisioningRequest(slug: "cleanup-pending", brief: "preserve active cleanup")
        )
        let driver = WorkspaceStopTerminalDriver(pid: 7_100)
        let reaper = WorkspaceStopReaper(results: [.stillRunning, .stillRunning])
        let manager = TerminalSessionManager { taskID, generation, specification in
            TerminalSession(
                taskID: taskID,
                generation: generation,
                specification: specification,
                terminalDriver: driver,
                signaler: WorkspaceStopSignaler(),
                childReaper: reaper,
                processGroupResolver: WorkspaceStopGroupResolver(group: driver.processIdentifier),
                clock: WorkspaceStopClock(),
                stopPolicy: TerminalStopPolicy(
                    gracePeriodNanoseconds: 0,
                    pollIntervalNanoseconds: 0,
                    postKillReapTimeoutNanoseconds: 0
                )
            )
        }
        let store = WorkspaceStore(
            repositoryURL: fixture.repositoryURL,
            terminalSessions: manager
        )
        store.select(try XCTUnwrap(store.tasks.first(where: { $0.slug == record.slug })))
        store.startSelectedSession()
        try await waitUntilSessionLaunches(store)
        let session = try XCTUnwrap(store.selectedSession)
        XCTAssertEqual(session.state, .running)

        store.stopSelectedSession()
        for _ in 0..<500 where store.errorMessage == nil {
            try await Task.sleep(nanoseconds: 10_000_000)
        }

        XCTAssertEqual(session.state, .stopping)
        XCTAssertTrue(session.state.isActive)
        XCTAssertTrue(manager.hasActiveSessions)
        XCTAssertEqual(store.sessionState.label, SessionDisplayState.running.label)
        XCTAssertTrue(store.errorMessage?.contains("제한 시간을 초과") == true)
        let persisted = try XCTUnwrap(
            try service.registry.load().tasks.first(where: { $0.id == record.id })?.lastSession
        )
        XCTAssertEqual(persisted.outcome, .active)
        XCTAssertNil(persisted.endedAt)
    }

    @MainActor
    func testMappedWorkspaceSymlinkSwapPreventsAgentLaunch() async throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }
        let service = WorktreeService(repositoryURL: fixture.repositoryURL)
        let record = try service.provision(
            WorktreeProvisioningRequest(slug: "launch-symlink", brief: "reject stale cwd")
        )
        var launchCount = 0
        let manager = TerminalSessionManager { taskID, generation, specification in
            launchCount += 1
            let driver = WorkspaceStopTerminalDriver(pid: 7_200)
            return TerminalSession(
                taskID: taskID,
                generation: generation,
                specification: specification,
                terminalDriver: driver,
                processGroupResolver: WorkspaceStopGroupResolver(group: driver.processIdentifier),
                clock: WorkspaceStopClock()
            )
        }
        let store = WorkspaceStore(
            repositoryURL: fixture.repositoryURL,
            terminalSessions: manager
        )
        store.select(try XCTUnwrap(store.tasks.first(where: { $0.slug == record.slug })))

        let mapped = URL(fileURLWithPath: record.worktreePath, isDirectory: true)
        let held = mapped.deletingLastPathComponent()
            .appendingPathComponent("launch-symlink-held", isDirectory: true)
        try FileManager.default.moveItem(at: mapped, to: held)
        try FileManager.default.createSymbolicLink(
            atPath: mapped.path,
            withDestinationPath: held.path
        )

        store.startSelectedSession()
        try await waitUntilSessionAttemptFinishes(store)

        XCTAssertEqual(launchCount, 0)
        XCTAssertNil(store.selectedSession)
        XCTAssertEqual(store.selectedTask?.health, .conflicted)
        XCTAssertNil(store.selectedTask?.document)
        XCTAssertTrue(store.errorMessage?.contains("명령을 실행하지 않았습니다") == true)
    }

    @MainActor
    func testLegacySymlinkedStateIsRejectedBeforePassRecheckDone() async throws {
        let scenarios: [(StateSymlinkComponent, MutationAction)] = [
            (.gdmDirectory, .pass),
            (.slugDirectory, .recheck),
            (.checksFile, .done)
        ]

        for (component, action) in scenarios {
            let fixture = try GitFixture.make()
            defer { fixture.remove() }
            let slug = "legacy-\(component.rawValue)"
            let plan = CommandRunner.run(
                executable: fixture.gdmURL.path,
                arguments: ["plan", "init", "--slug", slug],
                directory: fixture.repositoryURL
            )
            XCTAssertEqual(plan.exitCode, 0, plan.output)
            if action != .pass {
                let pass = CommandRunner.run(
                    executable: fixture.gdmURL.path,
                    arguments: ["pass", "c1", "--slug", slug],
                    directory: fixture.repositoryURL
                )
                XCTAssertEqual(pass.exitCode, 0, pass.output)
            }

            let recorder = MutationCallRecorder(result: CommandResult(exitCode: 0, output: "unexpected"))
            let store = WorkspaceStore(
                repositoryURL: fixture.repositoryURL,
                commandRunner: recorder.runner
            )
            XCTAssertEqual(store.selectedTask?.slug, slug)
            try replaceStateComponentWithSymlink(
                component,
                slug: slug,
                worktreeURL: fixture.repositoryURL,
                sandboxURL: fixture.sandboxURL
            )

            switch action {
            case .pass, .recheck:
                store.runVerification()
            case .done:
                store.completeSelectedTask()
            }
            try await waitUntilCommandFinishes(store)

            XCTAssertEqual(
                recorder.calls.count,
                0,
                "legacy \(action.rawValue) must not run after \(component.rawValue) becomes a symlink"
            )
            XCTAssertEqual(store.selectedTask?.health, .conflicted)
            XCTAssertNil(store.selectedTask?.document)
            XCTAssertTrue(store.errorMessage?.contains("명령을 실행하지 않았습니다") == true)
            if case .some(.legacyRoot(_)) = store.selectedTask?.location {
                // The task remains explicitly legacy; it is not remapped or silently dropped.
            } else {
                XCTFail("unsafe legacy task changed location")
            }
        }
    }

    @MainActor
    func testNonzeroPassRecheckDoneErrorsSurviveRefresh() async throws {
        for action in [MutationAction.pass, .recheck, .done] {
            let fixture = try GitFixture.make()
            defer { fixture.remove() }
            let slug = "nonzero-\(action.rawValue)"
            let service = WorktreeService(repositoryURL: fixture.repositoryURL)
            let record = try service.provision(
                WorktreeProvisioningRequest(slug: slug, brief: "preserve command error")
            )
            if action != .pass {
                let pass = CommandRunner.run(
                    executable: fixture.gdmURL.path,
                    arguments: ["pass", "c1", "--slug", slug],
                    directory: URL(fileURLWithPath: record.worktreePath, isDirectory: true)
                )
                XCTAssertEqual(pass.exitCode, 0, pass.output)
            }

            let recorder = MutationCallRecorder(
                result: CommandResult(exitCode: 19, output: "deterministic fixture failure")
            )
            let store = WorkspaceStore(
                repositoryURL: fixture.repositoryURL,
                commandRunner: recorder.runner
            )
            store.select(try XCTUnwrap(store.tasks.first(where: { $0.slug == slug })))

            switch action {
            case .pass, .recheck:
                store.runVerification()
            case .done:
                store.completeSelectedTask()
            }
            try await waitUntilCommandFinishes(store)

            XCTAssertEqual(recorder.calls.count, 1)
            XCTAssertTrue(
                store.errorMessage?.contains(slug) == true,
                "\(action.rawValue) error was erased by refresh: \(store.errorMessage ?? "nil")"
            )
            switch action {
            case .pass:
                XCTAssertTrue(store.errorMessage?.contains("c1") == true)
            case .recheck:
                XCTAssertTrue(store.errorMessage?.contains("재검증") == true)
            case .done:
                XCTAssertTrue(store.errorMessage?.contains("완료") == true)
            }
        }
    }

    @MainActor
    func testSymlinkedStateComponentsAreRejectedForLoadAndBeforePassRecheckDone() async throws {
        let scenarios: [(StateSymlinkComponent, MutationAction)] = [
            (.gdmDirectory, .pass),
            (.slugDirectory, .recheck),
            (.checksFile, .done)
        ]

        for (component, action) in scenarios {
            let fixture = try GitFixture.make()
            defer { fixture.remove() }
            let service = WorktreeService(repositoryURL: fixture.repositoryURL)
            let slug = "symlink-\(component.rawValue)"
            let record = try service.provision(
                WorktreeProvisioningRequest(slug: slug, brief: "reject symlink state")
            )
            let worktreeURL = URL(fileURLWithPath: record.worktreePath, isDirectory: true)
            if action != .pass {
                let pass = CommandRunner.run(
                    executable: fixture.gdmURL.path,
                    arguments: ["pass", "c1", "--slug", slug],
                    directory: worktreeURL
                )
                XCTAssertEqual(pass.exitCode, 0, pass.output)
            }

            let recorder = MutationCallRecorder(result: CommandResult(exitCode: 0, output: "unexpected"))
            let store = WorkspaceStore(
                repositoryURL: fixture.repositoryURL,
                commandRunner: recorder.runner
            )
            let cachedTask = try XCTUnwrap(store.tasks.first(where: { $0.slug == slug }))
            store.select(cachedTask)
            try replaceStateComponentWithSymlink(
                component,
                slug: slug,
                worktreeURL: worktreeURL,
                sandboxURL: fixture.sandboxURL
            )

            XCTAssertThrowsError(try RepositoryLoader.loadWork(slug: slug, from: worktreeURL)) {
                guard let pathError = $0 as? WorkspaceStatePathValidationError else {
                    return XCTFail("\(component.rawValue) followed instead of rejected: \($0)")
                }
                XCTAssertTrue(pathError.isUnsafeType)
            }
            let loaded = try RepositoryLoader.loadTasks(
                from: fixture.repositoryURL,
                registry: service.registry.load()
            )
            let refused = try XCTUnwrap(loaded.tasks.first(where: { $0.slug == slug }))
            XCTAssertNil(refused.document)
            XCTAssertEqual(refused.health, .conflicted)

            switch action {
            case .pass, .recheck:
                store.runVerification()
            case .done:
                store.completeSelectedTask()
            }
            try await waitUntilCommandFinishes(store)

            XCTAssertEqual(
                recorder.calls.count,
                0,
                "\(action.rawValue) must not launch after \(component.rawValue) fails lstat validation"
            )
            XCTAssertEqual(store.selectedTask?.health, .conflicted)
            XCTAssertNil(store.selectedTask?.document)
            XCTAssertTrue(store.errorMessage?.contains("명령을 실행하지 않았습니다") == true)
            XCTAssertTrue(store.journalText.contains("안전하지 않아"))
        }
    }

    func testPlanInitDoesNotRunWhenStatePathBecomesSymlinkAfterGitCreation() throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }
        let sabotagingRunner = ProvisionStateSabotagingRunner(sandboxURL: fixture.sandboxURL)
        let service = WorktreeService(
            repositoryURL: fixture.repositoryURL,
            runner: sabotagingRunner.runner
        )

        XCTAssertThrowsError(
            try service.provision(
                WorktreeProvisioningRequest(slug: "pre-plan-link", brief: "validate before plan init")
            )
        ) { error in
            guard let pathError = error as? WorkspaceStatePathValidationError else {
                return XCTFail("unexpected pre-plan validation error: \(error)")
            }
            XCTAssertTrue(pathError.isUnsafeType)
        }

        XCTAssertEqual(sabotagingRunner.gdmCallCount, 0)
        let record = try XCTUnwrap(try service.registry.load().tasks.first)
        XCTAssertEqual(record.phase, .failed)
        XCTAssertTrue(FileManager.default.fileExists(atPath: record.worktreePath))
        XCTAssertTrue(
            WorkspaceRegistry.pathExistsIncludingDanglingSymlink(
                URL(fileURLWithPath: record.worktreePath).appendingPathComponent(".gdm").path
            )
        )
    }

    @MainActor
    func testVerificationStateStaysScopedToOriginTaskAcrossSelectionChanges() async throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }
        let service = WorktreeService(repositoryURL: fixture.repositoryURL)
        _ = try service.provision(
            WorktreeProvisioningRequest(slug: "scope-task-a", brief: "task A")
        )
        _ = try service.provision(
            WorktreeProvisioningRequest(slug: "scope-task-b", brief: "task B")
        )
        let blocker = BlockingMutationRunner()
        let store = WorkspaceStore(
            repositoryURL: fixture.repositoryURL,
            commandRunner: blocker.runner
        )
        let taskA = try XCTUnwrap(store.tasks.first(where: { $0.slug == "scope-task-a" }))
        let taskB = try XCTUnwrap(store.tasks.first(where: { $0.slug == "scope-task-b" }))
        let checkB = try XCTUnwrap(taskB.document?.checks.first)

        store.select(taskA)
        store.runVerification()
        try await blocker.waitUntilCalled()
        XCTAssertEqual(store.activeCheckID, "c1")
        XCTAssertEqual(store.displayState(for: taskA), .verifying)

        store.select(taskB)
        XCTAssertNil(store.activeCheckID, "task B must not inherit task A's active c1")
        XCTAssertTrue(store.failedCheckIDs.isEmpty)
        XCTAssertEqual(store.displayState(for: checkB), .open)
        XCTAssertNotEqual(store.displayState(for: taskB), .verifying)
        XCTAssertEqual(store.displayState(for: taskA), .verifying)

        blocker.release()
        try await waitUntilCommandFinishes(store)
        XCTAssertEqual(blocker.calls.count, 1)
        XCTAssertTrue(store.failedCheckIDs.isEmpty, "task B must not inherit task A's failed c1")
        XCTAssertEqual(store.displayState(for: checkB), .open)
        XCTAssertNotEqual(store.displayState(for: taskB), .blocked)

        store.select(try XCTUnwrap(store.tasks.first(where: { $0.slug == "scope-task-a" })))
        XCTAssertEqual(store.failedCheckIDs, ["c1"])
        XCTAssertEqual(
            store.displayState(for: try XCTUnwrap(store.selectedWork?.checks.first)),
            .failed
        )
        XCTAssertEqual(store.displayState(for: try XCTUnwrap(store.selectedTask)), .blocked)
    }

    @MainActor
    func testSelectedAgentSurvivesTaskSwitchWithoutARefresh() throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }
        try write(
            work: makeWork(slug: "legacy-agent", createdAt: "2026-08-07T00:00:00.000Z"),
            to: fixture.repositoryURL
        )
        let service = WorktreeService(repositoryURL: fixture.repositoryURL)
        _ = try service.provision(
            WorktreeProvisioningRequest(slug: "mapped-agent", brief: "persist selected agent")
        )
        let store = WorkspaceStore(repositoryURL: fixture.repositoryURL)
        let mapped = try XCTUnwrap(store.tasks.first(where: { $0.slug == "mapped-agent" }))
        let legacy = try XCTUnwrap(store.tasks.first(where: { $0.slug == "legacy-agent" }))

        store.select(mapped)
        store.chooseAgent(.claude)
        store.select(legacy)
        XCTAssertEqual(store.selectedAgent, .shell)
        store.select(try XCTUnwrap(store.tasks.first(where: { $0.slug == "mapped-agent" })))

        XCTAssertEqual(store.selectedAgent, .claude)
        XCTAssertEqual(try service.registry.load().tasks.first?.selectedAgent, AgentKind.claude.rawValue)
    }

    @MainActor
    func testLegacyLiveAgentSurvivesTaskSwitchAndRefreshInCurrentProcess() async throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }
        try write(
            work: makeWork(slug: "legacy-live-agent", createdAt: "2026-08-07T00:00:00.000Z"),
            to: fixture.repositoryURL
        )
        let service = WorktreeService(repositoryURL: fixture.repositoryURL)
        _ = try service.provision(
            WorktreeProvisioningRequest(slug: "mapped-selector", brief: "switch target")
        )

        let bin = fixture.sandboxURL.appendingPathComponent("agent-bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let claude = bin.appendingPathComponent("claude", isDirectory: false)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: claude)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: claude.path)
        let catalog = AgentCatalog(
            environment: ["SHELL": "/bin/zsh"],
            searchDirectories: [bin],
            homeDirectory: fixture.sandboxURL
        )
        let driver = WorkspaceStopTerminalDriver(pid: 7_300)
        let manager = TerminalSessionManager { taskID, generation, specification in
            TerminalSession(
                taskID: taskID,
                generation: generation,
                specification: specification,
                terminalDriver: driver,
                processGroupResolver: WorkspaceStopGroupResolver(group: driver.processIdentifier),
                clock: WorkspaceStopClock()
            )
        }
        let store = WorkspaceStore(
            repositoryURL: fixture.repositoryURL,
            terminalSessions: manager,
            agentCatalog: catalog
        )
        let legacy = try XCTUnwrap(store.tasks.first(where: { $0.slug == "legacy-live-agent" }))
        let mapped = try XCTUnwrap(store.tasks.first(where: { $0.slug == "mapped-selector" }))

        store.select(legacy)
        store.chooseAgent(.claude)
        store.startSelectedSession()
        try await waitUntilSessionLaunches(store)
        XCTAssertEqual(store.selectedSession?.specification.agent, .claude)

        store.select(mapped)
        store.select(try XCTUnwrap(store.tasks.first(where: { $0.slug == "legacy-live-agent" })))
        XCTAssertEqual(store.selectedAgent, .claude)

        store.refresh()
        XCTAssertEqual(store.selectedTask?.slug, "legacy-live-agent")
        XCTAssertEqual(store.selectedAgent, .claude)
        XCTAssertEqual(store.selectedSession?.specification.agent, .claude)
        let activity = try XCTUnwrap(
            store.agentActivityItems.first(where: { $0.taskID == store.selectedTask?.id })
        )
        XCTAssertEqual(activity.agent, .claude)
        XCTAssertEqual(activity.state, .active)
    }

    func testProvisionAndProofCommandsKeepAllGDMStateInsideMappedWorktree() throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }

        let service = WorktreeService(repositoryURL: fixture.repositoryURL)
        let record = try service.provision(
            WorktreeProvisioningRequest(
                slug: "proof-loop",
                brief: "prove worktree-local GDM state",
                required: ["keep state local"],
                forbidden: ["root fallback"],
                selectedAgent: "codex"
            )
        )

        XCTAssertEqual(record.phase, .ready)
        XCTAssertEqual(record.branch, "refs/heads/gdm/proof-loop")
        XCTAssertTrue((record.worktreePath as NSString).isAbsolutePath)

        let worktreeURL = URL(fileURLWithPath: record.worktreePath, isDirectory: true)
        let invocation = CommandInvocation(executable: fixture.gdmURL.path, prefixArguments: [])
        let pass = CommandRunner.run(
            executable: invocation.executable,
            arguments: ["pass", "c1", "--slug", "proof-loop"],
            directory: worktreeURL
        )
        XCTAssertEqual(pass.exitCode, 0, pass.output)
        let done = CommandRunner.run(
            executable: invocation.executable,
            arguments: ["done", "--slug", "proof-loop"],
            directory: worktreeURL
        )
        XCTAssertEqual(done.exitCode, 0, done.output)

        let localState = worktreeURL.appendingPathComponent(".gdm/proof-loop", isDirectory: true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: localState.appendingPathComponent("checks.json").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: localState.appendingPathComponent("out/c1.txt").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: localState.appendingPathComponent("done.marker").path))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: fixture.repositoryURL.appendingPathComponent(".gdm/proof-loop/checks.json").path
            ),
            "mapped GDM state must never be copied or redirected to root"
        )

        let cwdLog = try String(
            contentsOf: localState.appendingPathComponent("cwd.log"),
            encoding: .utf8
        )
        let loggedDirectories = cwdLog.split(separator: "\n").map {
            URL(fileURLWithPath: String($0.split(separator: "|", maxSplits: 1)[0]))
                .resolvingSymlinksInPath()
                .standardizedFileURL
                .path
        }
        let expectedDirectory = worktreeURL.resolvingSymlinksInPath().standardizedFileURL.path
        XCTAssertEqual(loggedDirectories, Array(repeating: expectedDirectory, count: 3))

        let completed = try RepositoryLoader.loadWork(slug: "proof-loop", from: worktreeURL)
        XCTAssertTrue(completed.done)
        XCTAssertEqual(completed.checks.map(\.status), ["proven"])

        let persistedJSON = try String(
            contentsOf: WorkspaceRegistry(repositoryURL: fixture.repositoryURL).registryURL,
            encoding: .utf8
        )
        for forbiddenKey in ["\"pid\"", "\"pgid\"", "\"environment\"", "\"transcript\""] {
            XCTAssertFalse(persistedJSON.contains(forbiddenKey), "registry persisted forbidden key \(forbiddenKey)")
        }
    }

    func testProvisioningProgressUsesOnlyVerifiedServiceBoundaries() throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }
        let recorder = ProvisioningProgressRecorder()

        let record = try WorktreeService(repositoryURL: fixture.repositoryURL).provision(
            WorktreeProvisioningRequest(
                slug: "truthful-progress",
                brief: "emit real provisioning boundaries"
            ),
            onProgress: { recorder.append($0) }
        )

        XCTAssertEqual(record.phase, .ready)
        XCTAssertEqual(recorder.steps, [.worktree, .gdmContract, .ready])
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: URL(fileURLWithPath: record.worktreePath)
                    .appendingPathComponent(".gdm/truthful-progress/checks.json")
                    .path
            ),
            "ready must be emitted only after the GDM contract exists"
        )
    }

    func testRootLegacyAndMappedTasksAggregateWithoutSharingState() throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }

        let legacy = makeWork(slug: "legacy-root", createdAt: "2026-08-07T00:00:00.000Z")
        try write(work: legacy, to: fixture.repositoryURL)

        let service = WorktreeService(repositoryURL: fixture.repositoryURL)
        let record = try service.provision(
            WorktreeProvisioningRequest(slug: "mapped-task", brief: "mapped task")
        )
        let registry = try service.registry.load()
        let loaded = try RepositoryLoader.loadTasks(from: fixture.repositoryURL, registry: registry)

        XCTAssertEqual(Set(loaded.tasks.map(\.slug)), ["legacy-root", "mapped-task"])
        XCTAssertTrue(loaded.warnings.isEmpty, loaded.warnings.joined(separator: "\n"))

        let legacyTask = try XCTUnwrap(loaded.tasks.first(where: { $0.slug == "legacy-root" }))
        guard case .legacyRoot(let legacyRoot) = legacyTask.location else {
            return XCTFail("legacy task must remain rooted at the repository")
        }
        XCTAssertEqual(legacyRoot.standardizedFileURL, fixture.repositoryURL.standardizedFileURL)

        let mappedTask = try XCTUnwrap(loaded.tasks.first(where: { $0.slug == "mapped-task" }))
        guard case .worktree(let loadedRecord, let verifiedURL) = mappedTask.location else {
            return XCTFail("mapped task must retain its worktree location")
        }
        XCTAssertEqual(loadedRecord.id, record.id)
        XCTAssertEqual(verifiedURL.standardizedFileURL.path, record.worktreePath)
        XCTAssertEqual(mappedTask.health, .ready)
    }

    func testTraversalLegacyBranchAndDanglingPathCollisionsFailBeforeGitMutation() throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }
        let service = WorktreeService(repositoryURL: fixture.repositoryURL)

        XCTAssertThrowsError(
            try service.provision(
                WorktreeProvisioningRequest(slug: "../escape", brief: "invalid traversal")
            )
        ) { error in
            guard case WorktreeServiceError.invalidSlug = error else {
                return XCTFail("unexpected traversal error: \(error)")
            }
        }
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: fixture.sandboxURL.appendingPathComponent("escape").path)
        )

        try write(
            work: makeWork(slug: "legacy-clash", createdAt: "2026-08-07T00:00:00.000Z"),
            to: fixture.repositoryURL
        )
        XCTAssertThrowsError(
            try service.provision(
                WorktreeProvisioningRequest(slug: "legacy-clash", brief: "must not merge")
            )
        ) { error in
            guard case WorktreeServiceError.legacyCollision = error else {
                return XCTFail("unexpected legacy collision error: \(error)")
            }
        }

        try fixture.git(["branch", "gdm/branch-clash"])
        XCTAssertThrowsError(
            try service.provision(
                WorktreeProvisioningRequest(slug: "branch-clash", brief: "must not reuse")
            )
        ) { error in
            guard case WorktreeServiceError.branchCollision = error else {
                return XCTFail("unexpected branch collision error: \(error)")
            }
        }

        let danglingDestination = service.destinationURL(for: "dangling-path")
        try FileManager.default.createDirectory(
            at: danglingDestination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createSymbolicLink(
            atPath: danglingDestination.path,
            withDestinationPath: fixture.sandboxURL.appendingPathComponent("does-not-exist").path
        )
        XCTAssertThrowsError(
            try service.provision(
                WorktreeProvisioningRequest(slug: "dangling-path", brief: "must not follow symlink")
            )
        ) { error in
            guard case WorktreeServiceError.destinationCollision = error else {
                return XCTFail("unexpected dangling path error: \(error)")
            }
        }
        XCTAssertTrue(WorkspaceRegistry.pathExistsIncludingDanglingSymlink(danglingDestination.path))

        let registry = try service.registry.load()
        XCTAssertTrue(registry.tasks.isEmpty, "preflight failures must not leave creating reservations")
    }

    func testDuplicateReservationIsRejectedAndOriginalReadyWorktreeIsUntouched() throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }
        let service = WorktreeService(repositoryURL: fixture.repositoryURL)
        let original = try service.provision(
            WorktreeProvisioningRequest(slug: "duplicate-task", brief: "first")
        )

        XCTAssertThrowsError(
            try service.provision(
                WorktreeProvisioningRequest(slug: "duplicate-task", brief: "second")
            )
        ) { error in
            guard case WorktreeServiceError.registryCollision = error else {
                return XCTFail("unexpected duplicate error: \(error)")
            }
        }

        let registry = try service.registry.load()
        XCTAssertEqual(registry.tasks.count, 1)
        XCTAssertEqual(registry.tasks.first?.id, original.id)
        XCTAssertEqual(registry.tasks.first?.phase, .ready)
        XCTAssertTrue(FileManager.default.fileExists(atPath: original.worktreePath))
    }

    func testFailedPlanInitPreservesWorktreeBranchPartialStateAndFailedRecord() throws {
        let fixture = try GitFixture.make(gdmMode: .failPlan)
        defer { fixture.remove() }
        let service = WorktreeService(repositoryURL: fixture.repositoryURL)

        XCTAssertThrowsError(
            try service.provision(
                WorktreeProvisioningRequest(slug: "partial-task", brief: "fixture failure")
            )
        ) { error in
            guard case WorktreeServiceError.commandFailed(let command, let exitCode, _) = error else {
                return XCTFail("unexpected provisioning error: \(error)")
            }
            XCTAssertEqual(command, "gdm plan init")
            XCTAssertEqual(exitCode, 42)
        }

        let registry = try service.registry.load()
        let record = try XCTUnwrap(registry.tasks.first)
        XCTAssertEqual(record.phase, .failed)
        XCTAssertEqual(record.lastError, "gdm plan init failed (exit 42)")
        XCTAssertTrue(FileManager.default.fileExists(atPath: record.worktreePath))
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: URL(fileURLWithPath: record.worktreePath)
                    .appendingPathComponent(".gdm/partial-task/partial.txt").path
            )
        )
        let branch = try fixture.gitOutput(["show-ref", "--verify", record.branch])
        XCTAssertFalse(branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    func testRecoveryPromotesCompleteCreatingRecordButMissingMappingNeverFallsBackToRoot() throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }
        let service = WorktreeService(repositoryURL: fixture.repositoryURL)
        let ready = try service.provision(
            WorktreeProvisioningRequest(slug: "recover-task", brief: "recover fixture")
        )

        _ = try service.registry.update { document in
            let index = try XCTUnwrap(document.tasks.firstIndex(where: { $0.id == ready.id }))
            document.tasks[index].phase = .creating
            document.tasks[index].lastError = "simulated crash"
        }
        let recovery = try service.recoverProvisioning()
        XCTAssertEqual(recovery.count, 1)
        XCTAssertTrue(try XCTUnwrap(recovery.first).promotedToReady)
        XCTAssertEqual(try service.registry.load().tasks.first?.phase, .ready)

        let originalWorktree = URL(fileURLWithPath: ready.worktreePath, isDirectory: true)
        let heldWorktree = originalWorktree.deletingLastPathComponent()
            .appendingPathComponent("recover-task-held", isDirectory: true)
        try FileManager.default.moveItem(at: originalWorktree, to: heldWorktree)
        try write(
            work: makeWork(slug: "recover-task", createdAt: "2026-08-07T00:00:00.000Z"),
            to: fixture.repositoryURL
        )

        let missing = service.inspect(try XCTUnwrap(try service.registry.load().tasks.first))
        XCTAssertEqual(missing.health, .disconnected)
        XCTAssertNil(missing.document, "a missing mapped worktree must not read the root legacy document")
    }

    func testRegistryAtomicallyRecoversActiveSessionWithoutPersistingProcessState() throws {
        let fixture = try GitFixture.make()
        defer { fixture.remove() }
        let registry = WorkspaceRegistry(repositoryURL: fixture.repositoryURL)
        let id = UUID()
        let record = WorkspaceRegistryRecord(
            id: id,
            slug: "session-task",
            worktreePath: fixture.sandboxURL.appendingPathComponent("session-worktree").path,
            branch: "refs/heads/gdm/session-task",
            baseOID: String(repeating: "a", count: 40),
            gitCommonDirectory: fixture.repositoryURL.appendingPathComponent(".git").path,
            phase: .creating,
            selectedAgent: "codex",
            lastSession: PersistedSessionRecord(
                kind: "codex",
                startedAt: "2026-08-07T00:00:00.000Z",
                endedAt: nil,
                outcome: .active
            ),
            lastError: nil,
            createdAt: "2026-08-07T00:00:00.000Z"
        )
        try registry.reserve(record)

        let recovered = try registry.recoverInterruptedSessions(
            at: Date(timeIntervalSince1970: 1_786_060_800)
        )
        XCTAssertEqual(recovered.tasks.first?.lastSession?.outcome, .interrupted)
        XCTAssertNil(recovered.tasks.first?.lastSession?.endedAt)

        let raw = try String(contentsOf: registry.registryURL, encoding: .utf8)
        for forbiddenKey in ["\"pid\"", "\"pgid\"", "\"environment\"", "\"transcript\""] {
            XCTAssertFalse(raw.contains(forbiddenKey))
        }
        let temporaryFiles = try FileManager.default.contentsOfDirectory(
            atPath: registry.registryDirectoryURL.path
        ).filter { $0.hasPrefix(".workspace.json.tmp.") }
        XCTAssertTrue(temporaryFiles.isEmpty, "atomic persistence must not leave temporary files")
    }
}

private extension WorktreeProofLoopIntegrationTests {
    enum StateSymlinkComponent: String {
        case gdmDirectory = "gdm"
        case slugDirectory = "slug"
        case checksFile = "checks"
    }

    enum MutationAction: String {
        case pass
        case recheck
        case done
    }

    @MainActor
    func waitUntilCommandFinishes(_ store: WorkspaceStore) async throws {
        for _ in 0..<500 {
            if !store.isCommandRunning { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw NSError(
            domain: "GDMNative.WorktreeTests.Timeout",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "WorkspaceStore command did not finish"]
        )
    }

    @MainActor
    func waitUntilSessionLaunches(_ store: WorkspaceStore) async throws {
        for _ in 0..<500 {
            if store.selectedSession != nil { return }
            if store.errorMessage != nil { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw NSError(
            domain: "GDMNative.WorktreeTests.Timeout",
            code: 3,
            userInfo: [NSLocalizedDescriptionKey: store.errorMessage ?? "Agent session did not launch"]
        )
    }

    @MainActor
    func waitUntilSessionAttemptFinishes(_ store: WorkspaceStore) async throws {
        for _ in 0..<500 {
            if store.selectedSession != nil || store.errorMessage != nil { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw NSError(
            domain: "GDMNative.WorktreeTests.Timeout",
            code: 4,
            userInfo: [NSLocalizedDescriptionKey: "Agent session attempt did not finish"]
        )
    }

    func replaceStateComponentWithSymlink(
        _ component: StateSymlinkComponent,
        slug: String,
        worktreeURL: URL,
        sandboxURL: URL
    ) throws {
        let source: URL
        switch component {
        case .gdmDirectory:
            source = worktreeURL.appendingPathComponent(".gdm", isDirectory: true)
        case .slugDirectory:
            source = worktreeURL.appendingPathComponent(".gdm/\(slug)", isDirectory: true)
        case .checksFile:
            source = worktreeURL.appendingPathComponent(".gdm/\(slug)/checks.json", isDirectory: false)
        }
        let target = sandboxURL.appendingPathComponent(
            "held-\(slug)-\(component.rawValue)",
            isDirectory: component != .checksFile
        )
        try FileManager.default.moveItem(at: source, to: target)
        try FileManager.default.createSymbolicLink(
            atPath: source.path,
            withDestinationPath: target.path
        )
    }

    func makeWork(slug: String, createdAt: String) -> WorkDocument {
        WorkDocument(
            slug: slug,
            brief: "fixture",
            createdAt: createdAt,
            done: false,
            doneAt: nil,
            auditRequired: false,
            audit: nil,
            delivery: nil,
            checks: [],
            contract: WorkContractRecord(
                required: [],
                forbidden: [],
                commit: "forbidden",
                risk: "low",
                verification: "deterministic"
            )
        )
    }

    func write(work: WorkDocument, to workspaceURL: URL) throws {
        let directory = workspaceURL.appendingPathComponent(".gdm/\(work.slug)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var data = try JSONEncoder().encode(work)
        data.append(0x0A)
        try data.write(to: directory.appendingPathComponent("checks.json"))
    }
}

private struct RecordedMutationCall: Equatable, Sendable {
    let executable: String
    let arguments: [String]
    let directory: String
}

private final class MutationCallRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedCalls: [RecordedMutationCall] = []
    private let result: CommandResult

    init(result: CommandResult) {
        self.result = result
    }

    var calls: [RecordedMutationCall] {
        lock.withLock { recordedCalls }
    }

    var runner: WorktreeCommandRunner {
        WorktreeCommandRunner { [self] executable, arguments, directory, _ in
            lock.withLock {
                recordedCalls.append(
                    RecordedMutationCall(
                        executable: executable,
                        arguments: arguments,
                        directory: directory.path
                    )
                )
            }
            return result
        }
    }
}

private final class ProvisioningProgressRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedSteps: [WorktreeProvisioningStep] = []

    var steps: [WorktreeProvisioningStep] {
        lock.withLock { recordedSteps }
    }

    func append(_ step: WorktreeProvisioningStep) {
        lock.withLock { recordedSteps.append(step) }
    }
}

private final class BlockingMutationRunner: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedCalls: [RecordedMutationCall] = []
    private let releaseSemaphore = DispatchSemaphore(value: 0)

    var calls: [RecordedMutationCall] {
        lock.withLock { recordedCalls }
    }

    var runner: WorktreeCommandRunner {
        WorktreeCommandRunner { [self] executable, arguments, directory, _ in
            lock.withLock {
                recordedCalls.append(
                    RecordedMutationCall(
                        executable: executable,
                        arguments: arguments,
                        directory: directory.path
                    )
                )
            }
            releaseSemaphore.wait()
            return CommandResult(exitCode: 1, output: "fixture verification failure")
        }
    }

    func waitUntilCalled() async throws {
        for _ in 0..<500 {
            if !calls.isEmpty { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw NSError(
            domain: "GDMNative.WorktreeTests.Timeout",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "mutation runner was not called"]
        )
    }

    func release() {
        releaseSemaphore.signal()
    }
}

@MainActor
private final class WorkspaceStopTerminalDriver: TerminalDriving {
    let hostedView = NSView(frame: .zero)
    let processIdentifier: pid_t
    var isRunning = false
    var onProcessTerminated: ((Int32?) -> Void)?

    init(pid: pid_t) {
        processIdentifier = pid
    }

    func start(_ specification: AgentLaunchSpecification) {
        isRunning = true
    }

    func terminate() {
        isRunning = false
    }

    func send(_ bytes: [UInt8]) {}
    func resize(to size: NSSize) {}
}

private actor WorkspaceStopReaper: ChildReaping {
    private var results: [ChildWaitResult]

    init(results: [ChildWaitResult]) {
        self.results = results
    }

    func poll(processIdentifier: pid_t) async -> ChildWaitResult {
        guard !results.isEmpty else { return .stillRunning }
        return results.removeFirst()
    }
}

private struct WorkspaceStopSignaler: ProcessSignaling {
    func sendToProcessGroup(_ processGroup: pid_t, signal: Int32) -> POSIXSignalResult {
        .success
    }

    func sendToProcess(_ processIdentifier: pid_t, signal: Int32) -> POSIXSignalResult {
        .success
    }
}

private struct WorkspaceStopGroupResolver: ProcessGroupResolving {
    let group: pid_t

    func processGroupIdentifier(for processIdentifier: pid_t) -> pid_t? {
        group
    }
}

private struct WorkspaceStopClock: StopClock {
    func nowNanoseconds() -> UInt64 { 0 }
    func sleep(nanoseconds: UInt64) async { await Task.yield() }
}

private final class ProvisionStateSabotagingRunner: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedGDMCallCount = 0
    private let sandboxURL: URL
    private let live = WorktreeCommandRunner.live

    init(sandboxURL: URL) {
        self.sandboxURL = sandboxURL
    }

    var gdmCallCount: Int {
        lock.withLock { recordedGDMCallCount }
    }

    var runner: WorktreeCommandRunner {
        WorktreeCommandRunner { [self] executable, arguments, directory, environment in
            if executable == "/usr/bin/git" {
                let result = live.run(
                    executable: executable,
                    arguments: arguments,
                    directory: directory,
                    environment: environment
                )
                if result.exitCode == 0,
                   arguments.starts(with: ["worktree", "add"]),
                   let separator = arguments.firstIndex(of: "--"),
                   arguments.indices.contains(separator + 1) {
                    let worktree = URL(
                        fileURLWithPath: arguments[separator + 1],
                        isDirectory: true
                    )
                    let target = sandboxURL.appendingPathComponent(
                        "pre-plan-external-state",
                        isDirectory: true
                    )
                    do {
                        try FileManager.default.createDirectory(
                            at: target,
                            withIntermediateDirectories: true
                        )
                        try FileManager.default.createSymbolicLink(
                            atPath: worktree.appendingPathComponent(".gdm").path,
                            withDestinationPath: target.path
                        )
                    } catch {
                        return CommandResult(
                            exitCode: 98,
                            output: "fixture sabotage failed: \(error.localizedDescription)"
                        )
                    }
                }
                return result
            }
            lock.withLock { recordedGDMCallCount += 1 }
            return live.run(
                executable: executable,
                arguments: arguments,
                directory: directory,
                environment: environment
            )
        }
    }
}

private struct GitFixture {
    enum GDMMode {
        case success
        case failPlan
    }

    let sandboxURL: URL
    let repositoryURL: URL
    let gdmURL: URL

    static func make(gdmMode: GDMMode = .success) throws -> GitFixture {
        let sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("GDMNativeWorktreeTests-\(UUID().uuidString)", isDirectory: true)
        let repository = sandbox.appendingPathComponent("fixture-repository", isDirectory: true)
        try FileManager.default.createDirectory(at: repository, withIntermediateDirectories: true)
        let fixture = GitFixture(
            sandboxURL: sandbox,
            repositoryURL: repository,
            gdmURL: repository.appendingPathComponent("cli/dist/gdm", isDirectory: false)
        )
        try fixture.git(["init"])
        try fixture.git(["config", "user.name", "GDM Native Tests"])
        try fixture.git(["config", "user.email", "gdm-native-tests@example.invalid"])
        try Data("fixture\n".utf8).write(to: repository.appendingPathComponent("README.md"))
        try fixture.git(["add", "README.md"])
        try fixture.git(["commit", "-m", "fixture base"])
        try fixture.git(["branch", "-M", "main"])
        try fixture.installGDM(mode: gdmMode)
        return fixture
    }

    func remove() {
        try? FileManager.default.removeItem(at: sandboxURL)
    }

    @discardableResult
    func git(_ arguments: [String]) throws -> CommandResult {
        let result = CommandRunner.run(
            executable: "/usr/bin/git",
            arguments: arguments,
            directory: repositoryURL
        )
        guard result.exitCode == 0 else {
            throw NSError(
                domain: "GDMNative.WorktreeTests.Git",
                code: Int(result.exitCode),
                userInfo: [NSLocalizedDescriptionKey: result.output]
            )
        }
        return result
    }

    func gitOutput(_ arguments: [String]) throws -> String {
        try git(arguments).output
    }

    private func installGDM(mode: GDMMode) throws {
        try FileManager.default.createDirectory(
            at: gdmURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let shouldFail = mode == .failPlan ? "yes" : "no"
        let script = #"""
        #!/bin/sh
        set -eu

        slug=""
        previous=""
        for argument in "$@"; do
          if [ "$previous" = "--slug" ]; then
            slug="$argument"
            break
          fi
          previous="$argument"
        done
        if [ -z "$slug" ]; then
          echo "missing --slug" >&2
          exit 64
        fi

        state_dir=".gdm/$slug"
        mkdir -p "$state_dir"
        printf '%s|%s %s\n' "$PWD" "${1:-}" "${2:-}" >> "$state_dir/cwd.log"

        write_checks() {
          status="$1"
          done_value="$2"
          evidence="null"
          if [ "$status" = "proven" ]; then
            evidence='{"observed":".gdm/'"$slug"'/out/c1.txt","sha256":"fixture","exitCode":0,"manual":false,"note":null,"reviewer":null,"at":"2026-08-07T00:00:01.000Z"}'
          fi
          cat > "$state_dir/checks.json" <<JSON
        {
          "slug": "$slug",
          "brief": "fixture work",
          "createdAt": "2026-08-07T00:00:00.000Z",
          "done": $done_value,
          "doneAt": null,
          "auditRequired": false,
          "audit": null,
          "delivery": null,
          "checks": [{
            "id": "c1",
            "desc": "fixture check",
            "cmd": "true",
            "expect": "exit 0",
            "manual": false,
            "kind": "behavior",
            "expert": false,
            "status": "$status",
            "redEvidence": null,
            "evidence": $evidence
          }],
          "contract": {
            "required": [],
            "forbidden": [],
            "commit": "forbidden",
            "risk": "low",
            "verification": "deterministic"
          }
        }
        JSON
        }

        case "${1:-} ${2:-}" in
          "plan init")
            if [ "__FAIL_PLAN__" = "yes" ]; then
              printf 'preserve me\n' > "$state_dir/partial.txt"
              echo "fixture plan failure" >&2
              exit 42
            fi
            write_checks open false
            ;;
          pass*)
            mkdir -p "$state_dir/out"
            printf 'proof from %s\n' "$PWD" > "$state_dir/out/c1.txt"
            write_checks proven false
            ;;
          done*)
            write_checks proven true
            printf 'done\n' > "$state_dir/done.marker"
            ;;
          *)
            echo "unsupported fixture command: $*" >&2
            exit 64
            ;;
        esac
        """#
            .replacingOccurrences(of: "__FAIL_PLAN__", with: shouldFail)
        try Data((script + "\n").utf8).write(to: gdmURL)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: gdmURL.path
        )
    }
}
