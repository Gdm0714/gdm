import Darwin
import Foundation

enum GDMToolchainMode: String, Equatable, Sendable {
    case packaged
    case development
}

enum GDMToolchainLocatorError: Error, LocalizedError, Equatable, Sendable {
    case missing(mode: GDMToolchainMode, path: String)
    case symbolicLink(mode: GDMToolchainMode, path: String)
    case notRegularFile(mode: GDMToolchainMode, path: String)
    case notExecutable(mode: GDMToolchainMode, path: String)
    case inspectionFailed(mode: GDMToolchainMode, path: String, code: Int32)

    var errorDescription: String? {
        let detail: String
        switch self {
        case .missing(let mode, let path):
            detail = "GDM executable이 없습니다 (\(mode.label)): \(path)"
        case .symbolicLink(let mode, let path):
            detail = "GDM executable이 symbolic link라서 거부했습니다 (\(mode.label)): \(path)"
        case .notRegularFile(let mode, let path):
            detail = "GDM executable이 regular file이 아닙니다 (\(mode.label)): \(path)"
        case .notExecutable(let mode, let path):
            detail = "GDM executable에 실행 권한이 없습니다 (\(mode.label)): \(path)"
        case .inspectionFailed(let mode, let path, let code):
            detail = "GDM executable을 검사하지 못했습니다 (\(mode.label)): \(path) (\(Self.posixMessage(code)))"
        }

        switch mode {
        case .packaged:
            return "\(detail). Gidem 앱을 다시 빌드하거나 설치하세요."
        case .development:
            return "\(detail). `cd cli && bun run build`로 이 GDM source tree의 CLI를 빌드하세요."
        }
    }

    private var mode: GDMToolchainMode {
        switch self {
        case .missing(let mode, _),
             .symbolicLink(let mode, _),
             .notRegularFile(let mode, _),
             .notExecutable(let mode, _),
             .inspectionFailed(let mode, _, _):
            return mode
        }
    }

    private static func posixMessage(_ code: Int32) -> String {
        String(cString: strerror(code))
    }
}

private extension GDMToolchainMode {
    var label: String {
        switch self {
        case .packaged: "packaged app"
        case .development: "SwiftPM development"
        }
    }
}

/// Resolves the one GDM runtime owned by this application/source tree.
///
/// A packaged app can execute only `Contents/Helpers/gdm`. A SwiftPM build can
/// execute only the `cli/dist/gdm` derived from this file's source location.
/// The selected repository, Bun source, and `PATH` are deliberately not inputs.
enum GDMToolchainLocator {
    private static let locatorSourceFileURL = URL(fileURLWithPath: #filePath, isDirectory: false)

    static func resolve() -> Result<CommandInvocation, GDMToolchainLocatorError> {
        resolve(
            bundleURL: Bundle.main.bundleURL,
            developmentSourceFileURL: locatorSourceFileURL
        )
    }

    static func resolve(
        bundleURL: URL,
        developmentSourceFileURL: URL
    ) -> Result<CommandInvocation, GDMToolchainLocatorError> {
        do {
            return .success(
                try require(
                    bundleURL: bundleURL,
                    developmentSourceFileURL: developmentSourceFileURL
                )
            )
        } catch let error as GDMToolchainLocatorError {
            return .failure(error)
        } catch {
            preconditionFailure("GDMToolchainLocator emitted an unexpected error: \(error)")
        }
    }

    static func require() throws -> CommandInvocation {
        try resolve().get()
    }

    static func require(
        bundleURL: URL,
        developmentSourceFileURL: URL
    ) throws -> CommandInvocation {
        let bundleURL = bundleURL.standardizedFileURL
        let mode: GDMToolchainMode
        let candidate: URL

        if bundleURL.pathExtension.lowercased() == "app" {
            mode = .packaged
            candidate = bundleURL
                .appendingPathComponent("Contents", isDirectory: true)
                .appendingPathComponent("Helpers", isDirectory: true)
                .appendingPathComponent("gdm", isDirectory: false)
        } else {
            mode = .development
            let sourceRoot = developmentSourceFileURL.standardizedFileURL
                .deletingLastPathComponent() // GDMNative
                .deletingLastPathComponent() // Sources
                .deletingLastPathComponent() // native
                .deletingLastPathComponent() // GDM source root
            candidate = sourceRoot
                .appendingPathComponent("cli", isDirectory: true)
                .appendingPathComponent("dist", isDirectory: true)
                .appendingPathComponent("gdm", isDirectory: false)
        }

        try validate(candidate, mode: mode)
        return CommandInvocation(
            executable: candidate.standardizedFileURL.path,
            prefixArguments: []
        )
    }

    private static func validate(_ executableURL: URL, mode: GDMToolchainMode) throws {
        let path = executableURL.path
        var info = stat()
        let result = path.withCString { Darwin.lstat($0, &info) }
        guard result == 0 else {
            let code = errno
            if code == ENOENT {
                throw GDMToolchainLocatorError.missing(mode: mode, path: path)
            }
            throw GDMToolchainLocatorError.inspectionFailed(mode: mode, path: path, code: code)
        }

        let nodeType = info.st_mode & mode_t(S_IFMT)
        if nodeType == mode_t(S_IFLNK) {
            throw GDMToolchainLocatorError.symbolicLink(mode: mode, path: path)
        }
        guard nodeType == mode_t(S_IFREG) else {
            throw GDMToolchainLocatorError.notRegularFile(mode: mode, path: path)
        }
        guard path.withCString({ Darwin.access($0, X_OK) }) == 0 else {
            let code = errno
            if code == EACCES {
                throw GDMToolchainLocatorError.notExecutable(mode: mode, path: path)
            }
            throw GDMToolchainLocatorError.inspectionFailed(mode: mode, path: path, code: code)
        }
    }
}
