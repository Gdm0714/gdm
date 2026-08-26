import AppKit
import Darwin
import Foundation
import XCTest
@testable import GDMNative

final class AgentLaunchIntegrationTests: XCTestCase {
    private var temporaryDirectories: [URL] = []

    override func tearDownWithError() throws {
        for directory in temporaryDirectories {
            try? FileManager.default.removeItem(at: directory)
        }
        temporaryDirectories.removeAll()
    }

    func testAgentFixturesLaunchWithExactExecutableArgumentsDirectoryAndEnvironment() throws {
        let root = try makeTemporaryDirectory()
        let bin = root.appendingPathComponent("bin", isDirectory: true)
        let worktree = root.appendingPathComponent("worktree with spaces", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: worktree, withIntermediateDirectories: true)

        for agent in [AgentKind.codex, .claude, .gemini] {
            try makeExecutable(
                named: agent.rawValue,
                in: bin,
                contents: """
                #!/bin/sh
                printf 'cwd=%s\\n' "$PWD"
                printf 'argc=%s\\n' "$#"
                printf 'term=%s\\n' "$TERM"
                printf 'color=%s\\n' "$COLORTERM"
                printf 'locale=%s\\n' "$LANG"
                printf 'parent=%s\\n' "$GDM_TEST_PARENT_SENTINEL"
                """
            )
        }

        let catalog = AgentCatalog(
            environment: [
                "PATH": bin.path,
                "GDM_TEST_PARENT_SENTINEL": "preserved"
            ],
            searchDirectories: [bin],
            homeDirectory: root
        )

        for agent in [AgentKind.codex, .claude, .gemini] {
            let specification = try catalog.launchSpecification(
                for: agent,
                workingDirectory: worktree
            )
            XCTAssertEqual(specification.executableURL, bin.appendingPathComponent(agent.rawValue))
            XCTAssertEqual(specification.arguments, [])
            XCTAssertFalse(specification.arguments.contains("-lc"))

            let result = try run(specification)
            XCTAssertEqual(result.exitCode, 0)
            XCTAssertEqual(
                result.output.split(separator: "\n").map(String.init),
                [
                    "cwd=\(canonicalPath(worktree))",
                    "argc=0",
                    "term=xterm-256color",
                    "color=truecolor",
                    "locale=en_US.UTF-8",
                    "parent=preserved"
                ]
            )
        }
    }

    func testInteractiveTerminalEnvironmentDropsInheritedColorOptOuts() throws {
        let root = try makeTemporaryDirectory()
        let bin = root.appendingPathComponent("bin", isDirectory: true)
        let worktree = root.appendingPathComponent("worktree", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: worktree, withIntermediateDirectories: true)
        try makeExecutable(named: "codex", in: bin, contents: "#!/bin/sh\nexit 0\n")

        let catalog = AgentCatalog(
            environment: [
                "PATH": bin.path,
                "TERM": "dumb",
                "COLORTERM": "",
                "NO_COLOR": "1",
                "FORCE_COLOR": "0",
                "CLICOLOR": "0",
                "CLICOLOR_FORCE": "0"
            ],
            searchDirectories: [bin],
            homeDirectory: root
        )

        let specification = try catalog.launchSpecification(
            for: .codex,
            workingDirectory: worktree
        )

        XCTAssertEqual(specification.environment["TERM"], "xterm-256color")
        XCTAssertEqual(specification.environment["COLORTERM"], "truecolor")
        XCTAssertNil(specification.environment["NO_COLOR"])
        XCTAssertNil(specification.environment["FORCE_COLOR"])
        XCTAssertNil(specification.environment["CLICOLOR"])
        XCTAssertNil(specification.environment["CLICOLOR_FORCE"])
    }

