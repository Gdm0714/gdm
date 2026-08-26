import AppKit
import Darwin
import Foundation
import XCTest
@testable import GDMNative

@MainActor
final class SessionLaneTests: XCTestCase {
    func testLaneKeyIsCodableHashableAndStable() throws {
        let key = TerminalSessionLaneKey(taskID: "task-a", laneID: "review")
        XCTAssertEqual(key.id, "task-a#review")
        XCTAssertEqual(
            try JSONDecoder().decode(TerminalSessionLaneKey.self, from: JSONEncoder().encode(key)),
            key
        )
        XCTAssertNotEqual(key, TerminalSessionLaneKey(taskID: "task-a", laneID: "default"))
    }

    func testTwoIndependentLanesCanRunForOneTaskAndAppearInSnapshot() throws {
        let fixture = LaneManagerFixture()
        let manager = fixture.makeManager()
        let taskID = "task-a"

        _ = try manager.start(
            taskID: taskID,
            laneID: "review",
            specification: makeSpecification(agent: .codex)
        )
        _ = try manager.start(
            taskID: taskID,
            laneID: "implement",
            specification: makeSpecification(agent: .claude)
        )
        _ = try manager.start(
            taskID: taskID,
            specification: makeSpecification(agent: .gemini)
        )

        XCTAssertEqual(manager.snapshot().count, 3)
        XCTAssertEqual(
            Set(manager.snapshot().map { $0.laneID }),
            ["default", "implement", "review"]
        )
        XCTAssertEqual(manager.session(for: taskID)?.laneID, "default")
        XCTAssertEqual(
            manager.session(for: TerminalSessionLaneKey(taskID: taskID, laneID: "review"))?.specification.agent,
            .codex
        )
    }

    func testOneActiveSessionPerLaneAndGenerationIsIndependentAcrossLanes() throws {
        let fixture = LaneManagerFixture()
        let manager = fixture.makeManager()
        let review = TerminalSessionLaneKey(taskID: "task-a", laneID: "review")
        let implement = TerminalSessionLaneKey(taskID: "task-a", laneID: "implement")
        let specification = makeSpecification(agent: .codex)

        let firstReview = try manager.start(key: review, specification: specification)
        _ = try manager.start(key: implement, specification: specification)
        XCTAssertThrowsError(try manager.start(key: review, specification: specification)) {
            XCTAssertEqual($0 as? TerminalSessionManagerError, .sessionLaneAlreadyActive(review))
        }

        fixture.driver(for: review).complete(rawStatus: 0)
        let secondReview = try manager.start(key: review, specification: specification)
        XCTAssertEqual(firstReview.generation, 1)
        XCTAssertEqual(secondReview.generation, 2)
        XCTAssertEqual(manager.session(for: implement)?.generation, 1)
        XCTAssertEqual(
            manager.snapshot().first(where: { $0.laneID == "review" })?.generation,
            2
        )
    }

    func testLegacyTaskIDStartRejectsDefaultLaneButNotSiblingLane() throws {
        let fixture = LaneManagerFixture()
        let manager = fixture.makeManager()
        let specification = makeSpecification(agent: .codex)

        _ = try manager.start(taskID: "task-a", specification: specification)
        XCTAssertThrowsError(try manager.start(taskID: "task-a", specification: specification)) {
            XCTAssertEqual($0 as? TerminalSessionManagerError, .sessionAlreadyActive("task-a"))
        }
        XCTAssertNoThrow(
            try manager.start(
                taskID: "task-a",
                laneID: "sibling",
                specification: specification
            )
        )
    }

    func testStopAllStopsEveryLaneAndLegacyResultFailsClosedOnAnyLaneFailure() async throws {
        let fixture = LaneManagerFixture(failingLane: "broken")
        let manager = fixture.makeManager()
        let specification = makeSpecification(agent: .codex)
        _ = try manager.start(
            taskID: "task-a",
            laneID: "healthy",
            specification: specification
        )
        _ = try manager.start(
            taskID: "task-a",
            laneID: "broken",
            specification: specification
        )

        let laneResults = await manager.stopAllLanes()
        XCTAssertEqual(laneResults.count, 2)
        XCTAssertTrue(laneResults[TerminalSessionLaneKey(taskID: "task-a", laneID: "healthy")]?.cleanlyReaped == true)
        XCTAssertFalse(laneResults[TerminalSessionLaneKey(taskID: "task-a", laneID: "broken")]?.cleanlyReaped == true)

        // The compatibility result collapses duplicate task IDs conservatively.
        let legacy = await manager.stopAll()
        XCTAssertFalse(legacy["task-a"]?.cleanlyReaped == true)
    }

