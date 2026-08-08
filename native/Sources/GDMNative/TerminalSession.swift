import AppKit
import Combine
import Darwin
import Foundation
import SwiftTerm

enum TerminalTermination: Equatable, Sendable {
    case exited(Int32)
    case signaled(Int32)
    case launchFailed(String)
    case ownershipLost
    case waitFailed(Int32)
    case reapTimedOut
    case unknownWaitStatus(Int32?)

    var label: String {
        switch self {
        case .exited(let code): "exit \(code)"
        case .signaled(let signal): "signal \(signal)"
        case .launchFailed(let message): "launch failed · \(message)"
        case .ownershipLost: "ended · ownership not attached"
        case .waitFailed(let errorNumber): "ended · waitpid error \(errorNumber)"
        case .reapTimedOut: "ended · reap timed out"
        case .unknownWaitStatus(let status): "ended · unknown status \(status.map(String.init) ?? "nil")"
        }
    }
}

enum TerminalSessionState: Equatable, Sendable {
    case idle
    case starting
    case running
    /// Includes cleanup-pending after a bounded reap attempt fails. Keeping this
    /// state active preserves PID ownership and blocks replacement or app exit.
    case stopping
    case ended(TerminalTermination)

    var isActive: Bool {
        switch self {
        case .starting, .running, .stopping: true
        case .idle, .ended: false
        }
    }

    var label: String {
        switch self {
        case .idle: "idle"
        case .starting: "starting"
        case .running: "running"
        case .stopping: "stopping"
        case .ended(let termination): termination.label
        }
    }
}

enum TerminalStopResult: Equatable, Sendable {
    case reaped(TerminalTermination)
    case alreadyEnded(TerminalTermination)
    case notRunning
    case alreadyStopping
    case invalidOwnership(pid: pid_t, pgid: pid_t?)
    case ownershipLost
    case waitFailed(Int32)
    case reapTimedOut

    var cleanlyReaped: Bool {
        switch self {
        case .reaped:
            return true
        case .alreadyEnded(.exited), .alreadyEnded(.signaled):
            // Natural exits are reaped by SwiftTerm before its delegate callback.
            return true
        case .alreadyEnded, .notRunning, .alreadyStopping, .invalidOwnership,
             .ownershipLost, .waitFailed, .reapTimedOut:
            return false
        }
    }
}

struct TerminalStopPolicy: Equatable, Sendable {
    let gracePeriodNanoseconds: UInt64
    let pollIntervalNanoseconds: UInt64
    let postKillReapTimeoutNanoseconds: UInt64
    let ownershipStabilizationTimeoutNanoseconds: UInt64
    let ownershipPollIntervalNanoseconds: UInt64

    init(
        gracePeriodNanoseconds: UInt64 = 3_000_000_000,
        pollIntervalNanoseconds: UInt64 = 50_000_000,
        postKillReapTimeoutNanoseconds: UInt64 = 3_000_000_000,
        ownershipStabilizationTimeoutNanoseconds: UInt64 = 1_000_000_000,
        ownershipPollIntervalNanoseconds: UInt64 = 1_000_000
    ) {
        self.gracePeriodNanoseconds = gracePeriodNanoseconds
        self.pollIntervalNanoseconds = pollIntervalNanoseconds
        self.postKillReapTimeoutNanoseconds = postKillReapTimeoutNanoseconds
        self.ownershipStabilizationTimeoutNanoseconds = ownershipStabilizationTimeoutNanoseconds
        self.ownershipPollIntervalNanoseconds = ownershipPollIntervalNanoseconds
    }
}

enum ChildWaitResult: Equatable, Sendable {
    case stillRunning
    case reaped(rawStatus: Int32)
    case noChild
    case failed(Int32)
}

protocol ChildReaping: Sendable {
    func poll(processIdentifier: pid_t) async -> ChildWaitResult
}

struct SystemChildReaper: ChildReaping {
    func poll(processIdentifier: pid_t) async -> ChildWaitResult {
        var status: Int32 = 0
        errno = 0
        let result = waitpid(processIdentifier, &status, WNOHANG)
        if result == processIdentifier {
            return .reaped(rawStatus: status)
        }
        if result == 0 {
            return .stillRunning
        }
        if result == -1 {
            let errorNumber = errno
            return errorNumber == ECHILD ? .noChild : .failed(errorNumber)
        }
        return .failed(EINVAL)
    }
}

