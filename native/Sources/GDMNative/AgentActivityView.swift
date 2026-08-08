import AppKit
import SwiftUI

enum AgentActivityComposition: Equatable {
    case expanded(agents: [AgentKind])
    case compact(current: AgentKind, foldedCount: Int)

    static let stripAgents: [AgentKind] = [.codex, .claude, .gemini]
    static let popoverAgents: [AgentKind] = [.codex, .claude, .gemini, .shell]

    static func resolve(width: CGFloat, current: AgentKind) -> AgentActivityComposition {
        if MotionPolicy.usesExpandedAgentActivity(width: width) {
            return .expanded(agents: stripAgents)
        }
        let foldedCount = stripAgents.filter { $0 != current }.count
        return .compact(current: current, foldedCount: foldedCount)
    }
}

struct AgentActivityBoundsPreferenceKey: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil

    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = nextValue() ?? value
    }
}

struct AgentActivityView: View {
    @ObservedObject var store: WorkspaceStore
    let availableWidth: CGFloat
    @Binding var isPresented: Bool
    @Binding var highlightedAgent: AgentKind?

    var body: some View {
        activityStrip
            .anchorPreference(key: AgentActivityBoundsPreferenceKey.self, value: .bounds) { $0 }
            .zIndex(isPresented ? 100 : 0)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Agent Activity")
            .onAppear {
                if store.presentsAgentActivityPopoverInDemo {
                    present(store.selectedAgent)
                }
            }
    }

    @ViewBuilder
    private var activityStrip: some View {
        switch AgentActivityComposition.resolve(width: availableWidth, current: store.selectedAgent) {
        case .expanded(let agents):
            HStack(spacing: DesignTokens.space1) {
                ForEach(agents) { agent in
                    AgentActivityCell(
                        summary: store.agentActivitySummary(for: agent),
                        resolver: store.agentIconResolver,
                        showsName: false,
                        isCurrent: store.selectedAgent == agent
                    ) {
                        present(agent)
                    }
                }
            }
        case .compact(let current, let foldedCount):
            HStack(spacing: DesignTokens.space1) {
                AgentActivityCell(
                    summary: store.agentActivitySummary(for: current),
                    resolver: store.agentIconResolver,
                    showsName: true,
                    isCurrent: true
                ) {
                    present(current)
                }
                Button {
                    present(current)
                } label: {
                    Text("+\(foldedCount)")
                        .font(.system(size: DesignTokens.metaSize, weight: .medium, design: .monospaced))
                        .foregroundStyle(DesignTokens.textSecondary)
                        .frame(minWidth: DesignTokens.controlMinimumHeight, minHeight: DesignTokens.controlMinimumHeight)
                        .background(DesignTokens.surfaceHover)
                        .overlay {
                            RoundedRectangle(cornerRadius: DesignTokens.controlRadius)
                                .stroke(DesignTokens.lineControl, lineWidth: 1)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.controlRadius))
                }
                .buttonStyle(.plain)
                .help("모든 agent activity 보기")
                .accessibilityLabel("추가 agent \(foldedCount)개 보기")
            }
        }
    }

    private func present(_ agent: AgentKind) {
        highlightedAgent = agent
        isPresented = true
    }

}

struct AgentIconView: View {
    let agent: AgentKind
    let resolver: AgentIconResolver
    var size: CGFloat = 16

