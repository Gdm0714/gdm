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
    static let coordinateSpaceName = "gidem.agent-activity.workspace"
    static let defaultValue: CGRect? = nil

    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) {
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
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: AgentActivityBoundsPreferenceKey.self,
                        value: proxy.frame(in: .named(AgentActivityBoundsPreferenceKey.coordinateSpaceName))
                    )
                }
            }
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
    let laneID: UUID?
    let compact: Bool
    let disabled: Bool
    let restoreTerminalFocus: () -> Void

    @State private var isPresented = false

    private var selectedState: AgentActivityState {
        state(for: selectedAgent)
    }

    private var selectedAgent: AgentKind {
        laneID.map(store.agent(for:)) ?? store.selectedAgent
    }

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            HStack(spacing: DesignTokens.space2) {
                AgentIconView(agent: selectedAgent, resolver: store.agentIconResolver)
                if !compact {
                    Text(selectedAgent.displayName)
                        .font(.system(size: DesignTokens.rowSize, weight: .medium))
                        .foregroundStyle(DesignTokens.textPrimary)
                        .lineLimit(1)
                }
                AgentStateLabel(state: selectedState, includesLabel: !compact)
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
                                selectedAgent == agent
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
        .accessibilityLabel("Agent selector, \(selectedAgent.displayName), \(selectedState.label)")
    }

    private func state(for agent: AgentKind) -> AgentActivityState {
        if let taskID = store.selectedTask?.id,
           let item = store.agentActivityItems.first(where: {
               $0.taskID == taskID
                    && $0.agent == agent
                    && (laneID == nil || $0.laneID == laneID.map { $0.uuidString.lowercased() })
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
            store.chooseAgent(agent, laneID: laneID)
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
    let maximumHeight: CGFloat
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
            .frame(height: max(0, maximumHeight - DesignTokens.paneHeaderHeight))
        }
        .background(DesignTokens.surfaceRaised)
        .overlay {
            RoundedRectangle(cornerRadius: DesignTokens.overlayRadius)
                .stroke(DesignTokens.lineControl, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.overlayRadius))
        .frame(height: maximumHeight)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agent Activity 상세")
        .accessibilityIdentifier("gidem.agent-activity.popover")
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
                    store: store,
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
    @ObservedObject var store: WorkspaceStore
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
                    AgentActivityTaskRow(store: store, item: item, now: now)
                }
            }
        }
        .background(highlighted ? DesignTokens.surfaceSelected : DesignTokens.surfaceRaised)
        .animation(MotionAnimations.state(reduceMotion: reduceMotion), value: highlighted)
        .overlay(alignment: .bottom) { TokenDivider() }
    }
}

private struct AgentActivityTaskRow: View {
    @ObservedObject var store: WorkspaceStore
    let item: AgentActivityItem
    let now: Date

