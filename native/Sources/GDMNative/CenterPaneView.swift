import SwiftUI

enum WorkbenchPresentation {
    static func shouldUseTabs(
        compact: Bool,
        availableWidth: Double,
        availableHeight: Double,
        requiredWidth: Double,
        requiredHeight: Double
    ) -> Bool {
        compact || availableWidth < requiredWidth || availableHeight < requiredHeight
    }
}

struct CenterPaneView: View {
    @ObservedObject var store: WorkspaceStore
    @ObservedObject private var workbench: WorkbenchState
    let compact: Bool

    init(store: WorkspaceStore, compact: Bool) {
        self.store = store
        self.compact = compact
        _workbench = ObservedObject(wrappedValue: store.workbench)
    }

    var body: some View {
        GeometryReader { geometry in
            let readablePaneWidth = max(
                DesignTokens.paneMinimumWidth,
                DesignTokens.paletteWidth / 2
            )
            let minimum = workbench.layout.root.minimumPresentationSize(
                paneWidth: Double(readablePaneWidth),
                paneHeight: Double(DesignTokens.paneMinimumHeight),
                divider: Double(DesignTokens.splitDividerHitSize)
            )
            let constrained = WorkbenchPresentation.shouldUseTabs(
                compact: compact,
                availableWidth: Double(geometry.size.width),
                availableHeight: Double(geometry.size.height),
                requiredWidth: minimum.width,
                requiredHeight: minimum.height
            )

            VStack(spacing: 0) {
                if constrained {
                    CompactWorkbenchTabs(
                        leaves: workbench.layout.root.presentationLeaves,
                        focusedPaneID: workbench.focusedPaneID,
                        onSelect: store.focusPane
                    )
                    if let leaf = workbench.layout.focusedLeaf {
                        splitContainer(node: .leaf(leaf))
                    }
                } else {
                    splitContainer(node: workbench.layout.root)
                }
            }
            .onAppear {
                workbench.setSplitMeasurementsEnabled(!constrained)
            }
            .onChange(of: constrained) { _, value in
                workbench.setSplitMeasurementsEnabled(!value)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(accessibilityLayoutSummary)
            .accessibilityIdentifier("gidem.workbench.layout")
        }
        .background(DesignTokens.surfaceTerminal)
    }

    private var accessibilityLayoutSummary: String {
        let paneIDs = workbench.layout.root.presentationLeaves.map(\.id)
        let focus = paneIDs.firstIndex(of: workbench.focusedPaneID).map { $0 + 1 } ?? 0
        return "Workbench layout, \(paneIDs.count) panes, focus \(focus)"
    }

    private func splitContainer(node: PaneNode) -> some View {
        SplitContainerView(
            node: node,
            focusedPaneID: workbench.focusedPaneID,
            canClosePane: store.canCloseFocusedPane,
            onFocus: store.focusPane,
            onChangeContent: { paneID, choice in
                store.showContent(choice.content(agent: store.selectedAgent), in: paneID)
            },
            onSplit: store.splitPane,
            onClose: store.closePane,
            onResize: store.resizePane,
            onMeasureSplit: store.recordPaneSplitMeasurement,
            leafContent: { AnyView(WorkbenchPaneContent(store: store, workbench: workbench, leaf: $0)) }
        )
    }
}

private struct CompactWorkbenchTabs: View {
    let leaves: [PaneLeafRecord]
    let focusedPaneID: UUID
    let onSelect: (UUID) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(leaves) { leaf in
                    Button { onSelect(leaf.id) } label: {
                        Text(leaf.content.title)
                            .font(.system(size: DesignTokens.metaSize, design: .monospaced))
                            .foregroundStyle(
                                leaf.id == focusedPaneID
                                    ? DesignTokens.textStrong
                                    : DesignTokens.textTertiary
                            )
                            .padding(.horizontal, DesignTokens.space3)
                            .frame(minHeight: DesignTokens.paneHeaderHeight)
                            .overlay(alignment: .bottom) {
                                if leaf.id == focusedPaneID {
                                    Rectangle()
                                        .fill(DesignTokens.active)
                                        .frame(height: DesignTokens.focusRingWidth)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(leaf.content.title) pane 열기")
                    .accessibilityValue(leaf.id == focusedPaneID ? "선택됨" : "")
                    .accessibilityAddTraits(leaf.id == focusedPaneID ? [.isSelected] : [])
                }
            }
        }
        .background(DesignTokens.surfaceBar)
        .overlay(alignment: .bottom) { TokenDivider() }
    }
}

private struct WorkbenchPaneContent: View {
    @ObservedObject var store: WorkspaceStore
    @ObservedObject var workbench: WorkbenchState
    let leaf: PaneLeafRecord

