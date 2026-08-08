import SwiftUI

struct CenterPaneView: View {
    @ObservedObject var store: WorkspaceStore
    let compact: Bool
    @Environment(\.gdmReduceMotion) private var reduceMotion
    @State private var displayedPane: CompactPane = .terminal
    @State private var paneOpacity = 1.0
    @State private var paneGeneration = 0

    var body: some View {
        VStack(spacing: 0) {
            if compact {
                CompactPaneTabs(store: store)
                Group {
                    switch displayedPane {
                    case .terminal:
                        TerminalHostView(store: store)
                    case .proof:
                        ProofRailView(store: store, compact: true)
                    case .drawer:
                        DrawerView(store: store, fillsAvailableSpace: true)
                    }
                }
                .opacity(paneOpacity)
            } else {
                TerminalHostView(store: store)
                DrawerView(store: store, fillsAvailableSpace: false)
                    .frame(height: DesignTokens.drawerHeight)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DesignTokens.surfaceTerminal)
        .onAppear { commitPane(store.compactPane) }
        .onChange(of: store.compactPane) { _, newPane in
            transition(to: newPane)
        }
        .onChange(of: reduceMotion) { _, isEnabled in
            if isEnabled {
                paneGeneration += 1
                commitPane(store.compactPane)
            }
        }
    }

    private func transition(to pane: CompactPane) {
        paneGeneration += 1
        let currentGeneration = paneGeneration

        guard !reduceMotion, compact, displayedPane != pane else {
            commitPane(pane)
            return
        }

        withAnimation(MotionAnimations.fadeOut(reduceMotion: false)) {
            paneOpacity = 0
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + MotionTokens.fadeOut) {
            guard paneGeneration == currentGeneration else { return }
            commitPane(pane, opacity: 0)
            withAnimation(MotionAnimations.fadeIn(reduceMotion: false)) {
                paneOpacity = 1
            }
        }
    }

    private func commitPane(_ pane: CompactPane, opacity: Double = 1) {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            displayedPane = pane
            paneOpacity = opacity
        }
    }
}

private struct CompactPaneTabs: View {
    @ObservedObject var store: WorkspaceStore
    @Environment(\.gdmReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            ForEach(CompactPane.allCases, id: \.self) { pane in
                Button {
                    store.compactPane = pane
                } label: {
                    HStack(spacing: DesignTokens.space1) {
                        Text(pane.rawValue)
                        if pane == .proof, !(store.selectedWork?.blockers.isEmpty ?? true) {
                            Text("●").foregroundStyle(DesignTokens.blocked)
                        }
                    }
                    .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                    .foregroundStyle(store.compactPane == pane ? DesignTokens.textStrong : DesignTokens.textTertiary)
                    .padding(.horizontal, DesignTokens.space3)
                    .frame(minHeight: DesignTokens.paneHeaderHeight)
                    .overlay(alignment: .bottom) {
                        if store.compactPane == pane {
                            Rectangle().fill(DesignTokens.active).frame(height: 2)
                        }
                    }
                }
                .buttonStyle(.plain)
                .animation(
                    MotionAnimations.fadeIn(reduceMotion: reduceMotion),
                    value: store.compactPane == pane
                )
            }
            Spacer()
        }
        .background(DesignTokens.surfaceBar)
        .overlay(alignment: .bottom) { TokenDivider() }
    }
}