enum POSIXSignalResult: Equatable, Sendable {
    case success
    case failure(Int32)
}

protocol ProcessSignaling: Sendable {
    func sendToProcessGroup(_ processGroup: pid_t, signal: Int32) -> POSIXSignalResult
    func sendToProcess(_ processIdentifier: pid_t, signal: Int32) -> POSIXSignalResult
}

struct SystemProcessSignaler: ProcessSignaling {
    func sendToProcessGroup(_ processGroup: pid_t, signal: Int32) -> POSIXSignalResult {
        guard processGroup > 1 else { return .failure(EINVAL) }
        errno = 0
        return kill(-processGroup, signal) == 0 ? .success : .failure(errno)
    }

    func sendToProcess(_ processIdentifier: pid_t, signal: Int32) -> POSIXSignalResult {
        guard processIdentifier > 1 else { return .failure(EINVAL) }
        errno = 0
        return kill(processIdentifier, signal) == 0 ? .success : .failure(errno)
    }
}

protocol ProcessGroupResolving: Sendable {
    func processGroupIdentifier(for processIdentifier: pid_t) -> pid_t?
}

struct SystemProcessGroupResolver: ProcessGroupResolving {
    func processGroupIdentifier(for processIdentifier: pid_t) -> pid_t? {
        guard processIdentifier > 1 else { return nil }
        let result = getpgid(processIdentifier)
        return result >= 0 ? result : nil
    }
}

protocol StopClock: Sendable {
    func nowNanoseconds() -> UInt64
    func sleep(nanoseconds: UInt64) async
}

struct SystemStopClock: StopClock {
    func nowNanoseconds() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds
    }

    func sleep(nanoseconds: UInt64) async {
        guard nanoseconds > 0 else {
            await Task.yield()
            return
        }
        try? await Task.sleep(nanoseconds: nanoseconds)
    }
}

@MainActor
protocol TerminalDriving: AnyObject {
    var hostedView: NSView { get }
    var processIdentifier: pid_t { get }
    var isRunning: Bool { get }
    var onProcessTerminated: ((Int32?) -> Void)? { get set }

    func start(_ specification: AgentLaunchSpecification)
    func terminate()
    func send(_ bytes: [UInt8])
    func resize(to size: NSSize)
}

@MainActor
final class SwiftTermTerminalDriver:
    NSObject,
    TerminalDriving,
    @preconcurrency LocalProcessTerminalViewDelegate
{
    let swiftTermView: LocalProcessTerminalView
    var onProcessTerminated: ((Int32?) -> Void)?

    override init() {
        swiftTermView = LocalProcessTerminalView(frame: .zero)
        super.init()
        swiftTermView.processDelegate = self
    }

    var hostedView: NSView { swiftTermView }
    var processIdentifier: pid_t { swiftTermView.process.shellPid }
    var isRunning: Bool { swiftTermView.process.running }

    func start(_ specification: AgentLaunchSpecification) {
        swiftTermView.startProcess(
            executable: specification.executableURL.path,
            args: specification.arguments,
            environment: specification.environmentEntries,
            execName: nil,
            currentDirectory: specification.currentDirectory.path
        )
    }

    func terminate() {
        swiftTermView.terminate()
    }

    func send(_ bytes: [UInt8]) {
        swiftTermView.process.send(data: bytes[...])
    }

    func resize(to size: NSSize) {
        swiftTermView.setFrameSize(size)
    }

    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func processTerminated(source: TerminalView, exitCode: Int32?) {
        onProcessTerminated?(exitCode)
    }
}

private struct TerminalProcessIdentity: Equatable, Sendable {
    let sessionID: UUID
    let generation: UInt64
    let processIdentifier: pid_t
    let processGroupIdentifier: pid_t
}

private struct TerminalLaunchCandidate: Equatable, Sendable {
    let sessionID: UUID
    let generation: UInt64
    let processIdentifier: pid_t
}

private enum OwnershipResolution: Equatable, Sendable {
    case confirmed(processGroupIdentifier: pid_t)
    case timedOut(lastObservedProcessGroup: pid_t?)
    case stale
}

