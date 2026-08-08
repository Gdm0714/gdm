import SwiftUI

struct WorkspaceView: View {
    @ObservedObject var store: WorkspaceStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pendingTaskKey: String?
    @State private var contentOpacity = 1.0
    @State private var selectionGeneration = 0
    @State private var isAgentActivityPresented = false
    @State private var highlightedActivityAgent: AgentKind?

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
                            EmptyWorkspaceView { store.isNewTaskPresented = true }
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

                        NewTaskSheet(store: store, dismiss: dismissNewTask)
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
            .background(DesignTokens.surfaceApp)
            .overlayPreferenceValue(AgentActivityBoundsPreferenceKey.self) { anchor in
                GeometryReader { proxy in
                    if let anchor, isAgentActivityPresented {
                        let bounds = proxy[anchor]
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
                                dismiss: dismissAgentActivity
                            )
                            .frame(width: DesignTokens.agentActivityPopoverWidth)
                            .offset(x: popoverX, y: bounds.maxY + DesignTokens.space2)
                            .mountOnlyMotion(duration: MotionTokens.overlayPopover)
                        }
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
                ForEach(0..<3, id: \.self) { _ in
                    Circle()
                        .fill(DesignTokens.textDisabled)
                        .frame(width: DesignTokens.space3, height: DesignTokens.space3)
                }
            }
            .accessibilityHidden(true)

            Button { store.toggleTasks() } label: {
                Text(store.isTaskRailVisible ? "◀" : "▶")
                    .font(.system(size: DesignTokens.metaSize, design: .monospaced))
            }
            .buttonStyle(OperationalButtonStyle())
            .help("작업 목록 접기 · ⌘[")

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

            SignalMarker(
                glyph: compact ? "R" : "RISK",
                label: store.selectedWork?.contract.risk?.uppercased() ?? "LOW",
                tone: (store.selectedWork?.auditRequired ?? false) ? .blocked : .attention
            )

            Button {
                store.runVerification()
            } label: {
                Text(store.isCommandRunning ? "Working…" : (compact ? "Run  ⌘R" : "Run verification  ⌘R"))
                    .lineLimit(1)
            }
            .buttonStyle(OperationalButtonStyle())
            .keyboardShortcut("r", modifiers: .command)
            .disabled(store.selectedTask?.canMutate != true || store.isCommandRunning || store.isDemo)

            Button { store.refresh() } label: {
                Text("↻")
                    .font(.system(size: DesignTokens.bodySize, design: .monospaced))
            }
            .buttonStyle(OperationalButtonStyle())
            .disabled(store.isDemo)
            .help("상태 새로고침")

            Button { store.toggleProof() } label: {
                Text(store.isProofRailVisible ? "▶" : "◀")
                    .font(.system(size: DesignTokens.metaSize, design: .monospaced))
            }
            .buttonStyle(OperationalButtonStyle())
            .help("Proof Rail 접기 · ⌘]")
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
                Text("\(work.blockers.count) blockers")
                    .foregroundStyle(work.blockers.isEmpty ? DesignTokens.proven : DesignTokens.attention)
            }
            if !store.workspaceWarnings.isEmpty {
                Text("\(store.workspaceWarnings.count) workspace warnings")
                    .foregroundStyle(DesignTokens.attention)
            }
            Spacer()
            Text("FOCUS · \(store.focusedRegion.rawValue)")
                .foregroundStyle(DesignTokens.textSecondary)
            Text("⌘J terminal · ⌘L tasks · ⌘P proof")
        }
        .font(.system(size: DesignTokens.metaSize, design: .monospaced))
        .foregroundStyle(DesignTokens.textTertiary)
        .padding(.horizontal, DesignTokens.space3)
        .frame(height: DesignTokens.statusBarHeight)
        .background(DesignTokens.surfaceStatusBar)
        .overlay(alignment: .top) { TokenDivider() }
    }
}

private struct CommandPaletteView: View {
    @ObservedObject var store: WorkspaceStore