struct DrawerView: View {
    @ObservedObject var store: WorkspaceStore
    let fillsAvailableSpace: Bool
    @Environment(\.gdmReduceMotion) private var reduceMotion
    @State private var displayedTab: DrawerTab = .diff
    @State private var bodyOpacity = 1.0
    @State private var bodyGeneration = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(DrawerTab.allCases, id: \.self) { tab in
                    Button {
                        store.setDrawer(tab)
                    } label: {
                        Text(tabTitle(tab))
                            .font(.system(size: DesignTokens.metaSize, weight: store.selectedDrawerTab == tab ? .medium : .regular, design: .monospaced))
                            .foregroundStyle(store.selectedDrawerTab == tab ? DesignTokens.textStrong : DesignTokens.textTertiary)
                            .padding(.horizontal, DesignTokens.space3)
                            .frame(minHeight: DesignTokens.paneHeaderHeight)
                            .overlay(alignment: .bottom) {
                                if store.selectedDrawerTab == tab {
                                    Rectangle().fill(DesignTokens.active).frame(height: 2)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .animation(
                        MotionAnimations.fadeIn(reduceMotion: reduceMotion),
                        value: store.selectedDrawerTab == tab
                    )
                    .keyboardShortcut(KeyEquivalent(Character("\(DrawerTab.allCases.firstIndex(of: tab)! + 1)")), modifiers: .command)
                }
                Spacer()
                Text("⌘1  ⌘2  ⌘3")
                    .font(.system(size: DesignTokens.labelSize, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
                    .padding(.trailing, DesignTokens.space3)
            }
            .background(DesignTokens.surfaceBar)
            .overlay(alignment: .bottom) { TokenDivider() }

            GeometryReader { geometry in
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: DesignTokens.space1) {
                        ForEach(Array(drawerText.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                            DrawerLine(text: String(line), tab: displayedTab)
                        }
                    }
                    .padding(DesignTokens.space3)
                    .frame(minWidth: geometry.size.width, alignment: .leading)
                }
                .opacity(bodyOpacity)
            }
        }
        .frame(maxHeight: fillsAvailableSpace ? .infinity : DesignTokens.drawerHeight)
        .background(DesignTokens.surfaceStatusBar)
        .overlay(alignment: .top) {
            Rectangle().fill(DesignTokens.lineStructure).frame(height: 1)
        }
        .contentShape(Rectangle())
        .onTapGesture { store.focusedRegion = .drawer }
        .paneFocused(store.focusedRegion == .drawer)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("변경과 증거 서랍")
        .onAppear { commitTab(store.selectedDrawerTab) }
        .onChange(of: store.selectedDrawerTab) { _, newTab in
            transition(to: newTab)
        }
        .onChange(of: reduceMotion) { _, isEnabled in
            if isEnabled {
                bodyGeneration += 1
                commitTab(store.selectedDrawerTab)
            }
        }
    }

    private var drawerText: String {
        switch displayedTab {
        case .diff: store.diffText
        case .logs: store.journalText
        case .evidence: store.selectedEvidenceText
        }
    }

    private func transition(to tab: DrawerTab) {
        bodyGeneration += 1
        let currentGeneration = bodyGeneration

        guard !reduceMotion, displayedTab != tab else {
            commitTab(tab)
            return
        }

        withAnimation(MotionAnimations.fadeOut(reduceMotion: false)) {
            bodyOpacity = 0
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + MotionTokens.fadeOut) {
            guard bodyGeneration == currentGeneration else { return }
            commitTab(tab, opacity: 0)
            withAnimation(MotionAnimations.fadeIn(reduceMotion: false)) {
                bodyOpacity = 1
            }
        }
    }

    private func commitTab(_ tab: DrawerTab, opacity: Double = 1) {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            displayedTab = tab
            bodyOpacity = opacity
        }
    }

    private func tabTitle(_ tab: DrawerTab) -> String {
        switch tab {
        case .diff: "DIFF"
        case .logs: "LOGS"
        case .evidence: "EVIDENCE · \(store.selectedWork?.checks.filter { $0.evidence != nil || $0.redEvidence != nil }.count ?? 0)"
        }
    }
}

private struct DrawerLine: View {
    let text: String
    let tab: DrawerTab

    private var foreground: Color {
        guard tab == .diff else { return DesignTokens.textSecondary }
        if text.hasPrefix("+") { return DesignTokens.proven }
        if text.hasPrefix("-") { return DesignTokens.blocked }
        if text.hasPrefix("@@") { return DesignTokens.textTertiary }
        return DesignTokens.textSecondary
    }

    var body: some View {
        Text(text.isEmpty ? " " : text)
            .font(.system(size: DesignTokens.rowSize, design: .monospaced))
            .foregroundStyle(foreground)
            .textSelection(.enabled)
            .fixedSize(horizontal: true, vertical: false)
    }
}
