import SwiftUI

struct EditorPaneView: View {
    let tabs: [EditorTabItem]
    let selectedTabID: UUID?
    let buffer: EditorBuffer?
    let isSaving: Bool
    let errorMessage: String?
    let onSelectTab: (UUID) -> Void
    let onCloseTab: (UUID) -> Void
    let onTextChange: @Sendable (String) -> Void
    let onSave: () -> Void
    let onReload: () -> Void
    let onOverwrite: () -> Void

    init(
        tabs: [EditorTabItem] = [],
        selectedTabID: UUID? = nil,
        buffer: EditorBuffer?,
        isSaving: Bool,
        errorMessage: String?,
        onSelectTab: @escaping (UUID) -> Void = { _ in },
        onCloseTab: @escaping (UUID) -> Void = { _ in },
        onTextChange: @escaping @Sendable (String) -> Void,
        onSave: @escaping () -> Void,
        onReload: @escaping () -> Void,
        onOverwrite: @escaping () -> Void
    ) {
        self.tabs = tabs
        self.selectedTabID = selectedTabID
        self.buffer = buffer
        self.isSaving = isSaving
        self.errorMessage = errorMessage
        self.onSelectTab = onSelectTab
        self.onCloseTab = onCloseTab
        self.onTextChange = onTextChange
        self.onSave = onSave
        self.onReload = onReload
        self.onOverwrite = onOverwrite
    }

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader {
                if tabs.isEmpty {
                    Text(buffer?.relativePath ?? "NO FILE")
                        .font(.system(
                            size: DesignTokens.metaSize,
                            weight: .medium,
                            design: .monospaced
                        ))
                        .foregroundStyle(buffer == nil ? DesignTokens.textTertiary : DesignTokens.textStrong)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if buffer?.isDirty == true {
                        Text("●")
                            .foregroundStyle(DesignTokens.attention)
                            .accessibilityLabel("저장하지 않은 변경 있음")
                    }
                } else {
                    EditorTabStrip(
                        tabs: tabs,
                        selectedTabID: selectedTabID,
                        onSelect: onSelectTab,
                        onClose: onCloseTab
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                Spacer(minLength: DesignTokens.space2)
                Button("Reload", action: onReload)
                    .buttonStyle(OperationalButtonStyle())
                    .disabled(buffer == nil || isSaving)
                Button(isSaving ? "Saving…" : "Save", action: onSave)
                    .buttonStyle(OperationalButtonStyle(emphasized: buffer?.isDirty == true))
                    .disabled(buffer?.isDirty != true || isSaving)
            }

            if let conflict = buffer?.conflictMessage {
                EditorConflictBar(
                    message: conflict,
                    onReload: onReload,
                    onOverwrite: onOverwrite
                )
            } else if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: DesignTokens.metaSize))
                    .foregroundStyle(DesignTokens.blocked)
                    .padding(.horizontal, DesignTokens.space3)
                    .frame(maxWidth: .infinity, minHeight: DesignTokens.rowHeight, alignment: .leading)
                    .background(DesignTokens.surfaceStatusBar)
                    .overlay(alignment: .bottom) { TokenDivider() }
            }

            if let buffer {
                TextEditor(text: Binding(
                    get: { buffer.text },
                    set: onTextChange
                ))
                .font(.system(size: DesignTokens.terminalSize, design: .monospaced))
                .foregroundStyle(DesignTokens.textPrimary)
                .scrollContentBackground(.hidden)
                .padding(DesignTokens.space3)
                .background(DesignTokens.surfaceTerminal)
                .accessibilityLabel("\(buffer.relativePath) 편집기")
            } else {
                Text("파일 트리에서 UTF-8 텍스트 파일을 선택하세요.")
                    .font(.system(size: DesignTokens.bodySize))
                    .foregroundStyle(DesignTokens.textSecondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(DesignTokens.space4)
                    .background(DesignTokens.surfaceTerminal)
            }
        }
        .background(DesignTokens.surfaceTerminal)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("파일 편집기")
    }
}

private struct EditorConflictBar: View {
    let message: String
    let onReload: () -> Void
    let onOverwrite: () -> Void

    var body: some View {
        HStack(spacing: DesignTokens.space2) {
            SignalMarker(glyph: "!", label: "DISK CONFLICT", tone: .blocked)
            Text(message)
                .font(.system(size: DesignTokens.metaSize))
                .foregroundStyle(DesignTokens.textSecondary)
                .lineLimit(2)
            Spacer(minLength: DesignTokens.space2)
            Button("Reload", action: onReload)
                .buttonStyle(OperationalButtonStyle())
            Button("Overwrite", action: onOverwrite)
                .buttonStyle(OperationalButtonStyle(emphasis: .active))
        }
        .padding(.horizontal, DesignTokens.space3)
        .frame(minHeight: DesignTokens.rowHeight)
        .background(DesignTokens.surfaceStatusBar)
        .overlay(alignment: .bottom) { TokenDivider() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("디스크 파일 변경 충돌")
    }
}
