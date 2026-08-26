import AppKit
import SwiftUI

struct WorkspaceView: View {
    @ObservedObject var store: WorkspaceStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pendingTaskKey: String?
    @State private var contentOpacity = 1.0
    @State private var selectionGeneration = 0
    @State private var isAgentActivityPresented = false
    @State private var highlightedActivityAgent: AgentKind?
    @State private var cachedAgentActivityBounds: CGRect?

    private var effectiveReduceMotion: Bool {
        reduceMotion || CommandLine.arguments.contains("--reduce-motion")
    }

    var body: some View {
        GeometryReader { geometry in
            let compact = geometry.size.width < DesignTokens.compactBreakpoint
            let taskRailWidth = compact ? DesignTokens.taskRailMinimumWidth : DesignTokens.taskRailWidth

            ZStack {
                VStack(spacing: 0) {
                    WorkspaceToolbar(
                        store: store,
                        width: geometry.size.width,
                        compact: compact,
                        isAgentActivityPresented: $isAgentActivityPresented,
                        highlightedActivityAgent: $highlightedActivityAgent
                    )
                        .zIndex(20)

                    if store.tasks.isEmpty {
                        HStack(spacing: 0) {
                            taskRail(width: taskRailWidth)
                            EmptyWorkspaceView { store.presentNewTask() }
                        }
                    } else {
                        HStack(spacing: 0) {
                            taskRail(width: taskRailWidth)

                            CenterPaneView(store: store, compact: compact)
                                .opacity(contentOpacity)

                            if !compact {
                                ProofRailView(store: store, compact: false)
                                    .frame(width: DesignTokens.proofRailWidth)
                                    .frame(
                                        width: store.isProofRailVisible ? DesignTokens.proofRailWidth : 0,
                                        alignment: .leading
                                    )
                                    .clipped()
                                    .allowsHitTesting(store.isProofRailVisible)
                                    .accessibilityHidden(!store.isProofRailVisible)
                                    .opacity(contentOpacity)
                                    .animation(
                                        MotionAnimations.panel(reduceMotion: effectiveReduceMotion),
                                        value: store.isProofRailVisible
                                    )
                            }
                        }
                    }

                    WorkspaceStatusBar(store: store)
                }

                if store.isPalettePresented {
                    CommandPaletteView(store: store)
                        .zIndex(30)
                }

                if store.isNewTaskPresented {
                    ZStack {
                        DesignTokens.surfaceTerminal.opacity(0.82)
                            .ignoresSafeArea()
                            .contentShape(Rectangle())
                            .onTapGesture {
                                if !store.isProvisioning { dismissNewTask() }
                            }
                            .mountOnlyMotion(duration: MotionTokens.overlayBackdrop, rise: 0)

                        NewTaskSheet(
                            store: store,
                            maximumHeight: max(
                                DesignTokens.rowHeight,
                                geometry.size.height - (DesignTokens.space5 * 2)
                            ),
                            dismiss: dismissNewTask
                        )
                    }
                    .zIndex(35)
                }

                if store.isLoading {
                    LoadingOverlay()
                        .mountOnlyMotion(duration: MotionTokens.overlaySheet)
                        .zIndex(40)
                }

                ShortcutCommands(store: store, compact: compact)

            }
            .coordinateSpace(name: AgentActivityBoundsPreferenceKey.coordinateSpaceName)
            .background(DesignTokens.surfaceApp)
            .onPreferenceChange(AgentActivityBoundsPreferenceKey.self) { bounds in
                cacheAgentActivityBounds(bounds)
            }
            .overlay(alignment: .topLeading) {
                if let bounds = cachedAgentActivityBounds, isAgentActivityPresented {
                    let popoverX = min(
                        max(DesignTokens.space2, bounds.maxX - DesignTokens.agentActivityPopoverWidth),
                        geometry.size.width - DesignTokens.agentActivityPopoverWidth - DesignTokens.space2
                    )

                    ZStack(alignment: .topLeading) {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { dismissAgentActivity() }

                        AgentActivityPopover(
                            store: store,
                            highlightedAgent: highlightedActivityAgent,
                            maximumHeight: min(
                                840,
                                max(
                                    320,
                                    geometry.size.height
                                        - bounds.maxY
                                        - DesignTokens.statusBarHeight
                                        - DesignTokens.space3
                                )
                            ),
                            dismiss: dismissAgentActivity
                        )
                        .frame(width: DesignTokens.agentActivityPopoverWidth)
                        .offset(x: popoverX, y: bounds.maxY + DesignTokens.space2)
                        .mountOnlyMotion(duration: MotionTokens.overlayPopover)
                    }
                }
            }
            .environment(\.gdmReduceMotion, effectiveReduceMotion)
            .onChange(of: effectiveReduceMotion) { _, isEnabled in
                if isEnabled { settleTaskSelectionWithoutMotion() }
            }
        }
        .frame(minWidth: 1024, minHeight: 700)
        .preferredColorScheme(.dark)
        .onReceive(NotificationCenter.default.publisher(for: .gidemOpenRepository)) { _ in
            guard !store.isDemo else { return }
            presentRepositoryPicker(for: store)
        }
        .onReceive(NotificationCenter.default.publisher(for: .gidemSaveFocusedFile)) { _ in
            store.saveFocusedFile()
        }
        .onReceive(NotificationCenter.default.publisher(for: .gidemNewTask)) { _ in
            store.presentNewTask()
        }
        .onReceive(NotificationCenter.default.publisher(for: .gidemStartFocusedAgent)) { _ in
            store.startFocusedSession()
        }
        .onReceive(NotificationCenter.default.publisher(for: .gidemRunVerification)) { _ in
            store.performPrimaryVerificationAction()
        }
        .onReceive(NotificationCenter.default.publisher(for: .gidemShowCommandPalette)) { _ in
            guard !store.isLoading, !store.isNewTaskPresented else { return }
            store.isPalettePresented = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .gidemShowTerminal)) { _ in
            store.revealPane(.terminal(TerminalPaneState(agent: store.selectedAgent)))
        }
        .onReceive(NotificationCenter.default.publisher(for: .gidemShowProof)) { _ in
            store.revealPane(.proof)
        }
        .onReceive(NotificationCenter.default.publisher(for: .gidemSplitPaneRight)) { _ in
            store.splitPane(store.workbench.focusedPaneID, axis: .horizontal)
        }
        .onReceive(NotificationCenter.default.publisher(for: .gidemSplitPaneDown)) { _ in
            store.splitPane(store.workbench.focusedPaneID, axis: .vertical)
        }
        .onReceive(NotificationCenter.default.publisher(for: .gidemCloseFocusedPane)) { _ in
            guard store.canCloseFocusedPane else { return }
            store.closePane(store.workbench.focusedPaneID)
        }
        .alert("작업을 계속할 수 없습니다", isPresented: Binding(
            get: { store.errorMessage != nil },
            set: { if !$0 { store.errorMessage = nil } }
        )) {
            Button("닫기") { store.errorMessage = nil }
        } message: {
            Text(store.errorMessage ?? "원인을 확인할 수 없습니다.")
        }
    }

    private func taskRail(width: CGFloat) -> some View {
        TaskRailView(
            store: store,
            width: width,
            selectedTaskKey: pendingTaskKey ?? store.selectedTaskKey,
            onSelect: selectTask
        )
        .frame(width: width)
        .frame(width: store.isTaskRailVisible ? width : 0, alignment: .leading)
        .clipped()
        .allowsHitTesting(store.isTaskRailVisible)
        .accessibilityHidden(!store.isTaskRailVisible)
        .animation(MotionAnimations.panel(reduceMotion: effectiveReduceMotion), value: store.isTaskRailVisible)
    }

    private func selectTask(_ task: WorkspaceTask) {
        guard task.id != store.selectedTask?.id || pendingTaskKey != nil else {
            store.focusedRegion = .tasks
            return
        }

        selectionGeneration += 1
        let currentGeneration = selectionGeneration
        pendingTaskKey = task.id

        guard !effectiveReduceMotion else {
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                store.select(task)
                pendingTaskKey = nil
                contentOpacity = 1
            }
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + MotionTokens.fadeIn) {
            guard selectionGeneration == currentGeneration else { return }
            withAnimation(MotionAnimations.fadeOut(reduceMotion: false)) {
                contentOpacity = 0
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + MotionTokens.fadeOut) {
                guard selectionGeneration == currentGeneration else { return }
                var transaction = Transaction(animation: nil)
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    store.select(task)
                    pendingTaskKey = nil
                }
                withAnimation(MotionAnimations.fadeIn(reduceMotion: false)) {
                    contentOpacity = 1
                }
            }
        }
    }

    private func dismissAgentActivity() {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) { isAgentActivityPresented = false }
    }

    private func cacheAgentActivityBounds(_ bounds: CGRect?) {
        guard let bounds, bounds != cachedAgentActivityBounds else { return }
        cachedAgentActivityBounds = bounds
    }

    private func settleTaskSelectionWithoutMotion() {
        selectionGeneration += 1
        let task = pendingTaskKey.flatMap { key in
            store.tasks.first(where: { $0.id == key })
        }
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            if let task { store.select(task) }
            pendingTaskKey = nil
            contentOpacity = 1
        }
    }

    private func dismissNewTask() {
        guard !store.isProvisioning else { return }
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) { store.isNewTaskPresented = false }
    }
}

