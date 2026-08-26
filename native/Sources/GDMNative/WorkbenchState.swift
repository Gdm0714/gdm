import Combine
import Foundation

@MainActor
final class WorkbenchState: ObservableObject {
    private struct SplitMeasurement {
        let length: Double
        let displayedFraction: Double
    }

    @Published private(set) var layout = PaneLayoutRecord.defaultLayout()
    @Published private(set) var fileEntries: [WorktreeFileEntry] = []
    @Published private(set) var fileErrorMessage: String?
    @Published private(set) var editorStore: EditorBufferStore?
    @Published private(set) var taskID: String?
    @Published private(set) var workingDirectory: URL?
    @Published private(set) var isIndexingFiles = false

    var onLayoutChange: ((String, PaneLayoutRecord) -> Void)?

    private var transientLayouts: [String: PaneLayoutRecord] = [:]
    private var indexTask: Task<Void, Never>?
    private var editorObservation: AnyCancellable?
    private var activationGeneration = 0
    private var splitMeasurements: [UUID: SplitMeasurement] = [:]
    private var acceptsSplitMeasurements = true

    var focusedPaneID: UUID { layout.focusedPaneID }
    var hasDirtyBuffers: Bool {
        editorStore?.buffers.values.contains(where: \.isDirty) == true
    }

    func activate(task: WorkspaceTask?, persistedLayout: PaneLayoutRecord?) {
        guard let task else {
            indexTask?.cancel()
            activationGeneration += 1
            taskID = nil
            workingDirectory = nil
            fileEntries = []
            fileErrorMessage = nil
            editorObservation = nil
            editorStore = nil
            isIndexingFiles = false
            splitMeasurements = [:]
            layout = .defaultLayout()
            return
        }

        let nextDirectory = task.workingDirectory.standardizedFileURL
        if taskID == task.id,
           workingDirectory?.standardizedFileURL == nextDirectory,
           editorStore != nil {
            // Refreshing task metadata must not recreate the editor store: doing so
            // would silently discard unsaved buffers while a verification is running.
            reloadFiles()
            return
        }

        if let currentTaskID = taskID {
            transientLayouts[currentTaskID] = layout
        }
        indexTask?.cancel()
        activationGeneration += 1
        taskID = task.id
        workingDirectory = nextDirectory
        fileEntries = []
        fileErrorMessage = nil
        isIndexingFiles = false
        splitMeasurements = [:]
        layout = normalized(
            transientLayouts[task.id]
                ?? persistedLayout
                ?? PaneLayoutRecord.defaultLayout()
        )

        do {
            let service = try WorktreeFileService(rootURL: nextDirectory)
            let nextEditorStore = EditorBufferStore(fileService: service)
            editorObservation = nextEditorStore.objectWillChange.sink { [weak self] in
                self?.objectWillChange.send()
            }
            editorStore = nextEditorStore
            fileErrorMessage = nil
            restoreSelectedEditorFiles()
            reloadFiles()
        } catch {
            editorObservation = nil
            editorStore = nil
            fileEntries = []
            fileErrorMessage = error.localizedDescription
        }
    }

    func resetRepository() {
        activate(task: nil, persistedLayout: nil)
        transientLayouts.removeAll()
    }

    func focus(_ paneID: UUID) {
        guard layout.focusedPaneID != paneID else { return }
        layout.focus(paneID)
        if case .editor(let editor) = layout.root.leaf(id: paneID)?.content,
           let path = editor.selectedTab?.relativePath {
            editorStore?.select(relativePath: path)
        }
        didChangeLayout()
    }

    func focusNext(reverse: Bool = false) {
        layout.focusNext(reverse: reverse)
        didChangeLayout()
    }

    @discardableResult
    func focus(_ target: PaneFocusTarget) -> Bool {
        let changed = layout.focus(target)
        if changed { didChangeLayout() }
        return changed
    }

