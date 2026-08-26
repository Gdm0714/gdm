import Foundation

struct GhosttyResourceLocation: Equatable, Sendable {
    let ghosttyDirectory: URL
    let terminfoDirectory: URL
}

/// Locates only the resources built from Gidem's pinned Ghostty revision.
/// In particular, an inherited `GHOSTTY_RESOURCES_DIR` from another terminal
/// is never trusted: it may describe a different Ghostty ABI or disappear when
/// that terminal is uninstalled.
enum GhosttyResourceLocator {
    static let pinnedCommit = "bb876a0d286b661089b7f40dd3a6488d629beffe"

    static func liveLocation(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundleResourceURL: URL? = Bundle.main.resourceURL,
        currentDirectory: URL = URL(
            fileURLWithPath: FileManager.default.currentDirectoryPath,
            isDirectory: true
        ),
        sourceFile: StaticString = #filePath
    ) -> GhosttyResourceLocation? {
        var candidates: [URL] = []
        if let override = environment["GIDEM_GHOSTTY_RESOURCES_DIR"], !override.isEmpty {
            candidates.append(URL(fileURLWithPath: override, isDirectory: true))
        }
        if let bundleResourceURL {
            candidates.append(bundleResourceURL.appendingPathComponent("ghostty", isDirectory: true))
        }

        let artifactSuffix = ".build/ghostty/artifacts/\(pinnedCommit)/native/Resources/ghostty"
        candidates.append(currentDirectory.appendingPathComponent(artifactSuffix, isDirectory: true))
        candidates.append(
            currentDirectory
                .appendingPathComponent("native", isDirectory: true)
                .appendingPathComponent(artifactSuffix, isDirectory: true)
        )

        let nativeDirectory = URL(fileURLWithPath: String(describing: sourceFile))
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        candidates.append(nativeDirectory.appendingPathComponent(artifactSuffix, isDirectory: true))

        var visited = Set<String>()
        for candidate in candidates {
            let normalized = candidate.standardizedFileURL
            guard visited.insert(normalized.path).inserted else { continue }
            if let location = validate(ghosttyDirectory: normalized) { return location }
        }
        return nil
    }

    static func validate(ghosttyDirectory: URL) -> GhosttyResourceLocation? {
        let ghosttyDirectory = ghosttyDirectory.standardizedFileURL
        let resourcesDirectory = ghosttyDirectory.deletingLastPathComponent()
        let terminfoDirectory = resourcesDirectory.appendingPathComponent("terminfo", isDirectory: true)
        let shellIntegration = ghosttyDirectory
            .appendingPathComponent("shell-integration", isDirectory: true)
            .appendingPathComponent("zsh", isDirectory: true)
            .appendingPathComponent("ghostty-integration", isDirectory: false)
        let terminfoSentinel = terminfoDirectory
            .appendingPathComponent("78", isDirectory: true)
            .appendingPathComponent("xterm-ghostty", isDirectory: false)

        guard isRegularFileWithoutSymlink(shellIntegration),
              isRegularFileWithoutSymlink(terminfoSentinel) else { return nil }
        return GhosttyResourceLocation(
            ghosttyDirectory: ghosttyDirectory,
            terminfoDirectory: terminfoDirectory
        )
    }

    private static func isRegularFileWithoutSymlink(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [
            .isRegularFileKey,
            .isSymbolicLinkKey
        ]) else { return false }
        return values.isRegularFile == true && values.isSymbolicLink != true
    }
}