private struct PendingNaturalTermination: Equatable, Sendable {
    let sessionID: UUID
    let generation: UInt64
    let processIdentifier: pid_t
    let rawStatus: Int32?
}

private struct ExplicitCleanupProgress: Equatable, Sendable {
    var didSendGroupTerm = false
    var groupKillResult: POSIXSignalResult?
    var didSendDirectKill = false
}

@MainActor
final class TerminalSession: ObservableObject, Identifiable {
    let id: UUID
    let taskID: String
    let generation: UInt64
    let specification: AgentLaunchSpecification
    let startedAt: Date

    @Published private(set) var state: TerminalSessionState = .idle

    /// This callback intentionally exposes lifecycle state without PID, PGID,
    /// environment, or transcript so callers can safely persist session metadata.
    var onStateChange: ((TerminalSessionState) -> Void)?

    var terminalView: NSView { terminalDriver.hostedView }
    var processIdentifier: pid_t? {
        processIdentity?.processIdentifier ?? launchCandidate?.processIdentifier
    }

    private let terminalDriver: any TerminalDriving
    private let signaler: any ProcessSignaling
    private let childReaper: any ChildReaping
    private let processGroupResolver: any ProcessGroupResolving
    private let clock: any StopClock
    private let stopPolicy: TerminalStopPolicy

    private var processIdentity: TerminalProcessIdentity?
    private var launchCandidate: TerminalLaunchCandidate?
    private var pendingNaturalTermination: PendingNaturalTermination?
    private var ownershipTask: Task<OwnershipResolution, Never>?
    private var ownershipAttemptID: UUID?
    private var lastObservedProcessGroup: pid_t?
    private var stopRequestedWhileStarting = false
    private var didTransferTerminationOwnership = false
    /// Records irreversible explicit-cleanup steps so a later Stop can retry
    /// waitpid without repeating TERM, KILL, or SwiftTerm ownership transfer.
    private var cleanupProgress = ExplicitCleanupProgress()
    private var pendingCleanupFailure: TerminalStopResult?
    private var stopTask: Task<TerminalStopResult, Never>?

    init(
        id: UUID = UUID(),
        taskID: String,
        generation: UInt64,
        specification: AgentLaunchSpecification,
        terminalDriver: (any TerminalDriving)? = nil,
        signaler: any ProcessSignaling = SystemProcessSignaler(),
        childReaper: any ChildReaping = SystemChildReaper(),
        processGroupResolver: any ProcessGroupResolving = SystemProcessGroupResolver(),
        clock: any StopClock = SystemStopClock(),
        stopPolicy: TerminalStopPolicy = TerminalStopPolicy(),
        startedAt: Date = Date()
    ) {
        self.id = id
        self.taskID = taskID
        self.generation = generation
        self.specification = specification
        self.terminalDriver = terminalDriver ?? SwiftTermTerminalDriver()
        self.signaler = signaler
        self.childReaper = childReaper
        self.processGroupResolver = processGroupResolver
        self.clock = clock
        self.stopPolicy = stopPolicy
        self.startedAt = startedAt
    }

    func start() {
        guard state == .idle else { return }
        transition(to: .starting)

        let callbackSessionID = id
        let callbackGeneration = generation
        terminalDriver.onProcessTerminated = { [weak self] rawStatus in
            self?.receiveNaturalTermination(
                rawStatus: rawStatus,
                sessionID: callbackSessionID,
                generation: callbackGeneration
            )
        }
        terminalDriver.start(specification)

        let pid = terminalDriver.processIdentifier
        guard pid > 1 else {
            finish(with: .launchFailed("SwiftTerm did not create a PTY child"))
            return
        }

        let candidate = TerminalLaunchCandidate(
            sessionID: id,
            generation: generation,
            processIdentifier: pid
        )
        launchCandidate = candidate

        if let pendingNaturalTermination {
            self.pendingNaturalTermination = nil
            receiveNaturalTermination(
                rawStatus: pendingNaturalTermination.rawStatus,
                sessionID: pendingNaturalTermination.sessionID,
                generation: pendingNaturalTermination.generation,
                observedProcessIdentifier: pendingNaturalTermination.processIdentifier
            )
            if case .ended = state { return }
        }

        let initialPGID = processGroupResolver.processGroupIdentifier(for: pid)
        lastObservedProcessGroup = initialPGID
        if initialPGID == pid {
            confirmOwnership(candidate, processGroupIdentifier: pid)
            return
        }

        let task = beginOwnershipStabilization(for: candidate, initialPGID: initialPGID)
        if let attemptID = ownershipAttemptID {
            observeOwnershipResolution(task, for: candidate, attemptID: attemptID)
        }
    }