    @discardableResult
    func split(
        paneID: UUID,
        axis: PaneSplitAxis,
        newPaneID: UUID = UUID(),
        content: PaneContent
    ) -> Bool {
        let changed = layout.split(
            paneID: paneID,
            axis: axis,
            newPaneID: newPaneID,
            content: content
        )
        if changed { didChangeLayout() }
        return changed
    }

    @discardableResult
    func split(
        paneID: UUID,
        direction: PaneDirection,
        newPaneID: UUID = UUID(),
        content: PaneContent
    ) -> Bool {
        let changed = layout.split(
            paneID: paneID,
            direction: direction,
            newPaneID: newPaneID,
            content: content
        )
        if changed { didChangeLayout() }
        return changed
    }

    @discardableResult
    func close(paneID: UUID) -> Bool {
        let changed = layout.close(paneID: paneID)
        if changed { didChangeLayout() }
        return changed
    }

    @discardableResult
    func resize(splitID: UUID, fraction: Double) -> Bool {
        let changed = layout.resize(splitID: splitID, fraction: fraction)
        if changed { didChangeLayout() }
        return changed
    }

    @discardableResult
    func resizeFocused(direction: PaneDirection, amount: UInt16) -> Bool {
        guard let split = layout.nearestResizeSplit(direction: direction),
              acceptsSplitMeasurements,
              let measurement = splitMeasurements[split.id] else { return false }
        let changed = layout.resizeFocused(
            direction: direction,
            amount: amount,
            splitLength: measurement.length,
            displayedFraction: measurement.displayedFraction
        )
        if changed { didChangeLayout() }
        return changed
    }

    func recordSplitMeasurement(
        splitID: UUID,
        length: Double,
        displayedFraction: Double
    ) {
        guard length.isFinite, length > 0,
              displayedFraction.isFinite else { return }
        splitMeasurements[splitID] = SplitMeasurement(
            length: length,
            displayedFraction: displayedFraction
        )
    }

    func setSplitMeasurementsEnabled(_ enabled: Bool) {
        acceptsSplitMeasurements = enabled
        if !enabled { splitMeasurements = [:] }
    }

    @discardableResult
    func equalizeSplits() -> Bool {
        let changed = layout.equalizeSplits()
        if changed { didChangeLayout() }
        return changed
    }

    @discardableResult
    func replaceContent(paneID: UUID, with content: PaneContent) -> Bool {
        let changed = layout.updateContent(paneID: paneID) { $0 = content }
        if changed { didChangeLayout() }
        return changed
    }

    func reloadFiles() {
        guard let service = editorStore?.fileService,
              let activeTaskID = taskID else { return }
        indexTask?.cancel()
        activationGeneration += 1
        let generation = activationGeneration
        isIndexingFiles = true
        indexTask = Task { [weak self] in
            let result = await Task.detached(priority: .userInitiated) {
                Result { try service.indexFiles() }
            }.value
            guard let self,
                  !Task.isCancelled,
                  generation == self.activationGeneration,
                  activeTaskID == self.taskID else { return }
            self.isIndexingFiles = false
            switch result {
            case .success(let entries):
                self.fileEntries = entries
                self.fileErrorMessage = nil
            case .failure(let error):
                self.fileEntries = []
                self.fileErrorMessage = error.localizedDescription
            }
        }
    }

    func openFile(relativePath: String, preferredPaneID: UUID? = nil) {
        guard let editorStore else { return }
        do {
            _ = try editorStore.open(relativePath: relativePath)
            let paneID = ensureEditorPane(preferredPaneID: preferredPaneID)
            _ = layout.updateContent(paneID: paneID) { content in
                var editor: EditorPaneState
                if case .editor(let existing) = content {
                    editor = existing
                } else {
                    editor = EditorPaneState()
                }
                editor.open(relativePath: relativePath)
                content = .editor(editor)
            }
            layout.focus(paneID)
            fileErrorMessage = nil
            didChangeLayout()
        } catch {
            fileErrorMessage = error.localizedDescription
        }
    }

