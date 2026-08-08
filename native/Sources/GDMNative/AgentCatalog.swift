import Foundation

enum AgentKind: String, CaseIterable, Identifiable, Codable, Sendable {
    case shell
    case codex
    case claude
    case gemini

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .shell: "Shell"
        case .codex: "Codex"
        case .claude: "Claude"
        case .gemini: "Gemini"
        }
    }

    static var toolbarCases: [AgentKind] {
        [.codex, .claude, .gemini]
    }

    fileprivate var executableName: String {
        switch self {
        case .shell: "zsh"
        case .codex: "codex"
        case .claude: "claude"
        case .gemini: "gemini"
        }
    }

    fileprivate var defaultArguments: [String] {
        switch self {
        case .shell: ["-l"]
        case .codex, .claude, .gemini: []
        }
    }
}

struct AgentLaunchSpecification: Equatable, Sendable {
    let agent: AgentKind
    let executableURL: URL
    let arguments: [String]
    let environment: [String: String]
    let currentDirectory: URL

    /// SwiftTerm accepts the environment in the `execve(2)` `KEY=value` form.
    /// Sorting makes launch specifications deterministic in tests and logs without
    /// changing the environment inherited by the child.
    var environmentEntries: [String] {
        environment
            .map { "\($0.key)=\($0.value)" }
            .sorted()
    }
}

enum AgentCatalogError: LocalizedError, Equatable {
    case invalidWorkingDirectory(String)
    case executableNotFound(AgentKind, searched: [String])
    case executableIsNotRunnable(AgentKind, path: String)

    var errorDescription: String? {
        switch self {
        case .invalidWorkingDirectory(let path):
            "Agent working directory is missing or is not a directory: \(path)"
        case .executableNotFound(let agent, let searched):
            "Could not find the \(agent.displayName) executable. Searched: \(searched.joined(separator: ", "))"
        case .executableIsNotRunnable(let agent, let path):
            "The \(agent.displayName) executable is not runnable: \(path)"
        }
    }
}

struct AgentCatalog: Sendable {
    private let environment: [String: String]
    private let configuredSearchDirectories: [URL]?
    private let homeDirectory: URL

    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        searchDirectories: [URL]? = nil,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) {
        self.environment = environment
        self.configuredSearchDirectories = searchDirectories
        self.homeDirectory = homeDirectory.standardizedFileURL
    }

    func launchSpecification(
        for agent: AgentKind,
        workingDirectory: URL
    ) throws -> AgentLaunchSpecification {
        let directory = workingDirectory.standardizedFileURL
        do {
            // `fileExists` follows a final symlink. A PTY cwd is a mutation
            // boundary, so require the path itself to still be a real directory.
            try WorkspaceStatePathBoundary.validateWorkspaceDirectory(directory)
        } catch {
            throw AgentCatalogError.invalidWorkingDirectory(directory.path)
        }

        var launchEnvironment = environment
        launchEnvironment["TERM"] = "xterm-256color"
        launchEnvironment["COLORTERM"] = "truecolor"
        let localeKeys = ["LC_ALL", "LC_CTYPE", "LANG"]
        if localeKeys.allSatisfy({ launchEnvironment[$0]?.isEmpty != false }) {
            launchEnvironment["LANG"] = "en_US.UTF-8"
        }

        return AgentLaunchSpecification(
            agent: agent,
            executableURL: try resolvedExecutable(for: agent),
            arguments: agent.defaultArguments,
            environment: launchEnvironment,
            currentDirectory: directory
        )
    }

    func resolvedExecutable(for agent: AgentKind) throws -> URL {
        if agent == .shell {
            if let configuredShell = environment["SHELL"], !configuredShell.isEmpty {
                let shellURL = URL(fileURLWithPath: configuredShell).standardizedFileURL
                if isRunnableFile(shellURL) {
                    return shellURL
                }
            }

            let systemShell = URL(fileURLWithPath: "/bin/zsh").standardizedFileURL
            if isRunnableFile(systemShell) {
                return systemShell
            }
            throw AgentCatalogError.executableIsNotRunnable(.shell, path: systemShell.path)
        }

        let candidates = searchDirectories.map {
            $0.appendingPathComponent(agent.executableName, isDirectory: false).standardizedFileURL
        }
        var firstNonRunnable: URL?
        for candidate in candidates {
            if isRunnableFile(candidate) {
                return candidate
            }
            if FileManager.default.fileExists(atPath: candidate.path), firstNonRunnable == nil {
                firstNonRunnable = candidate
            }
        }

        if let firstNonRunnable {
            throw AgentCatalogError.executableIsNotRunnable(agent, path: firstNonRunnable.path)
        }
        throw AgentCatalogError.executableNotFound(agent, searched: candidates.map(\.path))
    }

    /// A non-throwing discovery surface for idle/unavailable activity summaries.
    /// Launch still resolves again and reports the precise failure instead of
    /// silently falling back to a different agent.
    func isAvailable(_ agent: AgentKind) -> Bool {
        (try? resolvedExecutable(for: agent)) != nil
    }

    private var searchDirectories: [URL] {
        if let configuredSearchDirectories {
            return uniqueAbsoluteDirectories(configuredSearchDirectories)
        }

        let pathDirectories = (environment["PATH"] ?? "")
            .split(separator: ":", omittingEmptySubsequences: true)
            .map(String.init)
            .filter { $0.hasPrefix("/") }
            .map { URL(fileURLWithPath: $0, isDirectory: true) }
        let conventionalDirectories = [
            homeDirectory.appendingPathComponent(".local/bin", isDirectory: true),
            URL(fileURLWithPath: "/opt/homebrew/bin", isDirectory: true),
            URL(fileURLWithPath: "/usr/local/bin", isDirectory: true),
            homeDirectory.appendingPathComponent(".bun/bin", isDirectory: true)
        ]
        return uniqueAbsoluteDirectories(pathDirectories + conventionalDirectories)
    }

    private func uniqueAbsoluteDirectories(_ directories: [URL]) -> [URL] {
        var seen: Set<String> = []
        return directories.compactMap { directory in
            let standardized = directory.standardizedFileURL
            guard standardized.path.hasPrefix("/"), seen.insert(standardized.path).inserted else {
                return nil
            }
            return standardized
        }
    }

    private func isRunnableFile(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
            && !isDirectory.boolValue
            && FileManager.default.isExecutableFile(atPath: url.path)
    }
}