    func send(_ data: Data) {
        guard state == .running else { return }
        terminalDriver.send(Array(data))
    }

    func send(text: String) {
        send(Data(text.utf8))
    }

    func sendControlC() {
        send(Data([0x03]))
    }

    func resize(to size: NSSize) {
        terminalDriver.resize(to: size)
    }

    @discardableResult
    func stop() async -> TerminalStopResult {
        if let stopTask {
            return await stopTask.value
        }

        switch state {
        case .idle:
            return .notRunning
        case .starting:
            guard let candidate = launchCandidate else { return .notRunning }
            stopRequestedWhileStarting = true
            let task = Task { @MainActor [weak self] in
                guard let self else { return TerminalStopResult.notRunning }
                return await self.stopWhileStarting(candidate)
            }
            return await awaitStopTask(task)
        case .stopping:
            guard pendingCleanupFailure != nil,
                  let identity = processIdentity,
                  isCurrentStopping(identity) else {
                return .alreadyStopping
            }
            let task = Task { @MainActor [weak self] in
                guard let self else { return TerminalStopResult.notRunning }
                return await self.retryPendingCleanup(identity)
            }
            return await awaitStopTask(task)
        case .ended(let termination):
            return .alreadyEnded(termination)
        case .running:
            break
        }

        guard let identity = processIdentity,
              identity.sessionID == id,
              identity.generation == generation,
              identity.processIdentifier > 1,
              identity.processGroupIdentifier == identity.processIdentifier else {
            return .invalidOwnership(
                pid: processIdentity?.processIdentifier ?? 0,
                pgid: processIdentity?.processGroupIdentifier
            )
        }

        let task = Task { @MainActor [weak self] in
            guard let self else { return TerminalStopResult.notRunning }
            return await self.stopConfirmedProcess(identity)
        }
        return await awaitStopTask(task)
    }

    private func stopWhileStarting(
        _ candidate: TerminalLaunchCandidate
    ) async -> TerminalStopResult {
        guard isCurrentCandidate(candidate) else {
            return stopResultForCurrentState()
        }

        let task = ownershipTask
            ?? beginOwnershipStabilization(
                for: candidate,
                initialPGID: processGroupResolver.processGroupIdentifier(
                    for: candidate.processIdentifier
                )
            )
        let attemptID = ownershipAttemptID
        let resolution = await task.value
        if let attemptID {
            applyOwnershipResolution(resolution, for: candidate, attemptID: attemptID)
        }

        switch resolution {
        case .confirmed:
            guard let identity = processIdentity,
                  identity.sessionID == candidate.sessionID,
                  identity.generation == candidate.generation,
                  identity.processIdentifier == candidate.processIdentifier else {
                return stopResultForCurrentState()
            }
            return await stopConfirmedProcess(identity)
        case .timedOut(let lastObservedProcessGroup):
            // The PID is only a launch candidate until PGID==PID. Keep observing
            // its natural-exit callback, send no signal, and let app termination
            // reply false rather than hanging or claiming a false end.
            self.lastObservedProcessGroup = lastObservedProcessGroup
            return .invalidOwnership(
                pid: candidate.processIdentifier,
                pgid: lastObservedProcessGroup
            )
        case .stale:
            return stopResultForCurrentState()
        }
    }

