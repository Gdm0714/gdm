import Combine
import Foundation

struct EditorBuffer: Identifiable, Equatable, Sendable {
    var id: String { relativePath }

    let relativePath: String
    var text: String
    var baselineText: String
    var baselineRevision: WorktreeFileRevision
    var conflictMessage: String?

    var isDirty: Bool { text != baselineText }
}

/// Owns unsaved editor text independently from WorkspaceStore so pane/layout
/// integration can select an API without weakening the file boundary.
@MainActor
final class EditorBufferStore: ObservableObject {
    @Published private(set) var buffers: [String: EditorBuffer] = [:]
    @Published private(set) var activePath: String?
    @Published private(set) var lastErrorMessage: String?

    let fileService: WorktreeFileService

    init(fileService: WorktreeFileService) {
        self.fileService = fileService
    }

    var activeBuffer: EditorBuffer? {
        guard let activePath else { return nil }
        return buffers[activePath]
    }

    @discardableResult
    func open(relativePath: String) throws -> EditorBuffer {
        if let existing = buffers[relativePath] {
            activePath = relativePath
            lastErrorMessage = nil
            return existing
        }

        do {
            let file = try fileService.openFile(at: relativePath)
            let buffer = EditorBuffer(
                relativePath: file.relativePath,
                text: file.text,
                baselineText: file.text,
                baselineRevision: file.revision,
                conflictMessage: nil
            )
            buffers[relativePath] = buffer
            activePath = relativePath
            lastErrorMessage = nil
            return buffer
        } catch {
            record(error)
            throw error
        }
    }

    func select(relativePath: String) {
        guard buffers[relativePath] != nil else { return }
        activePath = relativePath
        lastErrorMessage = nil
    }

    func updateText(_ text: String, relativePath: String? = nil) {
        guard let path = relativePath ?? activePath,
              var buffer = buffers[path] else { return }
        buffer.text = text
        buffers[path] = buffer
    }

    @discardableResult
    func save(relativePath: String? = nil, overwrite: Bool = false) throws -> EditorBuffer {
        guard let path = relativePath ?? activePath,
              var buffer = buffers[path] else {
            throw WorktreeFileServiceError.invalidRelativePath(relativePath ?? "")
        }

        do {
            let saved = try fileService.saveFile(
                at: path,
                text: buffer.text,
                baseline: buffer.baselineRevision,
                overwrite: overwrite
            )
            buffer.baselineText = saved.text
            buffer.baselineRevision = saved.revision
            buffer.conflictMessage = nil
            buffers[path] = buffer
            lastErrorMessage = nil
            return buffer
        } catch let error as WorktreeFileServiceError {
            if case .externalModification = error {
                buffer.conflictMessage = error.localizedDescription
                buffers[path] = buffer
            }
            record(error)
            throw error
        } catch {
            record(error)
            throw error
        }
    }

    @discardableResult
    func reload(relativePath: String? = nil) throws -> EditorBuffer {
        guard let path = relativePath ?? activePath else {
            throw WorktreeFileServiceError.invalidRelativePath("")
        }
        do {
            let file = try fileService.openFile(at: path)
            let buffer = EditorBuffer(
                relativePath: file.relativePath,
                text: file.text,
                baselineText: file.text,
                baselineRevision: file.revision,
                conflictMessage: nil
            )
            buffers[path] = buffer
            activePath = path
            lastErrorMessage = nil
            return buffer
        } catch {
            record(error)
            throw error
        }
    }

    func close(relativePath: String) {
        buffers.removeValue(forKey: relativePath)
        if activePath == relativePath {
            activePath = buffers.keys.sorted().first
        }
    }

    private func record(_ error: Error) {
        lastErrorMessage = error.localizedDescription
    }
}
