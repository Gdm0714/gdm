import Foundation
import SwiftUI

struct EditorTabItem: Identifiable, Equatable, Sendable {
    let id: UUID
    let relativePath: String
    let isDirty: Bool
}

/// A presentation-only tab strip. Selection and close behavior stay with the
/// workbench owner so this view cannot bypass dirty-buffer policy.
struct EditorTabStrip: View {
    let tabs: [EditorTabItem]
    let selectedTabID: UUID?
    let onSelect: (UUID) -> Void
    let onClose: (UUID) -> Void

    @Environment(\.gdmReduceMotion) private var reduceMotion

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: DesignTokens.space1) {
                    ForEach(tabs) { tab in
                        EditorTabButton(
                            tab: tab,
                            title: displayTitle(for: tab),
                            selected: tab.id == selectedTabID,
                            onSelect: onSelect,
                            onClose: onClose
                        )
                        .id(tab.id)
                    }
                }
                .frame(minWidth: 0, alignment: .leading)
            }
            .onAppear { revealSelection(using: proxy, animated: false) }
            .onChange(of: selectedTabID) { _, _ in
                revealSelection(using: proxy, animated: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("열린 파일 탭")
    }

    private func displayTitle(for tab: EditorTabItem) -> String {
        let components = tab.relativePath.split(separator: "/").map(String.init)
        guard let leaf = components.last else { return tab.relativePath }
        let duplicateCount = tabs.lazy.filter {
            $0.relativePath.split(separator: "/").last.map(String.init) == leaf
        }.count
        guard duplicateCount > 1, components.count > 1 else { return leaf }
        return "\(components[components.count - 2])/\(leaf)"
    }

    private func revealSelection(using proxy: ScrollViewProxy, animated: Bool) {
        guard let selectedTabID else { return }
        let action = { proxy.scrollTo(selectedTabID, anchor: .center) }
        if animated {
            withAnimation(MotionAnimations.state(reduceMotion: reduceMotion), action)
        } else {
            action()
        }
    }
}

private struct EditorTabButton: View {
    let tab: EditorTabItem
    let title: String
    let selected: Bool
    let onSelect: (UUID) -> Void
    let onClose: (UUID) -> Void

    @Environment(\.gdmReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 0) {
            Button {
                onSelect(tab.id)
            } label: {
                HStack(spacing: DesignTokens.space2) {
                    if tab.isDirty {
                        Circle()
                            .fill(DesignTokens.attention)
                            .frame(width: DesignTokens.space1, height: DesignTokens.space1)
                            .accessibilityHidden(true)
                    }
                    Text(title)
                        .font(.system(
                            size: DesignTokens.metaSize,
                            weight: selected ? .semibold : .regular,
                            design: .monospaced
                        ))
                        .foregroundStyle(selected ? DesignTokens.textStrong : DesignTokens.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .padding(.leading, DesignTokens.space2)
                .padding(.trailing, tab.isDirty ? DesignTokens.space1 : DesignTokens.space2)
                .frame(minHeight: DesignTokens.controlMinimumHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(tab.relativePath)
            .accessibilityLabel("\(tab.relativePath)\(tab.isDirty ? ", 저장하지 않은 변경 있음" : "")")
            .accessibilityAddTraits(selected ? [.isSelected] : [])

            Button {
                onClose(tab.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: DesignTokens.metaSize, weight: .medium))
                    .foregroundStyle(hovering || selected ? DesignTokens.textSecondary : DesignTokens.textTertiary)
                    .frame(
                        minWidth: DesignTokens.controlMinimumHeight,
                        minHeight: DesignTokens.controlMinimumHeight
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("\(tab.relativePath) 닫기")
            .accessibilityLabel("\(tab.relativePath) 탭 닫기")
        }
        .background(background)
        .overlay(alignment: .bottom) {
            if selected {
                Rectangle()
                    .fill(DesignTokens.active)
                    .frame(height: DesignTokens.focusRingWidth)
                    .accessibilityHidden(true)
            }
        }
        .onHover { hovering = $0 }
        .animation(MotionAnimations.hover(reduceMotion: reduceMotion), value: hovering)
    }

    private var background: Color {
        if selected { return DesignTokens.surfaceSelected }
        if hovering { return DesignTokens.surfaceHover }
        return DesignTokens.surfaceBar
    }
}
