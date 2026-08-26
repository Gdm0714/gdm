import Combine
import Foundation

@MainActor
final class WorkspaceStore: ObservableObject {
    static let repositorySelectionRequiredMessage =
        "먼저 상단 폴더 버튼 또는 ⌘O로 Git repository의 최상위 폴더를 선택해 주세요."

    private struct DemoAgentOperation: Sendable {
        let agent: AgentKind
        let event: AgentEventKind
        let laneID: UUID
        let sessionID: UUID
        let runToken: String
        let summary: String
    }

    private static let demoAgentOperations: [DemoAgentOperation] = [
        DemoAgentOperation(
            agent: .codex,
            event: .needsInput,
            laneID: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
            sessionID: UUID(uuidString: "A1111111-1111-4111-8111-111111111111")!,
            runToken: String(repeating: "1", count: 64),
            summary: "Needs approval to replace the authentication fixture."
        ),
        DemoAgentOperation(
            agent: .claude,
            event: .working,
            laneID: UUID(uuidString: "22222222-2222-4222-8222-222222222222")!,
            sessionID: UUID(uuidString: "A2222222-2222-4222-8222-222222222222")!,
            runToken: String(repeating: "2", count: 64),
            summary: "Implementing the bounded retry path."
        ),
        DemoAgentOperation(
            agent: .gemini,
            event: .verifying,
            laneID: UUID(uuidString: "33333333-3333-4333-8333-333333333333")!,
            sessionID: UUID(uuidString: "A3333333-3333-4333-8333-333333333333")!,
            runToken: String(repeating: "3", count: 64),
            summary: "Running the focused regression checks."
        ),
        DemoAgentOperation(
            agent: .shell,
            event: .handoffRequested,
            laneID: UUID(uuidString: "44444444-4444-4444-8444-444444444444")!,
            sessionID: UUID(uuidString: "A4444444-4444-4444-8444-444444444444")!,
            runToken: String(repeating: "4", count: 64),
            summary: "Ready to hand primary coordination to Claude."
        )
    ]

    @Published var tasks: [WorkspaceTask] = []
    @Published var selectedTaskKey: String?
    @Published var branch = ""
    @Published var diffText = ""
    @Published var journalText = ""
    @Published var consoleText = ""
    @Published var errorMessage: String?
    @Published var workspaceWarnings: [String] = []
    @Published private var activeVerificationTaskKey: String?
    @Published private var activeVerificationCheckID: String?
    @Published private var failedCheckIDsByTask: [String: Set<String>] = [:]
    @Published var isLoading = false
    @Published var isCommandRunning = false
    @Published var isProvisioning = false
    @Published private(set) var isPlanApprovalPending = false
    @Published private(set) var provisioningStep: WorktreeProvisioningStep?
    @Published var sessionState: SessionDisplayState = .ready
    @Published var selectedAgent: AgentKind = .shell
    @Published private(set) var agentActivityItems: [AgentActivityItem] = []
    @Published private(set) var agentActivitySummaries: [AgentActivitySummary] = []
    @Published private(set) var agentActivityLiveCount = 0
    @Published var selectedDrawerTab: DrawerTab = .diff
    @Published var focusedRegion: FocusedRegion = .terminal
    @Published var compactPane: CompactPane = .terminal
    @Published var isTaskRailVisible = true
    @Published var isProofRailVisible = true
    @Published var isPalettePresented = false
    @Published var isNewTaskPresented = false
    @Published var areBlockersPresented = false

    @Published private(set) var repositoryURL: URL
    @Published private(set) var requiresRepositorySelection: Bool
    let isDemo: Bool
    let terminalSessions: TerminalSessionManager
    let agentCoordinator: AgentCoordinator
    let agentIconResolver: AgentIconResolver
    let workbench: WorkbenchState

    private var registry: WorkspaceRegistry
    private var worktreeService: WorktreeService
    private let gdmToolchain: Result<CommandInvocation, GDMToolchainLocatorError>
    private let agentCatalog: AgentCatalog
    private let commandRunner: WorktreeCommandRunner
    private let sourceFingerprintProvider: WorkspaceSourceFingerprintProvider?
    private let demoState: String?
    private var demoTaskStates: [String: TaskDisplayState] = [:]
    private var sessionStartedAt: [UUID: String] = [:]
    private var transientSessionRecords: [TerminalSessionLaneKey: PersistedSessionRecord] = [:]
    private var selectedAgentsByTask: [String: AgentKind] = [:]
    @Published private var pendingSessionLaunchKeys: Set<TerminalSessionLaneKey> = []
    private var pendingAutomationPrompts: [UUID: String] = [:]
    private var verificationPlanningSessionKeys: [String: TerminalSessionLaneKey] = [:]
    private var pendingVerificationPlanningTaskIDs: Set<String> = []
    private var transientPlanApprovalRequiredTaskIDs: Set<String> = []
    private var transientApprovedPlanFingerprints: [String: String] = [:]
    private var verificationPlanMonitorTasks: [String: Task<Void, Never>] = [:]
    private var verificationPlanMonitorIDs: [String: UUID] = [:]
    private var provisioningAttemptID: UUID?
    private var didRunRecovery = false
    private var repositoryGeneration: UInt64 = 0
    private var layoutPersistenceTask: Task<Void, Never>?
    private var agentEventServer: AgentEventSocketServer?

    init(
        repositoryURL: URL,
        requiresRepositorySelection: Bool = false,
        demoState: String? = nil,
        isDemo: Bool = false,
        terminalSessions: TerminalSessionManager = TerminalSessionManager(),
        commandRunner: WorktreeCommandRunner = .live,
        gdmInvocation: CommandInvocation? = nil,
        sourceFingerprintProvider: WorkspaceSourceFingerprintProvider? = nil,
        agentCatalog: AgentCatalog = AgentCatalog(),
        agentIconResolver: AgentIconResolver = AgentIconResolver(),
        workbench: WorkbenchState = WorkbenchState(),
        agentCoordinator: AgentCoordinator = AgentCoordinator()
    ) {
        self.repositoryURL = repositoryURL
        self.requiresRepositorySelection = requiresRepositorySelection
        self.isDemo = isDemo
        self.demoState = demoState
        self.registry = WorkspaceRegistry(repositoryURL: repositoryURL)
        let resolvedToolchain: Result<CommandInvocation, GDMToolchainLocatorError> = gdmInvocation
            .map(Result.success) ?? GDMToolchainLocator.resolve()
        self.gdmToolchain = resolvedToolchain
        self.worktreeService = WorktreeService(
            repositoryURL: repositoryURL,
            registry: registry,
            gdmInvocation: try? resolvedToolchain.get()
        )
        self.agentCatalog = agentCatalog
        self.agentIconResolver = agentIconResolver
        self.terminalSessions = terminalSessions
        self.agentCoordinator = agentCoordinator
        self.commandRunner = commandRunner
        self.sourceFingerprintProvider = sourceFingerprintProvider
            ?? (try? resolvedToolchain.get()).map {
                WorkspaceSourceFingerprintProvider.live(invocation: $0, runner: commandRunner)
            }
        self.workbench = workbench
        workbench.onLayoutChange = { [weak self] taskID, layout in
            self?.scheduleLayoutPersistence(taskID: taskID, layout: layout)
        }
        if isDemo {
            applyDemo(DemoData.workspace(state: demoState))
            activateWorkbench()
            if selectedTask != nil, !isAgentOperationsDemo {
                workbench.openFile(relativePath: "README.md")
            }
            if isAgentOperationsDemo {
                configureDemoAgentOperations()
            }
            if demoState == "split-overflow" {
                configureDemoSplitOverflow()
            }
            rebuildAgentActivity()
            if demoState == "worktree-loop-proof" {
                compactPane = .proof
                focusedRegion = .proof
            }
            if demoState == "no-checks-proof" || demoState == "review-plan-proof" {
                compactPane = .proof
                revealPane(.proof)
            }
            if demoState == "command-palette" {
                isPalettePresented = true
            }
            if demoState == "new-task-provisioning" {
                isNewTaskPresented = true
                isProvisioning = true
                isCommandRunning = true
                provisioningStep = .gdmContract
                sessionState = .running
            }
        } else {
            refresh()
        }
    }

    var repositoryName: String { repositoryURL.lastPathComponent }
    var branchLabel: String { Self.shortBranch(branch) }
    var presentsAgentActivityPopoverInDemo: Bool {
        isDemo && (
            demoState == "activity-popover"
                || demoState == "agent-operations-popover"
                || demoState == "detached-session"
        )
    }
    var presentsNewTaskProvisioningInDemo: Bool {
        isDemo && demoState == "new-task-provisioning"
    }
    var works: [WorkDocument] { tasks.compactMap(\.document) }
    var selectedTask: WorkspaceTask? {
        guard let selectedTaskKey else { return tasks.first }
        return tasks.first { $0.id == selectedTaskKey } ?? tasks.first
    }
    var selectedSlug: String? { selectedTask?.slug }
    var selectedWork: WorkDocument? { selectedTask?.document }
    var activeCheckID: String? {
        guard activeVerificationTaskKey == selectedTask?.id else { return nil }
        return activeVerificationCheckID
    }
    var failedCheckIDs: Set<String> {
        get {
            guard let taskID = selectedTask?.id else { return [] }
            return failedCheckIDsByTask[taskID] ?? []
        }
        set {
            guard let taskID = selectedTask?.id else { return }
            if newValue.isEmpty {
                failedCheckIDsByTask.removeValue(forKey: taskID)
            } else {
                failedCheckIDsByTask[taskID] = newValue
            }
        }
    }
    var selectedSession: TerminalSession? {
        guard let task = selectedTask else { return nil }
        if case .terminal(let terminal) = workbench.layout.focusedLeaf?.content,
           let session = terminalSessions.session(for: TerminalSessionLaneKey(
               taskID: task.id,
               laneID: Self.laneKey(terminal.laneID)
           )) {
            return session
        }
        return terminalSessions.session(for: task.id)
    }

    var focusedTerminalLaneID: UUID? {
        guard case .terminal(let terminal) = workbench.layout.focusedLeaf?.content else {
            return nil
        }
        return terminal.laneID
    }

    var canStartFocusedSession: Bool {
        guard let laneID = focusedTerminalLaneID else { return false }
        return canStartSession(laneID: laneID)
    }

    var canPresentNewTask: Bool {
        !isDemo
            && !isLoading
            && !isCommandRunning
            && !isProvisioning
            && !isNewTaskPresented
    }

    var canCloseFocusedPane: Bool {
        !isLoading
            && !isNewTaskPresented
            && !isCommandRunning
            && !isProvisioning
            && workbench.layout.root.orderedLeafIDs.count > 1
    }

    func presentNewTask() {
        guard canPresentNewTask else { return }
        guard !requiresRepositorySelection else {
            errorMessage = Self.repositorySelectionRequiredMessage
            return
        }
        isPalettePresented = false
        isNewTaskPresented = true
    }

    func canStartSession(laneID: UUID) -> Bool {
        sessionStartUnavailableReason(laneID: laneID) == nil
    }

    func sessionStartUnavailableReason(laneID: UUID) -> String? {
        guard !isDemo else { return "Demo 화면에서는 agent를 시작할 수 없습니다." }
        guard !isLoading else { return "워크스페이스 상태를 불러오는 중입니다." }
        guard !isCommandRunning else { return "다른 작업 명령이 끝난 뒤 시작할 수 있습니다." }
        guard let task = selectedTask else { return "먼저 왼쪽에서 작업을 선택하세요." }
        guard task.canMutate else {
            return task.statusMessage ?? "선택한 작업이 준비 상태가 아닙니다. 상태를 새로고침해 주세요."
        }

        let key = TerminalSessionLaneKey(taskID: task.id, laneID: Self.laneKey(laneID))
        guard !pendingSessionLaunchKeys.contains(key) else {
            return "Agent 시작 전 안전 검사를 진행 중입니다. 잠시 기다려 주세요."
        }
        guard session(for: laneID)?.state.isActive != true else {
            return "이 pane에는 이미 실행 중인 agent가 있습니다. 먼저 Stop을 눌러 주세요."
        }

        switch verificationPlanState(for: task) {
        case .needsPlan, .reviewRequired:
            return verificationPlannerAgent == nil
                ? "Codex, Claude 또는 Gemini를 선택해 검증 항목부터 만드세요."
                : nil
        case .approved:
            return nil
        case .unavailable:
            return "검증 상태를 읽을 수 없습니다. 작업 상태를 새로고침해 주세요."
        }
    }

    var selectedVerificationPlanState: VerificationPlanState {
        guard let task = selectedTask else { return .unavailable }
        return verificationPlanState(for: task)
    }

    var canRunVerification: Bool {
        guard let task = selectedTask,
              task.canMutate,
              task.document?.done != true else { return false }
        return verificationPlanState(for: task) == .approved
    }

