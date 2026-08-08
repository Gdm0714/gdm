import AppKit
import Darwin
import Foundation
import SwiftTerm
import XCTest
@testable import GDMNative

@MainActor
final class TerminalSessionIntegrationTests: XCTestCase {
    func testStopOrdersGroupTermBeforeTerminalTerminateAndWait() async throws {
        let recorder = EventRecorder()
        let driver = FakeTerminalDriver(pid: 4_200, recorder: recorder)
        let signaler = RecordingSignaler(recorder: recorder)
        let reaper = ScriptedChildReaper(results: [.reaped(rawStatus: 0)], recorder: recorder)
        let session = makeSession(driver: driver, signaler: signaler, reaper: reaper)
        session.start()
        recorder.reset()

        let result = await session.stop()

        XCTAssertEqual(result, .reaped(.exited(0)))
        XCTAssertEqual(recorder.snapshot(), [
            "group-signal:15:4200",
            "terminal-terminate",
            "waitpid:4200"
        ])
        XCTAssertEqual(driver.terminateCount, 1)

        let duplicateResult = await session.stop()
        XCTAssertEqual(duplicateResult, .alreadyEnded(.exited(0)))
        XCTAssertEqual(driver.terminateCount, 1, "Duplicate Stop must not call SwiftTerm terminate twice.")
    }

    func testLeaderGraceExitReapsWithoutPostReapGroupKill() async throws {
        let recorder = EventRecorder()
        let driver = FakeTerminalDriver(pid: 4_201, recorder: recorder)
        let signaler = RecordingSignaler(recorder: recorder)
        let reaper = ScriptedChildReaper(
            results: [.stillRunning, .reaped(rawStatus: 15)],
            recorder: recorder
        )
        let session = makeSession(
            driver: driver,
            signaler: signaler,
            reaper: reaper,
            clock: AdvancingStopClock(),
            policy: TerminalStopPolicy(
                gracePeriodNanoseconds: 10,
                pollIntervalNanoseconds: 1,
                postKillReapTimeoutNanoseconds: 10
            )
        )
        session.start()

        let result = await session.stop()

        XCTAssertEqual(result, .reaped(.signaled(15)))
        XCTAssertEqual(
            signaler.groupSignals.map(\.signal),
            [SIGTERM],
            "A reaped leader must never authorize a later signal to its former PGID."
        )
        XCTAssertTrue(signaler.processSignals.isEmpty)
    }

    func testLivePTYLeaderEscalatesToGroupKillExactlyOnce() async throws {
        let recorder = EventRecorder()
        let driver = FakeTerminalDriver(pid: 4_202, recorder: recorder)
        let signaler = RecordingSignaler(recorder: recorder)
        let reaper = ScriptedChildReaper(
            results: [.stillRunning, .reaped(rawStatus: SIGKILL)],
            recorder: recorder
        )
        let session = makeSession(
            driver: driver,
            signaler: signaler,
            reaper: reaper,
            clock: AdvancingStopClock(),
            policy: TerminalStopPolicy(
                gracePeriodNanoseconds: 0,
                pollIntervalNanoseconds: 1,
                postKillReapTimeoutNanoseconds: 10
            )
        )
        session.start()

        let result = await session.stop()

        XCTAssertEqual(result, .reaped(.signaled(SIGKILL)))
        XCTAssertEqual(signaler.groupSignals.map(\.signal), [SIGTERM, SIGKILL])
        XCTAssertTrue(signaler.processSignals.isEmpty)
        XCTAssertEqual(driver.terminateCount, 1)
    }

    func testFailedGroupKillUsesDirectChildOnlyAfterFreshWaitpidProof() async throws {
        let recorder = EventRecorder()
        let driver = FakeTerminalDriver(pid: 4_203, recorder: recorder)
        let signaler = RecordingSignaler(
            recorder: recorder,
            failingGroupSignals: [SIGKILL]
        )
        let reaper = ScriptedChildReaper(
            results: [.stillRunning, .stillRunning, .reaped(rawStatus: SIGKILL)],
            recorder: recorder
        )
        let session = makeSession(
            driver: driver,
            signaler: signaler,
            reaper: reaper,
            clock: AdvancingStopClock(),
            policy: TerminalStopPolicy(
                gracePeriodNanoseconds: 0,
                pollIntervalNanoseconds: 1,
                postKillReapTimeoutNanoseconds: 10
            )
        )
        session.start()
        recorder.reset()

        let result = await session.stop()
        XCTAssertEqual(result, .reaped(.signaled(SIGKILL)))
        XCTAssertEqual(recorder.snapshot(), [
            "group-signal:15:4203",
            "terminal-terminate",
            "waitpid:4203",
            "group-signal:9:4203",
            "waitpid:4203",
            "process-signal:9:4203",
            "waitpid:4203"
        ])
    }

