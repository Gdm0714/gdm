import CryptoKit
import Darwin
import Foundation

struct WorktreeFileEntry: Identifiable, Equatable, Sendable {
    enum Kind: String, Equatable, Sendable {
        case directory
        case file
    }

    var id: String { relativePath }

    let relativePath: String
    let name: String
    let kind: Kind
    let depth: Int
    let byteSize: Int64?
}

struct WorktreeDiskRevision: Equatable, Sendable {
    let device: UInt64
    let inode: UInt64
    let size: Int64
    let modificationSeconds: Int64
    let modificationNanoseconds: Int64
}

struct WorktreeFileRevision: Equatable, Sendable {
    let disk: WorktreeDiskRevision
    let sha256: String
}

struct WorktreeTextFile: Equatable, Sendable {
    let relativePath: String
    let text: String
    let revision: WorktreeFileRevision
    let permissions: UInt16
}

enum WorktreeFileServiceError: Error, LocalizedError, Equatable {
    case invalidRoot(String)
    case invalidRelativePath(String)
    case excludedPath(String)
    case depthLimitExceeded(Int)
    case entryLimitExceeded(Int)
    case symbolicLink(String)
    case outsideRoot(String)
    case fileNotFound(String)
    case notDirectory(String)
    case notRegularFile(String)
    case fileTooLarge(path: String, limit: Int)
    case invalidUTF8(String)
    case externalModification(String)
    case changedDuringOperation(String)
    case systemCall(operation: String, path: String, code: Int32)

    var errorDescription: String? {
        switch self {
        case .invalidRoot(let path):
            "편집기 root가 안전한 실제 디렉터리가 아닙니다: \(path)"
        case .invalidRelativePath(let path):
            "root 기준 상대 경로가 올바르지 않습니다: \(path)"
        case .excludedPath(let path):
            "편집기에서 제외된 경로입니다: \(path)"
        case .depthLimitExceeded(let limit):
            "파일 트리 최대 깊이 \(limit)을 초과했습니다."
        case .entryLimitExceeded(let limit):
            "파일 트리 최대 항목 수 \(limit)을 초과했습니다."
        case .symbolicLink(let path):
            "symbolic link 경로는 열거나 저장하지 않습니다: \(path)"
        case .outsideRoot(let path):
            "worktree root 밖의 경로는 열거나 저장하지 않습니다: \(path)"
        case .fileNotFound(let path):
            "파일을 찾지 못했습니다: \(path)"
        case .notDirectory(let path):
            "중간 경로가 디렉터리가 아닙니다: \(path)"
        case .notRegularFile(let path):
            "일반 파일만 편집할 수 있습니다: \(path)"
        case .fileTooLarge(let path, let limit):
            "파일이 편집 제한 \(limit) bytes를 초과했습니다: \(path)"
        case .invalidUTF8(let path):
            "UTF-8 텍스트 파일만 편집할 수 있습니다: \(path)"
        case .externalModification(let path):
            "파일이 열린 뒤 디스크에서 변경되었습니다: \(path)"
        case .changedDuringOperation(let path):
            "파일 작업 도중 경로 또는 내용이 바뀌었습니다: \(path)"
        case .systemCall(let operation, let path, let code):
            "\(operation) 실패 (\(path), errno \(code): \(String(cString: strerror(code))))"
        }
    }
}

/// A no-follow file boundary rooted at one selected task's working directory.
/// All file descriptors are opened relative to the trusted root so a component
/// swap cannot redirect a read or atomic rename outside the worktree.
struct WorktreeFileService: Sendable {
    static let defaultMaximumEntries = 10_000
    static let defaultMaximumDepth = 32
    static let defaultMaximumFileSize = 2 * 1_024 * 1_024

    private static let excludedComponents: Set<String> = [
        ".git", ".gdm", ".omo", ".omx", ".build", "node_modules"
    ]

    let rootURL: URL
    let maximumEntries: Int
    let maximumDepth: Int
    let maximumFileSize: Int

    private let canonicalRootPath: String