    var body: some View {
        Group {
            switch resolver.resolve(agent) {
            case .official(let image, _):
                Image(nsImage: image)
                    .resizable()
                    .renderingMode(.original)
                    .aspectRatio(contentMode: .fit)
            case .monogram(let monogram):
                Text(monogram)
                    .font(.system(size: max(8, size * 0.52), weight: .semibold, design: .monospaced))
                    .foregroundStyle(DesignTokens.textSecondary)
            case .systemSymbol(let symbol):
                Image(systemName: symbol)
                    .font(.system(size: size * 0.72, weight: .medium))
                    .foregroundStyle(DesignTokens.textSecondary)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct AgentStateLabel: View {
    let state: AgentActivityState
    var includesLabel = true

    @Environment(\.gdmReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: DesignTokens.space1) {
            Text(state.glyph)
                .unsettledPulse(state.isUnsettled)
            if includesLabel {
                Text(state.label)
                    .lineLimit(1)
            }
        }
        .font(.system(size: DesignTokens.labelSize, weight: .medium, design: .monospaced))
        .foregroundStyle(color(for: state.tone))
        .animation(MotionAnimations.state(reduceMotion: reduceMotion), value: state)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(state.label)
    }
}

struct TerminalAgentSelector: View {
    @ObservedObject var store: WorkspaceStore
    let disabled: Bool
    let restoreTerminalFocus: () -> Void

    @State private var isPresented = false

    private var selectedState: AgentActivityState {
        state(for: store.selectedAgent)
    }

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            HStack(spacing: DesignTokens.space2) {
                AgentIconView(agent: store.selectedAgent, resolver: store.agentIconResolver)
                Text(store.selectedAgent.displayName)
                    .font(.system(size: DesignTokens.rowSize, weight: .medium))
                    .foregroundStyle(DesignTokens.textPrimary)
                AgentStateLabel(state: selectedState)
                Text("▾")
                    .font(.system(size: DesignTokens.labelSize, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .padding(.horizontal, DesignTokens.space2)
            .frame(minHeight: DesignTokens.controlMinimumHeight)
            .background(DesignTokens.surfaceHover)
            .overlay {
                RoundedRectangle(cornerRadius: DesignTokens.controlRadius)
                    .stroke(DesignTokens.lineControl, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.controlRadius))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .overlay(alignment: .topTrailing) {
            if isPresented {
                VStack(spacing: 0) {
                    ForEach(AgentActivityComposition.popoverAgents) { agent in
                        Button {
                            choose(agent)
                        } label: {
                            HStack(spacing: DesignTokens.space2) {
                                AgentIconView(agent: agent, resolver: store.agentIconResolver)
                                Text(agent.displayName)
                                    .font(.system(size: DesignTokens.rowSize, weight: .medium))
                                    .foregroundStyle(DesignTokens.textPrimary)
                                Spacer(minLength: DesignTokens.space3)
                                AgentStateLabel(state: state(for: agent))
                            }
                            .padding(.horizontal, DesignTokens.space3)
                            .frame(minHeight: DesignTokens.rowHeight)
                            .background(
                                store.selectedAgent == agent
                                    ? DesignTokens.surfaceSelected
                                    : DesignTokens.surfaceRaised
                            )
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .overlay(alignment: .bottom) { TokenDivider() }
                    }
                }
                .frame(width: 232)
                .background(DesignTokens.surfaceRaised)
                .overlay {
                    RoundedRectangle(cornerRadius: DesignTokens.overlayRadius)
                        .stroke(DesignTokens.lineControl, lineWidth: 1)
                }
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.overlayRadius))
                .offset(y: DesignTokens.controlMinimumHeight + DesignTokens.space1)
                .mountOnlyMotion(duration: MotionTokens.overlaySelector)
                .zIndex(100)
            }
        }
        .zIndex(isPresented ? 100 : 0)
        .accessibilityLabel("Agent selector, \(store.selectedAgent.displayName), \(selectedState.label)")
    }

    private func state(for agent: AgentKind) -> AgentActivityState {
        if let taskID = store.selectedTask?.id,
           let item = store.agentActivityItems.first(where: {
               $0.taskID == taskID && $0.agent == agent
           }) {
            return item.state
        }
        return store.agentActivitySummary(for: agent).state == .unavailable
            ? .unavailable
            : .idle
    }

    private func choose(_ agent: AgentKind) {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            store.chooseAgent(agent)
            isPresented = false
        }
        DispatchQueue.main.async { restoreTerminalFocus() }
    }
}

private struct AgentActivityCell: View {
    let summary: AgentActivitySummary
    let resolver: AgentIconResolver
    let showsName: Bool
    let isCurrent: Bool
    let action: () -> Void

    @Environment(\.gdmReduceMotion) private var reduceMotion
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: DesignTokens.space1) {
                AgentIconView(agent: summary.agent, resolver: resolver)
                if showsName {
                    Text(summary.agent.displayName)
                        .font(.system(size: DesignTokens.metaSize, weight: .medium))
                        .foregroundStyle(DesignTokens.textPrimary)
                        .lineLimit(1)
                }
                AgentStateLabel(state: summary.state, includesLabel: false)
                if summary.runningCount > 0 {
                    MotionCounterText("\(summary.runningCount)", settled: !summary.state.isUnsettled)
                        .font(.system(size: DesignTokens.metaSize, weight: .medium, design: .monospaced))
                        .foregroundStyle(color(for: summary.state.tone))
                }
            }
            .padding(.horizontal, DesignTokens.space1)
            .frame(minHeight: DesignTokens.controlMinimumHeight)
            .background(
                (isCurrent || isHovering)
                    ? DesignTokens.surfaceSelected
                    : DesignTokens.surfaceBar
            )
            .overlay {
                if isCurrent {
                    RoundedRectangle(cornerRadius: DesignTokens.controlRadius)
                        .stroke(DesignTokens.lineControl, lineWidth: 1)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.controlRadius))
            .contentShape(Rectangle())
            .animation(MotionAnimations.hover(reduceMotion: reduceMotion), value: isHovering)
            .animation(MotionAnimations.state(reduceMotion: reduceMotion), value: isCurrent)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .help("\(summary.agent.displayName) · \(summary.state.label) · \(summary.runningCount) live")
        .accessibilityLabel("\(summary.agent.displayName), \(summary.state.label), live tasks \(summary.runningCount)")
    }
}

struct AgentActivityPopover: View {
    @ObservedObject var store: WorkspaceStore
    let highlightedAgent: AgentKind?
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: DesignTokens.space2) {
                SectionLabel(title: "Agent Activity")
                Spacer()
                if store.agentActivityLiveCount > 0 {
                    Text("\(store.agentActivityLiveCount) LIVE")
                        .font(.system(size: DesignTokens.labelSize, weight: .medium, design: .monospaced))
                        .foregroundStyle(DesignTokens.active)
                }
                Button(action: dismiss) {
                    Text("×")
                        .font(.system(size: DesignTokens.bodySize, design: .monospaced))
                        .foregroundStyle(DesignTokens.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Agent Activity 닫기")
            }
            .padding(.horizontal, DesignTokens.space3)
            .frame(height: DesignTokens.paneHeaderHeight)
            .background(DesignTokens.surfaceBar)

            TokenDivider()

            ScrollView {
                clockedContent
            }
            .frame(maxHeight: 520)
        }
        .background(DesignTokens.surfaceRaised)
        .overlay {
            RoundedRectangle(cornerRadius: DesignTokens.overlayRadius)
                .stroke(DesignTokens.lineControl, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.overlayRadius))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agent Activity 상세")
    }