    func testECHILDRetrySkipsWaitpidWhenReusedPIDWouldAppearStillRunning() async {
        await assertECHILDRetryIsTerminal(
            ignoredRetryResult: .stillRunning,
            processIdentifier: 4_204
        )
    }

    func testECHILDRetrySkipsWaitpidWhenReusedPIDWouldAppearReaped() async {
        await assertECHILDRetryIsTerminal(
            ignoredRetryResult: .reaped(rawStatus: 0),
            processIdentifier: 4_212
        )
    }

    private func assertECHILDRetryIsTerminal(
        ignoredRetryResult: ChildWaitResult,
        processIdentifier: pid_t
    ) async {
        let recorder = EventRecorder()
        let driver = FakeTerminalDriver(pid: processIdentifier, recorder: recorder)
        let signaler = RecordingSignaler(recorder: recorder)
        let reaper = ScriptedChildReaper(
            results: [.noChild, ignoredRetryResult],
            recorder: recorder
        )
        let session = makeSession(driver: driver, signaler: signaler, reaper: reaper)
        session.start()

        let firstResult = await session.stop()
        XCTAssertEqual(firstResult, .ownershipLost)
        XCTAssertEqual(signaler.groupSignals.map(\.signal), [SIGTERM])
        XCTAssertTrue(signaler.processSignals.isEmpty)
        XCTAssertEqual(driver.terminateCount, 1)
        XCTAssertEqual(session.state, .stopping)
        XCTAssertTrue(session.state.isActive)
        XCTAssertEqual(session.processIdentifier, processIdentifier)
        let initialPollCount = await reaper.pollCount()
        XCTAssertEqual(initialPollCount, 1)

        let retryResult = await session.stop()
        XCTAssertEqual(retryResult, .ownershipLost)
        XCTAssertEqual(signaler.groupSignals.map(\.signal), [SIGTERM])
        XCTAssertTrue(signaler.processSignals.isEmpty)
        XCTAssertEqual(driver.terminateCount, 1)
        XCTAssertEqual(session.state, .stopping)
        XCTAssertTrue(session.state.isActive)
        XCTAssertEqual(session.processIdentifier, processIdentifier)
        let retryPollCount = await reaper.pollCount()
        XCTAssertEqual(
            retryPollCount,
            1,
            "ECHILD retry must not call waitpid for a possibly reused PID."
        )
    }

    func testReapTimeoutRetryRecoversWithoutDuplicateSignalsOrTerminate() async throws {
        let recorder = EventRecorder()
        let driver = FakeTerminalDriver(pid: 4_211, recorder: recorder)
        let signaler = RecordingSignaler(recorder: recorder)
        let reaper = ScriptedChildReaper(
            results: [
                .stillRunning,
                .stillRunning,
                .reaped(rawStatus: SIGKILL)
            ],
            recorder: recorder
        )
        let session = makeSession(
            driver: driver,
            signaler: signaler,
            reaper: reaper,
            clock: AdvancingStopClock(),
            policy: TerminalStopPolicy(
                gracePeriodNanoseconds: 0,
                pollIntervalNanoseconds: 1,
                postKillReapTimeoutNanoseconds: 0
            )
        )
        session.start()

        let firstResult = await session.stop()

        XCTAssertEqual(firstResult, .reapTimedOut)
        XCTAssertEqual(session.state, .stopping)
        XCTAssertTrue(session.state.isActive)
        XCTAssertEqual(session.processIdentifier, 4_211)
        XCTAssertEqual(signaler.groupSignals.map(\.signal), [SIGTERM, SIGKILL])
        XCTAssertTrue(signaler.processSignals.isEmpty)
        XCTAssertEqual(driver.terminateCount, 1)

        let retryResult = await session.stop()

        XCTAssertEqual(retryResult, .reaped(.signaled(SIGKILL)))
        XCTAssertEqual(session.state, .ended(.signaled(SIGKILL)))
        XCTAssertFalse(session.state.isActive)
        XCTAssertEqual(signaler.groupSignals.map(\.signal), [SIGTERM, SIGKILL])
        XCTAssertTrue(signaler.processSignals.isEmpty)
        XCTAssertEqual(driver.terminateCount, 1)
    }