    init(
        rootURL: URL,
        maximumEntries: Int = Self.defaultMaximumEntries,
        maximumDepth: Int = Self.defaultMaximumDepth,
        maximumFileSize: Int = Self.defaultMaximumFileSize
    ) throws {
        let standardized = rootURL.standardizedFileURL
        var rootInfo = stat()
        let status = standardized.path.withCString { Darwin.lstat($0, &rootInfo) }
        guard status == 0,
              !Self.isSymbolicLink(rootInfo),
              Self.isDirectory(rootInfo) else {
            throw WorktreeFileServiceError.invalidRoot(standardized.path)
        }
        guard maximumEntries > 0, maximumDepth > 0, maximumFileSize > 0 else {
            throw WorktreeFileServiceError.invalidRoot(standardized.path)
        }

        self.rootURL = standardized
        self.maximumEntries = maximumEntries
        self.maximumDepth = maximumDepth
        self.maximumFileSize = maximumFileSize
        self.canonicalRootPath = standardized.resolvingSymlinksInPath().standardizedFileURL.path
    }

    func indexFiles() throws -> [WorktreeFileEntry] {
        let rootDescriptor = try openRootDirectory()
        defer { Darwin.close(rootDescriptor) }

        var entries: [WorktreeFileEntry] = []
        try walk(
            directoryDescriptor: rootDescriptor,
            relativeComponents: [],
            entries: &entries
        )
        return entries
    }

    func openFile(at relativePath: String) throws -> WorktreeTextFile {
        let components = try validatedComponents(for: relativePath)
        return try withSecureFile(components: components, relativePath: relativePath) {
            _, fileDescriptor, _, fileInfo in
            try validateDescriptorContainment(fileDescriptor, displayPath: relativePath)
            return try stableTextFile(
                descriptor: fileDescriptor,
                relativePath: relativePath,
                initialInfo: fileInfo
            )
        }
    }

    func saveFile(
        at relativePath: String,
        text: String,
        baseline: WorktreeFileRevision,
        overwrite: Bool = false
    ) throws -> WorktreeTextFile {
        let components = try validatedComponents(for: relativePath)
        let data = Data(text.utf8)
        guard data.count <= maximumFileSize else {
            throw WorktreeFileServiceError.fileTooLarge(
                path: relativePath,
                limit: maximumFileSize
            )
        }

        do {
            return try withSecureFile(components: components, relativePath: relativePath) {
                parentDescriptor, fileDescriptor, leaf, fileInfo in
                try validateDescriptorContainment(fileDescriptor, displayPath: relativePath)
                try validateDescriptorContainment(parentDescriptor, displayPath: relativePath)

                if !overwrite {
                    guard Self.diskRevision(fileInfo) == baseline.disk else {
                        throw WorktreeFileServiceError.externalModification(relativePath)
                    }
                    let current = try stableTextFile(
                        descriptor: fileDescriptor,
                        relativePath: relativePath,
                        initialInfo: fileInfo
                    )
                    guard current.revision == baseline else {
                        throw WorktreeFileServiceError.externalModification(relativePath)
                    }
                }

                let temporaryName = ".gidem-save-\(UUID().uuidString.lowercased()).tmp"
                let originalPermissions = mode_t(fileInfo.st_mode & 0o777)
                let temporaryDescriptor = try createTemporaryFile(
                    parentDescriptor: parentDescriptor,
                    name: temporaryName,
                    permissions: originalPermissions,
                    displayPath: relativePath
                )
                var shouldRemoveTemporary = true
                defer {
                    Darwin.close(temporaryDescriptor)
                    if shouldRemoveTemporary {
                        temporaryName.withCString {
                            _ = Darwin.unlinkat(parentDescriptor, $0, 0)
                        }
                    }
                }

                try writeAll(data, to: temporaryDescriptor, displayPath: relativePath)
                guard Darwin.fchmod(temporaryDescriptor, originalPermissions) == 0 else {
                    throw systemError("fchmod", path: relativePath)
                }
                guard Darwin.fsync(temporaryDescriptor) == 0 else {
                    throw systemError("fsync", path: relativePath)
                }

                // Revalidate the live target after the temp file is durable and
                // immediately before the atomic replacement.
                let latestInfo = try noFollowStat(
                    parentDescriptor: parentDescriptor,
                    component: leaf,
                    displayPath: relativePath
                )
                guard !Self.isSymbolicLink(latestInfo) else {
                    throw WorktreeFileServiceError.symbolicLink(relativePath)
                }
                guard Self.isRegularFile(latestInfo) else {
                    throw WorktreeFileServiceError.notRegularFile(relativePath)
                }
                if !overwrite {
                    guard Self.diskRevision(latestInfo) == baseline.disk else {
                        throw WorktreeFileServiceError.externalModification(relativePath)
                    }
                    let latest = try openAndReadFile(
                        parentDescriptor: parentDescriptor,
                        component: leaf,
                        relativePath: relativePath
                    )
                    guard latest.revision == baseline else {
                        throw WorktreeFileServiceError.externalModification(relativePath)
                    }
                }
                try validateDescriptorContainment(parentDescriptor, displayPath: relativePath)

                let renameStatus = temporaryName.withCString { temporaryPointer in
                    leaf.withCString { leafPointer in
                        Darwin.renameat(
                            parentDescriptor,
                            temporaryPointer,
                            parentDescriptor,
                            leafPointer
                        )
                    }
                }
                guard renameStatus == 0 else {
                    throw systemError("renameat", path: relativePath)
                }
                shouldRemoveTemporary = false
                _ = Darwin.fsync(parentDescriptor)

                var savedInfo = stat()
                guard Darwin.fstat(temporaryDescriptor, &savedInfo) == 0 else {
                    throw systemError("fstat", path: relativePath)
                }
                return WorktreeTextFile(
                    relativePath: relativePath,
                    text: text,
                    revision: WorktreeFileRevision(
                        disk: Self.diskRevision(savedInfo),
                        sha256: Self.sha256(data)
                    ),
                    permissions: UInt16(savedInfo.st_mode & 0o777)
                )
            }
        } catch WorktreeFileServiceError.fileNotFound {
            throw WorktreeFileServiceError.externalModification(relativePath)
        }
    }