private struct WorkspaceToolbar: View {
    @ObservedObject var store: WorkspaceStore
    let width: CGFloat
    let compact: Bool
    @Binding var isAgentActivityPresented: Bool
    @Binding var highlightedActivityAgent: AgentKind?

    var body: some View {
        HStack(spacing: DesignTokens.space3) {
            HStack(spacing: DesignTokens.space2) {
                GidemBrandMark()
                    .frame(width: 18, height: 18)
                if !compact {
                    Text(GidemBrandAssets.productName)
                        .font(.system(size: DesignTokens.rowSize, weight: .semibold))
                        .foregroundStyle(DesignTokens.textStrong)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(GidemBrandAssets.productName)

            Button { store.toggleTasks() } label: {
                Text(store.isTaskRailVisible ? "◀" : "▶")
                    .font(.system(size: DesignTokens.metaSize, design: .monospaced))
            }
            .buttonStyle(OperationalButtonStyle())
            .help("작업 목록 접기 · ⌘[")
            .accessibilityLabel(store.isTaskRailVisible ? "작업 목록 숨기기" : "작업 목록 표시")
            .accessibilityValue(store.isTaskRailVisible ? "표시됨" : "숨김")

            Text(store.repositoryName)
                .font(.system(size: DesignTokens.bodySize, weight: .semibold, design: .monospaced))
                .foregroundStyle(DesignTokens.textStrong)
            Text("/").foregroundStyle(DesignTokens.textTertiary)
            Text(store.branchLabel.isEmpty ? "detached" : store.branchLabel)
                .font(.system(size: DesignTokens.rowSize, design: .monospaced))
                .foregroundStyle(DesignTokens.textPrimary)
                .lineLimit(1)
            if !compact {
                Text("/").foregroundStyle(DesignTokens.textTertiary)
                Text(store.selectedTask?.workingDirectory.path ?? store.repositoryURL.path)
                    .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Button { presentRepositoryPicker(for: store) } label: {
                Image(systemName: "folder")
                    .font(.system(size: DesignTokens.metaSize, weight: .medium))
            }
            .buttonStyle(OperationalButtonStyle())
            .keyboardShortcut("o", modifiers: .command)
            .disabled(store.isDemo)
            .help("Repository 열기 · ⌘O")
            .accessibilityLabel("Repository 열기")

            Spacer(minLength: DesignTokens.space3)

            AgentActivityView(
                store: store,
                availableWidth: width,
                isPresented: $isAgentActivityPresented,
                highlightedAgent: $highlightedActivityAgent
            )

            Button {
                store.isPalettePresented = true
            } label: {
                Text(compact ? "⌘K" : "Command  ⌘K")
                    .lineLimit(1)
            }
            .buttonStyle(OperationalButtonStyle())
            .keyboardShortcut("k", modifiers: .command)
            .help("명령, 작업 또는 파일 찾기 · ⌘K")
            .accessibilityLabel("명령 팔레트 열기")

            SignalMarker(
                glyph: compact ? "R" : "RISK",
                label: store.selectedWork?.contract.risk?.uppercased() ?? "LOW",
                tone: (store.selectedWork?.auditRequired ?? false) ? .blocked : .attention
            )

            Button {
                store.performPrimaryVerificationAction()
            } label: {
                Text(primaryActionLabel)
                    .lineLimit(1)
            }
            .buttonStyle(OperationalButtonStyle())
            .keyboardShortcut("r", modifiers: .command)
            .disabled(!store.canPerformPrimaryVerificationAction)
            .help(store.primaryVerificationActionHint)
            .accessibilityLabel(store.primaryVerificationActionLabel)
            .accessibilityHint(store.primaryVerificationActionHint)

            Button { store.refresh() } label: {
                Text("↻")
                    .font(.system(size: DesignTokens.bodySize, design: .monospaced))
            }
            .buttonStyle(OperationalButtonStyle())
            .disabled(store.isDemo)
            .help("상태 새로고침")
            .accessibilityLabel("워크스페이스 상태 새로고침")

            Button { store.toggleProof(compact: compact) } label: {
                Text(compact ? "P" : (store.isProofRailVisible ? "▶" : "◀"))
                    .font(.system(size: DesignTokens.metaSize, design: .monospaced))
            }
            .buttonStyle(OperationalButtonStyle())
            .help(compact ? "Proof pane 열기 · ⌘]" : "Proof Rail 접기 · ⌘]")
            .accessibilityLabel(compact ? "Proof pane 열기" : (store.isProofRailVisible ? "Proof Rail 숨기기" : "Proof Rail 표시"))
            .accessibilityValue(compact ? (store.isFocusedProofPane ? "열림" : "준비됨") : (store.isProofRailVisible ? "표시됨" : "숨김"))
        }
        .padding(.horizontal, DesignTokens.space3)
        .frame(height: DesignTokens.toolbarHeight)
        .background(DesignTokens.surfaceBar)
        .overlay(alignment: .bottom) {
            Rectangle().fill(DesignTokens.lineStructure).frame(height: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("워크스페이스 도구 막대")
    }

    private var primaryActionLabel: String {
        if store.isCommandRunning { return "Working…" }
        guard compact else { return "\(store.primaryVerificationActionLabel)  ⌘R" }
        let short: String = switch store.selectedVerificationPlanState {
        case .needsPlan: "Plan"
        case .reviewRequired: "Review"
        case .approved, .unavailable: "Run"
        }
        return "\(short)  ⌘R"
    }
}

private struct WorkspaceStatusBar: View {
    @ObservedObject var store: WorkspaceStore

    var body: some View {
        HStack(spacing: DesignTokens.space4) {
            Text("● gdm state")
                .foregroundStyle(DesignTokens.active)
            Text("\(store.tasks.count) tasks")
            if let work = store.selectedWork {
                Text("\(work.provenCount)/\(work.checks.count) proven")
                Text("\(store.selectedCompletionBlockers.count) blockers")
                    .foregroundStyle(store.selectedCompletionBlockers.isEmpty ? DesignTokens.proven : DesignTokens.attention)
            }
            if !store.workspaceWarnings.isEmpty {
                Text("\(store.workspaceWarnings.count) workspace warnings")
                    .foregroundStyle(DesignTokens.attention)
            }
            Spacer()
            Text("PANE · \(store.workbench.layout.focusedLeaf?.content.title ?? "NONE")")
                .foregroundStyle(DesignTokens.textSecondary)
            ViewThatFits(in: .horizontal) {
                Text("⌘K commands · ⌃G H/J/K/L focus · ⌃G S… split · ⌃G X close")
                Text("⌃G pane mode · ⌘K commands")
            }
            .help("Ghostty pane mode: ⌃G H/J/K/L focus · ⌃G S H/J/K/L split · ⌃G W H/J/U/L resize · ⌃G X close")
        }
        .font(.system(size: DesignTokens.metaSize, design: .monospaced))
        .foregroundStyle(DesignTokens.textTertiary)
        .padding(.horizontal, DesignTokens.space3)
        .frame(height: DesignTokens.statusBarHeight)
        .background(DesignTokens.surfaceStatusBar)
        .overlay(alignment: .top) { TokenDivider() }
    }
}

enum CommandPaletteNavigation {
    enum Direction {
        case previous
        case next
    }

    static func move(
        selection: String?,
        orderedIDs: [String],
        direction: Direction
    ) -> String? {
        guard !orderedIDs.isEmpty else { return nil }
        guard let selection, let index = orderedIDs.firstIndex(of: selection) else {
            return direction == .next ? orderedIDs.first : orderedIDs.last
        }
        switch direction {
        case .previous:
            return orderedIDs[(index - 1 + orderedIDs.count) % orderedIDs.count]
        case .next:
            return orderedIDs[(index + 1) % orderedIDs.count]
        }
    }
}

private struct CommandPaletteView: View {
    @ObservedObject var store: WorkspaceStore
    @State private var query = ""
    @State private var selectedResultID: String?
    @FocusState private var searchFocused: Bool

    private struct CommandItem: Identifiable {
        let id: String
        let title: String
        let detail: String
        let shortcut: String
        let enabled: Bool
        let action: () -> Void
    }

    private var commands: [CommandItem] {
        [
            command("open-repository", "Open repository", "Switch the complete workspace", "⌘O", enabled: !store.isDemo) {
                dismiss(); presentRepositoryPicker(for: store)
            },
            command("run", store.primaryVerificationActionLabel, primaryActionDetail, "⌘R", enabled: store.canPerformPrimaryVerificationAction) {
                dismiss(); store.performPrimaryVerificationAction()
            },
            command("start-session", "Start focused agent", startActionDetail, "⌘↩", enabled: store.canStartFocusedSession) {
                dismiss(); store.startFocusedSession()
            },
            command("new-task", "New task and contract", newTaskActionDetail, "⌘N", enabled: store.canPresentNewTask) {
                store.presentNewTask()
            },
            command("save", "Save focused file", "Write the active editor buffer safely", "⌘S") {
                dismiss(); store.saveFocusedFile()
            },
            command("split-right", "Split Pane Right", "Open another agent terminal beside this pane", "⌘D · ⌃G›S›L") {
                dismiss(); store.splitPane(store.workbench.focusedPaneID, direction: .right)
            },
            command("split-left", "Split Pane Left", "Open another agent terminal left of this pane", "⌃G›S›H") {
                dismiss(); store.splitPane(store.workbench.focusedPaneID, direction: .left)
            },
            command("split-down", "Split Pane Down", "Open another agent terminal below this pane", "⇧⌘D · ⌃G›S›J") {
                dismiss(); store.splitPane(store.workbench.focusedPaneID, direction: .down)
            },
            command("split-up", "Split Pane Up", "Open another agent terminal above this pane", "⌃G›S›K") {
                dismiss(); store.splitPane(store.workbench.focusedPaneID, direction: .up)
            },
            command("close-pane", "Close Focused Pane", closePaneActionDetail, "⇧⌘K · ⌃G›X", enabled: store.canCloseFocusedPane) {
                dismiss(); store.closePane(store.workbench.focusedPaneID)
            },
            command("focus-left", "Focus Pane Left", "Move focus to the pane on the left", "⌃G›H") {
                dismiss(); _ = store.focusPane(.direction(.left))
            },
            command("focus-down", "Focus Pane Down", "Move focus to the pane below", "⌃G›J") {
                dismiss(); _ = store.focusPane(.direction(.down))
            },
            command("focus-up", "Focus Pane Up", "Move focus to the pane above", "⌃G›K") {
                dismiss(); _ = store.focusPane(.direction(.up))
            },
            command("focus-right", "Focus Pane Right", "Move focus to the pane on the right", "⌃G›L") {
                dismiss(); _ = store.focusPane(.direction(.right))
            },
            command("next-pane", "Focus Next Pane", "Move focus through the pane tree", "⌥⌘→ · ⌃G›N") {
                dismiss(); store.focusNextPane()
            },
            command("previous-pane", "Focus Previous Pane", "Move focus backward through the pane tree", "⌥⌘← · ⌃G›P") {
                dismiss(); store.focusNextPane(reverse: true)
            },
            command("resize-left", "Move Divider Left", "Resize the nearest horizontal split", "⌃G›W›H") {
                dismiss(); _ = store.resizeFocusedPane(direction: .left)
            },
            command("resize-right", "Move Divider Right", "Resize the nearest horizontal split", "⌃G›W›L") {
                dismiss(); _ = store.resizeFocusedPane(direction: .right)
            },
            command("resize-down", "Move Divider Down", "Resize the nearest vertical split", "⌃G›W›J") {
                dismiss(); _ = store.resizeFocusedPane(direction: .down)
            },
            command("resize-up", "Move Divider Up", "Resize the nearest vertical split", "⌃G›W›U") {
                dismiss(); _ = store.resizeFocusedPane(direction: .up)
            },
            command("equalize-panes", "Equalize Pane Sizes", "Balance every split using visible pane weights", "⌃G›S›E") {
                dismiss(); store.equalizePaneSplits()
            },
            command("files", "Reveal Files pane", "Browse the selected worktree", "") {
                dismiss(); store.revealPane(.files)
            },
            command("editor", "Reveal Editor pane", "Edit UTF-8 files inside the worktree", "") {
                dismiss(); store.revealPane(.editor(EditorPaneState()))
            },
            command("terminal", "Reveal Terminal pane", "Run Shell, Codex, Claude, or Gemini", "⌘J") {
                dismiss(); store.revealPane(.terminal(TerminalPaneState(agent: store.selectedAgent)))
            },
            command("diff", "Reveal Diff pane", "Inspect uncommitted Git changes", "") {
                dismiss(); store.revealPane(.diff)
            },
            command("logs", "Reveal Logs pane", "Inspect command and verification output", "") {
                dismiss(); store.revealPane(.logs)
            },
            command("evidence", "Reveal Evidence pane", "Inspect recorded check evidence", "") {
                dismiss(); store.revealPane(.evidence)
            },
            command("proof", "Reveal Proof pane", "Inspect blockers and completion state", "⌘P") {
                dismiss(); store.revealPane(.proof)
            }
        ]
    }

    private var primaryActionDetail: String {
        guard store.canPerformPrimaryVerificationAction else {
            return store.primaryVerificationActionHint
        }
        return switch store.selectedVerificationPlanState {
        case .needsPlan: "Ask an AI agent to define checks without implementing"
        case .reviewRequired: "Inspect and approve the proposed verification plan"
        case .approved: "Execute every approved deterministic check"
        case .unavailable: "Verification state is unavailable"
        }
    }

    private var startActionDetail: String {
        guard let laneID = store.focusedTerminalLaneID else {
            return "Reveal or focus a Terminal pane first"
        }
        return store.sessionStartUnavailableReason(laneID: laneID)
            ?? "Launch the selected agent in the focused Terminal pane"
    }

    private var newTaskActionDetail: String {
        if store.isDemo { return "Demo screen keeps its task list fixed" }
        if store.isLoading { return "Wait until the workspace finishes loading" }
        if store.isCommandRunning || store.isProvisioning {
            return "Wait until the current workspace command finishes"
        }
        if store.isNewTaskPresented { return "The New Task sheet is already open" }
        return "Create an isolated worktree task"
    }

    private var closePaneActionDetail: String {
        if store.workbench.layout.root.orderedLeafIDs.count <= 1 {
            return "Split the workbench before closing a pane"
        }
        if store.isCommandRunning || store.isProvisioning {
            return "Wait until the current workspace command finishes"
        }
        return "Keeps active sessions and dirty files safe"
    }

    private var matchingCommands: [CommandItem] {
        guard !normalizedQuery.isEmpty else { return commands }
        return commands.filter {
            "\($0.title) \($0.detail)".localizedCaseInsensitiveContains(normalizedQuery)
        }
    }

    private var matchingFiles: [WorktreeFileEntry] {
        guard !normalizedQuery.isEmpty else { return [] }
        return store.workbench.fileEntries.lazy
            .filter { $0.kind == .file && $0.relativePath.localizedCaseInsensitiveContains(normalizedQuery) }
            .prefix(24)
            .map { $0 }
    }

    private var matchingTasks: [WorkspaceTask] {
        guard !normalizedQuery.isEmpty else { return [] }
        return store.tasks.filter { task in
            "\(task.slug) \(task.branch ?? "") \(task.workingDirectory.path)"
                .localizedCaseInsensitiveContains(normalizedQuery)
        }
    }

    private var selectableResultIDs: [String] {
        matchingCommands.filter(\.enabled).map { commandResultID($0) }
            + matchingTasks.map { taskResultID($0) }
            + matchingFiles.map { fileResultID($0) }
    }

    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ZStack {
            DesignTokens.surfaceTerminal.opacity(0.82)
                .ignoresSafeArea()
                .onTapGesture { store.isPalettePresented = false }
                .mountOnlyMotion(duration: MotionTokens.overlayBackdrop, rise: 0)

            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(DesignTokens.textTertiary)
                    TextField("Search commands, tasks, or files", text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: DesignTokens.bodySize, design: .monospaced))
                        .foregroundStyle(DesignTokens.textStrong)
                        .focused($searchFocused)
                        .onSubmit(performSelectedResult)
                        .onKeyPress(.downArrow) {
                            moveSelection(.next)
                            return .handled
                        }
                        .onKeyPress(.upArrow) {
                            moveSelection(.previous)
                            return .handled
                        }
                    Text("COMMAND / TASK / FILE")
                        .font(.system(size: DesignTokens.labelSize, weight: .semibold, design: .monospaced))
                        .tracking(1.4)
                    Text("ESC")
                }
                .foregroundStyle(DesignTokens.textTertiary)
                .padding(DesignTokens.space3)

                TokenDivider()
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            if !matchingCommands.isEmpty {
                                paletteSection("COMMANDS")
                                ForEach(matchingCommands) { item in
                                    paletteCommand(item)
                                }
                            }
                            if !matchingTasks.isEmpty {
                                paletteSection("TASKS")
                                ForEach(matchingTasks) { task in
                                    paletteTask(task)
                                }
                            }
                            if !matchingFiles.isEmpty {
                                paletteSection("FILES")
                                ForEach(matchingFiles) { file in
                                    paletteFile(file)
                                }
                            }
                            if matchingCommands.isEmpty && matchingTasks.isEmpty && matchingFiles.isEmpty {
                                Text("No command, task, or file matches ‘\(normalizedQuery)’")
                                    .font(.system(size: DesignTokens.bodySize))
                                    .foregroundStyle(DesignTokens.textSecondary)
                                    .frame(maxWidth: .infinity, minHeight: DesignTokens.rowHeight * 2, alignment: .leading)
                                    .padding(.horizontal, DesignTokens.space3)
                            }
                        }
                    }
                    .onChange(of: selectedResultID) { _, resultID in
                        guard let resultID else { return }
                        proxy.scrollTo(resultID, anchor: .center)
                    }
                }
                .frame(maxHeight: 460)
            }
            .frame(width: DesignTokens.paletteWidth)
            .background(DesignTokens.surfaceRaised)
            .overlay {
                RoundedRectangle(cornerRadius: DesignTokens.overlayRadius)
                    .stroke(DesignTokens.lineControl, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.overlayRadius))
            .mountOnlyMotion(duration: MotionTokens.overlaySheet)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("명령 팔레트")
            .onAppear {
                selectedResultID = selectableResultIDs.first
                DispatchQueue.main.async { searchFocused = true }
            }
            .onChange(of: query) { _, _ in
                selectedResultID = selectableResultIDs.first
            }
        }
    }

    private func command(
        _ id: String,
        _ title: String,
        _ detail: String,
        _ shortcut: String,
        enabled: Bool = true,
        action: @escaping () -> Void
    ) -> CommandItem {
        CommandItem(id: id, title: title, detail: detail, shortcut: shortcut, enabled: enabled, action: action)
    }

    private func paletteCommand(_ item: CommandItem) -> some View {
        let resultID = commandResultID(item)
        let selected = item.enabled && selectedResultID == resultID
        return Button(action: item.action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .foregroundStyle(item.enabled ? DesignTokens.textPrimary : DesignTokens.textDisabled)
                    Text(item.detail)
                        .font(.system(size: DesignTokens.metaSize))
                        .foregroundStyle(DesignTokens.textTertiary)
                }
                Spacer()
                Text(item.shortcut)
                    .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .padding(.horizontal, DesignTokens.space3)
            .frame(minHeight: DesignTokens.rowHeight)
            .contentShape(Rectangle())
            .background(selected ? DesignTokens.surfaceSelected : Color.clear)
        }
        .buttonStyle(.plain)
        .disabled(!item.enabled)
        .id(resultID)
        .onHover { hovering in
            if hovering, item.enabled { selectedResultID = resultID }
        }
        .accessibilityValue(selected ? "선택됨" : (item.enabled ? "" : "사용 불가"))
        .accessibilityHint(item.detail)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .overlay(alignment: .bottom) { TokenDivider() }
    }

    private func paletteTask(_ task: WorkspaceTask) -> some View {
        let resultID = taskResultID(task)
        let selected = selectedResultID == resultID
        return Button {
            dismiss()
            store.select(task)
        } label: {
            HStack(spacing: DesignTokens.space2) {
                Text(task.slug)
                    .font(.system(size: DesignTokens.rowSize, weight: .medium, design: .monospaced))
                    .foregroundStyle(DesignTokens.textPrimary)
                    .lineLimit(1)
                Spacer()
                Text(task.branch ?? task.health.rawValue.uppercased())
                    .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
                    .lineLimit(1)
            }
            .padding(.horizontal, DesignTokens.space3)
            .frame(minHeight: DesignTokens.rowHeight)
            .contentShape(Rectangle())
            .background(selected ? DesignTokens.surfaceSelected : Color.clear)
        }
        .buttonStyle(.plain)
        .id(resultID)
        .onHover { hovering in
            if hovering { selectedResultID = resultID }
        }
        .accessibilityLabel("작업 \(task.slug) 열기")
        .accessibilityValue(selected ? "선택됨" : "")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .overlay(alignment: .bottom) { TokenDivider() }
    }

    private func paletteFile(_ file: WorktreeFileEntry) -> some View {
        let resultID = fileResultID(file)
        let selected = selectedResultID == resultID
        return Button {
            dismiss()
            store.openFile(file.relativePath)
        } label: {
            HStack(spacing: DesignTokens.space2) {
                Image(systemName: "doc.text")
                    .foregroundStyle(DesignTokens.textTertiary)
                Text(file.relativePath)
                    .font(.system(size: DesignTokens.rowSize, design: .monospaced))
                    .foregroundStyle(DesignTokens.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
            }
            .padding(.horizontal, DesignTokens.space3)
            .frame(minHeight: DesignTokens.rowHeight)
            .contentShape(Rectangle())
            .background(selected ? DesignTokens.surfaceSelected : Color.clear)
        }
        .buttonStyle(.plain)
        .id(resultID)
        .onHover { hovering in
            if hovering { selectedResultID = resultID }
        }
        .accessibilityValue(selected ? "선택됨" : "")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .overlay(alignment: .bottom) { TokenDivider() }
    }

    private func paletteSection(_ title: String) -> some View {
        Text(title)
            .font(.system(size: DesignTokens.labelSize, weight: .semibold, design: .monospaced))
            .tracking(1.2)
            .foregroundStyle(DesignTokens.textTertiary)
            .padding(.horizontal, DesignTokens.space3)
            .frame(maxWidth: .infinity, minHeight: DesignTokens.rowHeight, alignment: .leading)
            .background(DesignTokens.surfaceBar)
    }

    private func moveSelection(_ direction: CommandPaletteNavigation.Direction) {
        selectedResultID = CommandPaletteNavigation.move(
            selection: selectedResultID,
            orderedIDs: selectableResultIDs,
            direction: direction
        )
    }

    private func performSelectedResult() {
        guard let resultID = selectedResultID ?? selectableResultIDs.first else { return }
        if let command = matchingCommands.first(where: { commandResultID($0) == resultID && $0.enabled }) {
            command.action()
        } else if let task = matchingTasks.first(where: { taskResultID($0) == resultID }) {
            dismiss()
            store.select(task)
        } else if let file = matchingFiles.first(where: { fileResultID($0) == resultID }) {
            dismiss()
            store.openFile(file.relativePath)
        }
    }

    private func commandResultID(_ item: CommandItem) -> String { "command:\(item.id)" }
    private func taskResultID(_ task: WorkspaceTask) -> String { "task:\(task.id)" }
    private func fileResultID(_ file: WorktreeFileEntry) -> String { "file:\(file.relativePath)" }

    private func dismiss() {
        store.isPalettePresented = false
    }
}