    private var isAttached: Bool {
        store.isAgentActivityItemAttached(item)
    }

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
            if !isAttached {
                HStack(alignment: .top, spacing: DesignTokens.space2) {
                    SignalMarker(glyph: "⊘", label: "DETACHED", tone: .attention)
                    Text("Task 목록과 연결이 끊겼습니다. Stop한 뒤 repository를 변경하세요.")
                        .font(.system(size: DesignTokens.labelSize))
                        .foregroundStyle(DesignTokens.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let coordination = store.coordinationStatus(for: item) {
                HStack(spacing: DesignTokens.space1) {
                    AgentCoordinationRoleBadge(role: coordination.coordinationRole)
                    if coordination.ownsInput {
                        AgentOwnershipBadge(label: "INPUT", emphasized: true)
                    }
                    Spacer()
                }
                if let summary = coordination.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.system(size: DesignTokens.labelSize, design: .monospaced))
                        .foregroundStyle(
                            coordination.semanticState == .needsYou
                                ? DesignTokens.attention
                                : DesignTokens.textSecondary
                        )
                        .lineLimit(2)
                        .accessibilityLabel("Agent status: \(summary)")
                }
            }
            HStack(spacing: DesignTokens.space1) {
                if isAttached {
                    AgentRowAction(title: "Focus", itemID: item.id) { store.focusAgentActivityItem(item) }
                }
                if item.state.isRunning {
                    AgentRowAction(title: "Stop", itemID: item.id) { store.stopAgentActivityItem(item) }
                }
                if isAttached {
                    let targets = store.handoffTargets(for: item)
                    if !targets.isEmpty {
                        Menu {
                            ForEach(targets, id: \.identity) { target in
                                Button(store.handoffTargetLabel(target)) {
                                    store.handoffAgentActivityItem(item, to: target.identity)
                                }
                            }
                        } label: {
                            Text("Handoff")
                                .font(.system(size: DesignTokens.labelSize, weight: .medium, design: .monospaced))
                        }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                        .help("Advisory PRIMARY 역할을 넘깁니다. 파일 시스템 쓰기 권한은 변경하거나 강제하지 않습니다.")
                        .accessibilityLabel("Advisory coordination role handoff; filesystem write access is not enforced")
                        .accessibilityIdentifier("gidem.agent-activity.action.\(item.id).handoff")
                    }
                    AgentRowAction(title: "Diff", itemID: item.id) { store.showDiff(for: item) }
                    AgentRowAction(title: "Proof", itemID: item.id) { store.showProof(for: item) }
                }
            }
        }
        .padding(.horizontal, DesignTokens.space3)
        .padding(.bottom, DesignTokens.space2)
        .accessibilityElement(children: .contain)
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

private struct AgentCoordinationRoleBadge: View {
    let role: AgentCoordinationRole

    var body: some View {
        Text(role == .primary ? "PRIMARY" : "SECONDARY")
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .foregroundStyle(role == .primary ? DesignTokens.active : DesignTokens.textTertiary)
            .padding(.horizontal, DesignTokens.space1)
            .frame(minHeight: 18)
            .background(DesignTokens.surfaceBar)
            .overlay {
                RoundedRectangle(cornerRadius: DesignTokens.controlRadius)
                    .stroke(DesignTokens.lineControl, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.controlRadius))
            .help("협업 순서를 위한 advisory \(role.rawValue) 역할입니다. 파일 시스템 쓰기 권한을 부여하거나 차단하지 않습니다.")
            .accessibilityLabel(
                "Advisory coordination role \(role.rawValue); filesystem write access is not enforced"
            )
    }
}

private struct AgentOwnershipBadge: View {
    let label: String
    let emphasized: Bool

    var body: some View {
        Text(label)
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .foregroundStyle(emphasized ? DesignTokens.active : DesignTokens.textTertiary)
            .padding(.horizontal, DesignTokens.space1)
            .frame(minHeight: 18)
            .background(DesignTokens.surfaceBar)
            .overlay {
                RoundedRectangle(cornerRadius: DesignTokens.controlRadius)
                    .stroke(DesignTokens.lineControl, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.controlRadius))
    }
}

private struct AgentRowAction: View {
    let title: String
    let itemID: String
    let action: () -> Void

    var body: some View {
        Button(title, action: action)
            .buttonStyle(.plain)
            .font(.system(size: DesignTokens.labelSize, weight: .medium, design: .monospaced))
            .foregroundStyle(DesignTokens.textSecondary)
            .padding(.horizontal, DesignTokens.space1)
            .frame(minHeight: 24)
            .background(DesignTokens.surfaceHover)
            .overlay {
                RoundedRectangle(cornerRadius: DesignTokens.controlRadius)
                    .stroke(DesignTokens.lineControl, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.controlRadius))
            .accessibilityLabel(title)
            .accessibilityIdentifier("gidem.agent-activity.action.\(itemID).\(title.lowercased())")
    }
}