    @ViewBuilder
    private var clockedContent: some View {
        if store.agentActivityLiveCount > 0, !store.isDemo {
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
                rows(at: timeline.date)
            }
        } else {
            rows(at: store.isDemo ? DemoData.agentActivityReferenceDate : Date())
        }
    }

    private func rows(at now: Date) -> some View {
        LazyVStack(spacing: 0) {
            ForEach(AgentActivityComposition.popoverAgents) { agent in
                let summary = store.agentActivitySummary(for: agent)
                AgentActivityAgentSection(
                    summary: summary,
                    resolver: store.agentIconResolver,
                    highlighted: highlightedAgent == agent,
                    now: now
                )
            }
        }
    }
}

private struct AgentActivityAgentSection: View {
    let summary: AgentActivitySummary
    let resolver: AgentIconResolver
    let highlighted: Bool
    let now: Date

    @Environment(\.gdmReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: DesignTokens.space2) {
                AgentIconView(agent: summary.agent, resolver: resolver)
                Text(summary.agent.displayName)
                    .font(.system(size: DesignTokens.rowSize, weight: .semibold))
                    .foregroundStyle(DesignTokens.textPrimary)
                Spacer()
                AgentStateLabel(state: summary.state)
                if summary.runningCount > 0 {
                    Text("\(summary.runningCount)")
                        .font(.system(size: DesignTokens.metaSize, weight: .medium, design: .monospaced))
                        .foregroundStyle(DesignTokens.active)
                }
            }
            .padding(.horizontal, DesignTokens.space3)
            .frame(minHeight: DesignTokens.rowHeight)

            if summary.items.isEmpty {
                Text("— no attached task")
                    .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
                    .padding(.horizontal, DesignTokens.space3)
                    .padding(.bottom, DesignTokens.space2)
            } else {
                ForEach(summary.items) { item in
                    AgentActivityTaskRow(item: item, now: now)
                }
            }
        }
        .background(highlighted ? DesignTokens.surfaceSelected : DesignTokens.surfaceRaised)
        .animation(MotionAnimations.state(reduceMotion: reduceMotion), value: highlighted)
        .overlay(alignment: .bottom) { TokenDivider() }
    }
}

private struct AgentActivityTaskRow: View {
    let item: AgentActivityItem
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.space1) {
            HStack(spacing: DesignTokens.space2) {
                Text(item.taskSlug)
                    .font(.system(size: DesignTokens.rowSize, weight: .medium, design: .monospaced))
                    .foregroundStyle(DesignTokens.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: DesignTokens.space2)
                if let elapsed = item.elapsedLabel(at: now) {
                    Text(elapsed)
                        .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                        .foregroundStyle(DesignTokens.textSecondary)
                }
            }
            Text(shortBranch(item.branch))
                .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                .foregroundStyle(DesignTokens.textSecondary)
                .lineLimit(1)
            Text(item.worktreePath)
                .font(.system(size: DesignTokens.labelSize, design: .monospaced))
                .foregroundStyle(DesignTokens.textTertiary)
                .lineLimit(1)
                .truncationMode(.middle)
            AgentStateLabel(state: item.state)
        }
        .padding(.horizontal, DesignTokens.space3)
        .padding(.bottom, DesignTokens.space2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(item.taskSlug), \(shortBranch(item.branch)), \(item.worktreePath), \(item.state.label), \(item.elapsedLabel(at: now) ?? "elapsed unavailable")"
        )
    }

    private func shortBranch(_ branch: String?) -> String {
        guard let branch, !branch.isEmpty else { return "detached" }
        return branch.hasPrefix("refs/heads/")
            ? String(branch.dropFirst("refs/heads/".count))
            : branch
    }
}
