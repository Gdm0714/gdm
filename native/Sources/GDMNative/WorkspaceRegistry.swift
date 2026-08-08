import Darwin
import Foundation

@_silgen_name("flock")
private func posixFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

enum WorkspaceRegistryError: Error, LocalizedError {
    case unsupportedVersion(Int)
    case duplicateID(UUID)
    case duplicateSlug(String)
    case duplicateBranch(String)
    case duplicatePath(String)
    case invalidRecord(String)
    case missingRecord(UUID)
    case systemCall(operation: String, path: String, code: Int32)

    var errorDescription: String? {
        switch self {
        case .unsupportedVersion(let version):
            "지원하지 않는 workspace registry 버전입니다: \(version)"
        case .duplicateID(let id):
            "workspace registry에 같은 ID가 이미 있습니다: \(id.uuidString.lowercased())"
        case .duplicateSlug(let slug):
            "workspace registry에 같은 slug가 이미 있습니다: \(slug)"
        case .duplicateBranch(let branch):
            "workspace registry에 같은 branch가 이미 있습니다: \(branch)"
        case .duplicatePath(let path):
            "workspace registry에 같은 worktree path가 이미 있습니다: \(path)"
        case .invalidRecord(let message):
            "workspace registry record가 올바르지 않습니다: \(message)"
        case .missingRecord(let id):
            "workspace registry record를 찾지 못했습니다: \(id.uuidString.lowercased())"
        case .systemCall(let operation, let path, let code):
            "\(operation) 실패 (\(path)): \(WorkspaceRegistry.posixMessage(code))"
        }
    }
}

/// The root repository's durable task-to-worktree registry.
///
/// Every mutation is a read-modify-write transaction under a process-shared
/// `flock`. Persistence writes a sibling temporary file and then uses POSIX
/// `rename`, so readers observe either the old complete document or the new one.
struct WorkspaceRegistry: Sendable {
    static let currentVersion = 1

    let repositoryURL: URL

    var registryDirectoryURL: URL {
        repositoryURL
            .appendingPathComponent(".gdm", isDirectory: true)
            .appendingPathComponent("native", isDirectory: true)
    }

    var registryURL: URL {
        registryDirectoryURL.appendingPathComponent("workspace.json", isDirectory: false)
    }

    var lockURL: URL {
        registryDirectoryURL.appendingPathComponent("workspace.lock", isDirectory: false)
    }

    init(repositoryURL: URL) {
        self.repositoryURL = repositoryURL.standardizedFileURL
    }

    func load() throws -> WorkspaceRegistryDocument {
        try withExclusiveLock {
            try loadUnlocked()
        }
    }

    /// Replaces the complete registry under the cross-process lock.
    /// Prefer `update` for callers that started from an earlier snapshot.
    func save(_ document: WorkspaceRegistryDocument) throws {
        try withExclusiveLock {
            try validateVersion(document)
            try persistUnlocked(document)
        }
    }

    @discardableResult
    func update(
        _ mutation: (inout WorkspaceRegistryDocument) throws -> Void
    ) throws -> WorkspaceRegistryDocument {
        try withExclusiveLock {
            var document = try loadUnlocked()
            try mutation(&document)
            try validateVersion(document)
            try persistUnlocked(document)
            return document
        }
    }

    /// Adds a creating reservation while the same lock also protects the
    /// caller's Git/global collision preflight.
    @discardableResult
    func reserve(
        _ record: WorkspaceRegistryRecord,
        validating validation: (WorkspaceRegistryDocument) throws -> Void = { _ in }
    ) throws -> WorkspaceRegistryDocument {
        try update { document in
            try validation(document)
            try validateReservation(record, in: document)
            document.tasks.append(record)
        }
    }

    @discardableResult
    func markReady(id: UUID, select: Bool = false) throws -> WorkspaceRegistryRecord {
        var updatedRecord: WorkspaceRegistryRecord?
        _ = try update { document in
            guard let index = document.tasks.firstIndex(where: { $0.id == id }) else {
                throw WorkspaceRegistryError.missingRecord(id)
            }
            document.tasks[index].phase = .ready
            document.tasks[index].lastError = nil
            if select {
                document.selectedTaskKey = WorkspaceRegistry.taskKey(for: id)
            }
            updatedRecord = document.tasks[index]
        }
        guard let updatedRecord else {
            throw WorkspaceRegistryError.missingRecord(id)
        }
        return updatedRecord
    }

    @discardableResult
    func markReadyAndSelect(id: UUID) throws -> WorkspaceRegistryRecord {
        try markReady(id: id, select: true)
    }

    @discardableResult
    func markFailed(id: UUID, error: String) throws -> WorkspaceRegistryRecord {
        var updatedRecord: WorkspaceRegistryRecord?
        _ = try update { document in
            guard let index = document.tasks.firstIndex(where: { $0.id == id }) else {
                throw WorkspaceRegistryError.missingRecord(id)
            }
            document.tasks[index].phase = .failed
            document.tasks[index].lastError = error
            updatedRecord = document.tasks[index]
        }
        guard let updatedRecord else {
            throw WorkspaceRegistryError.missingRecord(id)
        }
        return updatedRecord
    }

    /// On app restart an active persisted session is only historical metadata.
    /// This method does not inspect processes, attach, scan, or signal anything.
    @discardableResult
    func recoverInterruptedSessions(at _: Date = Date()) throws -> WorkspaceRegistryDocument {
        return try update { document in
            for index in document.tasks.indices {
                guard var session = document.tasks[index].lastSession,
                      session.outcome == .active else {
                    continue
                }
                session.outcome = .interrupted
                // Recovery proves only that this process is not attached to the
                // former session. It does not prove when that session ended, so
                // keep an unknown end time unknown instead of using app launch.
                document.tasks[index].lastSession = session
            }
        }
    }

