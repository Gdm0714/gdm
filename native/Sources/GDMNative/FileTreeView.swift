import SwiftUI

struct FileTreeView: View {
    let rootName: String
    let entries: [WorktreeFileEntry]
    let selectedPath: String?
    let errorMessage: String?
    let isIndexing: Bool
    let onOpen: (String) -> Void
    let onReload: () -> Void

    @State private var collapsedDirectories: Set<String> = []

    private var visibleEntries: [WorktreeFileEntry] {
        entries.filter { entry in
            !collapsedDirectories.contains { directory in
                entry.relativePath != directory
                    && entry.relativePath.hasPrefix(directory + "/")
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader {
                SectionLabel(title: rootName)
                Spacer()
                if isIndexing {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("파일 목록 읽는 중")
                }
                Button(action: onReload) {
                    Text("↻")
                        .font(.system(size: DesignTokens.bodySize, design: .monospaced))
                }
                .buttonStyle(OperationalButtonStyle())
                .accessibilityLabel("파일 트리 새로고침")
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: DesignTokens.metaSize))
                    .foregroundStyle(DesignTokens.blocked)
                    .padding(DesignTokens.space3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(visibleEntries) { entry in
                        FileTreeRow(
                            entry: entry,
                            selected: entry.relativePath == selectedPath,
                            collapsed: collapsedDirectories.contains(entry.relativePath),
                            onToggleDirectory: toggleDirectory,
                            onOpen: onOpen
                        )
                    }
                }
            }
        }
        .background(DesignTokens.surfacePanel)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("파일 트리")
        .onChange(of: entries) { _, entries in
            let directories = Set(entries.lazy.filter { $0.kind == .directory }.map(\.relativePath))
            collapsedDirectories.formIntersection(directories)
        }
    }

    private func toggleDirectory(_ path: String) {
        if collapsedDirectories.contains(path) {
            collapsedDirectories.remove(path)
        } else {
            collapsedDirectories.insert(path)
        }
    }
}

private struct FileTreeRow: View {
    let entry: WorktreeFileEntry
    let selected: Bool
    let collapsed: Bool
    let onToggleDirectory: (String) -> Void
    let onOpen: (String) -> Void

    @State private var hovering = false

    var body: some View {
        Button {
            if entry.kind == .directory {
                onToggleDirectory(entry.relativePath)
            } else {
                onOpen(entry.relativePath)
            }
        } label: {
            HStack(spacing: DesignTokens.space2) {
                Image(systemName: iconName)
                    .font(.system(size: DesignTokens.metaSize, weight: .medium))
                    .foregroundStyle(DesignTokens.textTertiary)
                    .frame(width: DesignTokens.space3)
                Text(entry.name)
                    .font(.system(size: DesignTokens.rowSize, design: .monospaced))
                    .foregroundStyle(selected ? DesignTokens.textStrong : DesignTokens.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .padding(.leading, CGFloat(max(0, entry.depth - 1)) * DesignTokens.fileTreeIndent)
            .padding(.horizontal, DesignTokens.space2)
            .frame(maxWidth: .infinity, minHeight: DesignTokens.rowHeight, alignment: .leading)
            .background(
                selected
                    ? DesignTokens.surfaceSelected
                    : (hovering ? DesignTokens.surfaceHover : DesignTokens.surfacePanel)
            )
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) { TokenDivider() }
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(
            entry.kind == .directory
                ? "폴더 \(entry.relativePath)"
                : "파일 \(entry.relativePath)"
        )
    }

    private var iconName: String {
        guard entry.kind == .directory else { return "doc.text" }
        return collapsed ? "chevron.right" : "chevron.down"
    }
}