    var canApproveSelectedVerificationPlan: Bool {
        guard !isDemo,
              !isCommandRunning,
              !isPlanApprovalPending,
              let task = selectedTask,
              task.canMutate,
              verificationPlanState(for: task) == .reviewRequired else { return false }
        return task.document?.verificationPlanFingerprint != nil
    }

    var primaryVerificationActionLabel: String {
        switch selectedVerificationPlanState {
        case .needsPlan: "Plan checks"
        case .reviewRequired: "Review checks"
        case .approved, .unavailable: "Run verification"
        }
    }

    var canPerformPrimaryVerificationAction: Bool {
        guard !isDemo,
              !isCommandRunning,
              !isPlanApprovalPending,
              !isVerificationPlanningPreparationPending,
              selectedTask?.canMutate == true else { return false }
        return switch selectedVerificationPlanState {
        case .needsPlan: verificationPlannerAgent != nil
        case .reviewRequired: true
        case .approved: canRunVerification
        case .unavailable: false
        }
    }

    var isVerificationPlanningPreparationPending: Bool {
        guard let taskID = selectedTask?.id else { return false }
        return pendingVerificationPlanningTaskIDs.contains(taskID)
    }

    var primaryVerificationActionHint: String {
        if isDemo { return "Demo 화면에서는 검증 상태를 변경할 수 없습니다." }
        if isLoading { return "워크스페이스 상태를 불러오는 중입니다." }
        if isCommandRunning { return "현재 명령이 끝난 뒤 다시 실행할 수 있습니다." }
        if isPlanApprovalPending { return "계획, 소스와 Git index가 그대로인지 두 번 확인하고 있습니다." }
        if isVerificationPlanningPreparationPending { return "계획 전용 세션을 열기 전에 소스 기준점을 저장하고 있습니다." }
        guard let task = selectedTask else { return "먼저 왼쪽에서 작업을 선택하세요." }
        guard task.canMutate else {
            return task.statusMessage ?? "선택한 작업이 준비 상태가 아닙니다. 상태를 새로고침해 주세요."
        }
        switch selectedVerificationPlanState {
        case .needsPlan:
            return verificationPlannerAgent == nil
                ? "Terminal pane에서 Codex, Claude 또는 Gemini를 선택하세요."
                : "AI가 검증 항목을 제안합니다. · ⌘R"
        case .reviewRequired:
            return "Proof pane에서 검증 항목을 검토합니다. · ⌘R"
        case .approved:
            return canRunVerification
                ? "승인된 검증 항목을 실행합니다. · ⌘R"
                : "이미 완료된 작업이거나 실행할 검증 항목이 없습니다."
        case .unavailable:
            return "검증 상태를 읽을 수 없습니다. 상태를 새로고침해 주세요."
        }
    }

    func performPrimaryVerificationAction() {
        guard canPerformPrimaryVerificationAction else { return }
        switch selectedVerificationPlanState {
        case .needsPlan:
            revealPane(.terminal(TerminalPaneState(agent: verificationPlannerAgent ?? selectedAgent)))
            startVerificationPlanning(laneID: focusedTerminalLaneID)
        case .reviewRequired:
            revealPane(.proof)
        case .approved:
            runVerification()
        case .unavailable:
            break
        }
    }

    var canCompleteSelectedTask: Bool {
        guard let task = selectedTask,
              let work = task.document,
              task.canMutate,
              work.canComplete else { return false }
        return verificationPlanState(for: task) == .approved
    }

    var selectedCompletionBlockers: [ProofBlocker] {
        guard let work = selectedWork else { return [] }
        switch selectedVerificationPlanState {
        case .needsPlan:
            return [ProofBlocker(
                glyph: "○",
                message: "검증 계획을 먼저 만들어야 합니다.",
                tone: .attention
            )]
        case .reviewRequired:
            return [ProofBlocker(
                glyph: "○",
                message: "검증 계획 승인이 필요합니다.",
                tone: .attention
            )] + work.blockers
        case .approved:
            return work.blockers
        case .unavailable:
            return [ProofBlocker(
                glyph: "⊘",
                message: "현재 workspace 상태를 확인할 수 없어 완료할 수 없습니다.",
                tone: .blocked
            )] + work.blockers
        }
    }

    var verificationPlannerAgent: AgentKind? {
        let requested = focusedTerminalState?.agent ?? selectedAgent
        if requested != .shell, agentCatalog.isAvailable(requested) { return requested }
        return [AgentKind.codex, .claude, .gemini].first(where: agentCatalog.isAvailable)
    }

    func verificationPlanState(for task: WorkspaceTask) -> VerificationPlanState {
        guard task.health == .ready, let work = task.document else { return .unavailable }
        if work.done { return .approved }
        guard let fingerprint = work.verificationPlanFingerprint else { return .needsPlan }
        if isDemo,
           (demoState == "review-plan" || demoState == "review-plan-proof"),
           task.id == selectedTask?.id {
            return .reviewRequired
        }

        let approvalRequired: Bool
        let approvedFingerprint: String?
        switch task.location {
        case .worktree(let record, _):
            approvalRequired = record.checksApprovalRequired == true
            approvedFingerprint = record.approvedChecksFingerprint
        case .legacyRoot:
            approvalRequired = transientPlanApprovalRequiredTaskIDs.contains(task.id)
            approvedFingerprint = transientApprovedPlanFingerprints[task.id]
        }
        guard approvalRequired else { return .approved }
        guard work.verificationPlanSourceFingerprint != nil else { return .needsPlan }
        return approvedFingerprint == fingerprint ? .approved : .reviewRequired
    }

    func session(for laneID: UUID) -> TerminalSession? {
        guard let taskID = selectedTask?.id else { return nil }
        return terminalSessions.session(for: TerminalSessionLaneKey(
            taskID: taskID,
            laneID: Self.laneKey(laneID)
        ))
    }

    func agent(for laneID: UUID) -> AgentKind {
        for leaf in workbench.layout.root.leaves {
            if case .terminal(let terminal) = leaf.content, terminal.laneID == laneID {
                return terminal.agent
            }
        }
        return selectedAgent
    }
    var selectedAgentActivitySummary: AgentActivitySummary {
        agentActivitySummary(for: selectedAgent)
    }

    func agentActivitySummary(for agent: AgentKind) -> AgentActivitySummary {
        if let summary = agentActivitySummaries.first(where: { $0.agent == agent }) {
            return summary
        }
        return AgentActivitySummary(
            agent: agent,
            state: agentCatalog.isAvailable(agent) ? .idle : .unavailable,
            items: []
        )
    }

    func coordinationStatus(for item: AgentActivityItem) -> AgentCoordinationStatus? {
        guard let laneID = item.laneID else { return nil }
        return agentCoordinator.activeStatuses(taskID: item.taskID).first {
            $0.identity.laneID == laneID
        }
    }

    func handoffTargets(for item: AgentActivityItem) -> [AgentCoordinationStatus] {
        guard let current = coordinationStatus(for: item) else { return [] }
        return agentCoordinator.activeStatuses(taskID: item.taskID).filter {
            $0.identity != current.identity
        }
    }

    func handoffTargetLabel(_ status: AgentCoordinationStatus) -> String {
        guard let item = agentActivityItems.first(where: {
            $0.taskID == status.identity.taskID
                && $0.laneID == status.identity.laneID
        }) else {
            return "Lane \(status.identity.laneID.prefix(8))"
        }
        let matchingItems = agentActivityItems.filter {
            $0.taskID == status.identity.taskID
                && $0.laneID != nil
                && $0.agent == item.agent
        }
        guard matchingItems.contains(where: {
            $0.laneID == status.identity.laneID
        }) else {
            return "Lane \(status.identity.laneID.prefix(8))"
        }
        if matchingItems.count == 1 { return item.agent.displayName }
        let index = matchingItems.firstIndex(of: item).map { $0 + 1 } ?? 1
        return "\(item.agent.displayName) · lane \(index)"
    }

    func terminalTranscript(laneID: UUID?) -> String {
        guard isAgentOperationsDemo else { return consoleText }
        let agent = laneID.map(agent(for:)) ?? selectedAgent
        switch agent {
        case .codex:
            return """
            Codex · NEEDS YOU
            cwd  \(selectedTask?.workingDirectory.path ?? repositoryURL.path)

            ? Replace the authentication fixture with the pinned response?
            approve with Focus, then type y or n

            ▌
            """
        case .claude:
            return """
            Claude Code · ACTIVE
            cwd  \(selectedTask?.workingDirectory.path ?? repositoryURL.path)

            ● Implementing the bounded retry path.
            ● Writer lease remains with Codex until explicit handoff.

            ▌
            """
        case .gemini:
            return """
            Gemini · VERIFYING
            cwd  \(selectedTask?.workingDirectory.path ?? repositoryURL.path)

            $ swift test --filter LoginRetryRegression
            ◐ 17 checks passed · final edge case running

            ▌
            """
        case .shell:
            return """
            Shell · HANDING OFF
            cwd  \(selectedTask?.workingDirectory.path ?? repositoryURL.path)

            $ git diff --stat
             3 files changed, 41 insertions(+), 9 deletions(-)
            handoff requested · Claude

            ▌
            """
        }
    }

    func focusAgentActivityItem(_ item: AgentActivityItem) {
        guard let task = tasks.first(where: { $0.id == item.taskID }) else { return }
        select(task)
        guard selectedTask?.id == task.id else { return }
        let matchingLeaf = workbench.layout.root.leaves.first { leaf in
            guard case .terminal(let terminal) = leaf.content else { return false }
            return item.laneID == nil
                || terminal.laneID.uuidString.lowercased() == item.laneID
        }
        if let matchingLeaf { focusPane(matchingLeaf.id) }
        if let status = coordinationStatus(for: item) {
            _ = agentCoordinator.claimInput(status.identity)
            rebuildAgentActivity()
        }
    }

    func isAgentActivityItemAttached(_ item: AgentActivityItem) -> Bool {
        tasks.contains { $0.id == item.taskID }
    }

    func stopAgentActivityItem(_ item: AgentActivityItem) {
        guard !isDemo,
              let laneID = item.laneID else { return }
        let key = TerminalSessionLaneKey(taskID: item.taskID, laneID: laneID)
        if let task = tasks.first(where: { $0.id == item.taskID }) {
            stopSession(task: task, key: key)
            return
        }

        // A live PTY can outlast the task row that originally owned it (for
        // example, when a concurrent refresh removes a disconnected task).
        // Keep that session visible and stoppable instead of leaving the user
        // behind a repository-switch blocker with no corresponding LIVE row.
        Task {
            let result = await terminalSessions.stop(key: key)
            transientSessionRecords.removeValue(forKey: key)
            sessionState = terminalSessions.hasActiveSessions ? .running : .ready
            rebuildAgentActivity()
            if let message = Self.stopErrorMessage(result) {
                errorMessage = message
            }
        }
    }

    func handoffAgentActivityItem(
        _ item: AgentActivityItem,
        to target: AgentRunIdentity
    ) {
        guard let current = coordinationStatus(for: item) else { return }
        let result = agentCoordinator.handoffCoordinationRole(from: current.identity, to: target)
        if result != .handedOff {
            errorMessage = "Coordination role handoff를 완료하지 못했습니다: \(String(describing: result))"
        }
        rebuildAgentActivity()
    }

    func showDiff(for item: AgentActivityItem) {
        guard let task = tasks.first(where: { $0.id == item.taskID }) else { return }
        select(task)
        if selectedTask?.id == task.id { revealPane(.diff) }
    }

    func showProof(for item: AgentActivityItem) {
        guard let task = tasks.first(where: { $0.id == item.taskID }) else { return }
        select(task)
        guard selectedTask?.id == task.id else { return }
        isProofRailVisible = true
        revealPane(.proof)
    }

    func refreshAgentActivity() {
        rebuildAgentActivity()
    }

    var selectedEvidenceText: String {
        guard let work = selectedWork else { return "선택된 작업이 없습니다." }
        let rows = work.checks.compactMap { check -> String? in
            guard let evidence = check.evidence ?? check.redEvidence else { return nil }
            let exit = evidence.exitCode.map(String.init) ?? "manual"
            return "\(check.id)  \(check.desc)\ncommand: \(check.cmd ?? "manual")\nexit: \(exit)\ntime: \(evidence.at)\nsha256: \(evidence.sha256)\nobserved: \(evidence.observed)"
        }
        return rows.isEmpty ? "저장된 증거가 없습니다." : rows.joined(separator: "\n\n")
    }

