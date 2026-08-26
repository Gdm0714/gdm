import AppKit
import SwiftUI

enum TerminalPaneSessionResolver {
    static func resolve<Session>(
        laneID: UUID?,
        laneSession: Session?,
        selectedSession: Session?
    ) -> Session? {
        laneID == nil ? selectedSession : laneSession
    }
}

struct TerminalHostView: View {
    @ObservedObject var store: WorkspaceStore
    let laneID: UUID?
    @State private var terminalFocusRequest = 0

    init(store: WorkspaceStore, laneID: UUID? = nil) {
        self.store = store
        self.laneID = laneID
    }

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader {
                Text("PTY · \(store.selectedSlug ?? "NO TASK")")
                    .font(.system(size: DesignTokens.metaSize, weight: .medium, design: .monospaced))
                    .foregroundStyle(DesignTokens.textStrong)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                TerminalAgentSelector(
                    store: store,
                    laneID: laneID,
                    compact: laneID != nil,
                    disabled: store.isDemo || sessionIsActive
                ) {
                    terminalFocusRequest += 1
                }

                if sessionIsActive {
                    Button {
                        store.stopSelectedSession(laneID: laneID)
                    } label: {
                        if laneID == nil {
                            Text("Stop").lineLimit(1)
                        } else {
                            Image(systemName: "stop.fill")
                                .accessibilityHidden(true)
                        }
                    }
                        .buttonStyle(OperationalButtonStyle())
                        .disabled(store.isDemo)
                        .help("Stop \(selectedAgent.displayName)")
                        .accessibilityLabel("Stop \(selectedAgent.displayName)")
                } else {
                    Button(action: startSession) {
                        if laneID == nil {
                            Text(startActionLabel).lineLimit(1)
                        } else {
                            Image(systemName: "play.fill")
                                .accessibilityHidden(true)
                        }
                    }
                        .buttonStyle(OperationalButtonStyle(emphasized: true))
                        .disabled(startDisabled)
                        .help(startHelp)
                        .accessibilityLabel(startActionLabel)
                        .accessibilityHint(isFocusedPane ? "Command Return" : "Focus this pane, then press Command Return")
                }
            }
            .zIndex(20)

            if store.isDemo {
                StaticTerminalTranscript(text: store.terminalTranscript(laneID: laneID))
            } else if let session = selectedSession {
                LiveTerminalSurface(
                    session: session,
                    focusRequest: terminalFocusRequest,
                    focused: isFocusedPane,
                    onHostAction: { [weak store, paneID = paneID] action in
                        guard let store, let paneID else { return false }
                        return store.handleTerminalHostAction(action, paneID: paneID)
                    }
                )
            } else if let task = store.selectedTask {
                TerminalEmptyState(
                    task: task,
                    agent: selectedAgent,
                    plannerAgent: store.verificationPlannerAgent,
                    planState: store.selectedVerificationPlanState,
                    shortcutHint: isFocusedPane ? "⌘↩" : nil,
                    startDisabled: startDisabled,
                    startHelp: startHelp,
                    start: startSession
                )
            } else {
                Text("작업을 선택하면 PTY 세션을 시작할 수 있습니다.")
                    .font(.system(size: DesignTokens.bodySize))
                    .foregroundStyle(DesignTokens.textSecondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(DesignTokens.surfaceTerminal)
        .contentShape(Rectangle())
        .onTapGesture {
            store.focusedRegion = .terminal
            if let paneID { store.focusPane(paneID) }
            terminalFocusRequest += 1
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("대화형 PTY 세션")
    }

    private var sessionIsActive: Bool {
        if let session = selectedSession { return session.state.isActive }
        if store.isDemo,
           let taskID = store.selectedTask?.id,
           let item = store.agentActivityItems.first(where: {
               $0.taskID == taskID
                    && $0.agent == selectedAgent
                    && (laneID == nil || $0.laneID == laneID.map { $0.uuidString.lowercased() })
           }) {
            return item.state == .starting
                || item.state == .active
                || item.state == .waiting
                || item.state == .needsYou
                || item.state == .handingOff
                || item.state == .verifying
                || item.state == .stopping
        }
        return store.isDemo
            && store.selectedTask?.location.registryRecord?.lastSession?.outcome == .active
    }

    private var selectedSession: TerminalSession? {
        TerminalPaneSessionResolver.resolve(
            laneID: laneID,
            laneSession: laneID.flatMap(store.session(for:)),
            selectedSession: store.selectedSession
        )
    }

    private var selectedAgent: AgentKind {
        laneID.map(store.agent(for:)) ?? store.selectedAgent
    }

    private var paneID: UUID? {
        guard let laneID else { return nil }
        return store.workbench.layout.root.leaves.first(where: {
            if case .terminal(let terminal) = $0.content { return terminal.laneID == laneID }
            return false
        })?.id
    }

    private var isFocusedPane: Bool {
        paneID == store.workbench.focusedPaneID
    }

    private var startHelp: String {
        if let laneID, let reason = store.sessionStartUnavailableReason(laneID: laneID) {
            return reason
        }
        return isFocusedPane
            ? "\(startActionLabel) · ⌘↩"
            : "\(startActionLabel) · focus this pane, then press ⌘↩"
    }

    private var startActionLabel: String {
        switch store.selectedVerificationPlanState {
        case .needsPlan: "Plan checks with \(store.verificationPlannerAgent?.displayName ?? "AI agent")"
        case .reviewRequired: "Revise checks with \(store.verificationPlannerAgent?.displayName ?? "AI agent")"
        case .approved, .unavailable: "Start \(selectedAgent.displayName)"
        }
    }

    private var startDisabled: Bool {
        guard let laneID else { return true }
        return !store.canStartSession(laneID: laneID)
    }

    private func startSession() {
        // The focus request is incremented before the session is created so
        // the newly mounted terminal accepts keyboard input immediately.
        terminalFocusRequest += 1
        store.startSelectedSession(laneID: laneID)
    }

}

private struct LiveTerminalSurface: View {
    @ObservedObject var session: TerminalSession
    let focusRequest: Int
    let focused: Bool
    let onHostAction: (TerminalHostAction) -> Bool

    var body: some View {
        HostedTerminalNSView(
            terminalView: session.terminalView,
            focusRequest: focusRequest,
            focused: focused
        )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(DesignTokens.surfaceTerminal)
            .accessibilityLabel("\(session.specification.agent.rawValue) terminal")
            .onAppear {
                session.setHostActionHandler(onHostAction)
            }
    }
}

private struct HostedTerminalNSView: NSViewRepresentable {
    let terminalView: NSView
    let focusRequest: Int
    let focused: Bool

    final class Coordinator {
        var lastFocusRequest: Int?
        var wasFocused = false
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        let container = TerminalClippingContainerView(frame: .zero)
        attach(to: container, requestFocus: focused, shouldOwnFocus: focused)
        context.coordinator.lastFocusRequest = focusRequest
        context.coordinator.wasFocused = focused
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        let shouldFocus = focused && (
            context.coordinator.lastFocusRequest != focusRequest
                || !context.coordinator.wasFocused
        )
        attach(to: container, requestFocus: shouldFocus, shouldOwnFocus: focused)
        context.coordinator.lastFocusRequest = focusRequest
        context.coordinator.wasFocused = focused
    }

    static func dismantleNSView(_ container: NSView, coordinator: Coordinator) {
        for view in container.subviews {
            view.removeFromSuperview()
        }
    }

    private func attach(to container: NSView, requestFocus: Bool, shouldOwnFocus: Bool) {
        if terminalView.superview !== container {
            terminalView.removeFromSuperview()
            terminalView.frame = container.bounds
            terminalView.autoresizingMask = [.width, .height]
            container.addSubview(terminalView)
        }
        terminalView.frame = container.bounds
        if !shouldOwnFocus,
           let responderView = terminalView.window?.firstResponder as? NSView,
           (responderView === terminalView || responderView.isDescendant(of: terminalView)) {
            terminalView.window?.makeFirstResponder(nil)
        } else if requestFocus {
            DispatchQueue.main.async {
                terminalView.window?.makeFirstResponder(terminalView)
            }
        }
    }
}

final class TerminalClippingContainerView: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configureClipping()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configureClipping()
    }