    private func walk(
        directoryDescriptor: Int32,
        relativeComponents: [String],
        entries: inout [WorktreeFileEntry]
    ) throws {
        try validateDescriptorContainment(
            directoryDescriptor,
            displayPath: relativeComponents.joined(separator: "/")
        )
        let names = try directoryNames(
            descriptor: directoryDescriptor,
            displayPath: relativeComponents.joined(separator: "/")
        )

        for name in names {
            guard !Self.isExcludedComponent(name),
                  !name.hasPrefix(".gidem-save-") else {
                continue
            }
            let childComponents = relativeComponents + [name]
            let relativePath = childComponents.joined(separator: "/")
            let depth = childComponents.count
            guard depth <= maximumDepth else {
                throw WorktreeFileServiceError.depthLimitExceeded(maximumDepth)
            }

            let info = try noFollowStat(
                parentDescriptor: directoryDescriptor,
                component: name,
                displayPath: relativePath
            )
            // Symlinks and special files are intentionally absent from the tree;
            // direct open/save calls still return an explicit rejection.
            guard !Self.isSymbolicLink(info) else { continue }

            if Self.isDirectory(info) {
                try appendEntry(
                    WorktreeFileEntry(
                        relativePath: relativePath,
                        name: name,
                        kind: .directory,
                        depth: depth,
                        byteSize: nil
                    ),
                    to: &entries
                )
                let childDescriptor = try openDirectory(
                    parentDescriptor: directoryDescriptor,
                    component: name,
                    expectedInfo: info,
                    displayPath: relativePath
                )
                defer { Darwin.close(childDescriptor) }
                try walk(
                    directoryDescriptor: childDescriptor,
                    relativeComponents: childComponents,
                    entries: &entries
                )
            } else if Self.isRegularFile(info) {
                try appendEntry(
                    WorktreeFileEntry(
                        relativePath: relativePath,
                        name: name,
                        kind: .file,
                        depth: depth,
                        byteSize: info.st_size
                    ),
                    to: &entries
                )
            }
        }
    }

    private func appendEntry(
        _ entry: WorktreeFileEntry,
        to entries: inout [WorktreeFileEntry]
    ) throws {
        guard entries.count < maximumEntries else {
            throw WorktreeFileServiceError.entryLimitExceeded(maximumEntries)
        }
        entries.append(entry)
    }

