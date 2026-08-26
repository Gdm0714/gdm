import SwiftUI

struct ProofRailView: View {
    @ObservedObject var store: WorkspaceStore
    let compact: Bool

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader {
                SectionLabel(title: "Proof Rail · \(store.selectedWork?.slug ?? "No task")")
                Spacer()
                if let work = store.selectedWork {
                    MotionCounterText(
                        planCounter(for: work),
                        settled: store.activeCheckID == nil
                    )
                        .font(.system(size: DesignTokens.labelSize, weight: .medium, design: .monospaced))
                        .foregroundStyle(store.canCompleteSelectedTask ? DesignTokens.proven : DesignTokens.attention)
                }
            }

            if let work = store.selectedWork {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ContractSection(work: work)
                        VerificationPlanSection(store: store, work: work)
                        StageStrip(work: work, store: store)
                        ForEach(work.checks) { check in
                            ProofCheckRow(check: check, state: store.displayState(for: check))
                        }
                        AuditSection(work: work)
                        DeliverySection(work: work)
                    }
                }

                CompletionGate(store: store, work: work)
            } else {
                Text("작업을 선택하면 완료 근거가 여기에 표시됩니다.")
                    .font(.system(size: DesignTokens.bodySize))
                    .foregroundStyle(DesignTokens.textSecondary)
                    .padding(DesignTokens.space4)
                Spacer()
            }
        }
        .frame(width: compact ? nil : DesignTokens.proofRailWidth)
        .frame(maxWidth: compact ? .infinity : DesignTokens.proofRailWidth, maxHeight: .infinity)
        .background(DesignTokens.surfacePanel)
        .overlay(alignment: .leading) {
            if !compact { Rectangle().fill(DesignTokens.lineStructure).frame(width: 1) }
        }
        .contentShape(Rectangle())
        .onTapGesture { store.focusedRegion = .proof }
        .paneFocused(store.focusedRegion == .proof)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("완료 근거 레일")
    }

    private func planCounter(for work: WorkDocument) -> String {
        switch store.selectedVerificationPlanState {
        case .needsPlan: "PLAN NEEDED"
        case .reviewRequired: "\(work.checks.count) TO REVIEW"
        case .approved: "\(work.provenCount) / \(work.checks.count) PROVEN"
        case .unavailable: "UNAVAILABLE"
        }
    }
}

private struct ContractSection: View {
    let work: WorkDocument

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.space2) {
            SectionLabel(title: "Contract")
            Text(work.brief)
                .font(.system(size: DesignTokens.bodySize, weight: .medium))
                .foregroundStyle(DesignTokens.textPrimary)
                .lineSpacing(DesignTokens.space1)
                .fixedSize(horizontal: false, vertical: true)
            ContractValueGroup(label: "필수", values: work.contract.required)
            ContractValueGroup(label: "금지", values: work.contract.forbidden)
            ContractValueGroup(label: "가정", values: work.contract.assumptions ?? [])
            ContractValueGroup(label: "불확실성", values: work.contract.uncertainties ?? [])
            ContractValueGroup(label: "허용 경로", values: work.contract.allowedPaths ?? ["."])
            ContractValueGroup(label: "금지 경로", values: work.contract.forbiddenPaths ?? [])
            ContractValueGroup(label: "중단 조건", values: work.contract.stopConditions ?? [])
            ContractMetadataRow(label: "커밋", value: normalizedCommitPolicy)
            ContractMetadataRow(label: "위험도", value: work.contract.risk ?? "low")
            ContractMetadataRow(label: "검증", value: work.contract.verification ?? "deterministic")
            ContractMetadataRow(label: "독립 검수", value: (work.auditRequired ?? false) ? "필수" : "선택")
            ContractMetadataRow(
                label: "단순화 검토",
                value: (work.contract.simplificationRequired ?? false) ? "필수" : "선택"
            )
        }
        .padding(DesignTokens.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DesignTokens.surfacePanel)
        .overlay(alignment: .bottom) { TokenDivider() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("작업 계약")
    }

    private var normalizedCommitPolicy: String {
        let value = work.contract.commit ?? "forbidden"
        return value.isEmpty ? "forbidden" : value
    }
}

