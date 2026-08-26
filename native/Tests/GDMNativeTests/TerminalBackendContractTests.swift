import AppKit
import XCTest
@testable import GDMNative

final class TerminalBackendContractTests: XCTestCase {
    private var resourceFixture: URL?

    override func tearDownWithError() throws {
        if let resourceFixture {
            try? FileManager.default.removeItem(at: resourceFixture)
        }
        resourceFixture = nil
    }

    @MainActor
    func testEmbeddedTerminalContainerClipsNativeSurfaceToPaneBounds() {
        let container = TerminalClippingContainerView(
            frame: NSRect(x: 0, y: 0, width: 320, height: 180)
        )

        XCTAssertTrue(container.wantsLayer)
        XCTAssertEqual(container.layer?.masksToBounds, true)
    }

    func testAutomaticSelectsGhosttyWhenItIsAvailable() {
        XCTAssertEqual(
            TerminalBackendResolver.resolve(
                preference: .automatic,
                ghosttyAvailable: true
            ),
            .ghostty
        )
    }

    func testPinnedResourceLocatorRejectsAmbientGhosttyAndAcceptsGidemOverride() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "gidem-ghostty-resources-\(UUID().uuidString)",
            isDirectory: true
        )
        resourceFixture = root
        let ghostty = root.appendingPathComponent("ghostty", isDirectory: true)
        let shell = ghostty.appendingPathComponent(
            "shell-integration/zsh/ghostty-integration",
            isDirectory: false
        )
        let terminfo = root.appendingPathComponent("terminfo/78/xterm-ghostty", isDirectory: false)
        try FileManager.default.createDirectory(
            at: shell.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: terminfo.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("integration".utf8).write(to: shell)
        try Data("terminfo".utf8).write(to: terminfo)

        XCTAssertNil(GhosttyResourceLocator.liveLocation(
            environment: ["GHOSTTY_RESOURCES_DIR": ghostty.path],
            bundleResourceURL: nil,
            currentDirectory: URL(fileURLWithPath: "/", isDirectory: true),
            sourceFile: "/unavailable/Sources/GDMNative/Fake.swift"
        ))
        XCTAssertEqual(
            GhosttyResourceLocator.liveLocation(
                environment: ["GIDEM_GHOSTTY_RESOURCES_DIR": ghostty.path],
                bundleResourceURL: nil,
                currentDirectory: URL(fileURLWithPath: "/", isDirectory: true),
                sourceFile: "/unavailable/Sources/GDMNative/Fake.swift"
            ),
            GhosttyResourceLocation(ghosttyDirectory: ghostty, terminfoDirectory: root.appendingPathComponent("terminfo"))
        )
    }

    @MainActor
    func testDriverOwnedLifecycleNeverSignalsOrWaitsOnObservedForegroundPID() async {
        let driver = ContractTerminalDriver()
        let signaler = ContractSignaler()
        let reaper = ContractReaper()
        let resolver = ContractGroupResolver()
        let session = TerminalSession(
            taskID: "contract",
            generation: 1,
            specification: Self.specification(),
            terminalDriver: driver,
            signaler: signaler,
            childReaper: reaper,
            processGroupResolver: resolver
        )

        session.start()
        XCTAssertEqual(session.state, .running)
        XCTAssertEqual(session.processIdentifier, 44_444)

        let result = await session.stop()
        XCTAssertEqual(result, .reaped(.driverStopped))
        XCTAssertEqual(session.state, .ended(.driverStopped))
        XCTAssertEqual(driver.terminateCount, 1)
        XCTAssertEqual(signaler.callCount, 0)
        XCTAssertEqual(resolver.callCount, 0)
        let reaperCalls = await reaper.calls()
        XCTAssertEqual(reaperCalls, 0)
    }

    @MainActor
    func testDriverOwnedNaturalExitUsesBackendReapProof() {
        let driver = ContractTerminalDriver()
        let session = TerminalSession(
            taskID: "natural-exit",
            generation: 3,
            specification: Self.specification(),
            terminalDriver: driver
        )
        session.start()

        driver.reportExit(code: 7)

        XCTAssertEqual(session.state, .ended(.exited(7)))
        XCTAssertTrue(TerminalStopResult.alreadyEnded(.exited(7)).cleanlyReaped)
    }

    #if canImport(GhosttyKit)
    @MainActor
    func testCompiledFactoryCreatesReadyGhosttyDriver() {
        let driver = TerminalBackendFactory.makeDefault(environment: [:])
        XCTAssertEqual(driver.lifecycleOwnership, .terminalDriver)
        XCTAssertTrue(driver is GhosttyTerminalDriver)
    }

    @MainActor
    func testGhosttySurfaceLaunchesPTYAndReportsExit() async throws {
        let driver = GhosttyTerminalDriver(runtime: .shared)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 420),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = driver.hostedView
        driver.resize(to: window.contentView!.bounds.size)

        let exited = expectation(description: "Ghostty reports its reaped child exit")
        var rawStatus: Int32?
        driver.onProcessTerminated = { status in
            rawStatus = status
            exited.fulfill()
        }
        let specification = AgentLaunchSpecification(
            agent: .shell,
            executableURL: URL(fileURLWithPath: "/bin/zsh"),
            arguments: ["-f", "-c", "printf 'gidem-ghostty-contract\\n'; exit 7"],
            environment: [
                "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"
            ],
            currentDirectory: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        )

        driver.start(specification)
        XCTAssertTrue(driver.isRunning)
        await fulfillment(of: [exited], timeout: 10)
        XCTAssertEqual(TerminalSession.decodeWaitStatus(rawStatus), .exited(7))
        XCTAssertFalse(driver.isRunning)
        driver.terminate()
        window.contentView = nil
    }
    #endif

    private static func specification() -> AgentLaunchSpecification {
        AgentLaunchSpecification(
            agent: .shell,
            executableURL: URL(fileURLWithPath: "/bin/zsh"),
            arguments: ["-l"],
            environment: [:],
            currentDirectory: URL(fileURLWithPath: "/tmp", isDirectory: true)
        )
    }
}

