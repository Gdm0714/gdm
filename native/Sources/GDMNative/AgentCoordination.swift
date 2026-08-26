import Combine
import Foundation

enum AgentSemanticState: String, Codable, Equatable, Sendable {
    case starting
    case working
    case needsYou
    case handingOff
    case verifying
    case completed
    case failed

    var activityState: AgentActivityState {
        switch self {
        case .starting: .starting
        case .working: .active
        case .needsYou: .needsYou
        case .handingOff: .handingOff
        case .verifying: .verifying
        case .completed: .ended
        case .failed: .interrupted
        }
    }
}

enum AgentEventKind: String, Codable, Equatable, Sendable {
    case started
    case working
    case needsInput
    case resumed
    case handoffRequested
    case verifying
    case completed
    case failed
    case heartbeat
}

struct AgentEventEnvelope: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1
    static let maximumSummaryBytes = 512
    static let maximumRelativePaths = 16
    static let maximumRelativePathBytes = 1_024

    let schemaVersion: Int
    let runToken: String
    /// Optional on the wire because the child receives its unguessable run
    /// token before TerminalSession exposes the host-created UUID. If present,
    /// it is verified and can never select a different run.
    let sessionID: UUID?
    let taskID: String
    let laneID: String
    let generation: UInt64
    let sequence: UInt64
    let kind: AgentEventKind
    let summary: String?
    let relativePaths: [String]

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case runToken = "run_token"
        case sessionID = "session_id"
        case taskID = "task_id"
        case laneID = "lane_id"
        case generation
        case sequence
        case kind
        case summary
        case relativePaths = "relative_paths"
    }
}

enum AgentEventRejection: String, Codable, Equatable, Sendable {
    case unsupportedSchema
    case unknownRun
    case staleIdentity
    case replayedSequence
    case invalidPayload
}

struct AgentEventReceipt: Codable, Equatable, Sendable {
    let accepted: Bool
    let rejection: AgentEventRejection?
    let lastSequence: UInt64?

    static func accepted(sequence: UInt64) -> Self {
        Self(accepted: true, rejection: nil, lastSequence: sequence)
    }

    static func rejected(_ reason: AgentEventRejection, lastSequence: UInt64? = nil) -> Self {
        Self(accepted: false, rejection: reason, lastSequence: lastSequence)
    }
}

struct AgentRunIdentity: Hashable, Equatable, Sendable {
    let sessionID: UUID
    let taskID: String
    let laneID: String
    let generation: UInt64
}

/// An advisory collaboration role for agents sharing a worktree. This role is
/// not a filesystem permission or an OS-level write lock.
enum AgentCoordinationRole: String, Equatable, Sendable {
    case primary
    case secondary
}

enum AgentCoordinationHandoffResult: Equatable, Sendable {
    case acquired
    case alreadyOwned
    case conflict(owner: AgentRunIdentity)
    case handedOff
    case staleOwner
    case incompatibleWorktree
}

struct AgentCoordinationStatus: Equatable, Sendable {
    let identity: AgentRunIdentity
    let semanticState: AgentSemanticState
    let summary: String?
    let coordinationRole: AgentCoordinationRole
    let ownsInput: Bool
    let lastSequence: UInt64
}

struct CoordinationRoleRegistry: Sendable {
    private struct Assignment: Equatable, Sendable {
        let owner: AgentRunIdentity
        let worktreePath: String
    }

    private var assignments: [String: Assignment] = [:]

    func role(for identity: AgentRunIdentity, worktreePath: String) -> AgentCoordinationRole {
        let path = Self.canonical(worktreePath)
        guard let assignment = assignments[path] else { return .primary }
        return assignment.owner == identity ? .primary : .secondary
    }

    mutating func acquire(
        _ identity: AgentRunIdentity,
        worktreePath: String
    ) -> AgentCoordinationHandoffResult {
        let path = Self.canonical(worktreePath)
        if let current = assignments[path] {
            return current.owner == identity
                ? .alreadyOwned
                : .conflict(owner: current.owner)
        }
        assignments[path] = Assignment(owner: identity, worktreePath: path)
        return .acquired
    }