private struct LoadingOverlay: View {
    var body: some View {
        VStack(spacing: DesignTokens.space3) {
            ProgressView()
                .controlSize(.small)
            Text("gdm 작업 상태를 읽는 중")
                .font(.system(size: DesignTokens.bodySize))
        }
        .foregroundStyle(DesignTokens.textPrimary)
        .padding(DesignTokens.space5)
        .background(DesignTokens.surfaceRaised)
        .overlay {
            RoundedRectangle(cornerRadius: DesignTokens.overlayRadius)
                .stroke(DesignTokens.lineControl, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.overlayRadius))
        .accessibilityLabel("작업 상태 로딩 중")
    }
}

private struct ShortcutCommands: View {
    @ObservedObject var store: WorkspaceStore
    let compact: Bool

    var body: some View {
        Group {
            Button("") { store.presentNewTask() }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(!store.canPresentNewTask)
            Button("") {
                store.revealPane(.terminal(TerminalPaneState(agent: store.selectedAgent)))
            }.keyboardShortcut("j", modifiers: .command)
            Button("") {
                store.isPalettePresented = false
                store.startFocusedSession()
            }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!store.canStartFocusedSession || store.isNewTaskPresented || store.isLoading)
            Button("") {
                store.focusedRegion = .tasks
                store.isTaskRailVisible = true
            }.keyboardShortcut("l", modifiers: .command)
            Button("") {
                store.revealPane(.proof)
            }.keyboardShortcut("p", modifiers: .command)
            Button("") { store.saveFocusedFile() }
                .keyboardShortcut("s", modifiers: .command)
            Button("") { store.splitPane(store.workbench.focusedPaneID, axis: .horizontal) }
                .keyboardShortcut("d", modifiers: .command)
            Button("") { store.splitPane(store.workbench.focusedPaneID, axis: .vertical) }
                .keyboardShortcut("d", modifiers: [.command, .shift])
            Button("") { store.closePane(store.workbench.focusedPaneID) }
                .keyboardShortcut("k", modifiers: [.command, .shift])
                .disabled(!store.canCloseFocusedPane)
            Button("") { store.focusNextPane(reverse: true) }
                .keyboardShortcut(.leftArrow, modifiers: [.option, .command])
            Button("") { store.focusNextPane() }
                .keyboardShortcut(.rightArrow, modifiers: [.option, .command])
            Button("") { store.toggleTasks() }
                .keyboardShortcut("[", modifiers: .command)
            Button("") { store.toggleProof(compact: compact) }
                .keyboardShortcut("]", modifiers: .command)
            Button("") {
                store.areBlockersPresented = true
                if compact { store.compactPane = .proof }
            }.keyboardShortcut("w", modifiers: [.command, .shift])
            Button("") { store.isPalettePresented = false }
                .keyboardShortcut(.escape, modifiers: [])
        }
        .frame(width: 0, height: 0)
        .opacity(0)
        .accessibilityHidden(true)
    }
}

