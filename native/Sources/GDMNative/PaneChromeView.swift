import SwiftUI

struct PaneChromeView<Content: View>: View {
    let leaf: PaneLeafRecord
    let focused: Bool
    let canClose: Bool
    let onFocus: () -> Void
    let onChangeContent: (PaneContentChoice) -> Void
    let onSplit: (PaneSplitAxis) -> Void
    let onClose: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader {
                ViewThatFits(in: .horizontal) {
                    expandedHeader
                    compactHeader
                }
            }

            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(DesignTokens.surfaceTerminal)
        .clipped()
        .contentShape(Rectangle())
        .simultaneousGesture(TapGesture().onEnded(onFocus))
        .paneFocused(focused)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(leaf.content.title) pane")
        .accessibilityAddTraits(focused ? [.isSelected] : [])
    }

    private var expandedHeader: some View {
        HStack(spacing: DesignTokens.space3) {
            title
            Spacer(minLength: DesignTokens.space2)
            contentMenu(compact: false)
            splitRightButton
            splitDownButton
            closeButton
        }
    }

    private var compactHeader: some View {
        HStack(spacing: DesignTokens.space2) {
            title
            Spacer(minLength: DesignTokens.space2)
            contentMenu(compact: true)
            closeButton
        }
    }

    private var title: some View {
        Text(leaf.content.title)
            .font(.system(size: DesignTokens.metaSize, weight: .medium, design: .monospaced))
            .foregroundStyle(DesignTokens.textStrong)
            .lineLimit(1)
            .truncationMode(.middle)
    }

    private var splitRightButton: some View {
        paneButton(
            systemName: "rectangle.split.2x1",
            label: "오른쪽으로 pane 분할",
            help: "오른쪽 분할 · ⌘D · ⌃G S L"
        ) { onSplit(.horizontal) }
    }

    private var splitDownButton: some View {
        paneButton(
            systemName: "rectangle.split.1x2",
            label: "아래로 pane 분할",
            help: "아래 분할 · ⇧⌘D · ⌃G S J"
        ) { onSplit(.vertical) }
    }

    private var closeButton: some View {
        paneButton(
            systemName: "xmark",
            label: "pane 닫기",
            help: "Pane 닫기 · ⇧⌘K · ⌃G X",
            disabled: !canClose,
            action: onClose
        )
    }

    private func contentMenu(compact: Bool) -> some View {
        Menu {
            ForEach(PaneContentChoice.allCases) { choice in
                Button {
                    onChangeContent(choice)
                } label: {
                    Label(choice.title, systemImage: choice.systemImage)
                }
            }
            if compact {
                Divider()
                Button {
                    onSplit(.horizontal)
                } label: {
                    Label("오른쪽으로 pane 분할", systemImage: "rectangle.split.2x1")
                }
                Button {
                    onSplit(.vertical)
                } label: {
                    Label("아래로 pane 분할", systemImage: "rectangle.split.1x2")
                }
            }
        } label: {
            Image(systemName: compact ? "ellipsis.circle" : "square.grid.2x2")
                .font(.system(size: DesignTokens.metaSize, weight: .medium))
                .frame(
                    minWidth: DesignTokens.controlMinimumHeight,
                    minHeight: DesignTokens.controlMinimumHeight
                )
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help(compact ? "Pane 작업" : "Pane 내용 선택")
        .accessibilityLabel(compact ? "Pane 작업" : "Pane 내용 선택")
    }

    @ViewBuilder
    private func paneButton(
        systemName: String,
        label: String,
        help: String,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: DesignTokens.metaSize, weight: .medium))
                .frame(
                    minWidth: DesignTokens.controlMinimumHeight,
                    minHeight: DesignTokens.controlMinimumHeight
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(disabled ? DesignTokens.textDisabled : DesignTokens.textSecondary)
        .disabled(disabled)
        .fixedSize()
        .help(help)
        .accessibilityLabel(label)
    }
}