    private func stopConfirmedProcess(
        _ identity: TerminalProcessIdentity
    ) async -> TerminalStopResult {
        guard state == .running,
              processIdentity == identity,
              identity.sessionID == id,
              identity.generation == generation,
              identity.processIdentifier > 1,
              identity.processGroupIdentifier == identity.processIdentifier else {
            return stopResultForCurrentState()
        }

        transition(to: .stopping)
        pendingCleanupFailure = nil
        // Explicit cleanup makes one best-effort TERM attempt against the
        // confirmed live PTY group. It guarantees reaping only the direct leader.
        if !cleanupProgress.didSendGroupTerm {
            cleanupProgress.didSendGroupTerm = true
            _ = signaler.sendToProcessGroup(identity.processGroupIdentifier, signal: SIGTERM)
        }
        if !didTransferTerminationOwnership {
            didTransferTerminationOwnership = true
            terminalDriver.terminate()
        }

        return await reapAfterTerm(identity)
    }

    private func awaitStopTask(
        _ task: Task<TerminalStopResult, Never>
    ) async -> TerminalStopResult {
        stopTask = task
        let result = await task.value
        stopTask = nil
        stopRequestedWhileStarting = false
        return result
    }

    private func reapAfterTerm(_ identity: TerminalProcessIdentity) async -> TerminalStopResult {
        let graceStarted = clock.nowNanoseconds()
        let graceDeadline = addingWithoutOverflow(graceStarted, stopPolicy.gracePeriodNanoseconds)

        while isCurrentStopping(identity) {
            let waitResult = await childReaper.poll(processIdentifier: identity.processIdentifier)
            guard isCurrentStopping(identity) else { return .alreadyStopping }

            switch waitResult {
            case .reaped(let rawStatus):
                return finishReaped(rawStatus: rawStatus)
            case .noChild:
                return keepCleanupPending(.ownershipLost)
            case .failed(let errorNumber):
                return keepCleanupPending(.waitFailed(errorNumber))
            case .stillRunning:
                if clock.nowNanoseconds() >= graceDeadline {
                    return await escalateAndReap(identity)
                }
                await clock.sleep(nanoseconds: stopPolicy.pollIntervalNanoseconds)
            }
        }
        return .alreadyStopping
    }

    static func decodeWaitStatus(_ rawStatus: Int32?) -> TerminalTermination {
        guard let rawStatus, rawStatus >= 0 else {
            return .unknownWaitStatus(rawStatus)
        }

        let terminationSignal = rawStatus & 0x7f
        if terminationSignal == 0 {
            return .exited((rawStatus >> 8) & 0xff)
        }
        if terminationSignal != 0x7f {
            return .signaled(terminationSignal)
        }
        return .unknownWaitStatus(rawStatus)
    }

    private func beginOwnershipStabilization(
        for candidate: TerminalLaunchCandidate,
        initialPGID: pid_t?
    ) -> Task<OwnershipResolution, Never> {
        if let ownershipTask { return ownershipTask }

        let attemptID = UUID()
        ownershipAttemptID = attemptID
        let task = Task { @MainActor [weak self] in
            guard let self else { return OwnershipResolution.stale }
            return await self.stabilizeOwnership(
                of: candidate,
                initialPGID: initialPGID
            )
        }
        ownershipTask = task
        return task
    }

    private func stabilizeOwnership(
        of candidate: TerminalLaunchCandidate,
        initialPGID: pid_t?
    ) async -> OwnershipResolution {
        let startedAt = clock.nowNanoseconds()
        let deadline = addingWithoutOverflow(
            startedAt,
            stopPolicy.ownershipStabilizationTimeoutNanoseconds
        )
        var observedPGID = initialPGID

        while isCurrentCandidate(candidate) {
            lastObservedProcessGroup = observedPGID
            if observedPGID == candidate.processIdentifier {
                return .confirmed(processGroupIdentifier: candidate.processIdentifier)
            }
            if Task.isCancelled {
                return .stale
            }
            if clock.nowNanoseconds() >= deadline {
                return .timedOut(lastObservedProcessGroup: observedPGID)
            }

            await clock.sleep(nanoseconds: stopPolicy.ownershipPollIntervalNanoseconds)
            guard !Task.isCancelled, isCurrentCandidate(candidate) else {
                return .stale
            }
            observedPGID = processGroupResolver.processGroupIdentifier(
                for: candidate.processIdentifier
            )
        }
        return .stale
    }