    func testNaturalExitDecodesRawWaitStatusWithoutTerminateAndPreservesView() throws {
        let recorder = EventRecorder()
        let driver = FakeTerminalDriver(pid: 4_205, recorder: recorder)
        let session = makeSession(
            driver: driver,
            signaler: RecordingSignaler(recorder: recorder),
            reaper: ScriptedChildReaper(results: [], recorder: recorder)
        )
        let originalView = session.terminalView
        var observedStates: [TerminalSessionState] = []
        session.onStateChange = { observedStates.append($0) }
        session.start()

        let staleCallback = driver.onProcessTerminated
        driver.complete(rawStatus: 7 << 8)

        XCTAssertEqual(session.state, .ended(.exited(7)))
        XCTAssertEqual(driver.terminateCount, 0)
        XCTAssertTrue(session.terminalView === originalView)
        XCTAssertEqual(observedStates, [.starting, .running, .ended(.exited(7))])

        staleCallback?(9)
        XCTAssertEqual(session.state, .ended(.exited(7)), "A stale callback must not rewrite ended state.")
    }

    func testInputControlCAndResizeAreForwardedOnlyWhileRunning() throws {
        let recorder = EventRecorder()
        let driver = FakeTerminalDriver(pid: 4_206, recorder: recorder)
        let session = makeSession(
            driver: driver,
            signaler: RecordingSignaler(recorder: recorder),
            reaper: ScriptedChildReaper(results: [], recorder: recorder)
        )
        session.send(text: "ignored")
        session.resize(to: NSSize(width: 640, height: 360))
        session.start()
        session.send(text: "pasted text\n")
        session.sendControlC()

        XCTAssertEqual(driver.sentBytes, [Array("pasted text\n".utf8), [0x03]])
        XCTAssertEqual(driver.sizes, [NSSize(width: 640, height: 360)])
    }

    func testStartingStopWaitsForPGIDProofBeforeSignallingAndReapsOnce() async throws {
        let recorder = EventRecorder()
        let driver = FakeTerminalDriver(pid: 4_207, recorder: recorder)
        let signaler = RecordingSignaler(recorder: recorder)
        let reaper = ScriptedChildReaper(results: [.reaped(rawStatus: 0)], recorder: recorder)
        let resolver = ScriptedProcessGroupResolver(
            results: [91, 91, driver.processIdentifier],
            recorder: recorder
        )
        let session = makeSession(
            driver: driver,
            signaler: signaler,
            reaper: reaper,
            resolver: resolver,
            clock: AdvancingStopClock(),
            policy: TerminalStopPolicy(
                gracePeriodNanoseconds: 10,
                pollIntervalNanoseconds: 1,
                postKillReapTimeoutNanoseconds: 10,
                ownershipStabilizationTimeoutNanoseconds: 10,
                ownershipPollIntervalNanoseconds: 1
            )
        )

        session.start()
        XCTAssertEqual(session.state, .starting)
        XCTAssertTrue(signaler.groupSignals.isEmpty)
        XCTAssertEqual(driver.terminateCount, 0)

        let result = await session.stop()

        XCTAssertEqual(result, .reaped(.exited(0)))
        XCTAssertEqual(resolver.callCount, 3)
        XCTAssertEqual(signaler.groupSignals.map(\.signal), [SIGTERM])
        XCTAssertEqual(driver.terminateCount, 1)
        XCTAssertEqual(recorder.snapshot(), [
            "terminal-start",
            "resolve-pgid:91",
            "resolve-pgid:91",
            "resolve-pgid:4207",
            "group-signal:15:4207",
            "terminal-terminate",
            "waitpid:4207"
        ])
    }