private struct ContractValueGroup: View {
    let label: String
    let values: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.space1) {
            Text(label.uppercased())
                .font(.system(size: DesignTokens.labelSize, weight: .medium, design: .monospaced))
                .foregroundStyle(DesignTokens.textTertiary)
            if values.isEmpty {
                Text("없음")
                    .font(.system(size: DesignTokens.metaSize))
                    .foregroundStyle(DesignTokens.textTertiary)
            } else {
                ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                    Text("· \(value)")
                        .font(.system(size: DesignTokens.metaSize))
                        .foregroundStyle(DesignTokens.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label), \(values.isEmpty ? "없음" : values.joined(separator: ", "))")
    }
}

private struct ContractMetadataRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DesignTokens.space2) {
            Text(label.uppercased())
                .font(.system(size: DesignTokens.labelSize, weight: .medium, design: .monospaced))
                .foregroundStyle(DesignTokens.textTertiary)
            Spacer(minLength: DesignTokens.space2)
            Text(value)
                .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                .foregroundStyle(DesignTokens.textSecondary)
                .multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label), \(value)")
    }
}

private struct VerificationPlanSection: View {
    @ObservedObject var store: WorkspaceStore
    let work: WorkDocument

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.space2) {
            HStack(spacing: DesignTokens.space2) {
                SignalMarker(glyph: glyph, label: label, tone: tone)
                Spacer(minLength: 0)
                if state == .reviewRequired {
                    Text("\(work.checks.count) CHECKS")
                        .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                        .foregroundStyle(DesignTokens.textTertiary)
                }
            }

            Text(title)
                .font(.system(size: DesignTokens.bodySize, weight: .semibold))
                .foregroundStyle(DesignTokens.textPrimary)
            Text(detail)
                .font(.system(size: DesignTokens.metaSize))
                .foregroundStyle(DesignTokens.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            switch state {
            case .needsPlan:
                Button(action: { store.startVerificationPlanning() }) {
                    Text(store.isVerificationPlanningPreparationPending
                        ? "소스 기준점 확인 중…"
                        : "\(plannerName)로 검증 계획 만들기")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(OperationalButtonStyle(emphasized: true))
                .disabled(!canPlan)
                .accessibilityHint("에이전트에게 계획 전용 요청을 보내며, 이후 소스나 Git index가 바뀌면 승인이 차단됩니다")
            case .reviewRequired:
                Button(action: store.approveSelectedVerificationPlan) {
                    Text(store.isPlanApprovalPending ? "변경 여부 확인 중…" : "검증 계획 승인")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(OperationalButtonStyle(emphasized: true))
                .disabled(!store.canApproveSelectedVerificationPlan)

                Button(action: { store.startVerificationPlanning() }) {
                    Text("\(plannerName)로 계획 다시 검토")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(OperationalButtonStyle())
                .disabled(!canPlan)
            case .approved, .unavailable:
                EmptyView()
            }
        }
        .padding(DesignTokens.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(state == .reviewRequired ? DesignTokens.surfaceSelected : DesignTokens.surfacePanel)
        .overlay(alignment: .bottom) { TokenDivider() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("검증 계획, \(label)")
    }

    private var state: VerificationPlanState { store.selectedVerificationPlanState }
    private var plannerName: String { store.verificationPlannerAgent?.displayName ?? "AI agent" }
    private var canPlan: Bool {
        !store.isDemo
            && !store.isCommandRunning
            && !store.isPlanApprovalPending
            && !store.isVerificationPlanningPreparationPending
            && store.selectedTask?.canMutate == true
            && store.verificationPlannerAgent != nil
    }
    private var glyph: String {
        switch state {
        case .approved: "✓"
        case .reviewRequired: "◔"
        case .needsPlan: "○"
        case .unavailable: "⊘"
        }
    }
    private var label: String {
        switch state {
        case .approved: "PLAN APPROVED"
        case .reviewRequired: "REVIEW REQUIRED"
        case .needsPlan: "PLAN NEEDED"
        case .unavailable: "UNAVAILABLE"
        }
    }
    private var tone: SignalTone {
        switch state {
        case .approved: .proven
        case .reviewRequired, .needsPlan: .attention
        case .unavailable: .blocked
        }
    }
    private var title: String {
        switch state {
        case .approved: "검증 계획 준비됨"
        case .reviewRequired: "검증 항목을 확인해 주세요"
        case .needsPlan: "무엇으로 완료를 증명할지 먼저 정합니다"
        case .unavailable: "검증 계획을 불러올 수 없습니다"
        }
    }
    private var detail: String {
        switch state {
        case .approved:
            "승인된 \(work.checks.count)개 항목을 기준으로 구현과 검증을 진행합니다."
        case .reviewRequired:
            "계획 전용 요청으로 만든 자동·수동 확인 항목입니다. 계약과 기대 결과를 확인하세요. 계획 이후 소스나 Git index가 바뀌면 승인이 차단됩니다."
        case .needsPlan:
            "목표와 제약은 정해졌지만 검증 항목은 비어 있습니다. 에이전트에게 계획 전용 요청을 보낸 뒤 승인을 기다립니다. 그 사이 소스나 Git index가 바뀌면 승인할 수 없습니다."
        case .unavailable:
            "작업 workspace와 checks.json 상태를 확인하세요."
        }
    }
}

private struct StageStrip: View {
    let work: WorkDocument
    @ObservedObject var store: WorkspaceStore
    @Environment(\.gdmReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: DesignTokens.space1) {
            stage("CONTRACT", glyph: "✓", tone: .proven)
            connector
            stage("RED", glyph: redGlyph, tone: redTone)
            connector
            stage("CHECKS", glyph: checksGlyph, tone: checksTone)
            connector
            stage("AUDIT", glyph: auditGlyph, tone: auditTone)
            connector
            stage("DELIVERY", glyph: work.done ? "✓" : "○", tone: work.done ? .proven : .neutral)
        }
        .padding(.horizontal, DesignTokens.space3)
        .frame(minHeight: DesignTokens.paneHeaderHeight)
        .background(DesignTokens.surfaceStatusBar)
        .overlay(alignment: .bottom) { TokenDivider() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("계약, 회귀, checks, audit, delivery 단계")
    }

    private func stage(_ label: String, glyph: String, tone: SignalTone) -> some View {
        Text("\(glyph) \(label)")
            .font(.system(size: DesignTokens.labelSize, design: .monospaced))
            .foregroundStyle(color(for: tone))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .animation(MotionAnimations.state(reduceMotion: reduceMotion), value: glyph)
            .animation(MotionAnimations.state(reduceMotion: reduceMotion), value: tone.rawValue)
    }

    private var connector: some View {
        Rectangle().fill(DesignTokens.lineStructure).frame(minWidth: DesignTokens.space1, maxWidth: .infinity, maxHeight: 1)
    }

    private var regressionChecks: [CheckRecord] { work.checks.filter(\.isRegression) }
    private var redGlyph: String {
        regressionChecks.isEmpty ? "—" : (regressionChecks.allSatisfy { $0.redEvidence != nil } ? "✓" : "○")
    }
    private var redTone: SignalTone {
        regressionChecks.isEmpty ? .neutral : (regressionChecks.allSatisfy { $0.redEvidence != nil } ? .proven : .attention)
    }
    private var checksGlyph: String {
        if !store.failedCheckIDs.isEmpty { return "✕" }
        if store.activeCheckID != nil { return "◐" }
        return work.allChecksProven ? "✓" : "○"
    }
    private var checksTone: SignalTone {
        if !store.failedCheckIDs.isEmpty { return .blocked }
        if store.activeCheckID != nil { return .active }
        return work.allChecksProven ? .proven : .attention
    }
    private var auditGlyph: String {
        if work.audit?.result == "fail" { return "✕" }
        if work.audit?.result == "pass" { return "✓" }
        return (work.auditRequired ?? false) ? "○" : "—"
    }
    private var auditTone: SignalTone {
        if work.audit?.result == "fail" { return .blocked }
        if work.audit?.result == "pass" { return .proven }
        return (work.auditRequired ?? false) ? .attention : .neutral
    }
}

private struct ProofCheckRow: View {
    let check: CheckRecord
    let state: CheckDisplayState
    @State private var expanded = false
    @State private var hovering = false
    @State private var settleFlash = false
    @State private var settleGeneration = 0
    @Environment(\.gdmReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            expanded.toggle()
        } label: {
            HStack(spacing: 0) {
                Rectangle()
                    .fill((state == .open || state == .failed) ? DesignTokens.blocked : Color.clear)
                    .frame(width: 2)
                    .animation(MotionAnimations.state(reduceMotion: reduceMotion), value: state)

                VStack(alignment: .leading, spacing: DesignTokens.space2) {
                    HStack(spacing: DesignTokens.space2) {
                        SignalMarker(
                            glyph: state.marker,
                            label: state.label,
                            tone: state.tone,
                            pulses: state == .running
                        )
                        Text("\(check.id) · \(check.kind ?? "manual")")
                            .font(.system(size: DesignTokens.labelSize, design: .monospaced))
                            .foregroundStyle(DesignTokens.textTertiary)
                        Spacer(minLength: 0)
                    }

                    Text(check.desc)
                        .font(.system(size: DesignTokens.bodySize, weight: .medium))
                        .foregroundStyle(DesignTokens.textPrimary)
                        .lineLimit(2)

                    if state == .running {
                        DeterminateProgressBar(progress: 0.8)
                        Text("검증 명령 실행 중")
                            .font(.system(size: DesignTokens.labelSize, design: .monospaced))
                            .foregroundStyle(DesignTokens.active)
                    }

                    Text(check.cmd ?? "manual evidence")
                        .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                        .foregroundStyle(DesignTokens.textSecondary)
                        .lineLimit(expanded ? nil : 1)
                        .truncationMode(.middle)

                    if let evidence = check.evidence ?? check.redEvidence {
                        Text("exit \(evidence.exitCode.map(String.init) ?? "manual") · sha \(evidence.sha256.prefix(10))…")
                            .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                            .foregroundStyle(DesignTokens.textTertiary)
                    }

                    if expanded {
                        Group {
                            Text("expect: \(check.expect)")
                                .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                                .foregroundStyle(DesignTokens.textSecondary)
                            if let evidence = check.evidence ?? check.redEvidence {
                                Text("captured: \(evidence.at)\nsha256: \(evidence.sha256)\nobserved: \(evidence.observed)")
                                    .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                                    .foregroundStyle(DesignTokens.textSecondary)
                                    .textSelection(.enabled)
                            }
                        }
                        .mountOnlyMotion(duration: MotionTokens.overlaySheet)
                    }
                }
                .padding(DesignTokens.space3)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(
                settleFlash
                    ? DesignTokens.surfaceSelected
                    : (hovering ? DesignTokens.surfaceHover : DesignTokens.surfacePanel)
            )
            .animation(MotionAnimations.hover(reduceMotion: reduceMotion), value: hovering)
            .overlay(alignment: .bottom) { TokenDivider() }
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .onChange(of: state) { oldState, newState in
            settle(from: oldState, to: newState)
        }
        .onChange(of: reduceMotion) { _, isEnabled in
            guard isEnabled else { return }
            settleGeneration += 1
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) { settleFlash = false }
        }
        .accessibilityLabel("\(check.id), \(check.desc), \(state.label)")
        .accessibilityHint("증거 상세를 펼칩니다")
    }

    private func settle(from oldState: CheckDisplayState, to newState: CheckDisplayState) {
        settleGeneration += 1
        let currentGeneration = settleGeneration
        guard !reduceMotion, MotionPolicy.shouldSettleCheck(from: oldState, to: newState) else {
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) { settleFlash = false }
            return
        }

        withAnimation(MotionAnimations.settle(reduceMotion: false)) {
            settleFlash = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + MotionTokens.settle * 2) {
            guard settleGeneration == currentGeneration else { return }
            withAnimation(MotionAnimations.settle(reduceMotion: false)) {
                settleFlash = false
            }
        }
    }
}

private struct DeterminateProgressBar: View {
    let progress: CGFloat
    @Environment(\.gdmReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Rectangle().fill(DesignTokens.lineSoft)
                Rectangle()
                    .fill(DesignTokens.active)
                    .frame(width: geometry.size.width * min(max(progress, 0), 1))
                    .animation(MotionAnimations.progress(reduceMotion: reduceMotion), value: progress)
            }
        }
        .frame(height: DesignTokens.space1)
        .accessibilityLabel("검증 진행률 \(Int(progress * 100))퍼센트")
    }
}

private struct AuditSection: View {
    let work: WorkDocument

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.space2) {
            HStack {
                Text("Independent audit")
                    .font(.system(size: DesignTokens.bodySize, weight: .medium))
                    .foregroundStyle(DesignTokens.textPrimary)
                Spacer()
                SignalMarker(glyph: glyph, label: label, tone: tone)
            }
            Text(detail)
                .font(.system(size: DesignTokens.metaSize))
                .foregroundStyle(DesignTokens.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(DesignTokens.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { TokenDivider() }
    }

    private var glyph: String {
        if work.audit?.result == "pass" { return "✓" }
        if work.audit?.result == "fail" { return "✕" }
        return (work.auditRequired ?? false) ? "○" : "—"
    }
    private var label: String {
        if work.audit?.result == "pass" { return "AUDIT PASSED" }
        if work.audit?.result == "fail" { return "AUDIT REJECTED" }
        return (work.auditRequired ?? false) ? "AUDIT REQUIRED" : "NOT REQUIRED"
    }
    private var tone: SignalTone {
        if work.audit?.result == "pass" { return .proven }
        if work.audit?.result == "fail" { return .blocked }
        return (work.auditRequired ?? false) ? .attention : .neutral
    }
    private var detail: String {
        if let audit = work.audit { return audit.report }
        if work.auditRequired ?? false { return "High risk 작업은 서로 다른 구현·검수 모델의 판정이 필요합니다." }
        return "현재 위험도에서는 독립 검수가 완료 게이트가 아닙니다."
    }
}

private struct DeliverySection: View {
    let work: WorkDocument

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.space2) {
            SectionLabel(title: "Delivery")
            deliveryRow("Issue", value: work.delivery.map { "#\($0.issue)" } ?? "not prepared", tone: .neutral)
            deliveryRow("Pull request", value: work.delivery?.pr.map { "#\($0.number)" } ?? "not created", tone: .neutral)
            deliveryRow("CI", value: work.delivery?.ci?.status ?? "pending", tone: work.delivery?.ci?.status == "passed" ? .proven : .attention)
            deliveryRow("Merge approval", value: work.delivery?.mergeApproval == nil ? "unavailable" : "approved", tone: work.delivery?.mergeApproval == nil ? .blocked : .proven)
        }
        .padding(DesignTokens.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func deliveryRow(_ label: String, value: String, tone: SignalTone) -> some View {
        HStack {
            Text(label).foregroundStyle(DesignTokens.textSecondary)
            Spacer()
            Text(value)
                .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                .foregroundStyle(color(for: tone))
        }
        .font(.system(size: DesignTokens.rowSize))
    }
}

private struct CompletionGate: View {
    @ObservedObject var store: WorkspaceStore
    let work: WorkDocument

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.space2) {
            Button {
                if store.canCompleteSelectedTask { store.completeSelectedTask() }
                else { store.areBlockersPresented.toggle() }
            } label: {
                Text(work.done ? "Verified" : (store.canCompleteSelectedTask ? "Complete verified task" : "Complete — unavailable"))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(OperationalButtonStyle(
                emphasis: store.canCompleteSelectedTask && !work.done ? .proven : .standard
            ))
            .disabled(work.done || store.isDemo || store.selectedTask?.canMutate != true)

            if let blocker = blockers.first {
                HStack(alignment: .top, spacing: DesignTokens.space2) {
                    Text(blocker.glyph)
                    Text(blocker.message)
                }
                .font(.system(size: DesignTokens.metaSize))
                .foregroundStyle(color(for: blocker.tone))
            } else if !work.done {
                Text("모든 결정적 완료 조건이 충족됐습니다.")
                    .font(.system(size: DesignTokens.metaSize))
                    .foregroundStyle(DesignTokens.proven)
            }

            if store.areBlockersPresented {
                VStack(alignment: .leading, spacing: DesignTokens.space2) {
                    ForEach(blockers) { blocker in
                        Text("\(blocker.glyph) \(blocker.message)")
                            .font(.system(size: DesignTokens.metaSize))
                            .foregroundStyle(color(for: blocker.tone))
                    }
                }
                .mountOnlyMotion(duration: MotionTokens.overlayPopover)
            }
        }
        .padding(DesignTokens.space3)
        .background(DesignTokens.surfaceStatusBar)
        .overlay(alignment: .top) { TokenDivider() }
    }

    private var blockers: [ProofBlocker] {
        store.selectedCompletionBlockers
    }
}