    private func directoryNames(descriptor: Int32, displayPath: String) throws -> [String] {
        let duplicated = Darwin.dup(descriptor)
        guard duplicated >= 0 else { throw systemError("dup", path: displayPath) }
        guard let directory = Darwin.fdopendir(duplicated) else {
            Darwin.close(duplicated)
            throw systemError("fdopendir", path: displayPath)
        }
        defer { Darwin.closedir(directory) }

        var names: [String] = []
        while true {
            errno = 0
            guard let entry = Darwin.readdir(directory) else {
                guard errno == 0 else {
                    throw systemError("readdir", path: displayPath)
                }
                break
            }
            let name = withUnsafePointer(to: entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
                    String(cString: $0)
                }
            }
            guard name != ".", name != ".." else { continue }
            names.append(name)
        }
        return names.sorted { lhs, rhs in
            lhs.utf8.lexicographicallyPrecedes(rhs.utf8)
        }
    }

    private func validatedComponents(for relativePath: String) throws -> [String] {
        guard !relativePath.isEmpty,
              !relativePath.hasPrefix("/"),
              !relativePath.contains("\0") else {
            throw WorktreeFileServiceError.invalidRelativePath(relativePath)
        }
        let components = relativePath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !components.isEmpty,
              components.count <= maximumDepth,
              components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            if components.count > maximumDepth {
                throw WorktreeFileServiceError.depthLimitExceeded(maximumDepth)
            }
            throw WorktreeFileServiceError.invalidRelativePath(relativePath)
        }
        if let excluded = components.first(where: Self.isExcludedComponent) {
            throw WorktreeFileServiceError.excludedPath(excluded)
        }
        return components
    }

    private func withSecureFile<T>(
        components: [String],
        relativePath: String,
        body: (_ parentDescriptor: Int32, _ fileDescriptor: Int32, _ leaf: String, _ info: stat) throws -> T
    ) throws -> T {
        var directoryDescriptor = try openRootDirectory()
        defer { Darwin.close(directoryDescriptor) }

        for (index, component) in components.dropLast().enumerated() {
            let displayPath = components.prefix(index + 1).joined(separator: "/")
            let info = try noFollowStat(
                parentDescriptor: directoryDescriptor,
                component: component,
                displayPath: displayPath
            )
            guard !Self.isSymbolicLink(info) else {
                throw WorktreeFileServiceError.symbolicLink(displayPath)
            }
            guard Self.isDirectory(info) else {
                throw WorktreeFileServiceError.notDirectory(displayPath)
            }
            let next = try openDirectory(
                parentDescriptor: directoryDescriptor,
                component: component,
                expectedInfo: info,
                displayPath: displayPath
            )
            Darwin.close(directoryDescriptor)
            directoryDescriptor = next
        }

        guard let leaf = components.last else {
            throw WorktreeFileServiceError.invalidRelativePath(relativePath)
        }
        let expected = try noFollowStat(
            parentDescriptor: directoryDescriptor,
            component: leaf,
            displayPath: relativePath
        )
        guard !Self.isSymbolicLink(expected) else {
            throw WorktreeFileServiceError.symbolicLink(relativePath)
        }
        guard Self.isRegularFile(expected) else {
            throw WorktreeFileServiceError.notRegularFile(relativePath)
        }

        let descriptor = leaf.withCString {
            Darwin.openat(
                directoryDescriptor,
                $0,
                O_RDONLY | O_CLOEXEC | O_NOFOLLOW,
                0
            )
        }
        guard descriptor >= 0 else {
            if errno == ELOOP { throw WorktreeFileServiceError.symbolicLink(relativePath) }
            if errno == ENOENT { throw WorktreeFileServiceError.fileNotFound(relativePath) }
            throw systemError("openat", path: relativePath)
        }
        defer { Darwin.close(descriptor) }

        var opened = stat()
        guard Darwin.fstat(descriptor, &opened) == 0 else {
            throw systemError("fstat", path: relativePath)
        }
        guard Self.sameNode(expected, opened), Self.isRegularFile(opened) else {
            throw WorktreeFileServiceError.changedDuringOperation(relativePath)
        }
        return try body(directoryDescriptor, descriptor, leaf, opened)
    }

    private func openAndReadFile(
        parentDescriptor: Int32,
        component: String,
        relativePath: String
    ) throws -> WorktreeTextFile {
        let expected = try noFollowStat(
            parentDescriptor: parentDescriptor,
            component: component,
            displayPath: relativePath
        )
        guard !Self.isSymbolicLink(expected) else {
            throw WorktreeFileServiceError.symbolicLink(relativePath)
        }
        guard Self.isRegularFile(expected) else {
            throw WorktreeFileServiceError.notRegularFile(relativePath)
        }
        let descriptor = component.withCString {
            Darwin.openat(parentDescriptor, $0, O_RDONLY | O_CLOEXEC | O_NOFOLLOW, 0)
        }
        guard descriptor >= 0 else {
            if errno == ELOOP { throw WorktreeFileServiceError.symbolicLink(relativePath) }
            if errno == ENOENT { throw WorktreeFileServiceError.externalModification(relativePath) }
            throw systemError("openat", path: relativePath)
        }
        defer { Darwin.close(descriptor) }
        var opened = stat()
        guard Darwin.fstat(descriptor, &opened) == 0 else {
            throw systemError("fstat", path: relativePath)
        }
        guard Self.sameNode(expected, opened), Self.isRegularFile(opened) else {
            throw WorktreeFileServiceError.changedDuringOperation(relativePath)
        }
        try validateDescriptorContainment(descriptor, displayPath: relativePath)
        return try stableTextFile(
            descriptor: descriptor,
            relativePath: relativePath,
            initialInfo: opened
        )
    }

    private func stableTextFile(
        descriptor: Int32,
        relativePath: String,
        initialInfo: stat
    ) throws -> WorktreeTextFile {
        guard initialInfo.st_size >= 0,
              initialInfo.st_size <= Int64(maximumFileSize) else {
            throw WorktreeFileServiceError.fileTooLarge(
                path: relativePath,
                limit: maximumFileSize
            )
        }
        let before = Self.diskRevision(initialInfo)
        let data = try readAll(descriptor, displayPath: relativePath)
        var afterInfo = stat()
        guard Darwin.fstat(descriptor, &afterInfo) == 0 else {
            throw systemError("fstat", path: relativePath)
        }
        guard before == Self.diskRevision(afterInfo) else {
            throw WorktreeFileServiceError.changedDuringOperation(relativePath)
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw WorktreeFileServiceError.invalidUTF8(relativePath)
        }
        return WorktreeTextFile(
            relativePath: relativePath,
            text: text,
            revision: WorktreeFileRevision(
                disk: before,
                sha256: Self.sha256(data)
            ),
            permissions: UInt16(afterInfo.st_mode & 0o777)
        )
    }

    private func readAll(_ descriptor: Int32, displayPath: String) throws -> Data {
        guard Darwin.lseek(descriptor, 0, SEEK_SET) >= 0 else {
            throw systemError("lseek", path: displayPath)
        }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
        while true {
            let count = buffer.withUnsafeMutableBytes { bytes -> Int in
                guard let baseAddress = bytes.baseAddress else { return 0 }
                return Darwin.read(descriptor, baseAddress, bytes.count)
            }
            if count == 0 { break }
            if count < 0 {
                if errno == EINTR { continue }
                throw systemError("read", path: displayPath)
            }
            guard result.count + count <= maximumFileSize else {
                throw WorktreeFileServiceError.fileTooLarge(
                    path: displayPath,
                    limit: maximumFileSize
                )
            }
            result.append(buffer, count: count)
        }
        return result
    }

    private func writeAll(_ data: Data, to descriptor: Int32, displayPath: String) throws {
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                guard let baseAddress = bytes.baseAddress else { return }
                let count = Darwin.write(
                    descriptor,
                    baseAddress.advanced(by: offset),
                    bytes.count - offset
                )
                if count < 0 {
                    if errno == EINTR { continue }
                    throw systemError("write", path: displayPath)
                }
                guard count > 0 else {
                    throw WorktreeFileServiceError.systemCall(
                        operation: "write",
                        path: displayPath,
                        code: EIO
                    )
                }
                offset += count
            }
        }
    }

    private func openRootDirectory() throws -> Int32 {
        let descriptor = rootURL.path.withCString {
            Darwin.open($0, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        }
        guard descriptor >= 0 else {
            throw WorktreeFileServiceError.invalidRoot(rootURL.path)
        }
        do {
            try validateDescriptorContainment(descriptor, displayPath: rootURL.path)
            return descriptor
        } catch {
            Darwin.close(descriptor)
            throw error
        }
    }

    private func openDirectory(
        parentDescriptor: Int32,
        component: String,
        expectedInfo: stat,
        displayPath: String
    ) throws -> Int32 {
        let descriptor = component.withCString {
            Darwin.openat(
                parentDescriptor,
                $0,
                O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
                0
            )
        }
        guard descriptor >= 0 else {
            if errno == ELOOP { throw WorktreeFileServiceError.symbolicLink(displayPath) }
            if errno == ENOENT { throw WorktreeFileServiceError.fileNotFound(displayPath) }
            throw systemError("openat", path: displayPath)
        }
        var opened = stat()
        guard Darwin.fstat(descriptor, &opened) == 0 else {
            Darwin.close(descriptor)
            throw systemError("fstat", path: displayPath)
        }
        guard Self.sameNode(expectedInfo, opened), Self.isDirectory(opened) else {
            Darwin.close(descriptor)
            throw WorktreeFileServiceError.changedDuringOperation(displayPath)
        }
        do {
            try validateDescriptorContainment(descriptor, displayPath: displayPath)
            return descriptor
        } catch {
            Darwin.close(descriptor)
            throw error
        }
    }

    private func createTemporaryFile(
        parentDescriptor: Int32,
        name: String,
        permissions: mode_t,
        displayPath: String
    ) throws -> Int32 {
        let descriptor = name.withCString {
            Darwin.openat(
                parentDescriptor,
                $0,
                O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                permissions
            )
        }
        guard descriptor >= 0 else {
            throw systemError("openat temp", path: displayPath)
        }
        return descriptor
    }

    private func noFollowStat(
        parentDescriptor: Int32,
        component: String,
        displayPath: String
    ) throws -> stat {
        var info = stat()
        let status = component.withCString {
            Darwin.fstatat(parentDescriptor, $0, &info, AT_SYMLINK_NOFOLLOW)
        }
        guard status == 0 else {
            if errno == ENOENT { throw WorktreeFileServiceError.fileNotFound(displayPath) }
            throw systemError("fstatat", path: displayPath)
        }
        return info
    }

    private func validateDescriptorContainment(_ descriptor: Int32, displayPath: String) throws {
        var info = vnode_fdinfowithpath()
        let byteCount = proc_pidfdinfo(
            getpid(),
            descriptor,
            PROC_PIDFDVNODEPATHINFO,
            &info,
            Int32(MemoryLayout<vnode_fdinfowithpath>.size)
        )
        guard byteCount == Int32(MemoryLayout<vnode_fdinfowithpath>.size) else {
            throw systemError("proc_pidfdinfo", path: displayPath)
        }
        let descriptorPath = withUnsafePointer(to: &info.pvip.vip_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) {
                String(cString: $0)
            }
        }
        let resolved = URL(fileURLWithPath: descriptorPath)
            .standardizedFileURL
            .path
        guard resolved == canonicalRootPath || resolved.hasPrefix(canonicalRootPath + "/") else {
            throw WorktreeFileServiceError.outsideRoot(resolved)
        }
    }

    private func systemError(_ operation: String, path: String) -> WorktreeFileServiceError {
        WorktreeFileServiceError.systemCall(operation: operation, path: path, code: errno)
    }

    private static func diskRevision(_ info: stat) -> WorktreeDiskRevision {
        WorktreeDiskRevision(
            device: UInt64(bitPattern: Int64(info.st_dev)),
            inode: UInt64(info.st_ino),
            size: info.st_size,
            modificationSeconds: Int64(info.st_mtimespec.tv_sec),
            modificationNanoseconds: Int64(info.st_mtimespec.tv_nsec)
        )
    }

    private static func sameNode(_ lhs: stat, _ rhs: stat) -> Bool {
        lhs.st_dev == rhs.st_dev && lhs.st_ino == rhs.st_ino
    }

    private static func isSymbolicLink(_ info: stat) -> Bool {
        (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFLNK)
    }

    private static func isDirectory(_ info: stat) -> Bool {
        (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR)
    }

    private static func isRegularFile(_ info: stat) -> Bool {
        (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG)
    }

    private static func isExcludedComponent(_ component: String) -> Bool {
        excludedComponents.contains(component.lowercased())
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