    private func observeOwnershipResolution(
        _ task: Task<OwnershipResolution, Never>,
        for candidate: TerminalLaunchCandidate,
        attemptID: UUID
    ) {
        Task { @MainActor [weak self] in
            let resolution = await task.value
            self?.applyOwnershipResolution(
                resolution,
                for: candidate,
                attemptID: attemptID
            )
        }
    }

    private func applyOwnershipResolution(
        _ resolution: OwnershipResolution,
        for candidate: TerminalLaunchCandidate,
        attemptID: UUID
    ) {
        guard ownershipAttemptID == attemptID else { return }
        ownershipTask = nil
        ownershipAttemptID = nil
        guard isCurrentCandidate(candidate) else { return }

        switch resolution {
        case .confirmed(let processGroupIdentifier):
            confirmOwnership(
                candidate,
                processGroupIdentifier: processGroupIdentifier
            )
        case .timedOut(let lastObservedProcessGroup):
            self.lastObservedProcessGroup = lastObservedProcessGroup
        case .stale:
            break
        }
    }

    private func confirmOwnership(
        _ candidate: TerminalLaunchCandidate,
        processGroupIdentifier: pid_t
    ) {
        guard isCurrentCandidate(candidate),
              candidate.processIdentifier > 1,
              processGroupIdentifier == candidate.processIdentifier else {
            return
        }
        processIdentity = TerminalProcessIdentity(
            sessionID: candidate.sessionID,
            generation: candidate.generation,
            processIdentifier: candidate.processIdentifier,
            processGroupIdentifier: processGroupIdentifier
        )
        launchCandidate = nil
        lastObservedProcessGroup = processGroupIdentifier
        transition(to: .running)
    }

    private func receiveNaturalTermination(
        rawStatus: Int32?,
        sessionID: UUID,
        generation: UInt64,
        observedProcessIdentifier: pid_t? = nil
    ) {
        guard sessionID == id, generation == self.generation else { return }
        let observedPID = observedProcessIdentifier ?? terminalDriver.processIdentifier

        if state == .starting, launchCandidate == nil, processIdentity == nil {
            pendingNaturalTermination = PendingNaturalTermination(
                sessionID: sessionID,
                generation: generation,
                processIdentifier: observedPID,
                rawStatus: rawStatus
            )
            return
        }

        switch state {
        case .starting:
            guard let candidate = launchCandidate,
                  candidate.sessionID == sessionID,
                  candidate.generation == generation,
                  candidate.processIdentifier == observedPID else {
                return
            }
        case .running:
            guard let identity = processIdentity,
                  identity.sessionID == sessionID,
                  identity.generation == generation,
                  identity.processIdentifier == observedPID else {
                return
            }
        case .idle, .stopping, .ended:
            return
        }

        // SwiftTerm's natural-exit monitor already reaped the direct PTY leader.
        // Calling terminate or signaling its former PGID here could target a
        // reused identity, so same-PGID descendants are deliberately left alone.
        finish(with: Self.decodeWaitStatus(rawStatus))
    }

    private func isCurrentCandidate(_ candidate: TerminalLaunchCandidate) -> Bool {
        state == .starting
            && launchCandidate == candidate
            && candidate.sessionID == id
            && candidate.generation == generation
            && candidate.processIdentifier > 1
    }

    private func stopResultForCurrentState() -> TerminalStopResult {
        switch state {
        case .idle:
            return .notRunning
        case .starting:
            return .invalidOwnership(
                pid: launchCandidate?.processIdentifier ?? 0,
                pgid: lastObservedProcessGroup
            )
        case .running:
            return .invalidOwnership(
                pid: processIdentity?.processIdentifier ?? 0,
                pgid: processIdentity?.processGroupIdentifier
            )
        case .stopping:
            return .alreadyStopping
        case .ended(let termination):
            return .alreadyEnded(termination)
        }
    }