    var body: some View {
        ZStack {
            DesignTokens.surfaceTerminal.opacity(0.82)
                .ignoresSafeArea()
                .onTapGesture { store.isPalettePresented = false }
                .mountOnlyMotion(duration: MotionTokens.overlayBackdrop, rise: 0)

            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("COMMAND PALETTE")
                        .font(.system(size: DesignTokens.labelSize, weight: .semibold, design: .monospaced))
                        .tracking(1.4)
                    Spacer()
                    Text("ESC")
                }
                .foregroundStyle(DesignTokens.textTertiary)
                .padding(DesignTokens.space3)

                TokenDivider()
                paletteCommand("Run verification", shortcut: "⌘R") {
                    store.isPalettePresented = false
                    store.runVerification()
                }
                paletteCommand("New task and contract", shortcut: "⌘N") {
                    store.isPalettePresented = false
                    store.isNewTaskPresented = true
                }
                paletteCommand("Focus command session", shortcut: "⌘J") {
                    store.focusedRegion = .terminal
                    store.compactPane = .terminal
                    store.isPalettePresented = false
                }
                paletteCommand("Focus task list", shortcut: "⌘L") {
                    store.focusedRegion = .tasks
                    store.isTaskRailVisible = true
                    store.isPalettePresented = false
                }
                paletteCommand("Focus Proof Rail", shortcut: "⌘P") {
                    store.focusedRegion = .proof
                    store.isProofRailVisible = true
                    store.compactPane = .proof
                    store.isPalettePresented = false
                }
                paletteCommand("Explain completion blockers", shortcut: "⇧⌘W") {
                    store.areBlockersPresented = true
                    store.isProofRailVisible = true
                    store.compactPane = .proof
                    store.isPalettePresented = false
                }
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
        }
    }

    private func paletteCommand(_ title: String, shortcut: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).foregroundStyle(DesignTokens.textPrimary)
                Spacer()
                Text(shortcut)
                    .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .padding(.horizontal, DesignTokens.space3)
            .frame(minHeight: DesignTokens.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) { TokenDivider() }
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
            Button("") {
                store.focusedRegion = .terminal
                store.compactPane = .terminal
            }.keyboardShortcut("j", modifiers: .command)
            Button("") {
                store.focusedRegion = .tasks
                store.isTaskRailVisible = true
            }.keyboardShortcut("l", modifiers: .command)
            Button("") {
                store.focusedRegion = .proof
                store.isProofRailVisible = true
                if compact { store.compactPane = .proof }
            }.keyboardShortcut("p", modifiers: .command)
            Button("") { store.toggleTasks() }
                .keyboardShortcut("[", modifiers: .command)
            Button("") { store.toggleProof() }
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

private struct NewTaskSheet: View {
    @ObservedObject var store: WorkspaceStore
    let dismiss: () -> Void
    @Environment(\.gdmReduceMotion) private var reduceMotion
    @State private var slug = ""
    @State private var brief = ""
    @State private var required = "기존 동작 보존"
    @State private var forbidden = "자동 커밋"
    @State private var risk = "medium"
    @State private var didSubmit = false
    @State private var dismissGeneration = 0

    private var canCreate: Bool {
        [slug, brief, required, forbidden].allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.space4) {
            VStack(alignment: .leading, spacing: DesignTokens.space1) {
                Text("새 작업 계약")
                    .font(.system(size: DesignTokens.titleSize, weight: .semibold))
                    .foregroundStyle(DesignTokens.textStrong)
                Text("작업을 시작하기 전에 완료 조건과 금지 조건부터 고정합니다.")
                    .font(.system(size: DesignTokens.bodySize))
                    .foregroundStyle(DesignTokens.textSecondary)
            }

            field("SLUG", placeholder: "fix-login-regression", text: $slug)
            field("작업 목표", placeholder: "만료된 세션을 한 번만 갱신한다", text: $brief)
            field("필수 조건", placeholder: "기존 로그인 동작 보존", text: $required)
            field("금지 조건", placeholder: "자동 커밋", text: $forbidden)

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
            }

            HStack {
                Spacer()
                Button("취소") { dismiss() }
                    .buttonStyle(OperationalButtonStyle())
                    .disabled(store.isProvisioning)
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
            }
        }
        .padding(DesignTokens.space5)
        .frame(width: DesignTokens.paletteWidth)
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

    private func field(_ label: String, placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: DesignTokens.space2) {
            SectionLabel(title: label)
            TextField(placeholder, text: text)
                .textFieldStyle(.plain)
                .font(.system(size: DesignTokens.bodySize))
                .foregroundStyle(DesignTokens.textPrimary)
                .padding(.horizontal, DesignTokens.space3)
                .frame(minHeight: DesignTokens.rowHeight)
                .background(DesignTokens.surfaceTerminal)
                .overlay {
                    RoundedRectangle(cornerRadius: DesignTokens.controlRadius)
                        .stroke(DesignTokens.lineControl, lineWidth: 1)
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
    }
}