@MainActor
private final class ContractTerminalDriver: TerminalDriving {
    let hostedView = NSView(frame: .zero)
    let lifecycleOwnership = TerminalLifecycleOwnership.terminalDriver
    var processIdentifier: pid_t = 44_444
    var isRunning = false
    var onProcessTerminated: ((Int32?) -> Void)?
    private(set) var terminateCount = 0

    func start(_ specification: AgentLaunchSpecification) { isRunning = true }
    func terminate() {
        terminateCount += 1
        isRunning = false
    }
    func send(_ bytes: [UInt8]) {}
    func resize(to size: NSSize) {}

    func reportExit(code: Int32) {
        isRunning = false
        onProcessTerminated?(code << 8)
    }
}

private final class ContractSignaler: ProcessSignaling, @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    var callCount: Int { lock.withLock { calls } }

    func sendToProcessGroup(_ processGroup: pid_t, signal: Int32) -> POSIXSignalResult {
        lock.withLock { calls += 1 }
        return .success
    }
    func sendToProcess(_ processIdentifier: pid_t, signal: Int32) -> POSIXSignalResult {
        lock.withLock { calls += 1 }
        return .success
    }
}

private actor ContractReaper: ChildReaping {
    private(set) var callCount = 0
    func calls() -> Int { callCount }
    func poll(processIdentifier: pid_t) async -> ChildWaitResult {
        callCount += 1
        return .stillRunning
    }
}

private final class ContractGroupResolver: ProcessGroupResolving, @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    var callCount: Int { lock.withLock { calls } }
    func processGroupIdentifier(for processIdentifier: pid_t) -> pid_t? {
        lock.withLock { calls += 1 }
        return processIdentifier
    }
}
