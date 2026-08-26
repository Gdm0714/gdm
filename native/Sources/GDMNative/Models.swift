import CryptoKit
import Foundation

enum GidemPreferences {
    static let lastRepositoryPathKey = "GidemLastRepositoryPath"
}

struct EvidenceRecord: Codable, Equatable, Sendable {
    let observed: String
    let sha256: String
    let exitCode: Int?
    let manual: Bool
    let note: String?
    let reviewer: String?
    let at: String
}

struct CheckRecord: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let desc: String
    let cmd: String?
    let expect: String
    let manual: Bool
    let kind: String?
    let expert: Bool?
    let status: String
    let redEvidence: EvidenceRecord?
    let evidence: EvidenceRecord?

    var isProven: Bool { status == "proven" }
    var isRegression: Bool { kind == "regression" }
}

struct WorkContractRecord: Codable, Equatable, Sendable {
    let required: [String]
    let forbidden: [String]
    let commit: String?
    var assumptions: [String]? = nil
    var uncertainties: [String]? = nil
    var allowedPaths: [String]? = nil
    var forbiddenPaths: [String]? = nil
    var stopConditions: [String]? = nil
    let risk: String?
    let verification: String?
    var simplificationRequired: Bool? = nil
}

struct AuditRecord: Codable, Equatable, Sendable {
    let result: String
    let report: String
    let at: String
}

struct DeliveryRecord: Codable, Equatable, Sendable {
    struct PullRequest: Codable, Equatable, Sendable {
        let number: String
        let head: String
        let at: String
    }

    struct ContinuousIntegration: Codable, Equatable, Sendable {
        let status: String
        let head: String
        let run: String
        let at: String
    }

    struct MergeApproval: Codable, Equatable, Sendable {
        let head: String
        let reason: String
        let at: String
    }

    struct Merge: Codable, Equatable, Sendable {
        let sha: String
        let at: String
    }

    let issue: String
    let branch: String
    let head: String
    let preparedAt: String
    let pr: PullRequest?
    let ci: ContinuousIntegration?
    let mergeApproval: MergeApproval?
    let merged: Merge?
}

struct WorkDocument: Codable, Identifiable, Equatable, Sendable {
    var id: String { slug }

    let slug: String
    let brief: String
    let createdAt: String
    let done: Bool
    let doneAt: String?
    let auditRequired: Bool?
    let audit: AuditRecord?
    let delivery: DeliveryRecord?
    let checks: [CheckRecord]
    let contract: WorkContractRecord
    var verificationPlanSourceFingerprint: String? = nil

    var provenCount: Int { checks.filter(\.isProven).count }
    var allChecksProven: Bool { !checks.isEmpty && checks.allSatisfy(\.isProven) }
    /// A stable revision of the verification contract only. Runtime status and
    /// evidence are deliberately excluded so proving a check does not revoke
    /// the user's approval of the plan that defined it.
    var verificationPlanFingerprint: String? {
        guard !checks.isEmpty else { return nil }
        var encoder = VerificationPlanFingerprintEncoder()
        encoder.appendString("gidem-verification-plan-v1")
        encoder.appendString(brief)
        encoder.appendBool(auditRequired ?? false)
        encoder.appendStrings(contract.required)
        encoder.appendStrings(contract.forbidden)
        encoder.appendString(contract.commit ?? "forbidden")
        encoder.appendStrings(contract.assumptions ?? [])
        encoder.appendStrings(contract.uncertainties ?? [])
        encoder.appendStrings(contract.allowedPaths ?? ["."])
        encoder.appendStrings(contract.forbiddenPaths ?? [])
        encoder.appendStrings(contract.stopConditions ?? [])
        encoder.appendString(contract.risk ?? "low")
        encoder.appendString(contract.verification ?? "deterministic")
        encoder.appendBool(contract.simplificationRequired ?? false)
        encoder.appendUInt64(UInt64(checks.count))
        for check in checks {
            encoder.appendString(check.id)
            encoder.appendString(check.desc)
            encoder.appendNullableString(check.cmd)
            encoder.appendString(check.expect)
            encoder.appendBool(check.manual)
            encoder.appendString(check.kind ?? (check.manual ? "manual" : "behavior"))
            encoder.appendBool(check.expert ?? false)
        }
        return SHA256.hash(data: encoder.data)
            .map { String(format: "%02x", $0) }
            .joined()
    }
    var auditPassed: Bool { audit?.result == "pass" }
    var canComplete: Bool {
        allChecksProven && (!(auditRequired ?? false) || auditPassed)
    }