    func testShellUsesVerifiedShellDirectlyWithLoginArgument() throws {
        let root = try makeTemporaryDirectory()
        let worktree = root.appendingPathComponent("worktree", isDirectory: true)
        let fixture = root.appendingPathComponent("fixture-shell")
        try FileManager.default.createDirectory(at: worktree, withIntermediateDirectories: true)
        try makeExecutable(at: fixture, contents: "#!/bin/sh\nprintf 'shell-ok\\n'\n")

        let catalog = AgentCatalog(
            environment: ["SHELL": fixture.path, "LANG": "ko_KR.UTF-8"],
            searchDirectories: [],
            homeDirectory: root
        )
        let specification = try catalog.launchSpecification(for: .shell, workingDirectory: worktree)

        XCTAssertEqual(specification.executableURL, fixture)
        XCTAssertEqual(specification.arguments, ["-l"])
        XCTAssertEqual(specification.environment["LANG"], "ko_KR.UTF-8")
        XCTAssertEqual(try run(specification).output, "shell-ok\n")
    }

    func testLaunchEnvironmentStartsOutsideParentMultiplexerSessions() throws {
        let root = try makeTemporaryDirectory()
        let worktree = root.appendingPathComponent("worktree", isDirectory: true)
        let fixture = root.appendingPathComponent("fixture-shell")
        try FileManager.default.createDirectory(at: worktree, withIntermediateDirectories: true)
        try makeExecutable(at: fixture, contents: "#!/bin/sh\nexit 0\n")

        let inheritedSessionEnvironment = [
            "SHELL": fixture.path,
            "PATH": "/usr/bin:/bin",
            "TMUX": "/tmp/tmux/default,100,0",
            "TMUX_PANE": "%3",
            "HERDR_ENV": "1",
            "HERDR_PANE_ID": "pane-parent",
            "HERDR_SOCKET_PATH": "/tmp/herdr.sock",
            "GDMUX_PANE_ID": "gdmux-parent",
            "CMUX_PANE_ID": "cmux-parent",
            "ZELLIJ": "0",
            "ZELLIJ_SESSION_NAME": "parent-session",
            "GDM_TEST_PARENT_SENTINEL": "preserved"
        ]
        let catalog = AgentCatalog(
            environment: inheritedSessionEnvironment,
            searchDirectories: [],
            homeDirectory: root
        )

        let specification = try catalog.launchSpecification(for: .shell, workingDirectory: worktree)

        XCTAssertEqual(specification.environment["GIDEM_TERMINAL"], "1")
        XCTAssertEqual(specification.environment["GDM_TEST_PARENT_SENTINEL"], "preserved")
        for key in inheritedSessionEnvironment.keys where
            key == "TMUX"
                || key == "ZELLIJ"
                || ["TMUX_", "HERDR_", "GDMUX_", "CMUX_", "ZELLIJ_"].contains(where: key.hasPrefix) {
            XCTAssertNil(specification.environment[key], key)
        }
    }

