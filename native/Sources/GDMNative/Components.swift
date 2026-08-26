import SwiftUI

func color(for tone: SignalTone) -> Color {
    switch tone {
    case .proven: DesignTokens.proven
    case .active: DesignTokens.active
    case .attention: DesignTokens.attention
    case .blocked: DesignTokens.blocked
    case .neutral: DesignTokens.textSecondary
    }
}

struct SignalMarker: View {
    let glyph: String
    let label: String
    let tone: SignalTone
    let pulses: Bool
    @Environment(\.gdmReduceMotion) private var reduceMotion

    init(glyph: String, label: String, tone: SignalTone, pulses: Bool = false) {
        self.glyph = glyph
        self.label = label
        self.tone = tone
        self.pulses = pulses
    }

    var body: some View {
        Text("\(glyph) \(label)")
            .font(.system(size: DesignTokens.labelSize, weight: .medium, design: .monospaced))
            .foregroundStyle(color(for: tone))
            .padding(.horizontal, DesignTokens.space1)
            .padding(.vertical, DesignTokens.space1 / 2)
            .overlay {
                Rectangle().stroke(color(for: tone), lineWidth: 1)
            }
            .fixedSize(horizontal: true, vertical: false)
            .animation(MotionAnimations.state(reduceMotion: reduceMotion), value: tone.rawValue)
            .unsettledPulse(pulses)
            .accessibilityLabel("\(label) 상태")
    }
}

struct MotionCounterText: View {
    let value: String
    let settled: Bool

    @Environment(\.gdmReduceMotion) private var reduceMotion
    @State private var displayedValue: String
    @State private var opacity = 1.0
    @State private var verticalOffset = 0.0
    @State private var generation = 0

    init(_ value: String, settled: Bool = true) {
        self.value = value
        self.settled = settled
        _displayedValue = State(initialValue: value)
    }

    var body: some View {
        Text(displayedValue)
            .opacity(opacity)
            .offset(y: verticalOffset)
            .onChange(of: value) { _, newValue in
                replace(with: newValue)
            }
            .onChange(of: reduceMotion) { _, _ in
                replace(with: value)
            }
            .onChange(of: settled) { _, isSettled in
                if !isSettled { replace(with: value) }
            }
    }

    private func replace(with newValue: String) {
        generation += 1
        let currentGeneration = generation

        guard settled, !reduceMotion, displayedValue != newValue else {
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                displayedValue = newValue
                opacity = 1
                verticalOffset = 0
            }
            return
        }

        withAnimation(MotionAnimations.counterOut(reduceMotion: false)) {
            opacity = 0
            verticalOffset = -2
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + MotionTokens.counterOut) {
            guard generation == currentGeneration else { return }
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                displayedValue = newValue
                verticalOffset = 2
            }
            withAnimation(MotionAnimations.counterIn(reduceMotion: false)) {
                opacity = 1
                verticalOffset = 0
            }
        }
    }
}

struct SectionLabel: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(.system(size: DesignTokens.labelSize, weight: .medium, design: .monospaced))
            .tracking(1.4)
            .foregroundStyle(DesignTokens.textTertiary)
    }
}

struct TokenDivider: View {
    var body: some View {
        Rectangle()
            .fill(DesignTokens.lineSoft)
            .frame(height: 1)
            .accessibilityHidden(true)
    }
}

struct PaneHeader<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: DesignTokens.space3) {
            content
        }
        .padding(.horizontal, DesignTokens.space3)
        .frame(maxWidth: .infinity, minHeight: DesignTokens.paneHeaderHeight, maxHeight: DesignTokens.paneHeaderHeight, alignment: .leading)
        .background(DesignTokens.surfaceBar)
        .overlay(alignment: .bottom) { TokenDivider() }
    }
}

struct OperationalButtonStyle: ButtonStyle {
    enum Emphasis {
        case standard
        case active
        case proven
    }

    let emphasis: Emphasis

    init(emphasized: Bool = false) {
        emphasis = emphasized ? .active : .standard
    }

    init(emphasis: Emphasis) {
        self.emphasis = emphasis
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: DesignTokens.bodySize, weight: .medium))
            .foregroundStyle(foreground)
            .padding(.horizontal, DesignTokens.space3)
            .frame(minHeight: DesignTokens.controlMinimumHeight)
            .background(configuration.isPressed ? DesignTokens.surfaceSelected : DesignTokens.surfaceHover)
            .overlay {
                RoundedRectangle(cornerRadius: DesignTokens.controlRadius)
                    .stroke(border, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.controlRadius))
    }

    private var foreground: Color {
        switch emphasis {
        case .standard: DesignTokens.textPrimary
        case .active: DesignTokens.active
        case .proven: DesignTokens.proven
        }
    }

    private var border: Color {
        switch emphasis {
        case .standard: DesignTokens.lineControl
        case .active: DesignTokens.active
        case .proven: DesignTokens.proven
        }
    }
}

struct PaneFocusModifier: ViewModifier {
    let focused: Bool