@MainActor
private func presentRepositoryPicker(for store: WorkspaceStore) {
    let panel = NSOpenPanel()
    panel.title = "Open Git Repository"
    panel.prompt = "Open"
    panel.message = "Gidem에서 사용할 Git repository의 최상위 폴더를 선택하세요."
    panel.directoryURL = store.repositoryURL
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = false
    panel.begin { response in
        guard response == .OK, let url = panel.url else { return }
        store.switchRepository(to: url)
    }
}

private struct NewTaskSheet: View {
    @ObservedObject var store: WorkspaceStore
    let maximumHeight: CGFloat
    let dismiss: () -> Void
    @Environment(\.gdmReduceMotion) private var reduceMotion
    @State private var slug = ""
    @State private var brief = ""
    @State private var required = "기존 동작 보존"
    @State private var forbidden = "자동 커밋"
    @State private var risk = "medium"
    @State private var didSubmit = false
    @State private var dismissGeneration = 0

    init(store: WorkspaceStore, maximumHeight: CGFloat, dismiss: @escaping () -> Void) {
        self.store = store
        self.maximumHeight = maximumHeight
        self.dismiss = dismiss

        guard store.presentsNewTaskProvisioningInDemo else { return }
        _slug = State(initialValue: "text-overlap-qa")
        _brief = State(
            initialValue: "워크트리를 만드는 동안 최소 창에서도 긴 작업 목표와 진행 상태가 서로 겹치지 않는지 확인한다"
        )
        _required = State(
            initialValue: "기존 저장소와 실행 중인 세션을 건드리지 않고 긴 필수 조건을 온전히 읽을 수 있어야 한다"
        )
        _forbidden = State(
            initialValue: "자동 커밋과 기존 작업 변경을 금지하고 화면 텍스트를 다른 행 위에 겹치지 않는다"
        )
        _didSubmit = State(initialValue: true)
    }