    func refresh() {
        guard !isDemo else { return }
        let previousTasks = tasks
        let previousSelectedTask = selectedTask
        let mustRetainSelectedTask = workbench.hasDirtyBuffers
        let activeTaskIDs = Set(terminalSessions.snapshot().compactMap { snapshot in
            snapshot.state.isActive ? snapshot.taskID : nil
        })
        isLoading = true
        defer { isLoading = false }
        do {
            if !didRunRecovery {
                _ = try registry.recoverInterruptedSessions()
                _ = try worktreeService.recoverProvisioning()
                didRunRecovery = true
            }
            let registryDocument = try registry.load()
            let loaded = try RepositoryLoader.loadTasks(from: repositoryURL, registry: registryDocument)
            var refreshedTasks = loaded.tasks
            var refreshedWarnings = loaded.warnings
            let retainedTaskIDs = activeTaskIDs.union(
                mustRetainSelectedTask ? [previousSelectedTask?.id].compactMap { $0 } : []
            )
            for previous in previousTasks where retainedTaskIDs.contains(previous.id) {
                guard !refreshedTasks.contains(where: { $0.id == previous.id }) else { continue }
                refreshedTasks.append(WorkspaceTask(
                    id: previous.id,
                    slug: previous.slug,
                    document: previous.document,
                    location: previous.location,
                    health: .disconnected,
                    statusMessage: "Refresh에서 작업을 다시 찾지 못했습니다. 실행 중 세션 또는 저장하지 않은 편집기를 보호하기 위해 유지합니다."
                ))
                refreshedWarnings.append("\(previous.slug): active session 또는 unsaved editor 보호를 위해 연결 끊긴 작업을 유지함")
            }
            tasks = refreshedTasks
            workspaceWarnings = refreshedWarnings

            let preferredKey = selectedTaskKey ?? registryDocument.selectedTaskKey
            if let preferredKey, tasks.contains(where: { $0.id == preferredKey }) {
                selectedTaskKey = preferredKey
            } else {
                selectedTaskKey = tasks.first?.id
            }
            restoreSelectedAgent()
            loadSelectedDetails()
            activateWorkbench()
            rebuildAgentActivity()
            if consoleText.isEmpty {
                consoleText = "gdm native · \(repositoryURL.path)\n작업 workspace \(tasks.count)개를 불러왔습니다."
            }
            errorMessage = nil
        } catch {
            errorMessage = "작업 workspace를 읽지 못했습니다: \(error.localizedDescription)"
        }
    }

    func select(_ task: WorkspaceTask) {
        // Re-selecting the active task must be a focus-only operation. Reloading
        // its branch/diff/journal here performs synchronous repository work on
        // the main thread and can rebuild a very large pane while an Activity
        // action is still being handled.
        if task.id == selectedTask?.id {
            focusedRegion = .tasks
            return
        }
        guard !workbench.hasDirtyBuffers else {
            errorMessage = "저장하지 않은 editor 변경을 저장하거나 닫은 뒤 작업을 바꿔 주세요."
            return
        }
        selectedTaskKey = task.id
        focusedRegion = .tasks
        restoreSelectedAgent()
        loadSelectedDetails()
        activateWorkbench()
        guard !isDemo else { return }
        do {
            _ = try registry.update { $0.selectedTaskKey = task.id }
        } catch {
            workspaceWarnings.append("선택 상태를 저장하지 못했습니다: \(error.localizedDescription)")
        }
    }

    func displayState(for task: WorkspaceTask) -> TaskDisplayState {
        if let state = demoTaskStates[task.slug] { return state }
        switch task.health {
        case .creating: return .working
        case .failed: return .blocked
        case .disconnected, .conflicted: return .disconnected
        case .ready: break
        }
        guard let work = task.document else { return .disconnected }
        return displayState(for: work, taskID: task.id)
    }

    func displayState(for work: WorkDocument) -> TaskDisplayState {
        let taskID = tasks.first(where: { $0.document == work })?.id
            ?? tasks.first(where: { $0.slug == work.slug })?.id
        return displayState(for: work, taskID: taskID)
    }

    private func displayState(for work: WorkDocument, taskID: String?) -> TaskDisplayState {
        if activeVerificationTaskKey == taskID { return .verifying }
        if work.audit?.result == "fail" { return .rejected }
        if work.done { return .proven }
        if work.checks.isEmpty { return .needsPlan }
        if let taskID,
           let task = tasks.first(where: { $0.id == taskID }),
           verificationPlanState(for: task) == .reviewRequired {
            return .reviewPlan
        }
        if let taskID, !(failedCheckIDsByTask[taskID] ?? []).isEmpty { return .blocked }
        return work.provenCount > 0 ? .working : .planned
    }

    func displayState(for check: CheckRecord) -> CheckDisplayState {
        if activeCheckID == check.id { return .running }
        if failedCheckIDs.contains(check.id) { return .failed }
        if check.isProven { return .proven }
        if check.redEvidence != nil { return .redCaptured }
        return .open
    }

    func runVerification() {
        guard !isDemo,
              !isCommandRunning,
              let task = selectedTask,
              task.canMutate,
              verificationPlanState(for: task) == .approved,
              let work = task.document,
              let expectedPlanFingerprint = work.verificationPlanFingerprint,
              activeVerificationTaskKey == nil else { return }
        let executableChecks = work.checks.filter { !$0.isProven && !$0.manual && $0.cmd != nil }
        guard let invocation = resolvedGDMInvocation() else { return }
        let slug = work.slug
        let directory = task.workingDirectory
        isCommandRunning = true
        sessionState = .running
        activeVerificationTaskKey = task.id
        activeVerificationCheckID = executableChecks.first?.id
        failedCheckIDsByTask.removeValue(forKey: task.id)

        Task {
            var stateValidationFailed = false
            var commandFailureMessage: String?
            if executableChecks.isEmpty {
                if await revalidateTaskForMutation(
                    task,
                    expectedPlanFingerprint: expectedPlanFingerprint
                ) {
                    appendConsole("$ gdm recheck --slug \(slug) · cwd \(directory.path)")
                    let result = await run(
                        invocation,
                        arguments: [
                            "recheck", "--slug", slug,
                            "--expected-plan-fingerprint", expectedPlanFingerprint
                        ],
                        directory: directory
                    )
                    appendConsole(result.output)
                    if result.exitCode != 0 {
                        let message = "\(slug) 재검증이 실패했습니다. LOGS에서 실패한 check를 확인하세요."
                        commandFailureMessage = message
                        errorMessage = message
                    }
                } else {
                    stateValidationFailed = true
                }
            } else {
                for check in executableChecks {
                    activeVerificationCheckID = check.id
                    guard await revalidateTaskForMutation(
                        task,
                        expectedPlanFingerprint: expectedPlanFingerprint
                    ) else {
                        stateValidationFailed = true
                        break
                    }
                    appendConsole("$ gdm pass \(check.id) --slug \(slug) · cwd \(directory.path)")
                    let result = await run(
                        invocation,
                        arguments: [
                            "pass", check.id, "--slug", slug,
                            "--expected-plan-fingerprint", expectedPlanFingerprint
                        ],
                        directory: directory
                    )
                    appendConsole(result.output)
                    if result.exitCode != 0 {
                        var failures = failedCheckIDsByTask[task.id] ?? []
                        failures.insert(check.id)
                        failedCheckIDsByTask[task.id] = failures
                        let message = "\(slug) · \(check.id) \(check.desc) 검증이 실패했습니다."
                        commandFailureMessage = message
                        errorMessage = message
                        break
                    }
                }
            }
            if activeVerificationTaskKey == task.id {
                activeVerificationTaskKey = nil
                activeVerificationCheckID = nil
            }
            isCommandRunning = false
            sessionState = .ready
            if !stateValidationFailed {
                refresh()
                if let commandFailureMessage { errorMessage = commandFailureMessage }
            }
        }
    }

    func completeSelectedTask() {
        guard !isDemo,
              !isCommandRunning,
              let task = selectedTask,
              task.canMutate,
              verificationPlanState(for: task) == .approved,
              let work = task.document,
              let expectedPlanFingerprint = work.verificationPlanFingerprint,
              work.canComplete else {
            areBlockersPresented = true
            return
        }
        guard let invocation = resolvedGDMInvocation() else { return }
        let directory = task.workingDirectory
        isCommandRunning = true
        sessionState = .running
        Task {
            guard await revalidateTaskForMutation(
                task,
                expectedPlanFingerprint: expectedPlanFingerprint
            ) else {
                isCommandRunning = false
                sessionState = .ready
                return
            }
            appendConsole("$ gdm done --slug \(work.slug) · cwd \(directory.path)")
            let result = await run(
                invocation,
                arguments: [
                    "done", "--slug", work.slug,
                    "--expected-plan-fingerprint", expectedPlanFingerprint
                ],
                directory: directory
            )
            appendConsole(result.output)
            var commandFailureMessage: String?
            if result.exitCode != 0 {
                let message = "\(work.slug) 작업 완료 처리가 실패했습니다. LOGS를 확인하세요."
                commandFailureMessage = message
                errorMessage = message
            }
            isCommandRunning = false
            sessionState = .ready
            refresh()
            if let commandFailureMessage { errorMessage = commandFailureMessage }
        }
    }

    func createTask(slug: String, brief: String, required: String, forbidden: String, risk: String) {
        guard !isDemo, !isProvisioning, !isCommandRunning else { return }
        guard resolvedGDMInvocation() != nil else { return }
        isProvisioning = true
        isCommandRunning = true
        provisioningStep = nil
        let attemptID = UUID()
        provisioningAttemptID = attemptID
        sessionState = .running
        let request = WorktreeProvisioningRequest(
            slug: slug,
            brief: brief,
            required: [required],
            forbidden: [forbidden],
            risk: risk,
            verification: "deterministic",
            simplificationRequired: true,
            auditRequired: risk == "high",
            selectedAgent: selectedAgent.rawValue
        )
        let service = worktreeService
        let progress: @Sendable (WorktreeProvisioningStep) -> Void = { [weak self] step in
            Task { @MainActor [weak self] in
                self?.advanceProvisioning(to: step, attemptID: attemptID)
            }
        }
        Task {
            let result = await Task.detached {
                Result { try service.provision(request, onProgress: progress) }
            }.value
            var provisioningFailureMessage: String?
            switch result {
            case .success(let record):
                // Also commit ready at the Result boundary so the final callback
                // cannot be observed after this task resumes on the main actor.
                advanceProvisioning(to: .ready, attemptID: attemptID)
                selectedTaskKey = "worktree:\(record.id.uuidString.lowercased())"
                appendConsole("worktree ready · \(record.worktreePath) · \(record.branch)")
            case .failure(let error):
                // Keep the sheet open and retain the last truthful step so the
                // user can see which real boundary failed. The next submit resets.
                provisioningFailureMessage = "worktree 작업을 만들지 못했습니다: \(error.localizedDescription)"
                errorMessage = provisioningFailureMessage
            }
            isProvisioning = false
            isCommandRunning = false
            sessionState = .ready
            refresh()
            if let provisioningFailureMessage {
                errorMessage = provisioningFailureMessage
            }
        }
    }

    func proposedWorktreePath(for slug: String) -> String {
        let clean = slug.trimmingCharacters(in: .whitespacesAndNewlines)
        let container = repositoryURL.deletingLastPathComponent()
            .appendingPathComponent("\(repositoryName)-worktrees", isDirectory: true)
        return container.appendingPathComponent(clean.isEmpty ? "<slug>" : clean, isDirectory: true).path
    }

    func chooseAgent(_ agent: AgentKind, laneID: UUID? = nil) {
        selectedAgent = agent
        if let taskID = selectedTask?.id {
            selectedAgentsByTask[taskID] = agent
        }
        if let laneID {
            if let leaf = workbench.layout.root.leaves.first(where: {
                if case .terminal(let terminal) = $0.content { return terminal.laneID == laneID }
                return false
            }), case .terminal(var terminal) = leaf.content {
                terminal.agent = agent
                _ = workbench.replaceContent(paneID: leaf.id, with: .terminal(terminal))
            }
        } else if case .terminal(var terminal) = workbench.layout.focusedLeaf?.content {
            terminal.agent = agent
            _ = workbench.replaceContent(
                paneID: workbench.focusedPaneID,
                with: .terminal(terminal)
            )
        }
        guard !isDemo, let recordID = selectedTask?.location.registryRecord?.id else {
            rebuildAgentActivity()
            return
        }
        do {
            let document = try registry.update { document in
                guard let index = document.tasks.firstIndex(where: { $0.id == recordID }) else { return }
                document.tasks[index].selectedAgent = agent.rawValue
            }
            replaceTaskRecord(recordID: recordID, from: document)
            rebuildAgentActivity()
        } catch {
            workspaceWarnings.append("agent 선택을 저장하지 못했습니다: \(error.localizedDescription)")
        }
    }

    func startSelectedSession(laneID requestedLaneID: UUID? = nil) {
        guard !isDemo,
              !isCommandRunning,
              let task = selectedTask,
              task.canMutate else { return }
        switch verificationPlanState(for: task) {
        case .needsPlan, .reviewRequired:
            startVerificationPlanning(laneID: requestedLaneID)
            return
        case .approved:
            break
        case .unavailable:
            return
        }
        let key = selectedLaneKey(taskID: task.id, requestedLaneID: requestedLaneID)
        let requestedAgent = requestedLaneID.map(agent(for:))
            ?? focusedTerminalState?.agent
            ?? selectedAgent
        startSession(task: task, agent: requestedAgent, key: key)
    }

