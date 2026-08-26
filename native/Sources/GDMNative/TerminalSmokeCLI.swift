import AppKit
import Darwin
import Foundation

enum TerminalSmokeCLI {
    static let codexSmokeMarker = "GIDEM_CODEX_SMOKE_OK"
    static let codexSmokeOptInVariable = "GIDEM_RUN_CODEX_SMOKE"
    static let codexSmokeTimeoutVariable = "GIDEM_CODEX_SMOKE_TIMEOUT_SECONDS"

    static func isInvocation(_ arguments: [String]) -> Bool {
        arguments.contains("--terminal-smoke") || arguments.contains("--codex-smoke")
    }

    @MainActor
    static func run(
        arguments: [String],
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Int32 {
        if arguments.contains("--codex-smoke") {
            return runCodexSmoke(environment: environment)
        }
        return runTerminalSmoke()
    }

    static func codexSmokeIsOptedIn(environment: [String: String]) -> Bool {
        environment[codexSmokeOptInVariable] == "1"
    }

    static func codexSmokeTimeout(environment: [String: String]) -> TimeInterval {
        guard let value = environment[codexSmokeTimeoutVariable],
              let seconds = TimeInterval(value),
              seconds.isFinite else { return 180 }
        return min(600, max(15, seconds))
    }

    static func codexSmokeArguments(
        outputURL: URL,
        marker: String = codexSmokeMarker
    ) -> [String] {
        [
            "--sandbox", "read-only",
            "--ask-for-approval", "never",
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--color", "never",
            "--output-last-message", outputURL.path,
            codexSmokePrompt(marker: marker)
        ]
    }

    static func codexSmokePrompt(marker: String = codexSmokeMarker) -> String {
        "This is a no-write transport smoke test. "
            + "Do not inspect the repository, call tools, or run commands. "
            + "Reply with exactly \(marker) and nothing else."
    }

    #if canImport(GhosttyKit)
    @MainActor
    private static func runTerminalSmoke() -> Int32 {
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)

        let runtime = GhosttyRuntime.shared
        guard runtime.isReady,
              let resources = GhosttyResourceLocator.liveLocation() else {
            writeError("Ghostty runtime unavailable: \(runtime.initializationError ?? "unknown error")")
            return 70
        }

        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "gidem-terminal-smoke-\(UUID().uuidString)",
            isDirectory: true
        )
        let ready = root.appendingPathComponent("ready", isDirectory: false)
        let result = root.appendingPathComponent("result", isDirectory: false)
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        } catch {
            writeError("Terminal smoke fixture failed: \(error.localizedDescription)")
            return 74
        }
        defer { try? FileManager.default.removeItem(at: root) }

        let driver = GhosttyTerminalDriver(runtime: runtime)
        let window = makeHeadlessWindow(driver: driver)
        defer {
            driver.terminate()
            window.contentView = nil
        }

        var didExit = false
        var rawStatus: Int32?
        driver.onProcessTerminated = { status in
            rawStatus = status
            didExit = true
        }
        let script = """
        /usr/bin/printf ready > "$1"
        IFS= read -r answer
        /usr/bin/infocmp xterm-ghostty >/dev/null 2>&1 || exit 41
        /usr/bin/printf '%s\\n%s\\n%s\\n' "$answer" "$GHOSTTY_RESOURCES_DIR" "$TERMINFO" > "$2"
        """
        let specification = AgentLaunchSpecification(
            agent: .shell,
            executableURL: URL(fileURLWithPath: "/bin/zsh"),
            arguments: ["-f", "-c", script, "gidem-terminal-smoke", ready.path, result.path],
            environment: [
                "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"
            ],
            currentDirectory: root
        )
        driver.start(specification)
        guard driver.isRunning else {
            writeError("Ghostty did not create the smoke PTY")
            return 70
        }
        guard waitUntil(timeout: 5, condition: {
            FileManager.default.fileExists(atPath: ready.path)
        }) else {
            writeError("Ghostty smoke shell did not become interactive")
            return 75
        }

        driver.send(Array("gidem-ready-한글\n".utf8))
        guard waitUntil(timeout: 10, condition: { didExit }) else {
            writeError("Ghostty smoke shell did not exit")
            return 75
        }
        guard TerminalSession.decodeWaitStatus(rawStatus) == .exited(0),
              let output = try? String(contentsOf: result, encoding: .utf8) else {
            writeError("Ghostty smoke shell failed its terminfo check")
            return 1
        }
        let lines = output.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let expectedGhostty = resources.ghosttyDirectory.standardizedFileURL.path
        let expectedTerminfo = resources.terminfoDirectory.standardizedFileURL.path
        guard lines.count >= 3,
              lines[0] == "gidem-ready-한글",
              lines[1] == expectedGhostty,
              lines[2] == expectedTerminfo else {
            writeError("Ghostty smoke environment did not use Gidem's pinned resources")
            return 1
        }

        print("Terminal smoke passed: resources=\(expectedGhostty)")
        return 0
    }

    @MainActor
    private static func runCodexSmoke(environment: [String: String]) -> Int32 {
        guard codexSmokeIsOptedIn(environment: environment) else {
            writeError(
                "Codex smoke is opt-in because it uses an authenticated model request. "
                    + "Set \(codexSmokeOptInVariable)=1 to run it."
            )
            return 77
        }

        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)

        let runtime = GhosttyRuntime.shared
        guard runtime.isReady, GhosttyResourceLocator.liveLocation() != nil else {
            writeError("Ghostty runtime unavailable: \(runtime.initializationError ?? "unknown error")")
            return 70
        }

        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "gidem-codex-smoke-\(UUID().uuidString)",
            isDirectory: true
        )
        let repository = root.appendingPathComponent("repository", isDirectory: true)
        let outputURL = root.appendingPathComponent("last-message.txt", isDirectory: false)
        do {
            try FileManager.default.createDirectory(
                at: repository,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            writeError("Codex smoke fixture failed: \(error.localizedDescription)")
            return 74
        }
        defer { try? FileManager.default.removeItem(at: root) }

        var gitEnvironment = environment
        gitEnvironment["GIT_CONFIG_NOSYSTEM"] = "1"
        gitEnvironment["GIT_CONFIG_GLOBAL"] = "/dev/null"
        let git = CommandRunner.run(
            executable: "/usr/bin/git",
            arguments: ["init", "--quiet", "--initial-branch=gidem-smoke", "--template="],
            directory: repository,
            environment: gitEnvironment
        )
        guard git.exitCode == 0 else {
            writeError("Codex smoke could not initialize its disposable Git repository")
            return 74
        }

        let baseSpecification: AgentLaunchSpecification
        do {
            baseSpecification = try AgentCatalog(environment: environment).launchSpecification(
                for: .codex,
                workingDirectory: repository
            )
        } catch {
            writeError("Codex smoke prerequisite unavailable: \(error.localizedDescription)")
            return 77
        }

        let before: CodexSmokeRepositorySnapshot
        do {
            before = try CodexSmokeRepositorySnapshot.capture(root: repository)
        } catch {
            writeError("Codex smoke could not snapshot its repository: \(error.localizedDescription)")
            return 74
        }

        let driver = GhosttyTerminalDriver(runtime: runtime)
        let window = makeHeadlessWindow(driver: driver)
        defer {
            driver.terminate()
            window.contentView = nil
        }

        var didExit = false
        var rawStatus: Int32?
        driver.onProcessTerminated = { status in
            rawStatus = status
            didExit = true
        }

        var codexEnvironment = baseSpecification.environment
        codexEnvironment["NO_COLOR"] = "1"
        let specification = AgentLaunchSpecification(
            agent: .codex,
            executableURL: baseSpecification.executableURL,
            arguments: codexSmokeArguments(outputURL: outputURL),
            environment: codexEnvironment,
            currentDirectory: repository
        )
        driver.start(specification)
        guard driver.isRunning else {
            writeError("Ghostty did not create the Codex smoke PTY")
            return 70
        }

        let timeout = codexSmokeTimeout(environment: environment)
        guard waitUntil(timeout: timeout, condition: { didExit }) else {
            writeError("Codex smoke timed out after \(Int(timeout)) seconds")
            return 75
        }

        let after: CodexSmokeRepositorySnapshot
        do {
            after = try CodexSmokeRepositorySnapshot.capture(root: repository)
        } catch {
            writeError("Codex smoke could not verify its repository: \(error.localizedDescription)")
            return 74
        }
        let changedPaths = after.changedPaths(comparedTo: before)
        guard changedPaths.isEmpty else {
            writeError(
                "Codex smoke changed its read-only repository: "
                    + changedPaths.prefix(12).joined(separator: ", ")
            )
            return 1
        }

        guard TerminalSession.decodeWaitStatus(rawStatus) == .exited(0) else {
            writeError("Codex smoke process did not exit successfully")
            return 1
        }
        guard let response = try? String(contentsOf: outputURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
              response == codexSmokeMarker else {
            writeError("Codex smoke response did not match the deterministic marker")
            return 1
        }

        print(
            "Codex smoke passed: marker=\(codexSmokeMarker) "
                + "sandbox=read-only ephemeral=true repository=unchanged"
        )
        return 0
    }

    @MainActor
    private static func makeHeadlessWindow(driver: GhosttyTerminalDriver) -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 420),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = driver.hostedView
        driver.resize(to: window.contentView?.bounds.size ?? NSSize(width: 720, height: 420))
        return window
    }
    #else
    @MainActor
    private static func runTerminalSmoke() -> Int32 {
        writeError("This build does not contain GhosttyKit")
        return 78
    }

    @MainActor
    private static func runCodexSmoke(environment _: [String: String]) -> Int32 {
        writeError("This build does not contain GhosttyKit")
        return 78
    }
    #endif

    @MainActor
    private static func waitUntil(timeout: TimeInterval, condition: () -> Bool) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.01))
        }
        return condition()
    }

    private static func writeError(_ message: String) {
        FileHandle.standardError.write(Data("\(message)\n".utf8))
    }
}