    func testOwnershipTimeoutStaysActiveAndFailsClosedUntilNaturalExit() async throws {
        let recorder = EventRecorder()
        let driver = FakeTerminalDriver(pid: 4_208, recorder: recorder)
        let signaler = RecordingSignaler(recorder: recorder)
        let resolver = ScriptedProcessGroupResolver(
            results: [77],
            repeatLastResult: true,
            recorder: recorder
        )
        let session = makeSession(
            driver: driver,
            signaler: signaler,
            reaper: ScriptedChildReaper(results: [], recorder: recorder),
            resolver: resolver,
            clock: AdvancingStopClock(),
            policy: TerminalStopPolicy(
                gracePeriodNanoseconds: 10,
                pollIntervalNanoseconds: 1,
                postKillReapTimeoutNanoseconds: 10,
                ownershipStabilizationTimeoutNanoseconds: 2,
                ownershipPollIntervalNanoseconds: 1
            )
        )
        session.start()

        let result = await session.stop()

        XCTAssertEqual(result, .invalidOwnership(pid: 4_208, pgid: 77))
        XCTAssertFalse(result.cleanlyReaped)
        XCTAssertEqual(session.state, .starting)
        XCTAssertTrue(session.state.isActive)
        XCTAssertEqual(session.processIdentifier, 4_208)
        XCTAssertTrue(signaler.groupSignals.isEmpty)
        XCTAssertTrue(signaler.processSignals.isEmpty)
        XCTAssertEqual(driver.terminateCount, 0)

        driver.complete(rawStatus: 6 << 8)
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(session.state, .ended(.exited(6)))
        XCTAssertEqual(driver.terminateCount, 0)
        XCTAssertTrue(signaler.groupSignals.isEmpty)
    }

    func testNaturalCallbackBeforeOwnershipProofCancelsStaleResolver() async throws {
        let recorder = EventRecorder()
        let driver = FakeTerminalDriver(pid: 4_209, recorder: recorder)
        let signaler = RecordingSignaler(recorder: recorder)
        let resolver = ScriptedProcessGroupResolver(
            results: [55, driver.processIdentifier],
            recorder: recorder
        )
        let session = makeSession(
            driver: driver,
            signaler: signaler,
            reaper: ScriptedChildReaper(results: [], recorder: recorder),
            resolver: resolver,
            clock: AdvancingStopClock(),
            policy: TerminalStopPolicy(
                ownershipStabilizationTimeoutNanoseconds: 10,
                ownershipPollIntervalNanoseconds: 1
            )
        )
        session.start()
        XCTAssertEqual(session.state, .starting)

        driver.complete(rawStatus: 3 << 8)
        for _ in 0..<20 { await Task.yield() }

        XCTAssertEqual(session.state, .ended(.exited(3)))
        XCTAssertEqual(resolver.callCount, 1)
        XCTAssertTrue(signaler.groupSignals.isEmpty)
        XCTAssertEqual(driver.terminateCount, 0)
    }

    func testCallbackInstalledBeforeStartCapturesSynchronousShortLivedChild() throws {
        let recorder = EventRecorder()
        let driver = FakeTerminalDriver(
            pid: 4_210,
            recorder: recorder,
            completionDuringStart: 9 << 8
        )
        let resolver = ScriptedProcessGroupResolver(
            results: [driver.processIdentifier],
            recorder: recorder
        )
        let session = makeSession(
            driver: driver,
            signaler: RecordingSignaler(recorder: recorder),
            reaper: ScriptedChildReaper(results: [], recorder: recorder),
            resolver: resolver
        )

        session.start()

        XCTAssertEqual(session.state, .ended(.exited(9)))
        XCTAssertEqual(resolver.callCount, 0)
        XCTAssertEqual(driver.terminateCount, 0)
    }