    func testTwoRealPTYLanesRunConcurrentlyAndStopCleanly() async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gidem-real-lanes-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let fixture = root.appendingPathComponent("lane-fixture")
        try Data("#!/bin/sh\nprintf '%s\\n' \"$GIDEM_LANE_MARKER\" > \"$GIDEM_LANE_FILE\"\nwhile :; do sleep 1; done\n".utf8)
            .write(to: fixture)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fixture.path)
        let firstMarker = root.appendingPathComponent("first.marker")
        let secondMarker = root.appendingPathComponent("second.marker")

        func specification(marker: String, markerFile: URL) -> AgentLaunchSpecification {
            var environment = ProcessInfo.processInfo.environment
            environment["TERM"] = "xterm-256color"
            environment["GIDEM_LANE_MARKER"] = marker
            environment["GIDEM_LANE_FILE"] = markerFile.path
            return AgentLaunchSpecification(
                agent: .shell,
                executableURL: fixture,
                arguments: [],
                environment: environment,
                currentDirectory: root
            )
        }

        let manager = TerminalSessionManager()
        let firstKey = TerminalSessionLaneKey(taskID: "real-task", laneID: "first")
        let secondKey = TerminalSessionLaneKey(taskID: "real-task", laneID: "second")
        let first = try manager.start(
            key: firstKey,
            specification: specification(marker: "LANE-ONE", markerFile: firstMarker)
        )
        let second = try manager.start(
            key: secondKey,
            specification: specification(marker: "LANE-TWO", markerFile: secondMarker)
        )

        let didRunBothChildren = laneWaitUntil(timeout: 3) {
            (try? String(contentsOf: firstMarker, encoding: .utf8)) == "LANE-ONE\n"
                && (try? String(contentsOf: secondMarker, encoding: .utf8)) == "LANE-TWO\n"
        }
        let firstPID = try XCTUnwrap(first.processIdentifier)
        let secondPID = try XCTUnwrap(second.processIdentifier)
        XCTAssertTrue(
            didRunBothChildren,
            "first state=\(first.state) pid=\(firstPID); second state=\(second.state) pid=\(secondPID)"
        )
        XCTAssertGreaterThan(firstPID, 1)
        XCTAssertGreaterThan(secondPID, 1)
        XCTAssertNotEqual(firstPID, secondPID)
        XCTAssertEqual(manager.snapshot().filter { $0.taskID == "real-task" }.count, 2)

        let results = await manager.stopAllLanes()
        XCTAssertTrue(results[firstKey]?.cleanlyReaped == true)
        XCTAssertTrue(results[secondKey]?.cleanlyReaped == true)
        XCTAssertFalse(manager.hasActiveSessions)
    }

    private func makeSpecification(agent: AgentKind) -> AgentLaunchSpecification {
        AgentLaunchSpecification(
            agent: agent,
            executableURL: URL(fileURLWithPath: "/bin/zsh"),
            arguments: [],
            environment: ["TERM": "xterm-256color"],
            currentDirectory: URL(fileURLWithPath: "/tmp", isDirectory: true)
        )
    }

    private func laneWaitUntil(timeout: TimeInterval, condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        return condition()
    }

}

@MainActor
private final class LaneManagerFixture {
    private var nextPID: pid_t = 9_000
    private var drivers: [TerminalSessionLaneKey: [LaneTerminalDriver]] = [:]
    private let failingLane: String?

    init(failingLane: String? = nil) {
        self.failingLane = failingLane
    }

    func makeManager() -> TerminalSessionManager {
        TerminalSessionManager(laneSessionFactory: { [weak self] key, generation, specification in
            guard let self else { fatalError("LaneManagerFixture released") }
            nextPID += 1
            let driver = LaneTerminalDriver(pid: nextPID)
            drivers[key, default: []].append(driver)
            let reaper: any ChildReaping = LaneReaper(shouldFail: key.laneID == failingLane)
            return TerminalSession(
                taskID: key.taskID,
                laneID: key.laneID,
                generation: generation,
                specification: specification,
                terminalDriver: driver,
                signaler: LaneSignaler(),
                childReaper: reaper,
                processGroupResolver: LaneGroupResolver(),
                clock: LaneClock(),
                stopPolicy: TerminalStopPolicy(
                    gracePeriodNanoseconds: 0,
                    pollIntervalNanoseconds: 0,
                    postKillReapTimeoutNanoseconds: 1
                )
            )
        })
    }

    func driver(for key: TerminalSessionLaneKey) -> LaneTerminalDriver {
        guard let driver = drivers[key]?.last else { fatalError("Missing driver") }
        return driver
    }
}

@MainActor
private final class LaneTerminalDriver: TerminalDriving {
    let hostedView = NSView(frame: .zero)
    let processIdentifier: pid_t
    var isRunning = false
    var onProcessTerminated: ((Int32?) -> Void)?

    init(pid: pid_t) { processIdentifier = pid }
    func start(_ specification: AgentLaunchSpecification) { isRunning = true }
    func terminate() { isRunning = false }
    func send(_ bytes: [UInt8]) {}
    func resize(to size: NSSize) {}

    func complete(rawStatus: Int32?) {
        isRunning = false
        onProcessTerminated?(rawStatus)
    }
}

private struct LaneGroupResolver: ProcessGroupResolving {
    func processGroupIdentifier(for processIdentifier: pid_t) -> pid_t? { processIdentifier }
}

private struct LaneClock: StopClock {
    func nowNanoseconds() -> UInt64 { 0 }
    func sleep(nanoseconds: UInt64) async { await Task.yield() }
}

private actor LaneReaper: ChildReaping {
    let shouldFail: Bool
    init(shouldFail: Bool) { self.shouldFail = shouldFail }

    func poll(processIdentifier: pid_t) async -> ChildWaitResult {
        shouldFail ? .failed(EIO) : .reaped(rawStatus: 0)
    }
}

private struct LaneSignaler: ProcessSignaling, @unchecked Sendable {
    func sendToProcessGroup(_ processGroup: pid_t, signal: Int32) -> POSIXSignalResult { .success }
    func sendToProcess(_ processIdentifier: pid_t, signal: Int32) -> POSIXSignalResult { .success }
}