    mutating func handoff(
        from currentOwner: AgentRunIdentity,
        to newOwner: AgentRunIdentity,
        worktreePath: String
    ) -> AgentCoordinationHandoffResult {
        let path = Self.canonical(worktreePath)
        guard let current = assignments[path], current.owner == currentOwner else {
            return .staleOwner
        }
        guard currentOwner.taskID == newOwner.taskID else {
            return .incompatibleWorktree
        }
        assignments[path] = Assignment(owner: newOwner, worktreePath: path)
        return .handedOff
    }

    mutating func release(_ identity: AgentRunIdentity, worktreePath: String) {
        let path = Self.canonical(worktreePath)
        guard assignments[path]?.owner == identity else { return }
        assignments.removeValue(forKey: path)
    }

    func owner(worktreePath: String) -> AgentRunIdentity? {
        assignments[Self.canonical(worktreePath)]?.owner
    }

    private static func canonical(_ path: String) -> String {
        URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL.path
    }
}

@MainActor
final class AgentCoordinator: ObservableObject {
    private struct RunRecord: Sendable {
        let identity: AgentRunIdentity
        let token: String
        let worktreePath: String
        var semanticState: AgentSemanticState
        var summary: String?
        var lastSequence: UInt64
    }

    @Published private(set) var revision: UInt64 = 0

    private var runsByToken: [String: RunRecord] = [:]
    private var tokensByIdentity: [AgentRunIdentity: String] = [:]
    private var newestGenerationByLane: [TerminalSessionLaneKey: UInt64] = [:]
    private var coordinationRoles = CoordinationRoleRegistry()
    private var inputOwner: AgentRunIdentity?