    func body(content: Content) -> some View {
        content.overlay {
            if focused {
                Rectangle()
                    .stroke(DesignTokens.active, lineWidth: DesignTokens.focusRingWidth)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }
}

extension View {
    func paneFocused(_ focused: Bool) -> some View {
        modifier(PaneFocusModifier(focused: focused))
    }

    func unsettledPulse(_ isUnsettled: Bool) -> some View {
        modifier(UnsettledPulseModifier(isUnsettled: isUnsettled))
    }

    func mountOnlyMotion(duration: TimeInterval, rise: CGFloat = 4) -> some View {
        modifier(MountOnlyMotionModifier(duration: duration, rise: rise))
    }
}

private struct UnsettledPulseModifier: ViewModifier {
    let isUnsettled: Bool

    @Environment(\.gdmReduceMotion) private var reduceMotion
    @State private var dimmed = false

    func body(content: Content) -> some View {
        content
            .opacity(dimmed ? 0.4 : 1)
            .onAppear { updatePulse() }
            .onChange(of: isUnsettled) { _, _ in updatePulse() }
            .onChange(of: reduceMotion) { _, _ in updatePulse() }
    }

    private func updatePulse() {
        let shouldPulse = MotionPolicy.allowsPulse(
            isUnsettled: isUnsettled,
            reduceMotion: reduceMotion
        )
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) { dimmed = false }
        guard shouldPulse else { return }

        DispatchQueue.main.async {
            guard MotionPolicy.allowsPulse(
                isUnsettled: isUnsettled,
                reduceMotion: reduceMotion
            ) else { return }
            withAnimation(MotionAnimations.pulse(isUnsettled: true, reduceMotion: false)) {
                dimmed = true
            }
        }
    }
}

private struct MountOnlyMotionModifier: ViewModifier {
    let duration: TimeInterval
    let rise: CGFloat

    @Environment(\.gdmReduceMotion) private var reduceMotion
    @State private var isMounted = false

    func body(content: Content) -> some View {
        content
            .opacity(isMounted ? 1 : 0)
            .offset(y: isMounted ? 0 : rise)
            .transaction { transaction in
                if reduceMotion {
                    transaction.animation = nil
                    transaction.disablesAnimations = true
                }
            }
            .onAppear {
                guard !reduceMotion else {
                    completeWithoutMotion()
                    return
                }
                DispatchQueue.main.async {
                    guard !reduceMotion else {
                        completeWithoutMotion()
                        return
                    }
                    withAnimation(MotionAnimations.mount(duration: duration, reduceMotion: false)) {
                        isMounted = true
                    }
                }
            }
            .onChange(of: reduceMotion) { _, isEnabled in
                if isEnabled { completeWithoutMotion() }
            }
    }

    private func completeWithoutMotion() {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) { isMounted = true }
    }
}

struct EmptyWorkspaceView: View {
    let onNewTask: () -> Void

    var body: some View {
        VStack(spacing: DesignTokens.space4) {
            Text("○")
                .font(.system(size: DesignTokens.titleSize * 2, design: .monospaced))
                .foregroundStyle(DesignTokens.textTertiary)
            Text("아직 gdm 작업이 없습니다")
                .font(.system(size: DesignTokens.titleSize, weight: .semibold))
                .foregroundStyle(DesignTokens.textStrong)
                .accessibilityAddTraits(.isHeader)
            Text("작업 계약을 만들면 agent, 검증 기록, diff가 한 worktree에 묶입니다.")
                .font(.system(size: DesignTokens.bodySize))
                .foregroundStyle(DesignTokens.textSecondary)
                .multilineTextAlignment(.center)
            VStack(alignment: .leading, spacing: DesignTokens.space2) {
                quickStartStep("1", "새 작업과 완료 조건을 만듭니다")
                quickStartStep("2", "Codex·Claude·Gemini가 검증 항목을 제안합니다")
                quickStartStep("3", "승인 후 ⌘R로 실행하고 Proof를 확인합니다")
            }
            .padding(DesignTokens.space3)
            .background(DesignTokens.surfacePanel)
            .overlay {
                RoundedRectangle(cornerRadius: DesignTokens.controlRadius)
                    .stroke(DesignTokens.lineControl, lineWidth: 1)
            }
            Button("새 작업 만들기  ⌘N", action: onNewTask)
                .buttonStyle(OperationalButtonStyle(emphasized: true))
                .accessibilityLabel("새 작업 만들기")
                .accessibilityHint("Command N")
        }
        .padding(DesignTokens.space5)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DesignTokens.surfaceTerminal)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Gidem 처음 시작하기")
    }

    private func quickStartStep(_ number: String, _ detail: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: DesignTokens.space3) {
            Text(number)
                .font(.system(size: DesignTokens.metaSize, weight: .semibold, design: .monospaced))
                .foregroundStyle(DesignTokens.active)
            Text(detail)
                .font(.system(size: DesignTokens.bodySize))
                .foregroundStyle(DesignTokens.textPrimary)
        }
        .accessibilityElement(children: .combine)
    }
}
