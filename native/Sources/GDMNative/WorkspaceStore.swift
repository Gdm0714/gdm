import Combine
import Foundation

@MainActor
final class WorkspaceStore: ObservableObject {
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

    let repositoryURL: URL
    let isDemo: Bool
    let terminalSessions: TerminalSessionManager
    let agentIconResolver: AgentIconResolver

    private let registry: WorkspaceRegistry
    private let worktreeService: WorktreeService
    private let agentCatalog: AgentCatalog
    private let commandRunner: WorktreeCommandRunner
    private let demoState: String?
    private var demoTaskStates: [String: TaskDisplayState] = [:]
    private var sessionStartedAt: [UUID: String] = [:]
    private var transientSessionRecords: [String: PersistedSessionRecord] = [:]
    private var selectedAgentsByTask: [String: AgentKind] = [:]
    private var pendingSessionLaunchTaskIDs: Set<String> = []
    private var provisioningAttemptID: UUID?
    private var didRunRecovery = false

    init(
        repositoryURL: URL,
        demoState: String? = nil,
        isDemo: Bool = false,
        terminalSessions: TerminalSessionManager = TerminalSessionManager(),
        commandRunner: WorktreeCommandRunner = .live,
        agentCatalog: AgentCatalog = AgentCatalog(),
        agentIconResolver: AgentIconResolver = AgentIconResolver()
    ) {
        self.repositoryURL = repositoryURL
        self.isDemo = isDemo
        self.demoState = demoState
        self.registry = WorkspaceRegistry(repositoryURL: repositoryURL)
        self.worktreeService = WorktreeService(repositoryURL: repositoryURL, registry: registry)
        self.agentCatalog = agentCatalog
        self.agentIconResolver = agentIconResolver
        self.terminalSessions = terminalSessions
        self.commandRunner = commandRunner
        if isDemo {
            applyDemo(DemoData.workspace(state: demoState))
            rebuildAgentActivity()
            if demoState == "worktree-loop-proof" {
                compactPane = .proof
                focusedRegion = .proof
            }
        } else {
            refresh()
        }
    }

