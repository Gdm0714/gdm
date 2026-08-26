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

    func addingEnvironment(_ values: [String: String]) -> Self {
        var updated = environment
        for (key, value) in values { updated[key] = value }
        return Self(
            agent: agent,
            executableURL: executableURL,
            arguments: arguments,
            environment: updated,
            currentDirectory: currentDirectory
        )
    }

    func appendingArgument(_ value: String) -> Self {
        Self(
            agent: agent,
            executableURL: executableURL,
            arguments: arguments + [value],
            environment: environment,
            currentDirectory: currentDirectory
        )
    }

    func prependingPathDirectory(_ directory: URL) -> Self {
        let path = directory.standardizedFileURL.path
        guard path.hasPrefix("/") else { return self }
        var entries = (environment["PATH"] ?? "")
            .split(separator: ":")
            .map(String.init)
        entries.removeAll { $0 == path }
        entries.insert(path, at: 0)
        return addingEnvironment(["PATH": entries.joined(separator: ":")])
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
        // A terminal embedded in Gidem is a new session boundary. Never leak
        // the parent multiplexer identity into its shell or agent processes;
        // doing so can reattach an existing Herdr/tmux/zellij workspace.
        let parentSessionKeys = launchEnvironment.keys.filter { key in
            key == "TMUX"
                || key == "ZELLIJ"
                || ["TMUX_", "HERDR_", "GDMUX_", "CMUX_", "ZELLIJ_"].contains {
                    key.hasPrefix($0)
                }
        }
        for key in parentSessionKeys {
            launchEnvironment.removeValue(forKey: key)
        }
        // Gidem owns a fresh interactive terminal boundary. A parent automation
        // session may deliberately disable ANSI output, but that opt-out must
        // not make an embedded Ghostty session monochrome.
        launchEnvironment.removeValue(forKey: "NO_COLOR")
        for key in ["FORCE_COLOR", "CLICOLOR", "CLICOLOR_FORCE"] {
            let value = launchEnvironment[key]?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            if value == "0" || value == "false" || value == "no" {
                launchEnvironment.removeValue(forKey: key)
            }
        }
        launchEnvironment["GIDEM_TERMINAL"] = "1"
        // Finder-launched applications inherit a minimal PATH. Agents often
        // launch MCP servers as child commands (for example, `npx`), so give
        // the child an ordered, absolute search path that includes every
        // executable-discovery directory.
        launchEnvironment["PATH"] = launchPathDirectories
            .map(\.path)
            .joined(separator: ":")
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

        return launchPathDirectories
    }

    private var launchPathDirectories: [URL] {
        let inheritedDirectories = (environment["PATH"] ?? "")
            .split(separator: ":", omittingEmptySubsequences: false)
            .compactMap { entry -> URL? in
                let path = String(entry)
                guard path.hasPrefix("/") else { return nil }
                return URL(fileURLWithPath: path, isDirectory: true)
            }
        return uniqueAbsoluteDirectories(
            inheritedDirectories
                + (configuredSearchDirectories ?? [])
                + conventionalPathDirectories
        )
    }

    private var conventionalPathDirectories: [URL] {
        // PATH permits absent directories. Keep these deterministic even when a
        // package manager/profile has not been installed yet (or appears later).
        var directories = [
            homeDirectory.appendingPathComponent(".local/bin", isDirectory: true),
            URL(fileURLWithPath: "/opt/homebrew/bin", isDirectory: true),
            URL(fileURLWithPath: "/usr/local/bin", isDirectory: true),
            homeDirectory.appendingPathComponent(".bun/bin", isDirectory: true),
            homeDirectory.appendingPathComponent(".nix-profile/bin", isDirectory: true)
        ]

        let accountName = homeDirectory.lastPathComponent
        if !accountName.isEmpty {
            directories.append(
                URL(fileURLWithPath: "/etc/profiles/per-user", isDirectory: true)
                    .appendingPathComponent(accountName, isDirectory: true)
                    .appendingPathComponent("bin", isDirectory: true)
            )
        }

        directories.append(contentsOf: [
            URL(fileURLWithPath: "/nix/var/nix/profiles/default/bin", isDirectory: true),
            URL(fileURLWithPath: "/run/current-system/sw/bin", isDirectory: true),
            URL(fileURLWithPath: "/usr/bin", isDirectory: true),
            URL(fileURLWithPath: "/bin", isDirectory: true),
            URL(fileURLWithPath: "/usr/sbin", isDirectory: true),
            URL(fileURLWithPath: "/sbin", isDirectory: true)
        ])
        return directories
    }

    private func uniqueAbsoluteDirectories(_ directories: [URL]) -> [URL] {
        var seen: Set<String> = []
        return directories.compactMap { directory in
            guard directory.isFileURL, directory.path.hasPrefix("/") else { return nil }
            let standardized = directory.standardizedFileURL
            guard seen.insert(standardized.path).inserted else {
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