    func testRealPTYAcceptsInputAppliesResizeAndInterpretsANSIStyle() throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gdm-real-pty-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let fixture = root.appendingPathComponent("pty-fixture")
        let source = """
        #!/bin/sh
        trap 'printf "INT-SEEN\\r\\n"; exit 0' INT
        if [ -t 0 ]; then printf 'TTY=yes\\r\\n'; else printf 'TTY=no\\r\\n'; fi
        printf '\\033[38;2;1;2;3mREADY\\033[0m\\r\\n'
        IFS= read -r line
        printf 'PASTE=%s\\r\\n' "$line"
        printf 'SIZE=%s\\r\\n' "$(stty size)"
        while :; do sleep 1; done
        """
        try Data(source.utf8).write(to: fixture)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fixture.path)

        var environment = ProcessInfo.processInfo.environment
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        let specification = AgentLaunchSpecification(
            agent: .shell,
            executableURL: fixture,
            arguments: [],
            environment: environment,
            currentDirectory: root
        )
        let session = TerminalSession(
            taskID: "real-pty",
            generation: 1,
            specification: specification
        )
        session.resize(to: NSSize(width: 800, height: 400))
        session.start()
        let view = try XCTUnwrap(session.terminalView as? LocalProcessTerminalView)

        XCTAssertTrue(waitUntil(timeout: 2) { screenText(view).contains("READY") })
        let readyLocation = try XCTUnwrap(findCharacter("R", in: view.terminal))
        XCTAssertEqual(
            view.terminal.getCharData(col: readyLocation.col, row: readyLocation.row)?.attribute.fg,
            .trueColor(red: 1, green: 2, blue: 3),
            "ANSI SGR must be interpreted into terminal cell style, not retained as raw text."
        )

        session.resize(to: NSSize(width: 640, height: 300))
        let expectedSize = "SIZE=\(view.terminal.rows) \(view.terminal.cols)"
        session.send(text: "hello from paste\n")
        XCTAssertTrue(waitUntil(timeout: 2) {
            let text = screenText(view)
            return text.contains("TTY=yes")
                && text.contains("PASTE=hello from paste")
                && text.contains(expectedSize)
        })

        session.sendControlC()
        XCTAssertTrue(waitUntil(timeout: 2) {
            if case .ended = session.state { return true }
            return false
        })
        XCTAssertTrue(screenText(view).contains("INT-SEEN"))
        XCTAssertTrue(session.terminalView === view, "Ended sessions retain the drained terminal view.")
    }

    func testRealPTYLiveLeaderIgnoringTermIsGuardedlyKilledAndReaped() async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gdm-real-stop-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let fixture = root.appendingPathComponent("ignore-term")
        let armedFile = root.appendingPathComponent("armed")
        try Data("#!/bin/sh\ntrap '' TERM\n: > \"$GDM_ARMED_FILE\"\nexec /bin/sleep 5\n".utf8).write(to: fixture)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fixture.path)

        var environment = ProcessInfo.processInfo.environment
        environment["TERM"] = "xterm-256color"
        environment["GDM_ARMED_FILE"] = armedFile.path
        let session = TerminalSession(
            taskID: "real-stop",
            generation: 1,
            specification: AgentLaunchSpecification(
                agent: .shell,
                executableURL: fixture,
                arguments: [],
                environment: environment,
                currentDirectory: root
            ),
            stopPolicy: TerminalStopPolicy(
                gracePeriodNanoseconds: 50_000_000,
                pollIntervalNanoseconds: 5_000_000,
                postKillReapTimeoutNanoseconds: 2_000_000_000
            )
        )
        session.resize(to: NSSize(width: 800, height: 400))
        session.start()
        let pid = try XCTUnwrap(session.processIdentifier)
        let didArm = waitUntil(timeout: 2) { FileManager.default.fileExists(atPath: armedFile.path) }
        XCTAssertTrue(didArm, "The fixture must install its TERM handler before Stop.")

        let result = await session.stop()

        XCTAssertEqual(result, .reaped(.signaled(SIGKILL)))
        XCTAssertEqual(session.state, .ended(.signaled(SIGKILL)))
        XCTAssertEqual(
            Darwin.kill(pid, 0),
            -1,
            "The direct PTY leader must be reaped, not left alive or zombie."
        )
        XCTAssertEqual(errno, ESRCH)
    }

    func testRealPTYOwnershipStabilizesAcrossTwoHundredLaunches() async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gdm-real-ownership-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let fixture = root.appendingPathComponent("long-lived-child")
        try Data("#!/bin/sh\nexec /bin/sleep 5\n".utf8).write(to: fixture)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fixture.path)

        var environment = ProcessInfo.processInfo.environment
        environment["TERM"] = "xterm-256color"
        var launchesThatNeededStabilization = 0
        var stabilizedLaunches = 0

        for index in 0..<200 {
            let session = TerminalSession(
                taskID: "ownership-\(index)",
                generation: UInt64(index + 1),
                specification: AgentLaunchSpecification(
                    agent: .shell,
                    executableURL: fixture,
                    arguments: [],
                    environment: environment,
                    currentDirectory: root
                ),
                stopPolicy: TerminalStopPolicy(
                    gracePeriodNanoseconds: 100_000_000,
                    pollIntervalNanoseconds: 1_000_000,
                    postKillReapTimeoutNanoseconds: 1_000_000_000,
                    ownershipStabilizationTimeoutNanoseconds: 500_000_000,
                    ownershipPollIntervalNanoseconds: 250_000
                )
            )
            session.start()
            if session.state == .starting {
                launchesThatNeededStabilization += 1
            }

            let didStabilize = await waitUntilAsync(timeout: 1) {
                session.state == .running
            }
            XCTAssertTrue(didStabilize, "launch \(index) remained \(session.state.label)")
            guard didStabilize else {
                continue
            }
            stabilizedLaunches += 1
            let stopResult = await session.stop()
            XCTAssertTrue(
                stopResult.cleanlyReaped,
                "launch \(index) did not reap cleanly: \(stopResult)"
            )
        }

        XCTAssertEqual(stabilizedLaunches, 200)
        print(
            "real PTY ownership stabilization: \(stabilizedLaunches)/200; "
                + "delayed=\(launchesThatNeededStabilization)"
        )
    }

    func testRealPTYReplacesTheOneShotShellCommandPath() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let storeURL = packageRoot.appendingPathComponent("Sources/GDMNative/WorkspaceStore.swift")
        let storeSource = try String(contentsOf: storeURL, encoding: .utf8)

        XCTAssertFalse(storeSource.contains("arguments: [\"-lc\", command]"))
        XCTAssertFalse(storeSource.contains("func runCommand()"))
    }

    func testREADMEScopesTerminationGuaranteeToDirectPTYLeader() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let readmeURL = packageRoot.appendingPathComponent("README.md")
        let readme = try String(contentsOf: readmeURL, encoding: .utf8)

        XCTAssertTrue(readme.contains("direct PTY leader"))
        XCTAssertTrue(readme.contains("same-PGID descendant"))
        XCTAssertTrue(readme.contains("PID/PGID 재사용 안전"))
        XCTAssertTrue(readme.contains("이후 group signal은"))
        XCTAssertTrue(readme.contains("fail-closed로 금지"))
    }

    private func makeSession(
        driver: FakeTerminalDriver,
        signaler: RecordingSignaler,
        reaper: ScriptedChildReaper,
        resolver: (any ProcessGroupResolving)? = nil,
        clock: any StopClock = AdvancingStopClock(),
        policy: TerminalStopPolicy = TerminalStopPolicy(
            gracePeriodNanoseconds: 10,
            pollIntervalNanoseconds: 1,
            postKillReapTimeoutNanoseconds: 10
        )
    ) -> TerminalSession {
        TerminalSession(
            taskID: "task",
            generation: 1,
            specification: AgentLaunchSpecification(
                agent: .shell,
                executableURL: URL(fileURLWithPath: "/bin/zsh"),
                arguments: ["-l"],
                environment: ["TERM": "xterm-256color"],
                currentDirectory: URL(fileURLWithPath: "/tmp", isDirectory: true)
            ),
            terminalDriver: driver,
            signaler: signaler,
            childReaper: reaper,
            processGroupResolver: resolver
                ?? FixedProcessGroupResolver(processGroup: driver.processIdentifier),
            clock: clock,
            stopPolicy: policy
        )
    }

    private func waitUntil(timeout: TimeInterval, condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        return condition()
    }

    private func waitUntilAsync(
        timeout: TimeInterval,
        condition: () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        return condition()
    }

    private func screenText(_ view: LocalProcessTerminalView) -> String {
        String(decoding: view.terminal.getBufferAsData(), as: UTF8.self)
    }

    private func findCharacter(_ character: Character, in terminal: Terminal) -> (col: Int, row: Int)? {
        for row in 0..<terminal.rows {
            for col in 0..<terminal.cols where terminal.getCharacter(col: col, row: row) == character {
                return (col, row)
            }
        }
        return nil
    }
}