    var repositoryName: String { repositoryURL.lastPathComponent }
    var branchLabel: String { Self.shortBranch(branch) }
    var presentsAgentActivityPopoverInDemo: Bool {
        isDemo && demoState == "activity-popover"
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
        return terminalSessions.session(for: task.id)
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
            tasks = loaded.tasks
            workspaceWarnings = loaded.warnings

            let preferredKey = selectedTaskKey ?? registryDocument.selectedTaskKey
            if let preferredKey, tasks.contains(where: { $0.id == preferredKey }) {
                selectedTaskKey = preferredKey
            } else {
                selectedTaskKey = tasks.first?.id
            }
            restoreSelectedAgent()
            loadSelectedDetails()
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
        selectedTaskKey = task.id
        focusedRegion = .tasks
        restoreSelectedAgent()
        loadSelectedDetails()
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
        if work.checks.isEmpty { return .planned }
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
              let work = task.document,
              activeVerificationTaskKey == nil else { return }
        let executableChecks = work.checks.filter { !$0.isProven && !$0.manual && $0.cmd != nil }
        let invocation = CommandRunner.gdm(at: repositoryURL)
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
                if await revalidateTaskForMutation(task) {
                    appendConsole("$ gdm recheck --slug \(slug) · cwd \(directory.path)")
                    let result = await run(
                        invocation,
                        arguments: ["recheck", "--slug", slug],
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
                    guard await revalidateTaskForMutation(task) else {
                        stateValidationFailed = true
                        break
                    }
                    appendConsole("$ gdm pass \(check.id) --slug \(slug) · cwd \(directory.path)")
                    let result = await run(
                        invocation,
                        arguments: ["pass", check.id, "--slug", slug],
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
              let work = task.document,
              work.canComplete else {
            areBlockersPresented = true
            return
        }
        let invocation = CommandRunner.gdm(at: repositoryURL)
        let directory = task.workingDirectory
        isCommandRunning = true
        sessionState = .running
        Task {
            guard await revalidateTaskForMutation(task) else {
                isCommandRunning = false
                sessionState = .ready
                return
            }
            appendConsole("$ gdm done --slug \(work.slug) · cwd \(directory.path)")
            let result = await run(
                invocation,
                arguments: ["done", "--slug", work.slug],
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

    func chooseAgent(_ agent: AgentKind) {
        selectedAgent = agent
        if let taskID = selectedTask?.id {
            selectedAgentsByTask[taskID] = agent
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

    func startSelectedSession() {
        guard !isDemo, let task = selectedTask, task.health == .ready else { return }
        let requestedAgent = selectedAgent
        guard terminalSessions.session(for: task.id)?.state.isActive != true else {
            errorMessage = "\(task.slug)에는 이미 active agent session이 있습니다. 먼저 해당 session을 종료하세요."
            rebuildAgentActivity()
            return
        }
        guard pendingSessionLaunchTaskIDs.insert(task.id).inserted else { return }

        Task {
            defer { pendingSessionLaunchTaskIDs.remove(task.id) }
            guard await revalidateTaskForMutation(task) else {
                rebuildAgentActivity()
                return
            }
            guard let currentTask = selectedTask,
                  currentTask.id == task.id,
                  currentTask.health == .ready else {
                errorMessage = "\(task.slug) agent session을 시작하지 않았습니다: 선택 작업이 변경되었습니다."
                rebuildAgentActivity()
                return
            }
            guard terminalSessions.session(for: task.id)?.state.isActive != true else {
                errorMessage = "\(task.slug)에는 이미 active agent session이 있습니다. 먼저 해당 session을 종료하세요."
                rebuildAgentActivity()
                return
            }
            launchSession(task: currentTask, agent: requestedAgent)
        }
    }

    private func launchSession(task: WorkspaceTask, agent: AgentKind) {
        do {
            let specification = try agentCatalog.launchSpecification(
                for: agent,
                workingDirectory: task.workingDirectory
            )
            let session = try terminalSessions.start(taskID: task.id, specification: specification)
            let startedAt = Self.timestamp()
            selectedAgent = agent
            selectedAgentsByTask[task.id] = agent
            transientSessionRecords.removeValue(forKey: task.id)
            sessionStartedAt[session.id] = startedAt
            session.onStateChange = { [weak self, weak session] state in
                guard let self, let session else { return }
                self.handleSessionState(state, task: task, session: session, startedAt: startedAt)
            }
            handleSessionState(session.state, task: task, session: session, startedAt: startedAt)
        } catch {
            let failedAt = Self.timestamp()
            transientSessionRecords[task.id] = PersistedSessionRecord(
                kind: agent.rawValue,
                startedAt: failedAt,
                endedAt: failedAt,
                outcome: .launchFailed
            )
            persistSession(
                task: task,
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

    func stopSelectedSession() {
        guard !isDemo, let task = selectedTask else { return }
        Task {
            let result = await terminalSessions.stop(taskID: task.id)
            let session = terminalSessions.session(for: task.id)
            let cleanupIsActive = session?.state.isActive == true
            if cleanupIsActive, let session {
                persistSession(
                    task: task,
                    kind: session.specification.agent,
                    startedAt: sessionStartedAt[session.id] ?? Self.timestamp(),
                    outcome: .active,
                    endedAt: nil
                )
            }
            rebuildAgentActivity()
            sessionState = cleanupIsActive ? .running : .ready
            if let message = Self.stopErrorMessage(result) {
                errorMessage = message
            }
        }
    }

    func terminateAllSessions() async -> Bool {
        let results = await terminalSessions.stopAll()
        for (taskID, _) in results {
            guard let task = tasks.first(where: { $0.id == taskID }),
                  let session = terminalSessions.session(for: taskID),
                  session.state.isActive else { continue }
            persistSession(
                task: task,
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

    private func restoreSelectedAgent() {
        guard let task = selectedTask else {
            selectedAgent = .shell
            return
        }
        let liveAgent = terminalSessions.session(for: task.id)
            .flatMap { $0.state.isActive ? $0.specification.agent : nil }
        let transientAgent = transientSessionRecords[task.id]
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

    private func revalidateTaskForMutation(_ task: WorkspaceTask) async -> Bool {
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
        return true
    }

    private func handleSessionState(
        _ state: TerminalSessionState,
        task: WorkspaceTask,
        session: TerminalSession,
        startedAt: String
    ) {
        switch state {
        case .idle:
            break
        case .starting, .running, .stopping:
            selectedAgentsByTask[task.id] = session.specification.agent
            if selectedTask?.id == task.id { sessionState = .running }
            persistSession(
                task: task,
                kind: session.specification.agent,
                startedAt: startedAt,
                outcome: .active,
                endedAt: nil
            )
            transientSessionRecords[task.id] = PersistedSessionRecord(
                kind: session.specification.agent.rawValue,
                startedAt: startedAt,
                endedAt: nil,
                outcome: .active
            )
        case .ended(let termination):
            if selectedTask?.id == task.id { sessionState = .ready }
            let outcome: PersistedSessionOutcome
            switch termination {
            case .launchFailed:
                outcome = .launchFailed
            case .exited, .signaled:
                outcome = .ended
            case .ownershipLost, .waitFailed, .reapTimedOut, .unknownWaitStatus:
                outcome = .interrupted
            }
            persistSession(
                task: task,
                kind: session.specification.agent,
                startedAt: startedAt,
                outcome: outcome,
                endedAt: Self.timestamp()
            )
            transientSessionRecords[task.id] = PersistedSessionRecord(
                kind: session.specification.agent.rawValue,
                startedAt: startedAt,
                endedAt: Self.timestamp(),
                outcome: outcome
            )
            sessionStartedAt.removeValue(forKey: session.id)
        }
        rebuildAgentActivity()
    }

    private func persistSession(
        task: WorkspaceTask,
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
            let document = try registry.update { document in
                guard let index = document.tasks.firstIndex(where: { $0.id == recordID }) else { return }
                document.tasks[index].selectedAgent = kind.rawValue
                document.tasks[index].lastSession = persisted
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
        let snapshots = terminalSessions.snapshot()
        let snapshotTaskIDs = Set(snapshots.map(\.taskID))
        var items = snapshots.map { snapshot -> AgentActivityItem in
            let task = taskByID[snapshot.taskID]
            let persisted = transientSessionRecords[snapshot.taskID]
                ?? task?.location.registryRecord?.lastSession
            return AgentActivityItem(
                taskID: snapshot.taskID,
                agent: snapshot.agent,
                state: Self.activityState(for: snapshot.state),
                taskSlug: task?.slug ?? snapshot.taskID,
                branch: activityBranch(for: task),
                worktreePath: task?.workingDirectory.path ?? repositoryURL.path,
                startedAt: snapshot.startedAt,
                endedAt: persisted?.endedAt.flatMap(Self.parseTimestamp)
            )
        }

        for task in tasks where !snapshotTaskIDs.contains(task.id) {
            guard let persisted = transientSessionRecords[task.id]
                    ?? task.location.registryRecord?.lastSession,
                  let agent = AgentKind(rawValue: persisted.kind) else {
                continue
            }
            items.append(
                AgentActivityItem(
                    taskID: task.id,
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
        return items
    }

    /// Existing demo documents predate Agent Activity. This adapter supplies
    /// deterministic display-only rows without manufacturing terminal sessions.
    private func makeDemoAgentActivityItems() -> [AgentActivityItem] {
        guard !tasks.isEmpty else { return [] }
        let base = Self.parseTimestamp("2026-08-07T12:34:12Z")
            ?? Date(timeIntervalSince1970: 0)

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
            case .exited, .signaled, .launchFailed: true
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
            case .exited, .signaled:
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