    var blockers: [ProofBlocker] {
        var result: [ProofBlocker] = []
        if checks.isEmpty {
            result.append(ProofBlocker(
                glyph: "○",
                message: "검증 항목이 아직 정의되지 않았습니다.",
                tone: .attention
            ))
        }
        result += checks
            .filter { !$0.isProven }
            .map { ProofBlocker(glyph: "○", message: "\($0.id) \($0.desc) — 증거 없음", tone: .blocked) }
        if audit?.result == "fail" {
            result.append(ProofBlocker(glyph: "✕", message: "독립 검수 반려 — \(audit?.report ?? "사유 확인 필요")", tone: .blocked))
        } else if (auditRequired ?? false) && !auditPassed {
            result.append(ProofBlocker(glyph: "○", message: "High risk 독립 검수가 아직 없습니다", tone: .attention))
        }
        return result
    }
}

private struct VerificationPlanFingerprintEncoder {
    private(set) var data = Data()

    mutating func appendUInt64(_ value: UInt64) {
        for shift in stride(from: 56, through: 0, by: -8) {
            data.append(UInt8(truncatingIfNeeded: value >> UInt64(shift)))
        }
    }

    mutating func appendString(_ value: String) {
        let bytes = Data(value.utf8)
        appendUInt64(UInt64(bytes.count))
        data.append(bytes)
    }

    mutating func appendBool(_ value: Bool) {
        data.append(value ? 1 : 0)
    }

    mutating func appendStrings(_ values: [String]) {
        appendUInt64(UInt64(values.count))
        for value in values { appendString(value) }
    }

    mutating func appendNullableString(_ value: String?) {
        guard let value else {
            data.append(0)
            return
        }
        data.append(1)
        appendString(value)
    }
}

enum WorkspaceProvisioningPhase: String, Codable, Equatable, Sendable {
    case creating
    case ready
    case failed
}

enum PersistedSessionOutcome: String, Codable, Equatable, Sendable {
    case active
    case ended
    case interrupted
    case launchFailed

    var displayLabel: String {
        switch self {
        case .active: "active"
        case .ended: "ended"
        case .interrupted: "interrupted · not attached"
        case .launchFailed: "launch failed"
        }
    }
}

struct PersistedSessionRecord: Codable, Equatable, Sendable {
    let kind: String
    let startedAt: String
    var endedAt: String?
    var outcome: PersistedSessionOutcome
}

struct WorkspaceRegistryRecord: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    let slug: String
    let worktreePath: String
    let branch: String
    let baseOID: String
    let gitCommonDirectory: String
    var phase: WorkspaceProvisioningPhase
    var selectedAgent: String?
    var lastSession: PersistedSessionRecord?
    /// When present, this lane-keyed map is the canonical session history.
    /// `lastSession` remains a compatibility projection for older app builds.
    var sessionsByLane: [String: PersistedSessionRecord]? = nil
    var lastError: String?
    var layout: PaneLayoutRecord? = nil
    /// New native tasks require a human review before their generated check
    /// plan can drive implementation. `nil` preserves pre-gate workspaces.
    var checksApprovalRequired: Bool? = nil
    var approvedChecksFingerprint: String? = nil
    var checksApprovedAt: String? = nil
    let createdAt: String
}

struct WorkspaceRegistryDocument: Codable, Equatable, Sendable {
    var version: Int = 1
    var selectedTaskKey: String?
    var tasks: [WorkspaceRegistryRecord] = []
}

enum WorkspaceHealth: String, Equatable, Sendable {
    case ready
    case creating
    case failed
    case disconnected
    case conflicted
}

enum WorkspaceLocation: Equatable, Sendable {
    case legacyRoot(URL)
    case worktree(record: WorkspaceRegistryRecord, verifiedURL: URL)

    var workingDirectory: URL {
        switch self {
        case .legacyRoot(let url): url
        case .worktree(_, let url): url
        }
    }

    var registryRecord: WorkspaceRegistryRecord? {
        guard case .worktree(let record, _) = self else { return nil }
        return record
    }
}

struct WorkspaceTask: Identifiable, Equatable, Sendable {
    let id: String
    let slug: String
    let document: WorkDocument?
    let location: WorkspaceLocation
    let health: WorkspaceHealth
    let statusMessage: String?

    static func legacy(_ document: WorkDocument, root: URL) -> WorkspaceTask {
        WorkspaceTask(
            id: "legacy:\(document.slug)",
            slug: document.slug,
            document: document,
            location: .legacyRoot(root),
            health: .ready,
            statusMessage: nil
        )
    }