struct CodexSmokeRepositorySnapshot: Equatable {
    enum Kind: String, Equatable {
        case directory
        case regularFile
        case symbolicLink
        case other
    }

    struct Entry: Equatable {
        let kind: Kind
        let permissions: mode_t
        let payload: Data
    }

    let entries: [String: Entry]

    static func capture(root: URL) throws -> Self {
        var entries: [String: Entry] = [:]
        try capture(url: root, relativePath: ".", entries: &entries)
        return Self(entries: entries)
    }

    func changedPaths(comparedTo baseline: Self) -> [String] {
        Set(entries.keys)
            .union(baseline.entries.keys)
            .filter { entries[$0] != baseline.entries[$0] }
            .sorted()
    }

    private static func capture(
        url: URL,
        relativePath: String,
        entries: inout [String: Entry]
    ) throws {
        var information = stat()
        guard url.path.withCString({ Darwin.lstat($0, &information) }) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }

        let permissions = information.st_mode & mode_t(0o7777)
        switch information.st_mode & mode_t(S_IFMT) {
        case mode_t(S_IFDIR):
            entries[relativePath] = Entry(
                kind: .directory,
                permissions: permissions,
                payload: Data()
            )
            let children = try FileManager.default.contentsOfDirectory(
                at: url,
                includingPropertiesForKeys: nil,
                options: []
            ).sorted { $0.lastPathComponent < $1.lastPathComponent }
            for child in children {
                let childPath = relativePath == "."
                    ? child.lastPathComponent
                    : "\(relativePath)/\(child.lastPathComponent)"
                try capture(url: child, relativePath: childPath, entries: &entries)
            }
        case mode_t(S_IFREG):
            entries[relativePath] = Entry(
                kind: .regularFile,
                permissions: permissions,
                payload: try Data(contentsOf: url, options: [.mappedIfSafe])
            )
        case mode_t(S_IFLNK):
            let destination = try FileManager.default.destinationOfSymbolicLink(atPath: url.path)
            entries[relativePath] = Entry(
                kind: .symbolicLink,
                permissions: permissions,
                payload: Data(destination.utf8)
            )
        default:
            entries[relativePath] = Entry(
                kind: .other,
                permissions: permissions,
                payload: Data()
            )
        }
    }
}
