import SwiftUI

struct TaskRailSections {
    let priority: [WorkspaceTask]
    let provenHistory: [WorkspaceTask]

    static func resolve(
        tasks: [WorkspaceTask],
        selectedTaskKey: String?,
        stateFor: (WorkspaceTask) -> TaskDisplayState
    ) -> TaskRailSections {
        TaskRailSections(
            priority: tasks.filter { task in
                stateFor(task) != .proven || task.id == selectedTaskKey
            },
            provenHistory: tasks.filter { task in
                stateFor(task) == .proven && task.id != selectedTaskKey
            }
        )
    }
}

struct TaskRailView: View {
    @ObservedObject var store: WorkspaceStore
    let width: CGFloat
    let selectedTaskKey: String?
    let onSelect: (WorkspaceTask) -> Void

    @State private var isProvenHistoryExpanded = false

    private var sections: TaskRailSections {
        TaskRailSections.resolve(
            tasks: store.tasks,
            selectedTaskKey: selectedTaskKey,
            stateFor: store.displayState(for:)
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader {
                SectionLabel(title: "Tasks · \(store.tasks.count)")
                Spacer()
                Button {
                    store.presentNewTask()
                } label: {
                    Text("+  ⌘N")
                        .font(.system(size: DesignTokens.labelSize, design: .monospaced))
                        .foregroundStyle(DesignTokens.textSecondary)
                }
                .buttonStyle(.plain)
                .disabled(!store.canPresentNewTask)
                .accessibilityLabel("새 작업 만들기")
            }

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(sections.priority) { task in
                        TaskRowView(
                            task: task,
                            state: store.displayState(for: task),
                            planState: store.verificationPlanState(for: task),
                            isSelected: selectedTaskKey == task.id
                        ) {
                            onSelect(task)
                        }
                    }

                    if !sections.provenHistory.isEmpty {
                        ProvenHistoryDisclosure(
                            count: sections.provenHistory.count,
                            isExpanded: $isProvenHistoryExpanded
                        )

                        if isProvenHistoryExpanded {
                            ForEach(sections.provenHistory) { task in
                                TaskRowView(
                                    task: task,
                                    state: store.displayState(for: task),
                                    planState: store.verificationPlanState(for: task),
                                    isSelected: selectedTaskKey == task.id
                                ) {
                                    onSelect(task)
                                }
                            }
                        }
                    }
                }
            }

            Spacer(minLength: 0)
            TokenDivider()
            HStack {
                Text(store.repositoryName)
                Spacer()
                Text("⌘L")
            }
            .font(.system(size: DesignTokens.metaSize, design: .monospaced))
            .foregroundStyle(DesignTokens.textTertiary)
            .padding(.horizontal, DesignTokens.space3)
            .frame(height: DesignTokens.paneHeaderHeight)
        }
        .frame(width: width)
        .background(DesignTokens.surfacePanel)
        .overlay(alignment: .trailing) {
            Rectangle().fill(DesignTokens.lineStructure).frame(width: 1)
        }
        .contentShape(Rectangle())
        .onTapGesture { store.focusedRegion = .tasks }
        .paneFocused(store.focusedRegion == .tasks)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("작업 목록")
    }
}

private struct ProvenHistoryDisclosure: View {
    let count: Int
    @Binding var isExpanded: Bool

    @Environment(\.gdmReduceMotion) private var reduceMotion
    @State private var isHovering = false

    var body: some View {
        Button {
            withAnimation(MotionAnimations.panel(reduceMotion: reduceMotion)) {
                isExpanded.toggle()
            }
        } label: {
            HStack(spacing: DesignTokens.space2) {
                Text(isExpanded ? "▾" : "▸")
                    .foregroundStyle(DesignTokens.textSecondary)
                Text("PROVEN HISTORY · \(count)")
                    .foregroundStyle(DesignTokens.textTertiary)
                Spacer()
            }
            .font(.system(size: DesignTokens.labelSize, weight: .medium, design: .monospaced))
            .padding(.horizontal, DesignTokens.space3)
            .frame(minHeight: DesignTokens.rowHeight)
            .background(isHovering ? DesignTokens.surfaceHover : DesignTokens.surfacePanel)
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) { TokenDivider() }
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .accessibilityLabel("Proven history, \(count) tasks")
        .accessibilityValue(isExpanded ? "expanded" : "collapsed")
        .help(isExpanded ? "완료 이력 접기" : "완료 이력 펼치기")
    }
}

private struct TaskRowView: View {
    let task: WorkspaceTask
    let state: TaskDisplayState
    let planState: VerificationPlanState
    let isSelected: Bool
    let action: () -> Void
    @State private var isHovering = false
    @Environment(\.gdmReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            HStack(spacing: 0) {
                Rectangle()
                    .fill(isSelected ? color(for: state.tone) : Color.clear)
                    .frame(width: 2)
                    .animation(MotionAnimations.state(reduceMotion: reduceMotion), value: isSelected)

                VStack(alignment: .leading, spacing: DesignTokens.space1) {
                    Text(task.slug)
                        .font(.system(size: DesignTokens.rowSize, weight: isSelected ? .semibold : .regular, design: .monospaced))
                        .foregroundStyle(isSelected ? DesignTokens.textStrong : DesignTokens.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    HStack(spacing: DesignTokens.space2) {
                        SignalMarker(glyph: state.marker, label: state.rawValue, tone: state.tone)
                        Text(proofCount)
                            .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                            .foregroundStyle(DesignTokens.textSecondary)
                    }

                    Text(detail)
                        .font(.system(size: DesignTokens.labelSize, design: .monospaced))
                        .foregroundStyle(DesignTokens.textTertiary)
                        .lineLimit(1)
                }
                .padding(.horizontal, DesignTokens.space3)
                .padding(.vertical, DesignTokens.space2)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(
                isSelected
                    ? DesignTokens.surfaceSelected
                    : (isHovering ? DesignTokens.surfaceHover : DesignTokens.surfacePanel)
            )
            .animation(MotionAnimations.hover(reduceMotion: reduceMotion), value: isHovering)
            .animation(MotionAnimations.fadeIn(reduceMotion: reduceMotion), value: isSelected)
            .overlay(alignment: .bottom) { TokenDivider() }
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .accessibilityLabel("\(task.slug), \(state.rawValue), \(proofAccessibilityLabel)")
    }

    private var proofCount: String {
        guard let work = task.document else { return "—/—" }
        switch planState {
        case .needsPlan: return "NO CHECKS"
        case .reviewRequired: return "\(work.checks.count) TO REVIEW"
        case .approved: return "\(work.provenCount)/\(work.checks.count)"
        case .unavailable: return "—/—"
        }
    }

    private var proofAccessibilityLabel: String {
        guard let work = task.document else { return "proof status unavailable" }
        switch planState {
        case .needsPlan: return "verification plan needed"
        case .reviewRequired: return "\(work.checks.count) checks awaiting approval"
        case .approved: return "\(work.provenCount) of \(work.checks.count) checks proven"
        case .unavailable: return "proof status unavailable"
        }
    }

    private var detail: String {
        let rawBranch = task.branch ?? task.document?.delivery?.branch ?? "root"
        let branch = rawBranch.hasPrefix("refs/heads/")
            ? String(rawBranch.dropFirst("refs/heads/".count))
            : rawBranch
        let risk = task.document?.contract.risk?.uppercased() ?? task.health.rawValue.uppercased()
        return "\(branch) · \(risk)"
    }
}