    static func makeRunToken() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "")
            + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }

    func predictedCoordinationRole(
        taskID _: String,
        worktreePath: String
    ) -> AgentCoordinationRole {
        coordinationRoles.owner(worktreePath: worktreePath) == nil ? .primary : .secondary
    }

    @discardableResult
    func register(
        identity: AgentRunIdentity,
        runToken: String,
        worktreePath: String
    ) -> Bool {
        let lane = TerminalSessionLaneKey(taskID: identity.taskID, laneID: identity.laneID)
        guard runToken.utf8.count >= 32,
              identity.generation > (newestGenerationByLane[lane] ?? 0) else { return false }

        if let oldToken = tokensByIdentity.first(where: {
            $0.key.taskID == identity.taskID && $0.key.laneID == identity.laneID
        })?.value {
            removeRun(token: oldToken)
        }
        newestGenerationByLane[lane] = identity.generation
        let record = RunRecord(
            identity: identity,
            token: runToken,
            worktreePath: worktreePath,
            semanticState: .starting,
            summary: nil,
            lastSequence: 0
        )
        runsByToken[runToken] = record
        tokensByIdentity[identity] = runToken
        _ = coordinationRoles.acquire(identity, worktreePath: worktreePath)
        changed()
        return true
    }

    func accept(_ event: AgentEventEnvelope) -> AgentEventReceipt {
        guard event.schemaVersion == AgentEventEnvelope.currentSchemaVersion else {
            return .rejected(.unsupportedSchema)
        }
        guard var record = runsByToken[event.runToken] else {
            return .rejected(.unknownRun)
        }
        guard (event.sessionID == nil || record.identity.sessionID == event.sessionID),
              record.identity.taskID == event.taskID,
              record.identity.laneID == event.laneID,
              record.identity.generation == event.generation else {
            return .rejected(.staleIdentity, lastSequence: record.lastSequence)
        }
        guard event.sequence > record.lastSequence else {
            return .rejected(.replayedSequence, lastSequence: record.lastSequence)
        }
        guard Self.payloadIsValid(event) else {
            return .rejected(.invalidPayload, lastSequence: record.lastSequence)
        }

        record.lastSequence = event.sequence
        if event.kind != .heartbeat {
            record.semanticState = Self.semanticState(for: event.kind)
            record.summary = event.summary
        }
        runsByToken[event.runToken] = record
        if event.kind == .completed || event.kind == .failed {
            coordinationRoles.release(record.identity, worktreePath: record.worktreePath)
            if inputOwner == record.identity { inputOwner = nil }
        }
        changed()
        return .accepted(sequence: event.sequence)
    }

    /// Advances the host-owned launch state without overwriting a richer
    /// semantic event that the agent may already have emitted.
    func terminalDidStart(sessionID: UUID) {
        guard let token = runsByToken.first(where: {
            $0.value.identity.sessionID == sessionID
        })?.key,
        var record = runsByToken[token],
        record.semanticState == .starting else { return }
        record.semanticState = .working
        runsByToken[token] = record
        changed()
    }

    func status(
        taskID: String,
        laneID: String,
        generation: UInt64
    ) -> AgentCoordinationStatus? {
        let identity = tokensByIdentity.keys.first {
            $0.taskID == taskID && $0.laneID == laneID && $0.generation == generation
        }
        guard let identity,
              let token = tokensByIdentity[identity],
              let record = runsByToken[token] else { return nil }
        return AgentCoordinationStatus(
            identity: identity,
            semanticState: record.semanticState,
            summary: record.summary,
            coordinationRole: coordinationRoles.role(
                for: identity,
                worktreePath: record.worktreePath
            ),
            ownsInput: inputOwner == identity,
            lastSequence: record.lastSequence
        )
    }

    func activeStatuses(taskID: String? = nil) -> [AgentCoordinationStatus] {
        runsByToken.values.compactMap { record in
            guard taskID == nil || record.identity.taskID == taskID else { return nil }
            return AgentCoordinationStatus(
                identity: record.identity,
                semanticState: record.semanticState,
                summary: record.summary,
                coordinationRole: coordinationRoles.role(
                    for: record.identity,
                    worktreePath: record.worktreePath
                ),
                ownsInput: inputOwner == record.identity,
                lastSequence: record.lastSequence
            )
        }.sorted {
            if $0.identity.taskID != $1.identity.taskID {
                return $0.identity.taskID < $1.identity.taskID
            }
            return $0.identity.laneID < $1.identity.laneID
        }
    }

    func claimInput(_ identity: AgentRunIdentity) -> Bool {
        guard tokensByIdentity[identity] != nil else { return false }
        inputOwner = identity
        changed()
        return true
    }

    @discardableResult
    func handoffCoordinationRole(
        from currentOwner: AgentRunIdentity,
        to newOwner: AgentRunIdentity
    ) -> AgentCoordinationHandoffResult {
        guard let currentToken = tokensByIdentity[currentOwner],
              let current = runsByToken[currentToken],
              let targetToken = tokensByIdentity[newOwner],
              let target = runsByToken[targetToken],
              current.worktreePath == target.worktreePath else {
            return .incompatibleWorktree
        }
        let result = coordinationRoles.handoff(
            from: currentOwner,
            to: newOwner,
            worktreePath: current.worktreePath
        )
        if result == .handedOff {
            var updatedCurrent = current
            updatedCurrent.semanticState = .handingOff
            runsByToken[currentToken] = updatedCurrent
            changed()
        }
        return result
    }

    func finish(sessionID: UUID) {
        guard let token = runsByToken.first(where: {
            $0.value.identity.sessionID == sessionID
        })?.key else { return }
        removeRun(token: token)
        changed()
    }

    private func removeRun(token: String) {
        guard let record = runsByToken.removeValue(forKey: token) else { return }
        tokensByIdentity.removeValue(forKey: record.identity)
        coordinationRoles.release(record.identity, worktreePath: record.worktreePath)
        if inputOwner == record.identity { inputOwner = nil }
    }

    private func changed() { revision &+= 1 }

    private static func semanticState(for kind: AgentEventKind) -> AgentSemanticState {
        switch kind {
        case .started: .starting
        case .working, .resumed, .heartbeat: .working
        case .needsInput: .needsYou
        case .handoffRequested: .handingOff
        case .verifying: .verifying
        case .completed: .completed
        case .failed: .failed
        }
    }

    private static func payloadIsValid(_ event: AgentEventEnvelope) -> Bool {
        guard event.summary?.utf8.count ?? 0 <= AgentEventEnvelope.maximumSummaryBytes,
              event.relativePaths.count <= AgentEventEnvelope.maximumRelativePaths else {
            return false
        }
        return event.relativePaths.allSatisfy { path in
            guard !path.isEmpty,
                  path.utf8.count <= AgentEventEnvelope.maximumRelativePathBytes,
                  !path.hasPrefix("/"),
                  !path.contains("\0") else { return false }
            let components = NSString(string: path).pathComponents
            return !components.contains("..")
        }
    }
}