    @ViewBuilder
    var body: some View {
        switch leaf.content {
        case .files:
            FileTreeView(
                rootName: store.selectedTask?.workingDirectory.lastPathComponent ?? store.repositoryName,
                entries: workbench.fileEntries,
                selectedPath: workbench.editorStore?.activePath,
                errorMessage: workbench.fileErrorMessage,
                isIndexing: workbench.isIndexingFiles,
                onOpen: store.openFile,
                onReload: workbench.reloadFiles
            )
        case .editor(let editor):
            let path = editor.selectedTab?.relativePath
            EditorPaneView(
                tabs: editor.tabs.map { tab in
                    EditorTabItem(
                        id: tab.id,
                        relativePath: tab.relativePath,
                        isDirty: workbench.editorStore?.buffers[tab.relativePath]?.isDirty == true
                    )
                },
                selectedTabID: editor.selectedTabID,
                buffer: path.flatMap { workbench.editorStore?.buffers[$0] },
                isSaving: false,
                errorMessage: workbench.fileErrorMessage,
                onSelectTab: { workbench.selectEditorTab(paneID: leaf.id, tabID: $0) },
                onCloseTab: { _ = workbench.closeEditorTab(paneID: leaf.id, tabID: $0) },
                onTextChange: { text in
                    guard let path else { return }
                    Task { @MainActor in workbench.updateEditorText(text, path: path) }
                },
                onSave: {
                    guard let path else { return }
                    workbench.save(path: path)
                    store.refreshAfterFileMutation()
                },
                onReload: {
                    guard let path else { return }
                    workbench.reload(path: path)
                },
                onOverwrite: {
                    guard let path else { return }
                    workbench.save(path: path, overwrite: true)
                    store.refreshAfterFileMutation()
                }
            )
        case .terminal(let terminal):
            TerminalHostView(store: store, laneID: terminal.laneID)
        case .diff:
            WorkbenchTextPane(text: store.diffText, accessibilityLabel: "Git diff")
        case .logs:
            WorkbenchTextPane(text: store.consoleText, accessibilityLabel: "작업 logs")
        case .evidence:
            WorkbenchTextPane(text: store.selectedEvidenceText, accessibilityLabel: "검증 evidence")
        case .proof:
            ProofRailView(store: store, compact: true)
        }
    }
}

private struct WorkbenchTextPane: View {
    let text: String
    let accessibilityLabel: String

    var body: some View {
        GeometryReader { geometry in
            ScrollView([.horizontal, .vertical]) {
                Text(text.isEmpty ? "표시할 내용이 없습니다." : text)
                    .font(.system(size: DesignTokens.terminalSize, design: .monospaced))
                    .foregroundStyle(DesignTokens.textPrimary)
                    .textSelection(.enabled)
                    .padding(DesignTokens.space3)
                    .frame(minWidth: geometry.size.width, alignment: .topLeading)
            }
        }
        .background(DesignTokens.surfaceStatusBar)
        .accessibilityLabel(accessibilityLabel)
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
                    .accessibilityLabel("\(tabTitle(tab)) 탭")
                    .accessibilityValue(store.selectedDrawerTab == tab ? "선택됨" : "")
                    .accessibilityAddTraits(store.selectedDrawerTab == tab ? [.isSelected] : [])
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