    private var canCreate: Bool {
        WorktreeService.isValidSlug(slug)
            && [brief, required, forbidden].allSatisfy {
                !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: DesignTokens.space4) {
                        VStack(alignment: .leading, spacing: DesignTokens.space1) {
                            Text("새 작업 계약")
                                .font(.system(size: DesignTokens.titleSize, weight: .semibold))
                                .foregroundStyle(DesignTokens.textStrong)
                            Text("작업을 시작하기 전에 완료 조건과 금지 조건부터 고정합니다.")
                                .font(.system(size: DesignTokens.bodySize))
                                .foregroundStyle(DesignTokens.textSecondary)
                        }

                        field(
                            "SLUG",
                            placeholder: "fix-login-regression",
                            text: $slug,
                            hint: "소문자 영문, 숫자, 하이픈만 사용해 2~51자로 입력하세요."
                        )
                        if !slug.isEmpty && !WorktreeService.isValidSlug(slug) {
                            Text("소문자 영문·숫자·하이픈 2~51자로 입력하세요.")
                                .font(.system(size: DesignTokens.metaSize))
                                .foregroundStyle(DesignTokens.blocked)
                                .accessibilityLabel("Slug 오류: 소문자 영문, 숫자, 하이픈 2자에서 51자로 입력하세요.")
                        }
                        field(
                            "작업 목표",
                            placeholder: "만료된 세션을 한 번만 갱신한다",
                            text: $brief,
                            multiline: true,
                            hint: "이 작업에서 달성할 결과를 입력하세요."
                        )
                        field(
                            "필수 조건",
                            placeholder: "기존 로그인 동작 보존",
                            text: $required,
                            multiline: true,
                            hint: "완료 후 반드시 지켜져야 하는 조건을 입력하세요."
                        )
                        field(
                            "금지 조건",
                            placeholder: "자동 커밋",
                            text: $forbidden,
                            multiline: true,
                            hint: "작업 중 하지 않아야 하는 행동을 입력하세요."
                        )

                        VStack(alignment: .leading, spacing: DesignTokens.space2) {
                            SectionLabel(title: "Dedicated worktree")
                            Text("branch · gdm/\(slug.isEmpty ? "<slug>" : slug)")
                            Text(store.proposedWorktreePath(for: slug))
                                .lineLimit(2)
                                .truncationMode(.middle)
                        }
                        .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                        .foregroundStyle(DesignTokens.textSecondary)

                        VStack(alignment: .leading, spacing: DesignTokens.space2) {
                            SectionLabel(title: "Risk")
                            Picker("위험도", selection: $risk) {
                                Text("Low").tag("low")
                                Text("Medium").tag("medium")
                                Text("High · independent audit").tag("high")
                            }
                            .pickerStyle(.segmented)
                            .disabled(store.isProvisioning)
                        }

                        if didSubmit {
                            VStack(alignment: .leading, spacing: DesignTokens.space2) {
                                SectionLabel(title: "Creation progress")
                                ProvisioningStepRow(
                                    title: "Worktree",
                                    presentation: provisioningPresentation(for: .worktree)
                                )
                                ProvisioningStepRow(
                                    title: "GDM contract",
                                    presentation: provisioningPresentation(for: .gdmContract)
                                )
                                ProvisioningStepRow(
                                    title: "Ready",
                                    presentation: provisioningPresentation(for: .ready)
                                )
                            }
                            .id("new-task-creation-progress")
                        }
                    }
                    .padding(DesignTokens.space5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollBounceBehavior(.basedOnSize)
                .onAppear {
                    guard didSubmit else { return }
                    revealCreationProgress(using: proxy)
                }
                .onChange(of: didSubmit) { _, submitted in
                    guard submitted else { return }
                    revealCreationProgress(using: proxy)
                }
                .onChange(of: store.provisioningStep) { _, step in
                    guard didSubmit, step != nil else { return }
                    revealCreationProgress(using: proxy)
                }
            }

            TokenDivider()

            HStack {
                Spacer()
                Button("취소") { dismiss() }
                    .buttonStyle(OperationalButtonStyle())
                    .disabled(store.isProvisioning)
                    .keyboardShortcut(.cancelAction)
                Button(
                    store.provisioningStep == .ready
                        ? "Ready"
                        : (store.isProvisioning ? "Creating worktree…" : "Worktree와 계약 만들기")
                ) {
                    didSubmit = true
                    store.createTask(slug: slug, brief: brief, required: required, forbidden: forbidden, risk: risk)
                }
                .buttonStyle(OperationalButtonStyle(emphasized: true))
                .disabled(!canCreate || store.isProvisioning || (didSubmit && store.provisioningStep == .ready))
                .keyboardShortcut(.defaultAction)
                .help(canCreate ? "독립 worktree와 검증 계약을 만듭니다." : "필수 입력과 slug 형식을 확인하세요.")
            }
            .padding(.horizontal, DesignTokens.space5)
            .padding(.vertical, DesignTokens.space3)
            .background(DesignTokens.surfaceApp)
            .accessibilityIdentifier("new-task-actions")
        }
        .frame(width: DesignTokens.paletteWidth)
        .frame(maxHeight: maximumHeight)
        .background(DesignTokens.surfaceApp)
        .overlay {
            RoundedRectangle(cornerRadius: DesignTokens.overlayRadius)
                .stroke(DesignTokens.lineControl, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.overlayRadius))
        .preferredColorScheme(.dark)
        .mountOnlyMotion(duration: MotionTokens.overlaySheet)
        .onChange(of: store.provisioningStep) { _, newStep in
            guard didSubmit, newStep == .ready else { return }
            dismissAfterReadySettles()
        }
    }

    private func field(
        _ label: String,
        placeholder: String,
        text: Binding<String>,
        multiline: Bool = false,
        hint: String
    ) -> some View {
        VStack(alignment: .leading, spacing: DesignTokens.space2) {
            SectionLabel(title: label)
                .accessibilityHidden(true)
            TextField(placeholder, text: text, axis: multiline ? .vertical : .horizontal)
                .textFieldStyle(.plain)
                .font(.system(size: DesignTokens.bodySize))
                .foregroundStyle(DesignTokens.textPrimary)
                .lineLimit(multiline ? 3 : 1)
                .padding(.horizontal, DesignTokens.space3)
                .frame(minHeight: DesignTokens.rowHeight)
                .background(DesignTokens.surfaceTerminal)
                .overlay {
                    RoundedRectangle(cornerRadius: DesignTokens.controlRadius)
                        .stroke(DesignTokens.lineControl, lineWidth: 1)
                }
                .disabled(store.isProvisioning)
                .accessibilityLabel(label)
                .accessibilityHint(hint)
        }
    }

    private func revealCreationProgress(using proxy: ScrollViewProxy) {
        DispatchQueue.main.async {
            withAnimation(MotionAnimations.state(reduceMotion: reduceMotion)) {
                proxy.scrollTo("new-task-creation-progress", anchor: .bottom)
            }
        }
    }

    private func provisioningPresentation(
        for step: WorktreeProvisioningStep
    ) -> ProvisioningStepPresentation {
        guard let current = store.provisioningStep else { return .pending }
        let currentRank = current.order
        let rowRank = step.order

        if current == .ready || rowRank < currentRank { return .done }
        if rowRank > currentRank { return .pending }
        if store.isProvisioning, step != .ready { return .active }
        return step == .ready ? .done : .failed
    }

    private func dismissAfterReadySettles() {
        dismissGeneration += 1
        let currentGeneration = dismissGeneration
        guard !reduceMotion else {
            dismiss()
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + MotionTokens.settle) {
            guard dismissGeneration == currentGeneration else { return }
            dismiss()
        }
    }
}

private enum ProvisioningStepPresentation: Equatable {
    case pending
    case active
    case done
    case failed

    var glyph: String {
        switch self {
        case .pending: "○"
        case .active: "◐"
        case .done: "✓"
        case .failed: "✕"
        }
    }

    var label: String {
        switch self {
        case .pending: "PENDING"
        case .active: "IN PROGRESS"
        case .done: "DONE"
        case .failed: "FAILED"
        }
    }

    var tone: SignalTone {
        switch self {
        case .pending: .neutral
        case .active: .active
        case .done: .neutral
        case .failed: .blocked
        }
    }
}

private struct ProvisioningStepRow: View {
    let title: String
    let presentation: ProvisioningStepPresentation

    var body: some View {
        HStack(spacing: DesignTokens.space2) {
            SignalMarker(
                glyph: presentation.glyph,
                label: presentation.label,
                tone: presentation.tone,
                pulses: presentation == .active
            )
            Text(title)
                .font(.system(size: DesignTokens.bodySize, weight: .medium))
                .foregroundStyle(DesignTokens.textPrimary)
            Spacer()
        }
        .frame(minHeight: DesignTokens.rowHeight)
        .overlay(alignment: .bottom) { TokenDivider() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(presentation.label)
    }
}