@MainActor
private final class FakeTerminalDriver: TerminalDriving {
    let hostedView = NSView(frame: .zero)
    let processIdentifier: pid_t
    var isRunning = false
    var onProcessTerminated: ((Int32?) -> Void)?
    private(set) var terminateCount = 0
    private(set) var sentBytes: [[UInt8]] = []
    private(set) var sizes: [NSSize] = []

    private let recorder: EventRecorder
    private let completionDuringStart: Int32?

    init(
        pid: pid_t,
        recorder: EventRecorder,
        completionDuringStart: Int32? = nil
    ) {
        processIdentifier = pid
        self.recorder = recorder
        self.completionDuringStart = completionDuringStart
    }

    func start(_ specification: AgentLaunchSpecification) {
        isRunning = true
        recorder.append("terminal-start")
        if let completionDuringStart {
            complete(rawStatus: completionDuringStart)
        }
    }

    func terminate() {
        terminateCount += 1
        isRunning = false
        recorder.append("terminal-terminate")
    }

    func send(_ bytes: [UInt8]) {
        sentBytes.append(bytes)
    }

    func resize(to size: NSSize) {
        sizes.append(size)
    }

    func complete(rawStatus: Int32?) {
        isRunning = false
        onProcessTerminated?(rawStatus)
    }
}