    func selectEditorTab(paneID: UUID, tabID: UUID) {
        var selectedPath: String?
        let changed = layout.updateContent(paneID: paneID) { content in
            guard case .editor(var editor) = content,
                  let tab = editor.tabs.first(where: { $0.id == tabID }) else { return }
            editor.selectedTabID = tabID
            selectedPath = tab.relativePath
            content = .editor(editor)
        }
        guard changed else { return }
        if let selectedPath { editorStore?.select(relativePath: selectedPath) }
        layout.focus(paneID)
        didChangeLayout()
    }

    func closeEditorTab(paneID: UUID, tabID: UUID) -> Bool {
        guard case .editor(let current) = layout.root.leaf(id: paneID)?.content,
              let tab = current.tabs.first(where: { $0.id == tabID }) else { return false }
        if editorStore?.buffers[tab.relativePath]?.isDirty == true {
            fileErrorMessage = "저장하지 않은 변경이 있어 tab을 닫지 않았습니다."
            return false
        }
        _ = layout.updateContent(paneID: paneID) { content in
            guard case .editor(var editor) = content else { return }
            editor.close(tabID: tabID)
            content = .editor(editor)
        }
        editorStore?.close(relativePath: tab.relativePath)
        didChangeLayout()
        return true
    }

    func buffer(for editor: EditorPaneState) -> EditorBuffer? {
        guard let path = editor.selectedTab?.relativePath else { return nil }
        if let existing = editorStore?.buffers[path] { return existing }
        do {
            return try editorStore?.open(relativePath: path)
        } catch {
            fileErrorMessage = error.localizedDescription
            return nil
        }
    }

    func updateEditorText(_ text: String, path: String) {
        editorStore?.updateText(text, relativePath: path)
    }

    func save(path: String, overwrite: Bool = false) {
        do {
            _ = try editorStore?.save(relativePath: path, overwrite: overwrite)
            fileErrorMessage = nil
            reloadFiles()
        } catch {
            fileErrorMessage = error.localizedDescription
        }
    }

    func reload(path: String) {
        do {
            _ = try editorStore?.reload(relativePath: path)
            fileErrorMessage = nil
        } catch {
            fileErrorMessage = error.localizedDescription
        }
    }

    func saveFocusedEditor(overwrite: Bool = false) {
        guard case .editor(let editor) = layout.focusedLeaf?.content,
              let path = editor.selectedTab?.relativePath else { return }
        save(path: path, overwrite: overwrite)
    }

    func clearError() {
        fileErrorMessage = nil
    }

    private func ensureEditorPane(preferredPaneID: UUID?) -> UUID {
        if let preferredPaneID,
           case .editor = layout.root.leaf(id: preferredPaneID)?.content {
            return preferredPaneID
        }
        if case .editor = layout.focusedLeaf?.content {
            return layout.focusedPaneID
        }
        if let existing = layout.root.leaves.first(where: {
            if case .editor = $0.content { return true }
            return false
        }) {
            return existing.id
        }
        let paneID = UUID()
        _ = layout.split(
            paneID: layout.focusedPaneID,
            axis: .horizontal,
            newPaneID: paneID,
            content: .editor(EditorPaneState())
        )
        return paneID
    }

    private func restoreSelectedEditorFiles() {
        guard let editorStore else { return }
        for leaf in layout.root.leaves {
            guard case .editor(let editor) = leaf.content,
                  let path = editor.selectedTab?.relativePath else { continue }
            do {
                _ = try editorStore.open(relativePath: path)
            } catch {
                fileErrorMessage = error.localizedDescription
            }
        }
    }

    private func normalized(_ candidate: PaneLayoutRecord) -> PaneLayoutRecord {
        let leafIDs = candidate.root.orderedLeafIDs
        guard candidate.version == PaneLayoutRecord.currentVersion,
              !leafIDs.isEmpty,
              Set(leafIDs).count == leafIDs.count,
              leafIDs.contains(candidate.focusedPaneID) else {
            return .defaultLayout()
        }
        return candidate
    }

    private func didChangeLayout() {
        guard let taskID else { return }
        transientLayouts[taskID] = layout
        onLayoutChange?(taskID, layout)
    }
}