    private func configureClipping() {
        wantsLayer = true
        layer?.masksToBounds = true
    }
}

private struct TerminalEmptyState: View {
    let task: WorkspaceTask
    let agent: AgentKind
    let plannerAgent: AgentKind?
    let planState: VerificationPlanState
    let shortcutHint: String?
    let startDisabled: Bool
    let startHelp: String
    let start: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.space3) {
            SignalMarker(
                glyph: statusGlyph,
                label: statusLabel,
                tone: statusTone
            )
            Text(task.workingDirectory.path)
                .font(.system(size: DesignTokens.terminalSize, design: .monospaced))
                .foregroundStyle(DesignTokens.textPrimary)
                .textSelection(.enabled)
            Text(task.statusMessage ?? detail)
                .font(.system(size: DesignTokens.bodySize))
                .foregroundStyle(DesignTokens.textSecondary)
            Button(action: start) {
                HStack(spacing: DesignTokens.space2) {
                    Text(actionLabel)
                    if let shortcutHint {
                        Text(shortcutHint)
                            .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                            .foregroundStyle(DesignTokens.textSecondary)
                    }
                }
            }
            .buttonStyle(OperationalButtonStyle(emphasized: true))
            .disabled(startDisabled)
            .help(startHelp)
            .accessibilityHint(startHelp)
        }
        .padding(DesignTokens.space5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var actionLabel: String {
        switch planState {
        case .needsPlan: "Plan checks with \(plannerAgent?.displayName ?? "AI agent")"
        case .reviewRequired: "Revise checks with \(plannerAgent?.displayName ?? "AI agent")"
        case .approved, .unavailable: "Start \(agent.rawValue)"
        }
    }
    private var detail: String {
        switch planState {
        case .needsPlan:
            "에이전트가 저장소를 읽고 검증 항목만 등록한 뒤 승인을 기다립니다."
        case .reviewRequired:
            "검증 항목이 준비됐습니다. Proof Rail에서 확인·승인하거나 에이전트에게 수정을 요청하세요."
        case .approved, .unavailable:
            "\(agent.rawValue)를 이 worktree의 interactive PTY에서 실행합니다."
        }
    }
    private var statusGlyph: String {
        if task.health != .ready { return "⊘" }
        return planState == .approved ? "●" : "○"
    }
    private var statusLabel: String {
        if task.health != .ready { return task.health.rawValue.uppercased() }
        return switch planState {
        case .needsPlan: "PLAN NEEDED"
        case .reviewRequired: "REVIEW REQUIRED"
        case .approved: "READY"
        case .unavailable: task.health.rawValue.uppercased()
        }
    }
    private var statusTone: SignalTone {
        if task.health != .ready { return .blocked }
        return switch planState {
        case .needsPlan, .reviewRequired: .attention
        case .approved, .unavailable: .neutral
        }
    }
}

private struct StaticTerminalTranscript: View {
    let text: String

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: DesignTokens.space1) {
                ForEach(Array(text.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                    Text(line.isEmpty ? " " : String(line))
                        .font(.system(size: DesignTokens.terminalSize, design: .monospaced))
                        .foregroundStyle(DesignTokens.textPrimary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(DesignTokens.space4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DesignTokens.surfaceTerminal)
    }
}