    private func escalateAndReap(
        _ identity: TerminalProcessIdentity
    ) async -> TerminalStopResult {
        guard isCurrentStopping(identity) else { return .alreadyStopping }

        // The immediately preceding waitpid returned zero, so the direct PTY
        // leader is still our unreaped child. Only that proof authorizes group
        // KILL; after leader reap we fail closed rather than risk PGID reuse.
        let groupKillResult: POSIXSignalResult
        if let attemptedResult = cleanupProgress.groupKillResult {
            groupKillResult = attemptedResult
        } else {
            groupKillResult = signaler.sendToProcessGroup(
                identity.processGroupIdentifier,
                signal: SIGKILL
            )
            cleanupProgress.groupKillResult = groupKillResult
        }

        if case .failure = groupKillResult, !cleanupProgress.didSendDirectKill {
            // A direct-child fallback is allowed only after a fresh ownership
            // proof. ECHILD and all wait errors fail closed.
            let ownershipCheck = await childReaper.poll(processIdentifier: identity.processIdentifier)
            guard isCurrentStopping(identity) else { return .alreadyStopping }
            switch ownershipCheck {
            case .stillRunning:
                cleanupProgress.didSendDirectKill = true
                _ = signaler.sendToProcess(identity.processIdentifier, signal: SIGKILL)
            case .reaped(let rawStatus):
                return finishReaped(rawStatus: rawStatus)
            case .noChild:
                return keepCleanupPending(.ownershipLost)
            case .failed(let errorNumber):
                return keepCleanupPending(.waitFailed(errorNumber))
            }
        }

        return await reapAfterKill(identity)
    }

    private func reapAfterKill(_ identity: TerminalProcessIdentity) async -> TerminalStopResult {
        let reapStarted = clock.nowNanoseconds()
        let reapDeadline = addingWithoutOverflow(
            reapStarted,
            stopPolicy.postKillReapTimeoutNanoseconds
        )
        while isCurrentStopping(identity) {
            let waitResult = await childReaper.poll(processIdentifier: identity.processIdentifier)
            guard isCurrentStopping(identity) else { return .alreadyStopping }
            switch waitResult {
            case .reaped(let rawStatus):
                return finishReaped(rawStatus: rawStatus)
            case .noChild:
                return keepCleanupPending(.ownershipLost)
            case .failed(let errorNumber):
                return keepCleanupPending(.waitFailed(errorNumber))
            case .stillRunning:
                if clock.nowNanoseconds() >= reapDeadline {
                    return keepCleanupPending(.reapTimedOut)
                }
                await clock.sleep(nanoseconds: stopPolicy.pollIntervalNanoseconds)
            }
        }
        return .alreadyStopping
    }

    private func retryPendingCleanup(
        _ identity: TerminalProcessIdentity
    ) async -> TerminalStopResult {
        guard isCurrentStopping(identity), pendingCleanupFailure != nil else {
            return stopResultForCurrentState()
        }
        if case .ownershipLost? = pendingCleanupFailure {
            // ECHILD permanently ends our waitpid ownership. Polling this PID
            // again could reap an unrelated child after PID reuse, so retries
            // become terminal fail-closed before any wait or signal operation.
            return .ownershipLost
        }

        // Recoverable retries start with a fresh waitpid proof. Errors retain
        // ownership state but never authorize another signal.
        let waitResult = await childReaper.poll(processIdentifier: identity.processIdentifier)
        guard isCurrentStopping(identity) else { return .alreadyStopping }
        switch waitResult {
        case .reaped(let rawStatus):
            return finishReaped(rawStatus: rawStatus)
        case .noChild:
            return keepCleanupPending(.ownershipLost)
        case .failed(let errorNumber):
            return keepCleanupPending(.waitFailed(errorNumber))
        case .stillRunning:
            pendingCleanupFailure = nil
            if cleanupProgress.groupKillResult == nil {
                return await escalateAndReap(identity)
            }
            if case .failure? = cleanupProgress.groupKillResult,
               !cleanupProgress.didSendDirectKill {
                cleanupProgress.didSendDirectKill = true
                _ = signaler.sendToProcess(identity.processIdentifier, signal: SIGKILL)
            }
            return await reapAfterKill(identity)
        }
    }

    private func isCurrentStopping(_ identity: TerminalProcessIdentity) -> Bool {
        state == .stopping
            && processIdentity == identity
            && identity.sessionID == id
            && identity.generation == generation
    }

    private func finishReaped(rawStatus: Int32) -> TerminalStopResult {
        // The direct leader is now reaped. Never signal its former group after
        // this point; TERM-ignoring descendants are outside the safe guarantee.
        let termination = Self.decodeWaitStatus(rawStatus)
        finish(with: termination)
        return .reaped(termination)
    }