    func startVerificationPlanning(laneID requestedLaneID: UUID? = nil) {
        guard !isDemo,
              !isCommandRunning,
              let originalTask = selectedTask,
              originalTask.canMutate,
              (verificationPlanState(for: originalTask) == .needsPlan
                || verificationPlanState(for: originalTask) == .reviewRequired) else { return }

        let requestedKey = selectedLaneKey(taskID: originalTask.id, requestedLaneID: requestedLaneID)
        let existingSession = terminalSessions.session(for: requestedKey)
        if let existingSession, existingSession.state.isActive {
            guard existingSession.state.acceptsInput else {
                errorMessage = "선택 pane의 agent session을 정리하는 중입니다. Stop이 끝난 뒤 다시 요청해 주세요."
                return
            }
            guard existingSession.specification.agent != .shell else {
                errorMessage = "검증 계획은 Codex, Claude 또는 Gemini 세션에서 요청해 주세요."
                return
            }
        } else if verificationPlannerAgent == nil {
            errorMessage = "검증 계획을 만들 AI agent를 찾지 못했습니다. Codex, Claude 또는 Gemini를 설치해 주세요."
            return
        }
        guard pendingVerificationPlanningTaskIDs.insert(originalTask.id).inserted else { return }
        let requestedRepositoryGeneration = repositoryGeneration
        Task {
            defer { pendingVerificationPlanningTaskIDs.remove(originalTask.id) }
            guard await revalidateTaskForMutation(originalTask),
                  repositoryGeneration == requestedRepositoryGeneration,
                  selectedTask?.id == originalTask.id else { return }
            guard let source = await captureSourceFingerprint(
                for: originalTask,
                failureContext: "검증 계획을 시작하지 않았습니다"
            ) else { return }
            guard let refreshedTask = await persistVerificationPlanSourceFingerprint(
                source.sha256,
                for: originalTask
            ),
            refreshedTask.id == selectedTask?.id,
            requireVerificationPlanApproval(for: refreshedTask),
            let task = selectedTask,
            task.id == originalTask.id else { return }

            let key = requestedKey
            let prompt = verificationPlanningPrompt(for: task)
            if let session = existingSession, session.state.isActive {
                guard session.state.acceptsInput else {
                    errorMessage = "선택 pane의 agent session을 정리하는 중입니다. Stop이 끝난 뒤 다시 요청해 주세요."
                    return
                }
                verificationPlanningSessionKeys[task.id] = key
                queuePrompt(prompt, for: session)
                monitorVerificationPlan(taskID: task.id)
                focusTerminal(for: key)
                return
            }

            guard let planner = verificationPlannerAgent else {
                errorMessage = "검증 계획을 만들 AI agent를 찾지 못했습니다. Codex, Claude 또는 Gemini를 설치해 주세요."
                return
            }
            let configuredAgent = requestedLaneID.map(agent(for:))
                ?? focusedTerminalState?.agent
                ?? selectedAgent
            if configuredAgent != planner {
                chooseAgent(planner, laneID: requestedLaneID ?? focusedTerminalState?.laneID)
            }
            startSession(
                task: task,
                agent: planner,
                key: key,
                initialPrompt: prompt,
                isVerificationPlanning: true
            )
        }
    }

    func approveSelectedVerificationPlan() {
        guard canApproveSelectedVerificationPlan,
              let task = selectedTask,
              let displayedFingerprint = task.document?.verificationPlanFingerprint,
              let displayedSourceFingerprint = task.document?.verificationPlanSourceFingerprint else { return }
        isPlanApprovalPending = true
        let requestedRepositoryGeneration = repositoryGeneration
        Task {
            defer { isPlanApprovalPending = false }
            guard await revalidateTaskForMutation(task),
                  repositoryGeneration == requestedRepositoryGeneration,
                  selectedTask?.id == task.id else { return }

            let currentWork: WorkDocument
            do {
                currentWork = try RepositoryLoader.loadWork(
                    slug: task.slug,
                    from: task.workingDirectory
                )
            } catch {
                errorMessage = "검증 계획을 다시 읽지 못해 승인하지 않았습니다: \(error.localizedDescription)"
                return
            }
            guard currentWork.verificationPlanFingerprint == displayedFingerprint,
                  currentWork.verificationPlanSourceFingerprint == displayedSourceFingerprint else {
                replaceTaskDocument(currentWork, taskID: task.id)
                errorMessage = "검증 계획 또는 소스 기준점이 화면에 표시된 뒤 변경되었습니다. 다시 검토해 주세요."
                return
            }

            guard let firstSource = await captureSourceFingerprint(
                for: task,
                failureContext: "검증 계획을 승인하지 않았습니다"
            ) else { return }
            guard firstSource.sha256 == displayedSourceFingerprint else {
                clearVerificationPlanApproval(for: task)
                refreshSourceChangeDetails(for: task)
                errorMessage = "계획을 만든 뒤 소스 또는 Git index가 변경되어 승인하지 않았습니다. 계획 다시 검토를 실행해 새 기준점을 만드세요."
                return
            }
            guard let refreshedTask = await persistVerificationPlanSourceFingerprint(
                firstSource.sha256,
                for: task
            ),
            let refreshedWork = refreshedTask.document,
            refreshedWork.verificationPlanFingerprint == displayedFingerprint else {
                return
            }
            guard persistVerificationPlanApproval(
                displayedFingerprint,
                for: refreshedTask
            ) else { return }

            guard let secondSource = await captureSourceFingerprint(
                for: refreshedTask,
                failureContext: "검증 계획 승인을 취소했습니다"
            ) else {
                clearVerificationPlanApproval(for: refreshedTask)
                return
            }
            let finalWork = try? RepositoryLoader.loadWork(
                slug: refreshedTask.slug,
                from: refreshedTask.workingDirectory
            )
            guard repositoryGeneration == requestedRepositoryGeneration,
                  selectedTask?.id == task.id,
                  secondSource.sha256 == firstSource.sha256,
                  finalWork?.verificationPlanFingerprint == displayedFingerprint,
                  finalWork?.verificationPlanSourceFingerprint == firstSource.sha256 else {
                clearVerificationPlanApproval(for: refreshedTask)
                if let finalWork { replaceTaskDocument(finalWork, taskID: task.id) }
                refreshSourceChangeDetails(for: refreshedTask)
                errorMessage = "승인을 저장하는 동안 계획, 소스 또는 Git index가 변경되어 승인을 취소했습니다. 다시 검토해 주세요."
                return
            }

            appendConsole("verification plan approved · \(task.slug) · \(finalWork?.checks.count ?? 0) checks")
            if let key = verificationPlanningSessionKeys[task.id],
               let session = terminalSessions.session(for: key),
               session.state.isActive {
                queuePrompt(
                    "사용자가 검증 계획을 승인했습니다. 이제 승인된 검증 항목과 계약 범위 안에서 구현을 시작하세요. 자동 커밋은 하지 말고, 구현 후 각 검증 항목의 증거를 남기세요.",
                    for: session
                )
            }
        }
    }

    private func startSession(
        task: WorkspaceTask,
        agent: AgentKind,
        key: TerminalSessionLaneKey,
        initialPrompt: String? = nil,
        isVerificationPlanning: Bool = false
    ) {
        guard terminalSessions.session(for: key)?.state.isActive != true else {
            errorMessage = "\(task.slug)의 선택 pane에는 이미 active agent session이 있습니다. 먼저 해당 session을 종료하세요."
            rebuildAgentActivity()
            return
        }
        guard pendingSessionLaunchKeys.insert(key).inserted else { return }
        let requestedRepositoryGeneration = repositoryGeneration
        let expectedPlanFingerprint = isVerificationPlanning
            ? nil
            : task.document?.verificationPlanFingerprint

        Task {
            defer { pendingSessionLaunchKeys.remove(key) }
            guard await revalidateTaskForMutation(
                task,
                expectedPlanFingerprint: expectedPlanFingerprint
            ) else {
                rebuildAgentActivity()
                return
            }
            guard let currentTask = selectedTask,
                  repositoryGeneration == requestedRepositoryGeneration,
                  currentTask.id == task.id,
                  currentTask.health == .ready else {
                errorMessage = "\(task.slug) agent session을 시작하지 않았습니다: 선택 작업이 변경되었습니다."
                rebuildAgentActivity()
                return
            }
            guard terminalSessions.session(for: key)?.state.isActive != true else {
                errorMessage = "\(task.slug)의 선택 pane에는 이미 active agent session이 있습니다. 먼저 해당 session을 종료하세요."
                rebuildAgentActivity()
                return
            }
            launchSession(
                task: currentTask,
                agent: agent,
                key: key,
                initialPrompt: initialPrompt,
                isVerificationPlanning: isVerificationPlanning
            )
        }
    }

    func startFocusedSession() {
        guard canStartFocusedSession, let laneID = focusedTerminalLaneID else { return }
        startSelectedSession(laneID: laneID)
    }

    private func launchSession(
        task: WorkspaceTask,
        agent: AgentKind,
        key: TerminalSessionLaneKey,
        initialPrompt: String? = nil,
        isVerificationPlanning: Bool = false
    ) {
        do {
            var specification = try agentCatalog.launchSpecification(
                for: agent,
                workingDirectory: task.workingDirectory
            )
            let expectedGeneration = terminalSessions.nextGeneration(for: key)
            let runToken = AgentCoordinator.makeRunToken()
            let coordinationRole = agentCoordinator.predictedCoordinationRole(
                taskID: task.id,
                worktreePath: task.workingDirectory.path
            )
            guard let gdmInvocation = resolvedGDMInvocation() else { return }
            specification = specification.prependingPathDirectory(
                URL(fileURLWithPath: gdmInvocation.executable).deletingLastPathComponent()
            )
            specification = specification.addingEnvironment([
                "GIDEM_GDM_EXECUTABLE": gdmInvocation.executable
            ])
            if let initialPrompt, !initialPrompt.isEmpty {
                // Codex, Claude and Gemini all accept one positional prompt
                // while remaining interactive. Supplying it at process launch
                // avoids racing raw PTY input against the agent's startup UI.
                specification = specification.appendingArgument(initialPrompt)
            }
            if let server = ensureAgentEventServer() {
                let eventCommand = Bundle.main.executableURL?.path
                    ?? CommandLine.arguments.first
                    ?? "gdm-native"
                specification = specification.addingEnvironment([
                    "GIDEM_AGENT_EVENT_PROTOCOL": String(AgentEventEnvelope.currentSchemaVersion),
                    "GIDEM_AGENT_EVENT_SOCKET": server.socketURL.path,
                    "GIDEM_AGENT_RUN_TOKEN": runToken,
                    "GIDEM_AGENT_TASK_ID": task.id,
                    "GIDEM_AGENT_LANE_ID": key.laneID,
                    "GIDEM_AGENT_GENERATION": String(expectedGeneration),
                    "GIDEM_AGENT_COORDINATION_ROLE": coordinationRole.rawValue,
                    "GIDEM_AGENT_EVENT_COMMAND": eventCommand
                ])
            }
            let session = try terminalSessions.start(key: key, specification: specification)
            if agentEventServer != nil {
                _ = agentCoordinator.register(
                    identity: AgentRunIdentity(
                        sessionID: session.id,
                        taskID: task.id,
                        laneID: key.laneID,
                        generation: session.generation
                    ),
                    runToken: runToken,
                    worktreePath: task.workingDirectory.path
                )
            }
            let startedAt = Self.timestamp()
            selectedAgent = agent
            selectedAgentsByTask[task.id] = agent
            transientSessionRecords.removeValue(forKey: key)
            sessionStartedAt[session.id] = startedAt
            if isVerificationPlanning {
                verificationPlanningSessionKeys[task.id] = key
            }
            monitorVerificationPlan(taskID: task.id)
            session.onStateChange = { [weak self, weak session] state in
                guard let self, let session else { return }
                self.handleSessionState(state, task: task, session: session, startedAt: startedAt)
                self.flushPendingPrompt(for: session, state: state)
            }
            handleSessionState(session.state, task: task, session: session, startedAt: startedAt)
            flushPendingPrompt(for: session, state: session.state)
        } catch {
            let failedAt = Self.timestamp()
            transientSessionRecords[key] = PersistedSessionRecord(
                kind: agent.rawValue,
                startedAt: failedAt,
                endedAt: failedAt,
                outcome: .launchFailed
            )
            persistSession(
                task: task,
                laneID: key.laneID,
                kind: agent,
                startedAt: failedAt,
                outcome: .launchFailed,
                endedAt: failedAt
            )
            rebuildAgentActivity()
            errorMessage = "\(agent.rawValue) 세션을 시작하지 못했습니다: \(error.localizedDescription)"
            sessionState = .disconnected
        }
    }