    static func mapped(
        record: WorkspaceRegistryRecord,
        document: WorkDocument?,
        health: WorkspaceHealth,
        message: String? = nil
    ) -> WorkspaceTask {
        WorkspaceTask(
            id: "worktree:\(record.id.uuidString.lowercased())",
            slug: record.slug,
            document: document,
            location: .worktree(record: record, verifiedURL: URL(fileURLWithPath: record.worktreePath, isDirectory: true)),
            health: health,
            statusMessage: message
        )
    }

    var workingDirectory: URL { location.workingDirectory }
    var branch: String? { location.registryRecord?.branch }
    var canMutate: Bool { health == .ready && document != nil }
}

enum SignalTone: String, Sendable {
    case proven
    case active
    case attention
    case blocked
    case neutral
}

/// The shared lifecycle vocabulary used by the Agent Activity strip, its
/// task rows, and the terminal selector. Agent liveness deliberately never
/// uses the proven (green) tone.
enum AgentActivityState: String, Equatable, Sendable {
    case unavailable
    case idle
    case starting
    case active
    case waiting
    case needsYou
    case handingOff
    case verifying
    case stopping
    case interrupted
    case launchFailed
    case ended

    var glyph: String {
        switch self {
        case .unavailable: "—"
        case .idle, .ended: "○"
        case .starting, .waiting: "◔"
        case .needsYou: "!"
        case .handingOff: "⇢"
        case .verifying: "◐"
        case .active: "●"
        case .stopping: "◑"
        case .interrupted: "⊘"
        case .launchFailed: "✕"
        }
    }

    var label: String {
        switch self {
        case .unavailable: "unavailable"
        case .idle: "idle"
        case .starting: "starting…"
        case .active: "active"
        case .waiting: "waiting for input"
        case .needsYou: "Needs You"
        case .handingOff: "handing off…"
        case .verifying: "verifying"
        case .stopping: "stopping…"
        case .interrupted: "interrupted · not attached"
        case .launchFailed: "launch failed"
        case .ended: "ended"
        }
    }

    var tone: SignalTone {
        switch self {
        case .starting, .active, .handingOff, .verifying:
            .active
        case .waiting, .needsYou, .stopping, .interrupted:
            .attention
        case .launchFailed:
            .blocked
        case .unavailable, .idle, .ended:
            .neutral
        }
    }

    /// Only process hand-off states pulse. Settled live states are static.
    var isUnsettled: Bool {
        self == .starting || self == .handingOff || self == .stopping
    }

    /// Counts sessions that are still live/owned, including bounded cleanup.
    /// This also controls whether the elapsed Timeline keeps ticking.
    var isRunning: Bool {
        switch self {
        case .starting, .active, .waiting, .needsYou, .handingOff, .verifying, .stopping: true
        case .unavailable, .idle, .interrupted, .launchFailed, .ended: false
        }
    }

    var summaryRank: Int {
        switch self {
        case .launchFailed: 0
        case .needsYou: 1
        case .waiting: 2
        case .interrupted: 3
        case .starting: 4
        case .handingOff: 5
        case .stopping: 6
        case .verifying: 7
        case .active: 8
        case .ended: 9
        case .idle: 10
        case .unavailable: 11
        }
    }
}

/// A safe, display-only task/session row. It intentionally has no PID,
/// prompt, command, environment, or terminal transcript fields.
struct AgentActivityItem: Identifiable, Equatable, Sendable {
    var id: String { laneID.map { "\(taskID)#\($0)" } ?? taskID }

    let taskID: String
    let laneID: String?
    let agent: AgentKind
    let state: AgentActivityState
    let taskSlug: String
    let branch: String?
    let worktreePath: String
    let startedAt: Date?
    let endedAt: Date?

    init(
        taskID: String,
        laneID: String? = nil,
        agent: AgentKind,
        state: AgentActivityState,
        taskSlug: String,
        branch: String?,
        worktreePath: String,
        startedAt: Date?,
        endedAt: Date?
    ) {
        self.taskID = taskID
        self.laneID = laneID
        self.agent = agent
        self.state = state
        self.taskSlug = taskSlug
        self.branch = branch
        self.worktreePath = worktreePath
        self.startedAt = startedAt
        self.endedAt = endedAt
    }

    func elapsedSeconds(at now: Date = Date()) -> Int? {
        guard let startedAt else { return nil }
        let effectiveEnd: Date
        if state.isRunning {
            effectiveEnd = now
        } else {
            guard let endedAt else { return nil }
            effectiveEnd = endedAt
        }
        return max(0, Int(effectiveEnd.timeIntervalSince(startedAt).rounded(.down)))
    }