    private func keepCleanupPending(_ failure: TerminalStopResult) -> TerminalStopResult {
        pendingCleanupFailure = failure
        return failure
    }

    private func finish(with termination: TerminalTermination) {
        ownershipTask?.cancel()
        ownershipTask = nil
        ownershipAttemptID = nil
        launchCandidate = nil
        processIdentity = nil
        pendingNaturalTermination = nil
        stopRequestedWhileStarting = false
        cleanupProgress = ExplicitCleanupProgress()
        pendingCleanupFailure = nil
        didTransferTerminationOwnership = false
        terminalDriver.onProcessTerminated = nil
        transition(to: .ended(termination))
    }

    private func transition(to newState: TerminalSessionState) {
        state = newState
        onStateChange?(newState)
    }

    private func addingWithoutOverflow(_ lhs: UInt64, _ rhs: UInt64) -> UInt64 {
        let (result, overflow) = lhs.addingReportingOverflow(rhs)
        return overflow ? UInt64.max : result
    }
}

/// Immutable metadata safe for all-task activity aggregation. Process identity,
/// arguments, environment, prompt, command, and terminal content stay private to
/// the owning session.
struct TerminalSessionSnapshot: Identifiable, Equatable, Sendable {
    let id: UUID
    let taskID: String
    let generation: UInt64
    let agent: AgentKind
    let state: TerminalSessionState
    let startedAt: Date
}

enum TerminalSessionManagerError: LocalizedError, Equatable {
    case sessionAlreadyActive(String)

    var errorDescription: String? {
        switch self {
        case .sessionAlreadyActive(let taskID):
            "Task \(taskID) already has an active terminal session."
        }
    }
}

@MainActor
final class TerminalSessionManager: ObservableObject {
    typealias SessionFactory = @MainActor (
        _ taskID: String,
        _ generation: UInt64,
        _ specification: AgentLaunchSpecification
    ) -> TerminalSession

    @Published private(set) var sessions: [String: TerminalSession] = [:]

    var hasActiveSessions: Bool {
        sessions.values.contains { $0.state.isActive }
    }

    private var generations: [String: UInt64] = [:]
    private let sessionFactory: SessionFactory

    init(sessionFactory: SessionFactory? = nil) {
        self.sessionFactory = sessionFactory ?? { taskID, generation, specification in
            TerminalSession(
                taskID: taskID,
                generation: generation,
                specification: specification
            )
        }
    }

    func session(for taskID: String) -> TerminalSession? {
        sessions[taskID]
    }

    func snapshot() -> [TerminalSessionSnapshot] {
        sessions.values
            .map { session in
                TerminalSessionSnapshot(
                    id: session.id,
                    taskID: session.taskID,
                    generation: session.generation,
                    agent: session.specification.agent,
                    state: session.state,
                    startedAt: session.startedAt
                )
            }
            .sorted { lhs, rhs in
                if lhs.taskID != rhs.taskID {
                    return lhs.taskID.localizedStandardCompare(rhs.taskID) == .orderedAscending
                }
                return lhs.generation < rhs.generation
            }
    }

    @discardableResult
    func start(
        taskID: String,
        specification: AgentLaunchSpecification
    ) throws -> TerminalSession {
        if let existing = sessions[taskID], existing.state.isActive {
            throw TerminalSessionManagerError.sessionAlreadyActive(taskID)
        }

        let generation = (generations[taskID] ?? 0) &+ 1
        generations[taskID] = generation
        let session = sessionFactory(taskID, generation, specification)
        sessions[taskID] = session
        session.start()
        return session
    }

    func stop(taskID: String) async -> TerminalStopResult {
        guard let session = sessions[taskID] else { return .notRunning }
        return await session.stop()
    }

    func stopAll() async -> [String: TerminalStopResult] {
        let activeSessions = sessions.filter { $0.value.state.isActive }
        return await withTaskGroup(of: (String, TerminalStopResult).self) { group in
            for (taskID, session) in activeSessions {
                group.addTask {
                    (taskID, await session.stop())
                }
            }

            var results: [String: TerminalStopResult] = [:]
            for await (taskID, result) in group {
                results[taskID] = result
            }
            return results
        }
    }
}