    private func captureSourceFingerprint(
        for task: WorkspaceTask,
        failureContext: String
    ) async -> WorkspaceSourceFingerprint? {
        guard let provider = sourceFingerprintProvider else {
            _ = resolvedGDMInvocation()
            if errorMessage == nil {
                errorMessage = "현재 소스와 Git index를 확인할 GDM toolchain이 없습니다."
            }
            return nil
        }
        do {
            return try await provider.capture(at: task.workingDirectory)
        } catch {
            errorMessage = "\(failureContext): \(error.localizedDescription)"
            return nil
        }
    }

    private func persistVerificationPlanSourceFingerprint(
        _ fingerprint: String,
        for task: WorkspaceTask
    ) async -> WorkspaceTask? {
        guard let invocation = resolvedGDMInvocation() else { return nil }
        let result = await run(
            invocation,
            arguments: [
                "plan", "source",
                "--slug", task.slug,
                "--fingerprint", fingerprint
            ],
            directory: task.workingDirectory
        )
        guard result.exitCode == 0 else {
            appendConsole(result.output)
            errorMessage = "검증 계획의 소스 기준점을 저장하지 못했습니다. LOGS를 확인하세요."
            return nil
        }
        do {
            let work = try RepositoryLoader.loadWork(slug: task.slug, from: task.workingDirectory)
            guard work.verificationPlanSourceFingerprint == fingerprint else {
                errorMessage = "저장한 소스 기준점을 다시 확인할 수 없어 검증 계획을 시작하지 않았습니다."
                return nil
            }
            replaceTaskDocument(work, taskID: task.id)
            return tasks.first(where: { $0.id == task.id })
        } catch {
            errorMessage = "소스 기준점을 저장한 뒤 검증 계획을 다시 읽지 못했습니다: \(error.localizedDescription)"
            return nil
        }
    }

    private func persistVerificationPlanApproval(
        _ fingerprint: String,
        for task: WorkspaceTask
    ) -> Bool {
        do {
            switch task.location {
            case .worktree(let record, _):
                let document = try registry.update { document in
                    guard let index = document.tasks.firstIndex(where: { $0.id == record.id }) else {
                        throw WorkspaceRegistryError.missingRecord(record.id)
                    }
                    document.tasks[index].checksApprovalRequired = true
                    document.tasks[index].approvedChecksFingerprint = fingerprint
                    document.tasks[index].checksApprovedAt = Self.timestamp()
                }
                replaceTaskRecord(recordID: record.id, from: document)
            case .legacyRoot:
                transientPlanApprovalRequiredTaskIDs.insert(task.id)
                transientApprovedPlanFingerprints[task.id] = fingerprint
            }
            return true
        } catch {
            errorMessage = "검증 계획 승인을 저장하지 못했습니다: \(error.localizedDescription)"
            return false
        }
    }

    private func clearVerificationPlanApproval(for task: WorkspaceTask) {
        do {
            switch task.location {
            case .worktree(let record, _):
                let document = try registry.update { document in
                    guard let index = document.tasks.firstIndex(where: { $0.id == record.id }) else {
                        throw WorkspaceRegistryError.missingRecord(record.id)
                    }
                    document.tasks[index].checksApprovalRequired = true
                    document.tasks[index].approvedChecksFingerprint = nil
                    document.tasks[index].checksApprovedAt = nil
                }
                replaceTaskRecord(recordID: record.id, from: document)
            case .legacyRoot:
                transientPlanApprovalRequiredTaskIDs.insert(task.id)
                transientApprovedPlanFingerprints.removeValue(forKey: task.id)
            }
        } catch {
            workspaceWarnings.append("검증 계획 승인을 취소한 상태를 저장하지 못했습니다: \(error.localizedDescription)")
        }
    }

    private func refreshSourceChangeDetails(for task: WorkspaceTask) {
        guard selectedTask?.id == task.id else { return }
        branch = task.branch ?? RepositoryLoader.branch(at: task.workingDirectory)
        diffText = RepositoryLoader.diff(at: task.workingDirectory)
        journalText = RepositoryLoader.journal(for: task.slug, at: task.workingDirectory)
    }

    private func requireVerificationPlanApproval(for task: WorkspaceTask) -> Bool {
        do {
            switch task.location {
            case .worktree(let record, _):
                let document = try registry.update { document in
                    guard let index = document.tasks.firstIndex(where: { $0.id == record.id }) else {
                        throw WorkspaceRegistryError.missingRecord(record.id)
                    }
                    document.tasks[index].checksApprovalRequired = true
                    document.tasks[index].approvedChecksFingerprint = nil
                    document.tasks[index].checksApprovedAt = nil
                }
                replaceTaskRecord(recordID: record.id, from: document)
            case .legacyRoot:
                transientPlanApprovalRequiredTaskIDs.insert(task.id)
                transientApprovedPlanFingerprints.removeValue(forKey: task.id)
            }
            return true
        } catch {
            errorMessage = "검증 계획 상태를 저장하지 못했습니다: \(error.localizedDescription)"
            return false
        }
    }

    private func verificationPlanningPrompt(for task: WorkspaceTask) -> String {
        guard let work = task.document else { return "" }
        let required = work.contract.required.joined(separator: "; ")
        let forbidden = work.contract.forbidden.joined(separator: "; ")
        let planAction = work.checks.isEmpty
            ? "검증 항목을 새로 정의하고 등록하세요."
            : "현재 검증 항목을 검토하고 필요할 때 \"$GIDEM_GDM_EXECUTABLE\" plan edit로 고치되 중복 항목은 추가하지 마세요."
        let prompt = [
            "지금은 구현이 아니라 검증 계획 수립 단계입니다.",
            "소스 코드를 수정하거나 검증을 실행하거나 커밋하지 마세요.",
            "작업 목표: \(work.brief)",
            "필수 조건: \(required.isEmpty ? "없음" : required)",
            "금지 조건: \(forbidden.isEmpty ? "없음" : forbidden)",
            planAction,
            "저장소와 현재 변경을 읽고 behavior, regression, edge, static 및 필요한 manual/UI 확인을 골고루 설계하세요.",
            "자동 항목은 \"$GIDEM_GDM_EXECUTABLE\" plan add --desc <설명> --cmd <결정적 재현 명령> --expect <기대 결과> --kind <종류> --slug \(work.slug)로, 화면 확인은 --manual로 등록하세요.",
            "각 항목은 사용자가 성공 여부를 바로 판단할 만큼 구체적이어야 합니다.",
            "등록이 끝나면 구현을 시작하지 말고 Gidem에서 사용자가 계획을 승인할 때까지 기다리세요."
        ]
        .joined(separator: " ")
        return Self.sanitizedTerminalPrompt(prompt)
    }

    private func queuePrompt(_ prompt: String, for session: TerminalSession) {
        guard !prompt.isEmpty else { return }
        pendingAutomationPrompts[session.id] = prompt
        flushPendingPrompt(for: session, state: session.state)
    }

    private func flushPendingPrompt(for session: TerminalSession, state: TerminalSessionState) {
        guard case .running = state,
              let prompt = pendingAutomationPrompts.removeValue(forKey: session.id) else { return }
        // A semantic paste keeps long automation input out of TUI keystroke-
        // burst heuristics. Return remains a separate, explicit submission.
        session.sendPaste(text: prompt)
        session.send(Data([0x0D]))
    }

