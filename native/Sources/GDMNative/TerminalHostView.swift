import AppKit
import SwiftUI

struct TerminalHostView: View {
    @ObservedObject var store: WorkspaceStore
    @State private var terminalFocusRequest = 0

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader {
                Text("PTY · \(store.selectedSlug ?? "NO TASK")")
                    .font(.system(size: DesignTokens.metaSize, weight: .medium, design: .monospaced))
                    .foregroundStyle(DesignTokens.textStrong)
                Spacer()
                TerminalAgentSelector(
                    store: store,
                    disabled: store.isDemo || sessionIsActive
                ) {
                    terminalFocusRequest += 1
                }

                if sessionIsActive {
                    Button("Stop") { store.stopSelectedSession() }
                        .buttonStyle(OperationalButtonStyle())
                        .disabled(store.isDemo)
                } else {
                    Button("Start \(store.selectedAgent.rawValue)") { store.startSelectedSession() }
                        .buttonStyle(OperationalButtonStyle(emphasized: true))
                        .disabled(store.isDemo || store.selectedTask?.health != .ready)
                }
            }
            .zIndex(20)

            if store.isDemo {
                StaticTerminalTranscript(text: store.consoleText)
            } else if let session = store.selectedSession {
                LiveTerminalSurface(session: session, focusRequest: terminalFocusRequest)
            } else if let task = store.selectedTask {
                TerminalEmptyState(task: task, agent: store.selectedAgent) {
                    store.startSelectedSession()
                }
            } else {
                Text("작업을 선택하면 PTY 세션을 시작할 수 있습니다.")
                    .font(.system(size: DesignTokens.bodySize))
                    .foregroundStyle(DesignTokens.textSecondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(DesignTokens.surfaceTerminal)
        .contentShape(Rectangle())
        .onTapGesture { store.focusedRegion = .terminal }
        .paneFocused(store.focusedRegion == .terminal)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("대화형 PTY 세션")
    }

    private var sessionIsActive: Bool {
        if let session = store.selectedSession { return session.state.isActive }
        if store.isDemo,
           let taskID = store.selectedTask?.id,
           let item = store.agentActivityItems.first(where: {
               $0.taskID == taskID && $0.agent == store.selectedAgent
           }) {
            return item.state == .starting
                || item.state == .active
                || item.state == .waiting
                || item.state == .stopping
        }
        return store.isDemo
            && store.selectedTask?.location.registryRecord?.lastSession?.outcome == .active
    }

}

private struct LiveTerminalSurface: View {
    @ObservedObject var session: TerminalSession
    let focusRequest: Int

    var body: some View {
        HostedTerminalNSView(terminalView: session.terminalView, focusRequest: focusRequest)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(DesignTokens.surfaceTerminal)
            .accessibilityLabel("\(session.specification.agent.rawValue) terminal")
    }
}

private struct HostedTerminalNSView: NSViewRepresentable {
    let terminalView: NSView
    let focusRequest: Int

    func makeNSView(context: Context) -> NSView {
        let container = NSView(frame: .zero)
        attach(to: container)
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        attach(to: container)
    }

    static func dismantleNSView(_ container: NSView, coordinator: Void) {
        for view in container.subviews {
            view.removeFromSuperview()
        }
    }

    private func attach(to container: NSView) {
        if terminalView.superview !== container {
            terminalView.removeFromSuperview()
            terminalView.frame = container.bounds
            terminalView.autoresizingMask = [.width, .height]
            container.addSubview(terminalView)
        }
        terminalView.frame = container.bounds
        DispatchQueue.main.async {
            terminalView.window?.makeFirstResponder(terminalView)
        }
    }
}

private struct TerminalEmptyState: View {
    let task: WorkspaceTask
    let agent: AgentKind
    let start: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.space3) {
            SignalMarker(
                glyph: task.health == .ready ? "●" : "⊘",
                label: task.health.rawValue.uppercased(),
                tone: task.health == .ready ? .neutral : .blocked
            )
            Text(task.workingDirectory.path)
                .font(.system(size: DesignTokens.terminalSize, design: .monospaced))
                .foregroundStyle(DesignTokens.textPrimary)
                .textSelection(.enabled)
            Text(task.statusMessage ?? "\(agent.rawValue)를 이 worktree의 interactive PTY에서 실행합니다.")
                .font(.system(size: DesignTokens.bodySize))
                .foregroundStyle(DesignTokens.textSecondary)
            Button("Start \(agent.rawValue)", action: start)
                .buttonStyle(OperationalButtonStyle(emphasized: true))
                .disabled(task.health != .ready)
        }
        .padding(DesignTokens.space5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