    func testFinderStyleLaunchPathResolvesAgentChildCommandsFromCommonInstallLocations() throws {
        let root = try makeTemporaryDirectory()
        let finderBin = root.appendingPathComponent("finder-system-bin", isDirectory: true)
        let localBin = root.appendingPathComponent(".local/bin", isDirectory: true)
        let bunBin = root.appendingPathComponent(".bun/bin", isDirectory: true)
        let worktree = root.appendingPathComponent("worktree", isDirectory: true)
        try FileManager.default.createDirectory(at: finderBin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: localBin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: bunBin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: worktree, withIntermediateDirectories: true)
        let agent = try makeExecutable(
            named: "codex",
            in: localBin,
            contents: "#!/bin/sh\nnpx\n"
        )
        try makeExecutable(named: "npx", in: localBin, contents: "#!/bin/sh\nprintf 'mcp-ok\\n'\n")

        let catalog = AgentCatalog(
            environment: ["PATH": finderBin.path],
            homeDirectory: root
        )
        let specification = try catalog.launchSpecification(for: .codex, workingDirectory: worktree)
        let pathEntries = try XCTUnwrap(specification.environment["PATH"])
            .split(separator: ":")
            .map(String.init)

        XCTAssertEqual(specification.executableURL, agent)
        XCTAssertEqual(pathEntries.first, finderBin.path)
        XCTAssertTrue(pathEntries.contains(localBin.path))
        XCTAssertTrue(pathEntries.contains(bunBin.path))
        XCTAssertTrue(pathEntries.contains(root.appendingPathComponent(".nix-profile/bin").path))
        XCTAssertTrue(
            pathEntries.contains("/etc/profiles/per-user/\(root.lastPathComponent)/bin")
        )
        XCTAssertTrue(pathEntries.contains("/opt/homebrew/bin"))
        XCTAssertTrue(pathEntries.contains("/usr/local/bin"))
        XCTAssertTrue(pathEntries.contains("/nix/var/nix/profiles/default/bin"))
        XCTAssertTrue(pathEntries.contains("/run/current-system/sw/bin"))
        let result = try run(specification)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.output, "mcp-ok\n")
    }

    func testLaunchPathPreservesInheritedOrderAndRejectsRelativeOrDuplicateEntries() throws {
        let root = try makeTemporaryDirectory()
        let first = root.appendingPathComponent("first", isDirectory: true)
        let second = root.appendingPathComponent("second", isDirectory: true)
        let configured = root.appendingPathComponent("configured", isDirectory: true)
        let relativeSearch = try XCTUnwrap(URL(string: "relative-search"))
        let worktree = root.appendingPathComponent("worktree", isDirectory: true)
        let fixture = root.appendingPathComponent("fixture-shell")
        try FileManager.default.createDirectory(at: worktree, withIntermediateDirectories: true)
        try makeExecutable(at: fixture, contents: "#!/bin/sh\nexit 0\n")
        let inheritedPath = [
            "relative-bin",
            second.path,
            "/opt/homebrew/bin",
            first.path,
            "\(second.path)/.",
            "",
            "../parent-bin"
        ].joined(separator: ":")
        let catalog = AgentCatalog(
            environment: ["SHELL": fixture.path, "PATH": inheritedPath],
            searchDirectories: [first, configured, relativeSearch],
            homeDirectory: root
        )

        let specification = try catalog.launchSpecification(for: .shell, workingDirectory: worktree)
        let pathEntries = try XCTUnwrap(specification.environment["PATH"])
            .split(separator: ":")
            .map(String.init)

        XCTAssertEqual(
            Array(pathEntries.prefix(4)),
            [second.path, "/opt/homebrew/bin", first.path, configured.path]
        )
        XCTAssertTrue(pathEntries.allSatisfy { $0.hasPrefix("/") })
        XCTAssertEqual(pathEntries.count, Set(pathEntries).count)
        XCTAssertEqual(pathEntries.filter { $0 == second.path }.count, 1)
        XCTAssertFalse(pathEntries.contains("relative-bin"))
        XCTAssertFalse(pathEntries.contains("../parent-bin"))
        XCTAssertFalse(pathEntries.contains("relative-search"))
    }

    func testPlanningUsesPinnedGDMExecutableAcrossLoginShellPATH() throws {
        let root = try makeTemporaryDirectory()
        let agentBin = root.appendingPathComponent("agent-bin", isDirectory: true)
        let shadowBin = root.appendingPathComponent("login-shell-shadow", isDirectory: true)
        let pinnedBin = root.appendingPathComponent("app-helper", isDirectory: true)
        let worktree = root.appendingPathComponent("worktree", isDirectory: true)
        for directory in [agentBin, shadowBin, pinnedBin, worktree] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        try makeExecutable(
            named: "codex",
            in: agentBin,
            contents: "#!/bin/sh\nprintf 'pinned=%s\\n' \"$GIDEM_GDM_EXECUTABLE\"\nprintf 'resolved=%s\\n' \"$(command -v gdm)\"\n"
        )
        try makeExecutable(named: "gdm", in: shadowBin, contents: "#!/bin/sh\nexit 99\n")
        let pinnedGDM = try makeExecutable(
            named: "gdm",
            in: pinnedBin,
            contents: "#!/bin/sh\nexit 0\n"
        )
        let catalog = AgentCatalog(
            environment: ["PATH": shadowBin.path],
            searchDirectories: [agentBin],
            homeDirectory: root
        )

        let specification = try catalog.launchSpecification(for: .codex, workingDirectory: worktree)
            .prependingPathDirectory(pinnedBin)
            .addingEnvironment(["GIDEM_GDM_EXECUTABLE": pinnedGDM.path])
        let pathEntries = try XCTUnwrap(specification.environment["PATH"])
            .split(separator: ":")
            .map(String.init)

        XCTAssertEqual(specification.environment["GIDEM_GDM_EXECUTABLE"], pinnedGDM.path)
        XCTAssertEqual(pathEntries.first, pinnedBin.path)
        XCTAssertTrue(pathEntries.contains(shadowBin.path))
        XCTAssertEqual(
            try run(specification).output,
            "pinned=\(pinnedGDM.path)\nresolved=\(pinnedGDM.path)\n"
        )
    }

    func testMissingAgentFailsWithoutFallingBackToAnotherExecutable() throws {
        let root = try makeTemporaryDirectory()
        let bin = root.appendingPathComponent("bin", isDirectory: true)
        let worktree = root.appendingPathComponent("worktree", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: worktree, withIntermediateDirectories: true)
        try makeExecutable(named: "codex", in: bin, contents: "#!/bin/sh\nexit 0\n")

        let catalog = AgentCatalog(
            environment: ["PATH": bin.path],
            searchDirectories: [bin],
            homeDirectory: root
        )

        XCTAssertThrowsError(try catalog.launchSpecification(for: .gemini, workingDirectory: worktree)) {
            guard case AgentCatalogError.executableNotFound(.gemini, let searched) = $0 else {
                return XCTFail("Unexpected error: \($0)")
            }
            XCTAssertEqual(searched, [bin.appendingPathComponent("gemini").path])
        }
    }

    func testNonExecutableAgentIsAnExplicitFailure() throws {
        let root = try makeTemporaryDirectory()
        let bin = root.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let broken = bin.appendingPathComponent("claude")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: broken)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: broken.path)

        let catalog = AgentCatalog(
            environment: ["PATH": bin.path],
            searchDirectories: [bin],
            homeDirectory: root
        )

        XCTAssertThrowsError(try catalog.resolvedExecutable(for: .claude)) {
            XCTAssertEqual(
                $0 as? AgentCatalogError,
                .executableIsNotRunnable(.claude, path: broken.path)
            )
        }
    }

    func testInvalidWorkingDirectoryFailsBeforeLaunch() throws {
        let root = try makeTemporaryDirectory()
        let bin = root.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try makeExecutable(named: "codex", in: bin, contents: "#!/bin/sh\nexit 0\n")
        let missing = root.appendingPathComponent("missing-worktree", isDirectory: true)
        let catalog = AgentCatalog(environment: [:], searchDirectories: [bin], homeDirectory: root)

        XCTAssertThrowsError(try catalog.launchSpecification(for: .codex, workingDirectory: missing)) {
            XCTAssertEqual(
                $0 as? AgentCatalogError,
                .invalidWorkingDirectory(missing.path)
            )
        }
    }

    func testSymlinkWorkingDirectoryIsRejectedWithoutFollowingIt() throws {
        let root = try makeTemporaryDirectory()
        let bin = root.appendingPathComponent("bin", isDirectory: true)
        let target = root.appendingPathComponent("real-worktree", isDirectory: true)
        let symlink = root.appendingPathComponent("mapped-worktree", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            atPath: symlink.path,
            withDestinationPath: target.path
        )
        try makeExecutable(named: "codex", in: bin, contents: "#!/bin/sh\nexit 0\n")
        let catalog = AgentCatalog(environment: [:], searchDirectories: [bin], homeDirectory: root)

        XCTAssertThrowsError(try catalog.launchSpecification(for: .codex, workingDirectory: symlink)) {
            XCTAssertEqual(
                $0 as? AgentCatalogError,
                .invalidWorkingDirectory(symlink.path)
            )
        }
    }

    func testAvailabilityIsNonThrowingAndNeverFallsBackAcrossAgents() throws {
        let root = try makeTemporaryDirectory()
        let bin = root.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try makeExecutable(named: "codex", in: bin, contents: "#!/bin/sh\nexit 0\n")
        let catalog = AgentCatalog(environment: [:], searchDirectories: [bin], homeDirectory: root)

        XCTAssertTrue(catalog.isAvailable(.codex))
        XCTAssertFalse(catalog.isAvailable(.gemini))
        XCTAssertThrowsError(try catalog.resolvedExecutable(for: .gemini)) {
            guard case AgentCatalogError.executableNotFound(.gemini, let searched) = $0 else {
                return XCTFail("Unexpected error: \($0)")
            }
            XCTAssertEqual(searched, [bin.appendingPathComponent("gemini").path])
        }
    }

    func testOfficialApplicationAssetsResolveByExactBundleAndResourceWithoutPixelMutation() throws {
        let root = try makeTemporaryDirectory()
        let fixtures: [(AgentKind, String, String, Int, Int)] = [
            (.codex, "com.openai.codex", "icon-codex-dark-color.png", 7, 5),
            (.claude, "com.anthropic.claudefordesktop", "ion-dist/images/claude_app_icon.png", 9, 6),
            (.gemini, "com.google.GeminiMacOS", "GeminiIcon.png", 11, 8)
        ]
        var applications: [String: URL] = [:]
        var expectedAssets: [AgentKind: URL] = [:]
        for (agent, identifier, resource, width, height) in fixtures {
            let application = try makeApplicationBundle(
                in: root,
                name: agent.displayName,
                identifier: identifier,
                resourcePath: resource,
                pixelWidth: width,
                pixelHeight: height,
                declaresBundleIcon: agent == .gemini
            )
            applications[identifier] = application
            expectedAssets[agent] = application
                .appendingPathComponent("Contents/Resources", isDirectory: true)
                .appendingPathComponent(resource)
        }
        let resolver = AgentIconResolver(
            applicationURLResolver: { applications[$0] },
            applicationIconLoader: { _ in nil }
        )

        for (agent, _, _, width, height) in fixtures {
            guard case .official(let image, let sourceURL) = resolver.resolve(agent) else {
                return XCTFail("Expected official image for \(agent)")
            }
            XCTAssertEqual(sourceURL.standardizedFileURL, expectedAssets[agent]?.standardizedFileURL)
            let representation = try XCTUnwrap(image.representations.first)
            XCTAssertEqual(representation.pixelsWide, width)
            XCTAssertEqual(representation.pixelsHigh, height)
        }
    }

    func testIconResolverRejectsWrongBundleAndUsesExactFallbacks() throws {
        let root = try makeTemporaryDirectory()
        let impostor = try makeApplicationBundle(
            in: root,
            name: "Impostor",
            identifier: "example.impostor",
            resourcePath: "icon-codex-dark-color.png",
            pixelWidth: 4,
            pixelHeight: 4,
            declaresBundleIcon: false
        )
        let resolver = AgentIconResolver(applicationURLResolver: { _ in impostor })

        guard case .monogram(let codex) = resolver.resolve(.codex) else {
            return XCTFail("Unverified app bundle must not supply Codex artwork")
        }
        XCTAssertEqual(codex, "CX")
        guard case .monogram(let claude) = resolver.resolve(.claude) else {
            return XCTFail("Expected Claude fallback")
        }
        XCTAssertEqual(claude, "CL")
        guard case .monogram(let gemini) = resolver.resolve(.gemini) else {
            return XCTFail("Expected Gemini fallback")
        }
        XCTAssertEqual(gemini, "GM")
        guard case .systemSymbol(let shell) = resolver.resolve(.shell) else {
            return XCTFail("Expected Shell system symbol")
        }
        XCTAssertEqual(shell, "terminal")
    }

    func testSupportedAgentsAndToolbarOrderAreExplicit() {
        XCTAssertEqual(AgentKind.allCases, [.shell, .codex, .claude, .gemini])
        XCTAssertEqual(AgentKind.toolbarCases, [.codex, .claude, .gemini])
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("gdm-agent-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        temporaryDirectories.append(directory)
        return directory
    }

    @discardableResult
    private func makeExecutable(named name: String, in directory: URL, contents: String) throws -> URL {
        let url = directory.appendingPathComponent(name)
        try makeExecutable(at: url, contents: contents)
        return url
    }

    private func makeExecutable(at url: URL, contents: String) throws {
        try Data(contents.utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    private func makeApplicationBundle(
        in root: URL,
        name: String,
        identifier: String,
        resourcePath: String,
        pixelWidth: Int,
        pixelHeight: Int,
        declaresBundleIcon: Bool
    ) throws -> URL {
        let application = root.appendingPathComponent("\(name).app", isDirectory: true)
        let contents = application.appendingPathComponent("Contents", isDirectory: true)
        let resources = contents.appendingPathComponent("Resources", isDirectory: true)
        let resourceURL = resources.appendingPathComponent(resourcePath)
        try FileManager.default.createDirectory(
            at: resourceURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        var info: [String: Any] = [
            "CFBundleIdentifier": identifier,
            "CFBundlePackageType": "APPL",
            "CFBundleName": name
        ]
        if declaresBundleIcon {
            info["CFBundleIconFile"] = resourcePath
        }
        let plist = try PropertyListSerialization.data(
            fromPropertyList: info,
            format: .xml,
            options: 0
        )
        try plist.write(to: contents.appendingPathComponent("Info.plist"))
        try makePNG(width: pixelWidth, height: pixelHeight).write(to: resourceURL)
        return application
    }

    private func makePNG(width: Int, height: Int) throws -> Data {
        let bitmap = try XCTUnwrap(
            NSBitmapImageRep(
                bitmapDataPlanes: nil,
                pixelsWide: width,
                pixelsHigh: height,
                bitsPerSample: 8,
                samplesPerPixel: 4,
                hasAlpha: true,
                isPlanar: false,
                colorSpaceName: .deviceRGB,
                bytesPerRow: 0,
                bitsPerPixel: 0
            )
        )
        bitmap.setColor(
            NSColor(deviceRed: 0.15, green: 0.45, blue: 0.85, alpha: 1),
            atX: 0,
            y: 0
        )
        return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }

    private func run(_ specification: AgentLaunchSpecification) throws -> (exitCode: Int32, output: String) {
        let outputPipe = Pipe()
        let process = Process()
        process.executableURL = specification.executableURL
        process.arguments = specification.arguments
        process.environment = specification.environment
        process.currentDirectoryURL = specification.currentDirectory
        process.standardOutput = outputPipe
        process.standardError = outputPipe
        try process.run()
        process.waitUntilExit()
        let output = String(decoding: outputPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return (process.terminationStatus, output)
    }

    private func canonicalPath(_ url: URL) -> String {
        guard let resolved = url.path.withCString({ Darwin.realpath($0, nil) }) else {
            return url.path
        }
        defer { Darwin.free(resolved) }
        return String(cString: resolved)
    }
}