    private func monitorVerificationPlan(taskID: String) {
        guard verificationPlanMonitorTasks[taskID] == nil else { return }
        let monitorID = UUID()
        verificationPlanMonitorIDs[taskID] = monitorID
        verificationPlanMonitorTasks[taskID] = Task { [weak self] in
            defer {
                if let self,
                   self.verificationPlanMonitorIDs[taskID] == monitorID {
                    self.verificationPlanMonitorTasks.removeValue(forKey: taskID)
                    self.verificationPlanMonitorIDs.removeValue(forKey: taskID)
                }
            }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(750))
                guard !Task.isCancelled, let self else { return }
                await self.reloadVerificationPlanDocument(taskID: taskID)
                guard self.tasks.contains(where: { $0.id == taskID }) else { return }
                let hasActiveSession = self.terminalSessions.snapshot().contains {
                    $0.taskID == taskID && $0.state.isActive
                }
                if !hasActiveSession { return }
            }
        }
    }

    private func cancelVerificationPlanMonitor(taskID: String) {
        verificationPlanMonitorTasks.removeValue(forKey: taskID)?.cancel()
        verificationPlanMonitorIDs.removeValue(forKey: taskID)
    }

    private func cancelAllVerificationPlanMonitors() {
        verificationPlanMonitorTasks.values.forEach { $0.cancel() }
        verificationPlanMonitorTasks.removeAll()
        verificationPlanMonitorIDs.removeAll()
    }

    private func reloadVerificationPlanDocument(taskID: String) async {
        guard let snapshot = tasks.first(where: { $0.id == taskID }) else { return }
        let slug = snapshot.slug
        let directory = snapshot.workingDirectory.standardizedFileURL
        let expectedRepositoryGeneration = repositoryGeneration
        let document = await Task.detached {
            try? RepositoryLoader.loadWork(slug: slug, from: directory)
        }.value
        guard !Task.isCancelled,
              expectedRepositoryGeneration == repositoryGeneration,
              let current = tasks.first(where: { $0.id == taskID }),
              current.workingDirectory.standardizedFileURL == directory,
              let document else { return }
        replaceTaskDocument(document, taskID: taskID)
    }

    private func replaceTaskDocument(_ document: WorkDocument, taskID: String) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }),
              tasks[index].document != document else { return }
        let current = tasks[index]
        tasks[index] = WorkspaceTask(
            id: current.id,
            slug: current.slug,
            document: document,
            location: current.location,
            health: current.health,
            statusMessage: current.statusMessage
        )
    }

    private func focusTerminal(for key: TerminalSessionLaneKey) {
        guard let laneID = UUID(uuidString: key.laneID),
              let pane = workbench.layout.root.leaves.first(where: {
                  if case .terminal(let terminal) = $0.content { return terminal.laneID == laneID }
                  return false
              }) else { return }
        workbench.focus(pane.id)
        focusedRegion = .terminal
        compactPane = .terminal
    }

    private func ensureAgentEventServer() -> AgentEventSocketServer? {
        if let agentEventServer { return agentEventServer }
        do {
            let server = try AgentEventSocketServer { [weak self] event in
                guard let self else { return .rejected(.unknownRun) }
                return await self.acceptAgentEvent(event)
            }
            agentEventServer = server
            return server
        } catch {
            workspaceWarnings.append(
                "Agent semantic event channel을 시작하지 못했습니다: \(error.localizedDescription)"
            )
            return nil
        }
    }

    private func acceptAgentEvent(_ event: AgentEventEnvelope) -> AgentEventReceipt {
        let receipt = agentCoordinator.accept(event)
        if receipt.accepted { rebuildAgentActivity() }
        return receipt
    }

    func stopSelectedSession(laneID requestedLaneID: UUID? = nil) {
        guard !isDemo, let task = selectedTask else { return }
        let key = selectedLaneKey(taskID: task.id, requestedLaneID: requestedLaneID)
        stopSession(task: task, key: key)
    }

    private func stopSession(task: WorkspaceTask, key: TerminalSessionLaneKey) {
        Task {
            let result = await terminalSessions.stop(key: key)
            let session = terminalSessions.session(for: key)
            let cleanupIsActive = session?.state.isActive == true
            if cleanupIsActive, let session {
                persistSession(
                    task: task,
                    laneID: key.laneID,
                    kind: session.specification.agent,
                    startedAt: sessionStartedAt[session.id] ?? Self.timestamp(),
                    outcome: .active,
                    endedAt: nil
                )
            }
            rebuildAgentActivity()
            if selectedTask?.id == task.id {
                let selectedTaskHasActiveSession = terminalSessions.snapshot().contains {
                    $0.taskID == task.id && $0.state.isActive
                }
                sessionState = selectedTaskHasActiveSession ? .running : .ready
            }
            if let message = Self.stopErrorMessage(result) {
                errorMessage = message
            }
        }
    }

    func terminateAllSessions() async -> Bool {
        let results = await terminalSessions.stopAllLanes()
        for (key, _) in results {
            guard let task = tasks.first(where: { $0.id == key.taskID }),
                  let session = terminalSessions.session(for: key),
                  session.state.isActive else { continue }
            persistSession(
                task: task,
                laneID: key.laneID,
                kind: session.specification.agent,
                startedAt: sessionStartedAt[session.id] ?? Self.timestamp(),
                outcome: .active,
                endedAt: nil
            )
        }
        rebuildAgentActivity()
        let safeToQuit = results.values.allSatisfy(Self.stopAllowsQuit)
        sessionState = terminalSessions.hasActiveSessions ? .running : .ready
        if !safeToQuit {
            errorMessage = "소유한 PTY child를 안전하게 회수하지 못해 종료를 취소했습니다. 세션 상태를 확인하세요."
        }
        return safeToQuit
    }

    func setDrawer(_ tab: DrawerTab) {
        selectedDrawerTab = tab
        compactPane = .drawer
        focusedRegion = .drawer
    }

    func toggleTasks() { isTaskRailVisible.toggle() }
    func toggleProof() { isProofRailVisible.toggle() }

    func focusPane(_ paneID: UUID) {
        workbench.focus(paneID)
        if case .terminal(let terminal) = workbench.layout.root.leaf(id: paneID)?.content {
            selectedAgent = terminal.agent
            focusedRegion = .terminal
            if let task = selectedTask,
               let session = terminalSessions.session(for: TerminalSessionLaneKey(
                   taskID: task.id,
                   laneID: Self.laneKey(terminal.laneID)
               )) {
                _ = agentCoordinator.claimInput(AgentRunIdentity(
                    sessionID: session.id,
                    taskID: task.id,
                    laneID: Self.laneKey(terminal.laneID),
                    generation: session.generation
                ))
                rebuildAgentActivity()
            }
        } else {
            focusedRegion = .drawer
        }
    }

    func focusNextPane(reverse: Bool = false) {
        workbench.focusNext(reverse: reverse)
        focusPane(workbench.focusedPaneID)
    }

    @discardableResult
    func focusPane(_ target: PaneFocusTarget) -> Bool {
        guard workbench.focus(target) else { return false }
        focusPane(workbench.focusedPaneID)
        return true
    }

    @discardableResult
    func resizeFocusedPane(direction: PaneDirection, amount: UInt16 = 100) -> Bool {
        workbench.resizeFocused(direction: direction, amount: amount)
    }

    func equalizePaneSplits() {
        _ = workbench.equalizeSplits()
    }

    func revealPane(_ content: PaneContent) {
        if let existing = workbench.layout.root.leaves.first(where: {
            Self.samePaneKind($0.content, content)
        }) {
            focusPane(existing.id)
            return
        }

        let axis: PaneSplitAxis = content.isTerminal ? .vertical : .horizontal
        _ = workbench.split(
            paneID: workbench.focusedPaneID,
            axis: axis,
            content: content
        )
        focusPane(workbench.focusedPaneID)
    }

    func splitPane(_ paneID: UUID, axis: PaneSplitAxis) {
        _ = workbench.split(
            paneID: paneID,
            axis: axis,
            content: .terminal(TerminalPaneState(agent: selectedAgent))
        )
        focusPane(workbench.focusedPaneID)
    }

    @discardableResult
    func splitPane(_ paneID: UUID, direction: PaneDirection) -> Bool {
        let changed = workbench.split(
            paneID: paneID,
            direction: direction,
            content: .terminal(TerminalPaneState(agent: selectedAgent))
        )
        if changed { focusPane(workbench.focusedPaneID) }
        return changed
    }

    /// Handles only the workbench actions emitted by the Ghostty surface that
    /// owns `paneID`. All mutation still passes through the same safety checks
    /// as buttons and menu commands.
    func handleTerminalHostAction(_ action: TerminalHostAction, paneID: UUID) -> Bool {
        guard let sourceLeaf = workbench.layout.root.leaf(id: paneID),
              case .terminal(let sourceTerminal) = sourceLeaf.content else {
            return false
        }
        focusPane(paneID)
        switch action {
        case .split(let direction):
            return splitPane(paneID, direction: direction)
        case .focus(let target):
            return focusPane(target)
        case .resize(let direction, let amount):
            return resizeFocusedPane(direction: direction, amount: amount)
        case .equalizeSplits:
            equalizePaneSplits()
            return true
        case .closePane:
            // Consume the Ghostty close request even when the existing active
            // session or dirty-buffer guard deliberately refuses the close.
            guard canCloseFocusedPane, canDiscardPane(sourceLeaf) else { return true }
            let sourceTaskID = selectedTask?.id
            let sourceLaneID = sourceTerminal.laneID
            Task { @MainActor [weak self] in
                // Never free a Ghostty surface while its C callback is still on
                // the stack. Revalidate identity after yielding to the host.
                await Task.yield()
                guard let self,
                      self.selectedTask?.id == sourceTaskID,
                      case .terminal(let currentTerminal) = self.workbench.layout.root
                        .leaf(id: paneID)?.content,
                      currentTerminal.laneID == sourceLaneID else { return }
                self.closePane(paneID)
            }
            return true
        }
    }

    func closePane(_ paneID: UUID) {
        guard canCloseFocusedPane else { return }
        guard let leaf = workbench.layout.root.leaf(id: paneID) else { return }
        guard canDiscardPane(leaf) else { return }
        guard workbench.close(paneID: paneID) else { return }
        discardInactiveTerminalSession(for: leaf)
    }

    func resizePane(splitID: UUID, fraction: Double) {
        _ = workbench.resize(splitID: splitID, fraction: fraction)
    }

    func recordPaneSplitMeasurement(
        splitID: UUID,
        length: Double,
        displayedFraction: Double
    ) {
        workbench.recordSplitMeasurement(
            splitID: splitID,
            length: length,
            displayedFraction: displayedFraction
        )
    }

    func showContent(_ content: PaneContent, in paneID: UUID? = nil) {
        let targetPaneID = paneID ?? workbench.focusedPaneID
        guard let leaf = workbench.layout.root.leaf(id: targetPaneID) else { return }
        guard !Self.samePaneKind(leaf.content, content) else {
            focusPane(targetPaneID)
            return
        }
        guard canDiscardPane(leaf) else { return }
        guard workbench.replaceContent(paneID: targetPaneID, with: content) else { return }
        discardInactiveTerminalSession(for: leaf)
        focusPane(targetPaneID)
    }

    private func discardInactiveTerminalSession(for leaf: PaneLeafRecord) {
        guard case .terminal(let terminal) = leaf.content,
              let taskID = selectedTask?.id else { return }
        let key = TerminalSessionLaneKey(taskID: taskID, laneID: Self.laneKey(terminal.laneID))
        _ = terminalSessions.discardInactiveSession(key: key)
        transientSessionRecords.removeValue(forKey: key)
        if verificationPlanningSessionKeys[taskID] == key {
            verificationPlanningSessionKeys.removeValue(forKey: taskID)
        }
        if let recordID = selectedTask?.location.registryRecord?.id {
            do {
                _ = try registry.removeSession(recordID: recordID, laneID: key.laneID)
                let document = try registry.load()
                replaceTaskRecord(recordID: recordID, from: document)
            } catch {
                workspaceWarnings.append("닫은 pane의 세션 메타데이터를 정리하지 못했습니다: \(error.localizedDescription)")
            }
        }
        rebuildAgentActivity()
    }

    func openFile(_ relativePath: String) {
        workbench.openFile(relativePath: relativePath)
    }

    func saveFocusedFile(overwrite: Bool = false) {
        workbench.saveFocusedEditor(overwrite: overwrite)
        refreshAfterFileMutation()
    }

    private func canDiscardPane(_ leaf: PaneLeafRecord) -> Bool {
        switch leaf.content {
        case .terminal(let terminal):
            guard session(for: terminal.laneID)?.state.isActive != true else {
                errorMessage = "실행 중인 agent pane입니다. Stop한 뒤 닫거나 바꿔 주세요."
                return false
            }
        case .editor(let editor):
            let hasDirtyTab = editor.tabs.contains {
                workbench.editorStore?.buffers[$0.relativePath]?.isDirty == true
            }
            guard !hasDirtyTab else {
                errorMessage = "저장하지 않은 editor tab이 있어 pane을 닫거나 바꾸지 않았습니다."
                return false
            }
        default:
            break
        }
        return true
    }

    func refreshAfterFileMutation() {
        guard let task = selectedTask else { return }
        branch = RepositoryLoader.branch(at: task.workingDirectory)
        diffText = RepositoryLoader.diff(at: task.workingDirectory)
        journalText = RepositoryLoader.journal(for: task.slug, at: task.workingDirectory)
        workbench.reloadFiles()
    }

    func switchRepository(to url: URL) {
        guard !isDemo else { return }
        guard !isCommandRunning,
              !isProvisioning,
              !isPlanApprovalPending,
              pendingVerificationPlanningTaskIDs.isEmpty,
              pendingSessionLaunchKeys.isEmpty else {
            errorMessage = "진행 중인 작업 명령이나 agent 시작이 끝난 뒤 repository를 바꿔 주세요."
            return
        }
        guard !terminalSessions.hasActiveSessions else {
            rebuildAgentActivity()
            let live = terminalSessions.snapshot().filter(\.state.isActive)
            let agents = Array(Set(live.map { $0.agent.displayName })).sorted().joined(separator: ", ")
            let suffix = agents.isEmpty ? "" : " (\(agents))"
            errorMessage = "실행 중인 agent session \(live.count)개\(suffix)가 있습니다. Agent Activity에서 Stop한 뒤 repository를 바꿔 주세요."
            return
        }
        guard !workbench.hasDirtyBuffers else {
            errorMessage = "저장하지 않은 editor 변경을 저장하거나 닫은 뒤 repository를 바꿔 주세요."
            return
        }

        let candidate = url.standardizedFileURL
        do {
            try WorkspaceStatePathBoundary.validateWorkspaceDirectory(candidate)
        } catch {
            errorMessage = "선택한 repository 경로가 안전한 directory가 아닙니다: \(error.localizedDescription)"
            return
        }
        let topLevel = CommandRunner.run(
            executable: "/usr/bin/git",
            arguments: ["rev-parse", "--show-toplevel"],
            directory: candidate
        )
        let discovered = URL(
            fileURLWithPath: topLevel.output.trimmingCharacters(in: .whitespacesAndNewlines),
            isDirectory: true
        ).resolvingSymlinksInPath().standardizedFileURL
        guard topLevel.exitCode == 0,
              discovered.path == candidate.resolvingSymlinksInPath().standardizedFileURL.path else {
            errorMessage = "Git repository의 top level directory를 선택해 주세요."
            return
        }

        layoutPersistenceTask?.cancel()
        cancelAllVerificationPlanMonitors()
        _ = terminalSessions.discardInactiveSessions()
        repositoryGeneration &+= 1
        workbench.resetRepository()
        repositoryURL = candidate
        requiresRepositorySelection = false
        registry = WorkspaceRegistry(repositoryURL: candidate)
        worktreeService = WorktreeService(
            repositoryURL: candidate,
            registry: registry,
            gdmInvocation: try? gdmToolchain.get()
        )
        tasks = []
        selectedTaskKey = nil
        selectedAgentsByTask = [:]
        transientSessionRecords = [:]
        verificationPlanningSessionKeys = [:]
        pendingVerificationPlanningTaskIDs = []
        transientPlanApprovalRequiredTaskIDs = []
        transientApprovedPlanFingerprints = [:]
        pendingAutomationPrompts = [:]
        failedCheckIDsByTask = [:]
        didRunRecovery = false
        consoleText = ""
        diffText = ""
        journalText = ""
        UserDefaults.standard.set(candidate.path, forKey: GidemPreferences.lastRepositoryPathKey)
        refresh()
    }

    private var focusedTerminalState: TerminalPaneState? {
        guard case .terminal(let terminal) = workbench.layout.focusedLeaf?.content else { return nil }
        return terminal
    }

    private func selectedLaneKey(
        taskID: String,
        requestedLaneID: UUID?
    ) -> TerminalSessionLaneKey {
        if let requestedLaneID {
            return TerminalSessionLaneKey(taskID: taskID, laneID: Self.laneKey(requestedLaneID))
        }
        if let terminal = focusedTerminalState {
            return TerminalSessionLaneKey(taskID: taskID, laneID: Self.laneKey(terminal.laneID))
        }
        return TerminalSessionLaneKey(taskID: taskID)
    }

    private static func laneKey(_ laneID: UUID) -> String {
        laneID.uuidString.lowercased()
    }

    private static func samePaneKind(_ lhs: PaneContent, _ rhs: PaneContent) -> Bool {
        switch (lhs, rhs) {
        case (.files, .files),
             (.editor, .editor),
             (.terminal, .terminal),
             (.diff, .diff),
             (.logs, .logs),
             (.evidence, .evidence),
             (.proof, .proof):
            true
        default:
            false
        }
    }

    private func activateWorkbench() {
        workbench.activate(
            task: selectedTask,
            persistedLayout: selectedTask?.location.registryRecord?.layout
        )
    }

    private func scheduleLayoutPersistence(taskID: String, layout: PaneLayoutRecord) {
        guard !isDemo else { return }
        layoutPersistenceTask?.cancel()
        layoutPersistenceTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(220))
            guard !Task.isCancelled, let self else { return }
            self.persistLayout(taskID: taskID, layout: layout)
        }
    }

    private func persistLayout(taskID: String, layout: PaneLayoutRecord) {
        guard let recordID = tasks.first(where: { $0.id == taskID })?.location.registryRecord?.id else {
            return
        }
        do {
            let document = try registry.update { document in
                guard let index = document.tasks.firstIndex(where: { $0.id == recordID }) else { return }
                document.tasks[index].layout = layout
            }
            replaceTaskRecord(recordID: recordID, from: document)
        } catch {
            workspaceWarnings.append("pane layout을 저장하지 못했습니다: \(error.localizedDescription)")
        }
    }

    private func applyDemo(_ demo: DemoWorkspace) {
        tasks = demo.works.map { work in
            guard let record = demo.mappedRecords[work.slug] else {
                return WorkspaceTask.legacy(work, root: repositoryURL)
            }
            return WorkspaceTask.mapped(record: record, document: work, health: .ready)
        }
        selectedTaskKey = tasks.first(where: { $0.slug == demo.selectedSlug })?.id
        demoTaskStates = demo.taskStates
        activeVerificationTaskKey = demo.runningCheckID == nil ? nil : selectedTask?.id
        activeVerificationCheckID = demo.runningCheckID
        failedCheckIDs = demo.failedCheckIDs
        sessionState = demo.sessionState
        selectedAgent = selectedTask?.location.registryRecord?.selectedAgent
            .flatMap(AgentKind.init(rawValue:)) ?? .claude
        branch = selectedTask?.branch ?? "refs/heads/gdm/fix-login-regression"
        consoleText = demo.console
        diffText = demo.diff
        journalText = demo.journal
    }

    private var isAgentOperationsDemo: Bool {
        isDemo && (demoState == "agent-operations" || demoState == "agent-operations-popover")
    }

    private func configureDemoAgentOperations() {
        guard let task = selectedTask,
              let originalTerminal = workbench.layout.root.leaves.first(where: {
                  if case .terminal = $0.content { return true }
                  return false
              }) else { return }

        for leaf in workbench.layout.root.leaves where leaf.id != originalTerminal.id {
            _ = workbench.close(paneID: leaf.id)
        }

        let operations = Self.demoAgentOperations
        guard operations.count == 4 else { return }
        _ = workbench.replaceContent(
            paneID: originalTerminal.id,
            with: .terminal(TerminalPaneState(
                laneID: operations[0].laneID,
                agent: operations[0].agent
            ))
        )
        _ = workbench.split(
            paneID: originalTerminal.id,
            axis: .horizontal,
            newPaneID: operations[1].laneID,
            content: .terminal(TerminalPaneState(
                laneID: operations[1].laneID,
                agent: operations[1].agent
            ))
        )
        _ = workbench.split(
            paneID: originalTerminal.id,
            axis: .vertical,
            newPaneID: operations[2].laneID,
            content: .terminal(TerminalPaneState(
                laneID: operations[2].laneID,
                agent: operations[2].agent
            ))
        )
        _ = workbench.split(
            paneID: operations[1].laneID,
            axis: .vertical,
            newPaneID: operations[3].laneID,
            content: .terminal(TerminalPaneState(
                laneID: operations[3].laneID,
                agent: operations[3].agent
            ))
        )
        workbench.focus(originalTerminal.id)
        selectedAgent = .codex

        var inputIdentity: AgentRunIdentity?
        for operation in operations {
            let identity = AgentRunIdentity(
                sessionID: operation.sessionID,
                taskID: task.id,
                laneID: operation.laneID.uuidString.lowercased(),
                generation: 1
            )
            guard agentCoordinator.register(
                identity: identity,
                runToken: operation.runToken,
                worktreePath: task.workingDirectory.path
            ) else { continue }
            _ = agentCoordinator.accept(AgentEventEnvelope(
                schemaVersion: AgentEventEnvelope.currentSchemaVersion,
                runToken: operation.runToken,
                sessionID: operation.sessionID,
                taskID: task.id,
                laneID: identity.laneID,
                generation: identity.generation,
                sequence: 1,
                kind: operation.event,
                summary: operation.summary,
                relativePaths: []
            ))
            if operation.agent == .codex { inputIdentity = identity }
        }
        if let inputIdentity { _ = agentCoordinator.claimInput(inputIdentity) }
    }

    private func configureDemoSplitOverflow() {
        guard let filesPane = workbench.layout.root.leaves.first(where: {
            if case .files = $0.content { return true }
            return false
        }) else { return }

        let codexPaneID = UUID(uuidString: "55555555-5555-4555-8555-555555555555")!
        let claudePaneID = UUID(uuidString: "66666666-6666-4666-8666-666666666666")!
        _ = workbench.split(
            paneID: filesPane.id,
            axis: .horizontal,
            newPaneID: codexPaneID,
            content: .terminal(TerminalPaneState(laneID: codexPaneID, agent: .codex))
        )
        _ = workbench.split(
            paneID: filesPane.id,
            axis: .horizontal,
            newPaneID: claudePaneID,
            content: .terminal(TerminalPaneState(laneID: claudePaneID, agent: .claude))
        )
        workbench.focus(codexPaneID)
        selectedAgent = .codex
    }

    private func restoreSelectedAgent() {
        guard let task = selectedTask else {
            selectedAgent = .shell
            return
        }
        let liveAgent = terminalSessions.session(for: task.id)
            .flatMap { $0.state.isActive ? $0.specification.agent : nil }
        let transientForTask = Dictionary(uniqueKeysWithValues: transientSessionRecords.compactMap {
            key, record -> (String, PersistedSessionRecord)? in
            key.taskID == task.id ? (key.laneID, record) : nil
        })
        let transientAgent = WorkspaceRegistry.projectLastSession(from: transientForTask)
            .flatMap { AgentKind(rawValue: $0.kind) }
        let persistedAgent = task.location.registryRecord?.selectedAgent
            .flatMap(AgentKind.init(rawValue:))
        let restored = liveAgent
            ?? selectedAgentsByTask[task.id]
            ?? transientAgent
            ?? persistedAgent
            ?? .shell
        selectedAgent = restored
        selectedAgentsByTask[task.id] = restored
    }

    private func loadSelectedDetails() {
        guard let task = selectedTask else {
            branch = ""
            diffText = "변경된 파일이 없습니다."
            journalText = "선택된 작업이 없습니다."
            return
        }
        branch = task.branch ?? RepositoryLoader.branch(at: task.workingDirectory)
        diffText = RepositoryLoader.diff(at: task.workingDirectory)
        journalText = RepositoryLoader.journal(for: task.slug, at: task.workingDirectory)
    }

    private func appendConsole(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .newlines)
        guard !trimmed.isEmpty else { return }
        if !consoleText.isEmpty { consoleText.append("\n") }
        consoleText.append(trimmed)
    }

    private func advanceProvisioning(
        to step: WorktreeProvisioningStep,
        attemptID: UUID
    ) {
        guard provisioningAttemptID == attemptID else { return }
        guard provisioningStep.map({ $0.order <= step.order }) ?? true else { return }
        provisioningStep = step
    }

    private func run(
        _ invocation: CommandInvocation,
        arguments: [String],
        directory: URL
    ) async -> CommandResult {
        let runner = commandRunner
        return await Task.detached {
            runner.run(
                executable: invocation.executable,
                arguments: invocation.prefixArguments + arguments,
                directory: directory
            )
        }.value
    }

    private func resolvedGDMInvocation() -> CommandInvocation? {
        switch gdmToolchain {
        case .success(let invocation):
            return invocation
        case .failure(let error):
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private func revalidateTaskForMutation(
        _ task: WorkspaceTask,
        expectedPlanFingerprint: String? = nil
    ) async -> Bool {
        let validation: MutationWorkspaceValidation
        switch task.location {
        case .worktree(let record, _):
            let service = worktreeService
            let inspection = await Task.detached { service.inspect(record) }.value
            validation = MutationWorkspaceValidation(
                isValid: inspection.health == .ready && inspection.document != nil,
                health: inspection.health == .ready ? .conflicted : inspection.health,
                message: inspection.message
            )
        case .legacyRoot(let root):
            let slug = task.slug
            validation = await Task.detached {
                do {
                    _ = try RepositoryLoader.loadWork(slug: slug, from: root)
                    return MutationWorkspaceValidation(isValid: true, health: .ready, message: nil)
                } catch {
                    let health: WorkspaceHealth
                    if let pathError = error as? WorkspaceStatePathValidationError {
                        health = pathError.isUnsafeType ? .conflicted : .disconnected
                    } else {
                        health = .conflicted
                    }
                    return MutationWorkspaceValidation(
                        isValid: false,
                        health: health,
                        message: error.localizedDescription
                    )
                }
            }.value
        }

        guard validation.isValid else {
            let message = validation.message ?? "workspace identity 또는 GDM state가 올바르지 않습니다."
            if let index = tasks.firstIndex(where: { $0.id == task.id }) {
                tasks[index] = WorkspaceTask(
                    id: task.id,
                    slug: task.slug,
                    document: nil,
                    location: task.location,
                    health: validation.health,
                    statusMessage: message
                )
            }
            errorMessage = "\(task.slug) 명령을 실행하지 않았습니다: \(message)"
            workspaceWarnings.append("\(task.slug): mutation 직전 workspace 재검증 실패")
            if selectedTask?.id == task.id { loadSelectedDetails() }
            return false
        }
        if let expectedPlanFingerprint {
            let currentWork: WorkDocument
            do {
                currentWork = try RepositoryLoader.loadWork(
                    slug: task.slug,
                    from: task.workingDirectory
                )
            } catch {
                errorMessage = "\(task.slug) 명령을 실행하지 않았습니다: 검증 계획을 다시 읽지 못했습니다 (\(error.localizedDescription))"
                return false
            }
            guard currentWork.verificationPlanFingerprint == expectedPlanFingerprint else {
                replaceTaskDocument(currentWork, taskID: task.id)
                errorMessage = "\(task.slug) 명령을 실행하지 않았습니다: 승인 뒤 검증 계획 또는 계약이 변경되었습니다."
                return false
            }

            let approvalIsCurrent: Bool
            switch task.location {
            case .worktree(let record, _):
                let currentRecord = try? registry.load().tasks.first(where: { $0.id == record.id })
                if currentRecord?.checksApprovalRequired == true {
                    approvalIsCurrent = currentWork.verificationPlanSourceFingerprint != nil
                        && currentRecord?.approvedChecksFingerprint == expectedPlanFingerprint
                } else {
                    approvalIsCurrent = true
                }
            case .legacyRoot:
                approvalIsCurrent = !transientPlanApprovalRequiredTaskIDs.contains(task.id)
                    || transientApprovedPlanFingerprints[task.id] == expectedPlanFingerprint
            }
            guard approvalIsCurrent else {
                replaceTaskDocument(currentWork, taskID: task.id)
                errorMessage = "\(task.slug) 명령을 실행하지 않았습니다: 현재 검증 계획의 승인이 없습니다."
                return false
            }
            replaceTaskDocument(currentWork, taskID: task.id)
        }
        return true
    }

    private func handleSessionState(
        _ state: TerminalSessionState,
        task: WorkspaceTask,
        session: TerminalSession,
        startedAt: String
    ) {
        let key = TerminalSessionLaneKey(taskID: task.id, laneID: session.laneID)
        switch state {
        case .idle:
            break
        case .running:
            agentCoordinator.terminalDidStart(sessionID: session.id)
            fallthrough
        case .starting, .stopping:
            selectedAgentsByTask[task.id] = session.specification.agent
            if selectedTask?.id == task.id { sessionState = .running }
            persistSession(
                task: task,
                laneID: key.laneID,
                kind: session.specification.agent,
                startedAt: startedAt,
                outcome: .active,
                endedAt: nil
            )
            transientSessionRecords[key] = PersistedSessionRecord(
                kind: session.specification.agent.rawValue,
                startedAt: startedAt,
                endedAt: nil,
                outcome: .active
            )
        case .ended(let termination):
            agentCoordinator.finish(sessionID: session.id)
            pendingAutomationPrompts.removeValue(forKey: session.id)
            sessionStartedAt.removeValue(forKey: session.id)
            let outcome: PersistedSessionOutcome
            switch termination {
            case .launchFailed:
                outcome = .launchFailed
            case .exited, .signaled, .driverStopped:
                outcome = .ended
            case .ownershipLost, .waitFailed, .reapTimedOut, .unknownWaitStatus:
                outcome = .interrupted
            }
            let endedAt = Self.timestamp()
            persistSession(
                task: task,
                laneID: key.laneID,
                kind: session.specification.agent,
                startedAt: startedAt,
                outcome: outcome,
                endedAt: endedAt
            )
            transientSessionRecords[key] = PersistedSessionRecord(
                kind: session.specification.agent.rawValue,
                startedAt: startedAt,
                endedAt: endedAt,
                outcome: outcome
            )
            let hasActiveSibling = terminalSessions.snapshot().contains {
                $0.taskID == task.id && $0.state.isActive
            }
            if selectedTask?.id == task.id {
                sessionState = hasActiveSibling ? .running : .ready
            }
        }
        rebuildAgentActivity()
    }

    private func persistSession(
        task: WorkspaceTask,
        laneID: String,
        kind: AgentKind,
        startedAt: String,
        outcome: PersistedSessionOutcome,
        endedAt: String?
    ) {
        guard let recordID = task.location.registryRecord?.id else { return }
        let persisted = PersistedSessionRecord(
            kind: kind.rawValue,
            startedAt: startedAt,
            endedAt: endedAt,
            outcome: outcome
        )
        do {
            _ = try registry.updateSession(recordID: recordID, laneID: laneID, session: persisted)
            let document = try registry.update { document in
                guard let index = document.tasks.firstIndex(where: { $0.id == recordID }) else { return }
                document.tasks[index].selectedAgent = kind.rawValue
            }
            replaceTaskRecord(recordID: recordID, from: document)
        } catch {
            workspaceWarnings.append("세션 메타데이터를 저장하지 못했습니다: \(error.localizedDescription)")
        }
    }

    private func rebuildAgentActivity() {
        let items = isDemo ? makeDemoAgentActivityItems() : makeAgentActivityItems()
        let orderedItems = items.sorted { lhs, rhs in
            let lhsAgent = AgentKind.allCases.firstIndex(of: lhs.agent) ?? .max
            let rhsAgent = AgentKind.allCases.firstIndex(of: rhs.agent) ?? .max
            if lhsAgent != rhsAgent { return lhsAgent < rhsAgent }
            if lhs.state.summaryRank != rhs.state.summaryRank {
                return lhs.state.summaryRank < rhs.state.summaryRank
            }
            return lhs.taskSlug.localizedStandardCompare(rhs.taskSlug) == .orderedAscending
        }

        let summaries = AgentKind.allCases.map { agent -> AgentActivitySummary in
            let agentItems = orderedItems.filter { $0.agent == agent }
            let state: AgentActivityState
            if let dominant = agentItems.min(by: {
                $0.state.summaryRank < $1.state.summaryRank
            }) {
                state = dominant.state
            } else {
                let isAvailable = isDemo || agentCatalog.isAvailable(agent)
                state = isAvailable ? .idle : .unavailable
            }
            return AgentActivitySummary(agent: agent, state: state, items: agentItems)
        }

        agentActivityItems = orderedItems
        agentActivitySummaries = summaries
        agentActivityLiveCount = summaries.reduce(0) { $0 + $1.runningCount }
    }

    private func makeAgentActivityItems() -> [AgentActivityItem] {
        let taskByID = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
        // Active sessions must never disappear from Activity merely because
        // their task row is temporarily absent. Repository switching uses the
        // same manager-wide active set, so hiding one here creates an
        // impossible-to-resolve blocker.
        let snapshots = terminalSessions.snapshot().filter {
            taskByID[$0.taskID] != nil || $0.state.isActive
        }
        let snapshotKeys = Set(snapshots.map {
            TerminalSessionLaneKey(taskID: $0.taskID, laneID: $0.laneID)
        })
        let snapshotTaskIDs = Set(snapshots.map(\.taskID))
        var items = snapshots.map { snapshot -> AgentActivityItem in
            let task = taskByID[snapshot.taskID]
            let key = TerminalSessionLaneKey(taskID: snapshot.taskID, laneID: snapshot.laneID)
            let record = task?.location.registryRecord
            let persisted = transientSessionRecords[key]
                ?? record?.sessionsByLane?[snapshot.laneID]
                ?? (record?.sessionsByLane == nil ? record?.lastSession : nil)
            return AgentActivityItem(
                taskID: snapshot.taskID,
                laneID: snapshot.laneID,
                agent: snapshot.agent,
                state: agentCoordinator.status(
                    taskID: snapshot.taskID,
                    laneID: snapshot.laneID,
                    generation: snapshot.generation
                )?.semanticState.activityState ?? Self.activityState(for: snapshot.state),
                taskSlug: task?.slug ?? "Detached session",
                branch: activityBranch(for: task),
                worktreePath: task?.workingDirectory.path ?? "task · \(snapshot.taskID)",
                startedAt: snapshot.startedAt,
                endedAt: persisted?.endedAt.flatMap(Self.parseTimestamp)
            )
        }

        let legacyLaneMarker = "__legacy_last_session__"
        for task in tasks {
            var persistedByLane: [String: PersistedSessionRecord]
            if let canonical = task.location.registryRecord?.sessionsByLane {
                persistedByLane = canonical
            } else if let legacy = task.location.registryRecord?.lastSession {
                persistedByLane = [legacyLaneMarker: legacy]
            } else {
                persistedByLane = [:]
            }
            for (key, record) in transientSessionRecords where key.taskID == task.id {
                persistedByLane[key.laneID] = record
            }

            for (laneID, persisted) in persistedByLane {
                let isLegacy = laneID == legacyLaneMarker
                let key = TerminalSessionLaneKey(taskID: task.id, laneID: laneID)
                guard (!isLegacy || !snapshotTaskIDs.contains(task.id)),
                      (isLegacy || !snapshotKeys.contains(key)),
                      let agent = AgentKind(rawValue: persisted.kind) else { continue }
                items.append(
                    AgentActivityItem(
                        taskID: task.id,
                        laneID: isLegacy ? nil : laneID,
                        agent: agent,
                        state: Self.activityState(for: persisted.outcome),
                        taskSlug: task.slug,
                        branch: activityBranch(for: task),
                        worktreePath: task.workingDirectory.path,
                        startedAt: Self.parseTimestamp(persisted.startedAt),
                        endedAt: persisted.endedAt.flatMap(Self.parseTimestamp)
                    )
                )
            }
        }
        return items
    }

    /// Existing demo documents predate Agent Activity. This adapter supplies
    /// deterministic display-only rows without manufacturing terminal sessions.
    private func makeDemoAgentActivityItems() -> [AgentActivityItem] {
        guard !tasks.isEmpty else { return [] }
        let base = Self.parseTimestamp("2026-08-07T12:34:12Z")
            ?? Date(timeIntervalSince1970: 0)

        if demoState == "detached-session" {
            return [
                AgentActivityItem(
                    taskID: "missing-task",
                    laneID: "f77ef90b-c031-4c7f-b690-e51cbbbc0e43",
                    agent: .codex,
                    state: .active,
                    taskSlug: "Detached session",
                    branch: nil,
                    worktreePath: "task · missing-task",
                    startedAt: base,
                    endedAt: nil
                )
            ]
        }

        if isAgentOperationsDemo, let task = selectedTask {
            return Self.demoAgentOperations.map { operation in
                let laneID = operation.laneID.uuidString.lowercased()
                let state = agentCoordinator.status(
                    taskID: task.id,
                    laneID: laneID,
                    generation: 1
                )?.semanticState.activityState ?? .starting
                return AgentActivityItem(
                    taskID: task.id,
                    laneID: laneID,
                    agent: operation.agent,
                    state: state,
                    taskSlug: task.slug,
                    branch: activityBranch(for: task),
                    worktreePath: task.workingDirectory.path,
                    startedAt: base,
                    endedAt: nil
                )
            }
        }

        if demoState == "worktree-loop" || demoState == "worktree-loop-proof",
           let task = selectedTask {
            return [
                AgentActivityItem(
                    taskID: task.id,
                    agent: .claude,
                    state: .active,
                    taskSlug: task.slug,
                    branch: activityBranch(for: task),
                    worktreePath: task.workingDirectory.path,
                    startedAt: base,
                    endedAt: nil
                )
            ]
        }

        let selectedState: AgentActivityState
        switch demoState {
        case "activity-starting", "starting": selectedState = .starting
        case "waiting-input", "activity-waiting": selectedState = .waiting
        case "disconnected", "reconnecting", "relaunched", "activity-interrupted":
            selectedState = .interrupted
        case "launch-failed", "activity-launch-failed": selectedState = .launchFailed
        case "activity-stopping", "stopping": selectedState = .stopping
        case "all-proven", "activity-ended", "ended": selectedState = .ended
        default: selectedState = .active
        }

        let assignments: [(AgentKind, AgentActivityState)] = [
            (.claude, selectedState),
            (.codex, .ended),
            (.shell, .active)
        ]
        return zip(tasks, assignments).map { task, assignment in
            let (agent, state) = assignment
            let endedAt = state.isRunning ? nil : base.addingTimeInterval(2_468)
            return AgentActivityItem(
                taskID: task.id,
                agent: agent,
                state: state,
                taskSlug: task.slug,
                branch: activityBranch(for: task),
                worktreePath: task.workingDirectory.path,
                startedAt: base,
                endedAt: endedAt
            )
        }
    }

    private func activityBranch(for task: WorkspaceTask?) -> String? {
        guard let task else { return nil }
        if let branch = task.branch, !branch.isEmpty { return branch }
        if isDemo, let branch = task.document?.delivery?.branch, !branch.isEmpty {
            return branch
        }
        let discovered = RepositoryLoader.branch(at: task.workingDirectory)
        return discovered.isEmpty ? nil : discovered
    }

    private static func activityState(for state: TerminalSessionState) -> AgentActivityState {
        switch state {
        case .idle: .idle
        case .starting: .starting
        case .running: .active
        case .stopping: .stopping
        case .ended(let termination):
            switch termination {
            case .launchFailed: .launchFailed
            case .exited, .signaled: .ended
            case .driverStopped: .ended
            case .ownershipLost, .waitFailed, .reapTimedOut, .unknownWaitStatus: .interrupted
            }
        }
    }

    private static func activityState(
        for outcome: PersistedSessionOutcome
    ) -> AgentActivityState {
        switch outcome {
        case .active:
            // A persisted live marker has no process ownership after restart.
            .interrupted
        case .ended: .ended
        case .interrupted: .interrupted
        case .launchFailed: .launchFailed
        }
    }

    private static func parseTimestamp(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }

    private static func timestamp() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    private static func sanitizedTerminalPrompt(_ value: String) -> String {
        var sanitized = ""
        sanitized.reserveCapacity(value.utf8.count)
        for scalar in value.unicodeScalars {
            if CharacterSet.controlCharacters.contains(scalar) {
                sanitized.append(" ")
            } else {
                sanitized.unicodeScalars.append(scalar)
            }
        }
        return sanitized
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
    }

    private func replaceTaskRecord(
        recordID: UUID,
        from document: WorkspaceRegistryDocument
    ) {
        guard let taskIndex = tasks.firstIndex(where: { $0.location.registryRecord?.id == recordID }),
              let record = document.tasks.first(where: { $0.id == recordID }) else { return }
        let task = tasks[taskIndex]
        tasks[taskIndex] = .mapped(
            record: record,
            document: task.document,
            health: task.health,
            message: task.statusMessage
        )
    }

    private static func stopAllowsQuit(_ result: TerminalStopResult) -> Bool {
        switch result {
        case .reaped, .notRunning:
            true
        case .alreadyEnded(let termination):
            switch termination {
            case .exited, .signaled, .launchFailed, .driverStopped: true
            case .ownershipLost, .waitFailed, .reapTimedOut, .unknownWaitStatus: false
            }
        case .alreadyStopping, .invalidOwnership, .ownershipLost, .waitFailed, .reapTimedOut:
            false
        }
    }

    private static func stopErrorMessage(_ result: TerminalStopResult) -> String? {
        switch result {
        case .reaped, .notRunning:
            return nil
        case .alreadyEnded(let termination):
            switch termination {
            case .exited, .signaled, .driverStopped:
                return nil
            case .launchFailed(let message):
                return "terminal을 시작하지 못했습니다: \(message)"
            case .ownershipLost:
                return "terminal child 소유권을 확인하지 못해 안전한 종료를 증명할 수 없습니다."
            case .waitFailed(let errorNumber):
                return "terminal child 회수에 실패했습니다: waitpid errno \(errorNumber)"
            case .reapTimedOut:
                return "terminal child 회수가 제한 시간을 초과했습니다. 종료 정리를 다시 시도하세요."
            case .unknownWaitStatus(let status):
                return "terminal child 종료 상태를 해석하지 못했습니다: \(status.map(String.init) ?? "nil")"
            }
        case .alreadyStopping:
            return "terminal 종료 정리가 아직 진행 중입니다."
        case .invalidOwnership(let pid, let pgid):
            return "terminal child 소유권을 확인하지 못했습니다 (pid \(pid), pgid \(pgid.map(String.init) ?? "nil"))."
        case .ownershipLost:
            return "terminal child 소유권을 잃어 신호를 보내지 않았습니다. 종료 정리를 다시 확인하세요."
        case .waitFailed(let errorNumber):
            return "terminal child 회수에 실패했습니다: waitpid errno \(errorNumber)"
        case .reapTimedOut:
            return "terminal child 회수가 제한 시간을 초과했습니다. 종료 정리를 다시 시도하세요."
        }
    }

    private static func shortBranch(_ value: String) -> String {
        value.hasPrefix("refs/heads/") ? String(value.dropFirst("refs/heads/".count)) : value
    }
}

private struct MutationWorkspaceValidation: Sendable {
    let isValid: Bool
    let health: WorkspaceHealth
    let message: String?
}