private struct FixedProcessGroupResolver: ProcessGroupResolving {
    let processGroup: pid_t?

    func processGroupIdentifier(for processIdentifier: pid_t) -> pid_t? {
        processGroup
    }
}

private final class ScriptedProcessGroupResolver:
    ProcessGroupResolving,
    @unchecked Sendable
{
    private let lock = NSLock()
    private var results: [pid_t?]
    private let repeatLastResult: Bool
    private let recorder: EventRecorder
    private var lastResult: pid_t?
    private var storedCallCount = 0

    var callCount: Int { lock.withLock { storedCallCount } }

    init(
        results: [pid_t?],
        repeatLastResult: Bool = false,
        recorder: EventRecorder
    ) {
        self.results = results
        self.repeatLastResult = repeatLastResult
        self.recorder = recorder
        self.lastResult = results.last ?? nil
    }

    func processGroupIdentifier(for processIdentifier: pid_t) -> pid_t? {
        let result: pid_t? = lock.withLock {
            storedCallCount += 1
            if !results.isEmpty {
                let next = results.removeFirst()
                lastResult = next
                return next
            }
            return repeatLastResult ? lastResult : nil
        }
        recorder.append("resolve-pgid:\(result.map(String.init) ?? "nil")")
        return result
    }
}

private final class EventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [String] = []

    func append(_ event: String) {
        lock.withLock { events.append(event) }
    }

    func snapshot() -> [String] {
        lock.withLock { events }
    }

    func reset() {
        lock.withLock { events.removeAll() }
    }
}

private final class RecordingSignaler: ProcessSignaling, @unchecked Sendable {
    struct SignalCall: Equatable {
        let target: pid_t
        let signal: Int32
    }

    private let lock = NSLock()
    private let recorder: EventRecorder
    private let failingGroupSignals: Set<Int32>
    private var storedGroupSignals: [SignalCall] = []
    private var storedProcessSignals: [SignalCall] = []

    var groupSignals: [SignalCall] { lock.withLock { storedGroupSignals } }
    var processSignals: [SignalCall] { lock.withLock { storedProcessSignals } }

    init(recorder: EventRecorder, failingGroupSignals: Set<Int32> = []) {
        self.recorder = recorder
        self.failingGroupSignals = failingGroupSignals
    }

    func sendToProcessGroup(_ processGroup: pid_t, signal: Int32) -> POSIXSignalResult {
        lock.withLock { storedGroupSignals.append(SignalCall(target: processGroup, signal: signal)) }
        recorder.append("group-signal:\(signal):\(processGroup)")
        return failingGroupSignals.contains(signal) ? .failure(ESRCH) : .success
    }

    func sendToProcess(_ processIdentifier: pid_t, signal: Int32) -> POSIXSignalResult {
        lock.withLock { storedProcessSignals.append(SignalCall(target: processIdentifier, signal: signal)) }
        recorder.append("process-signal:\(signal):\(processIdentifier)")
        return .success
    }
}

private actor ScriptedChildReaper: ChildReaping {
    private var results: [ChildWaitResult]
    private let recorder: EventRecorder
    private var calls = 0

    init(results: [ChildWaitResult], recorder: EventRecorder) {
        self.results = results
        self.recorder = recorder
    }

    func poll(processIdentifier: pid_t) async -> ChildWaitResult {
        calls += 1
        recorder.append("waitpid:\(processIdentifier)")
        guard !results.isEmpty else { return .stillRunning }
        return results.removeFirst()
    }

    func pollCount() -> Int { calls }
}

private final class AdvancingStopClock: StopClock, @unchecked Sendable {
    private let lock = NSLock()
    private var instant: UInt64 = 0

    func nowNanoseconds() -> UInt64 {
        lock.withLock { instant }
    }

    func sleep(nanoseconds: UInt64) async {
        lock.withLock { instant &+= max(nanoseconds, 1) }
        await Task.yield()
    }
}