    static func taskKey(for id: UUID) -> String {
        "worktree:\(id.uuidString.lowercased())"
    }

    private func validateReservation(
        _ record: WorkspaceRegistryRecord,
        in document: WorkspaceRegistryDocument
    ) throws {
        guard record.phase == .creating else {
            throw WorkspaceRegistryError.invalidRecord("reservation phase는 creating이어야 합니다")
        }
        guard (record.worktreePath as NSString).isAbsolutePath else {
            throw WorkspaceRegistryError.invalidRecord("worktree path는 절대 경로여야 합니다")
        }
        guard (record.gitCommonDirectory as NSString).isAbsolutePath else {
            throw WorkspaceRegistryError.invalidRecord("git common directory는 절대 경로여야 합니다")
        }
        if document.tasks.contains(where: { $0.id == record.id }) {
            throw WorkspaceRegistryError.duplicateID(record.id)
        }
        if document.tasks.contains(where: { $0.slug == record.slug }) {
            throw WorkspaceRegistryError.duplicateSlug(record.slug)
        }
        if document.tasks.contains(where: { $0.branch == record.branch }) {
            throw WorkspaceRegistryError.duplicateBranch(record.branch)
        }
        let path = Self.normalizedPath(record.worktreePath)
        if document.tasks.contains(where: { Self.normalizedPath($0.worktreePath) == path }) {
            throw WorkspaceRegistryError.duplicatePath(record.worktreePath)
        }
    }

    private func validateVersion(_ document: WorkspaceRegistryDocument) throws {
        guard document.version == Self.currentVersion else {
            throw WorkspaceRegistryError.unsupportedVersion(document.version)
        }
    }

    private func loadUnlocked() throws -> WorkspaceRegistryDocument {
        guard Self.pathExistsIncludingDanglingSymlink(registryURL.path) else {
            return WorkspaceRegistryDocument()
        }
        let data = try Data(contentsOf: registryURL)
        let document = try JSONDecoder().decode(WorkspaceRegistryDocument.self, from: data)
        try validateVersion(document)
        return document
    }

    private func persistUnlocked(_ document: WorkspaceRegistryDocument) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(document)
        data.append(0x0A)

        let temporaryURL = registryDirectoryURL.appendingPathComponent(
            ".workspace.json.tmp.\(UUID().uuidString.lowercased())",
            isDirectory: false
        )
        try data.write(to: temporaryURL, options: [.withoutOverwriting])

        var shouldRemoveTemporary = true
        defer {
            if shouldRemoveTemporary {
                _ = temporaryURL.path.withCString { Darwin.unlink($0) }
            }
        }

        try syncFile(at: temporaryURL)
        let renameResult = temporaryURL.path.withCString { source in
            registryURL.path.withCString { destination in
                Darwin.rename(source, destination)
            }
        }
        guard renameResult == 0 else {
            throw WorkspaceRegistryError.systemCall(
                operation: "rename",
                path: registryURL.path,
                code: errno
            )
        }
        shouldRemoveTemporary = false
        try syncDirectory()
    }

    private func syncFile(at url: URL) throws {
        let descriptor = url.path.withCString { Darwin.open($0, O_RDONLY | O_CLOEXEC) }
        guard descriptor >= 0 else {
            throw WorkspaceRegistryError.systemCall(operation: "open", path: url.path, code: errno)
        }
        defer { _ = Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else {
            throw WorkspaceRegistryError.systemCall(operation: "fsync", path: url.path, code: errno)
        }
    }

    private func syncDirectory() throws {
        let descriptor = registryDirectoryURL.path.withCString {
            Darwin.open($0, O_RDONLY | O_CLOEXEC)
        }
        guard descriptor >= 0 else {
            throw WorkspaceRegistryError.systemCall(
                operation: "open",
                path: registryDirectoryURL.path,
                code: errno
            )
        }
        defer { _ = Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else {
            throw WorkspaceRegistryError.systemCall(
                operation: "fsync",
                path: registryDirectoryURL.path,
                code: errno
            )
        }
    }

    private func withExclusiveLock<T>(_ body: () throws -> T) throws -> T {
        try FileManager.default.createDirectory(
            at: registryDirectoryURL,
            withIntermediateDirectories: true
        )

        let descriptor = lockURL.path.withCString {
            Darwin.open($0, O_CREAT | O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR)
        }
        guard descriptor >= 0 else {
            throw WorkspaceRegistryError.systemCall(operation: "open", path: lockURL.path, code: errno)
        }
        defer { _ = Darwin.close(descriptor) }

        while posixFlock(descriptor, LOCK_EX) != 0 {
            if errno == EINTR { continue }
            throw WorkspaceRegistryError.systemCall(operation: "flock", path: lockURL.path, code: errno)
        }
        defer { _ = posixFlock(descriptor, LOCK_UN) }
        return try body()
    }

    static func normalizedPath(_ path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.path
    }

    static func pathExistsIncludingDanglingSymlink(_ path: String) -> Bool {
        var info = stat()
        return path.withCString { Darwin.lstat($0, &info) } == 0
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func posixMessage(_ code: Int32) -> String {
        guard let message = strerror(code) else { return "errno \(code)" }
        return String(cString: message)
    }
}