    func elapsedLabel(at now: Date = Date()) -> String? {
        guard let totalSeconds = elapsedSeconds(at: now) else { return nil }
        let hours = totalSeconds / 3_600
        let minutes = (totalSeconds % 3_600) / 60
        let seconds = totalSeconds % 60
        let clock = hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
            : String(format: "%02d:%02d", minutes, seconds)
        return state.isRunning ? clock : "ran \(clock)"
    }
}

struct AgentActivitySummary: Identifiable, Equatable, Sendable {
    var id: AgentKind { agent }

    let agent: AgentKind
    let state: AgentActivityState
    let items: [AgentActivityItem]

    var runningCount: Int { items.filter(\.state.isRunning).count }

    var primaryItem: AgentActivityItem? {
        items.min { lhs, rhs in
            if lhs.state.summaryRank != rhs.state.summaryRank {
                return lhs.state.summaryRank < rhs.state.summaryRank
            }
            return lhs.taskSlug.localizedStandardCompare(rhs.taskSlug) == .orderedAscending
        }
    }
}

struct ProofBlocker: Identifiable, Equatable, Sendable {
    let id = UUID()
    let glyph: String
    let message: String
    let tone: SignalTone

    static func == (lhs: ProofBlocker, rhs: ProofBlocker) -> Bool {
        lhs.glyph == rhs.glyph && lhs.message == rhs.message && lhs.tone == rhs.tone
    }
}

enum TaskDisplayState: String, Sendable {
    case needsPlan = "PLAN NEEDED"
    case reviewPlan = "REVIEW PLAN"
    case planned = "READY"
    case working = "WORKING"
    case waitingInput = "WAITING FOR INPUT"
    case waitingCI = "WAITING CI"
    case verifying = "VERIFYING"
    case proven = "PROVEN"
    case blocked = "BLOCKED"
    case rejected = "REJECTED"
    case disconnected = "DISCONNECTED"

    var marker: String {
        switch self {
        case .proven: "✓"
        case .working: "▶"
        case .verifying: "◐"
        case .waitingInput, .waitingCI: "◔"
        case .blocked, .rejected: "✕"
        case .disconnected: "⊘"
        case .needsPlan: "○"
        case .reviewPlan: "◔"
        case .planned: "●"
        }
    }

    var tone: SignalTone {
        switch self {
        case .proven: .proven
        case .working, .verifying: .active
        case .needsPlan, .reviewPlan, .waitingInput, .waitingCI: .attention
        case .blocked, .rejected, .disconnected: .blocked
        case .planned: .neutral
        }
    }
}

enum VerificationPlanState: Equatable, Sendable {
    case unavailable
    case needsPlan
    case reviewRequired
    case approved
}

enum CheckDisplayState: Equatable, Sendable {
    case open
    case running
    case proven
    case redCaptured
    case failed

    var marker: String {
        switch self {
        case .proven, .redCaptured: "✓"
        case .running: "◐"
        case .open: "○"
        case .failed: "✕"
        }
    }

    var label: String {
        switch self {
        case .open: "OPEN · BLOCKS"
        case .running: "RUNNING"
        case .proven: "PROVEN"
        case .redCaptured: "RED CAPTURED"
        case .failed: "FAILED · BLOCKS"
        }
    }

    var tone: SignalTone {
        switch self {
        case .proven, .redCaptured: .proven
        case .running: .active
        case .open, .failed: .blocked
        }
    }
}

enum DrawerTab: String, CaseIterable, Sendable {
    case diff = "DIFF"
    case logs = "LOGS"
    case evidence = "EVIDENCE"
}

enum FocusedRegion: String, Sendable {
    case tasks = "TASKS"
    case terminal = "COMMAND SESSION"
    case proof = "PROOF RAIL"
    case drawer = "DRAWER"
}

enum CompactPane: String, CaseIterable, Sendable {
    case terminal = "TERMINAL"
    case proof = "PROOF RAIL"
    case drawer = "DIFF · LOGS · EVIDENCE"
}

enum SessionDisplayState: Sendable {
    case ready
    case running
    case waitingInput
    case disconnected
    case reconnecting

    var glyph: String {
        switch self {
        case .ready: "●"
        case .running: "◐"
        case .waitingInput: "◔"
        case .disconnected: "⊘"
        case .reconnecting: "◐"
        }
    }

    var label: String {
        switch self {
        case .ready: "ready"
        case .running: "running"
        case .waitingInput: "waiting for input"
        case .disconnected: "disconnected"
        case .reconnecting: "reconnecting"
        }
    }

    var tone: SignalTone {
        switch self {
        case .ready: .neutral
        case .running, .reconnecting: .active
        case .waitingInput: .attention
        case .disconnected: .blocked
        }
    }
}
