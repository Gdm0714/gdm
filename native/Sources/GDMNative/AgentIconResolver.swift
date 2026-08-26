import AppKit
import Foundation

enum AgentIconResolution {
    case official(image: NSImage, sourceURL: URL)
    case monogram(String)
    case systemSymbol(String)

    var image: NSImage? {
        guard case .official(let image, _) = self else { return nil }
        return image
    }

    var sourceURL: URL? {
        guard case .official(_, let sourceURL) = self else { return nil }
        return sourceURL
    }

    var fallbackText: String? {
        guard case .monogram(let value) = self else { return nil }
        return value
    }

    var systemSymbolName: String? {
        guard case .systemSymbol(let value) = self else { return nil }
        return value
    }
}

/// Resolves brand artwork only from an installed, bundle-ID-verified vendor
/// application. The returned NSImage is the source image as loaded: no sizing,
/// tinting, cropping, compositing, or other pixel mutation is performed here.
struct AgentIconResolver {
    typealias ApplicationURLResolver = (_ bundleIdentifier: String) -> URL?
    typealias ApplicationIconLoader = (_ applicationURL: URL) -> NSImage?

    private struct VendorApplication {
        let bundleIdentifier: String
        let preferredResourcePath: String?
    }

    private let applicationURLResolver: ApplicationURLResolver
    private let applicationIconLoader: ApplicationIconLoader
    private let fileManager: FileManager

    init(
        applicationURLResolver: ApplicationURLResolver? = nil,
        applicationIconLoader: ApplicationIconLoader? = nil,
        fileManager: FileManager = .default
    ) {
        self.applicationURLResolver = applicationURLResolver ?? { bundleIdentifier in
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier)
        }
        self.applicationIconLoader = applicationIconLoader ?? { applicationURL in
            NSWorkspace.shared.icon(forFile: applicationURL.path)
        }
        self.fileManager = fileManager
    }

    func resolve(_ agent: AgentKind) -> AgentIconResolution {
        if agent == .shell {
            return .systemSymbol("terminal")
        }
        guard let sourceURL = officialAssetURL(for: agent) else {
            return .monogram(Self.monogram(for: agent))
        }

        if sourceURL.pathExtension == "app",
           let image = applicationIconLoader(sourceURL) {
            return .official(image: image, sourceURL: sourceURL)
        }
        guard let image = NSImage(contentsOf: sourceURL) else {
            return .monogram(Self.monogram(for: agent))
        }
        return .official(image: image, sourceURL: sourceURL)
    }

    /// Returns a verified source location without loading or transforming it.
    /// Gemini may return the `.app` URL when its icon is compiled into Assets.car;
    /// in that case NSWorkspace supplies the bundle's official application icon.
    func officialAssetURL(for agent: AgentKind) -> URL? {
        guard let vendor = Self.vendorApplication(for: agent),
              let applicationURL = applicationURLResolver(vendor.bundleIdentifier)?.standardizedFileURL,
              let bundle = Bundle(url: applicationURL),
              bundle.bundleIdentifier == vendor.bundleIdentifier else {
            return nil
        }

        if let preferredResourcePath = vendor.preferredResourcePath,
           let preferredURL = containedResource(
               preferredResourcePath,
               applicationURL: applicationURL
           ),
           canLoadImage(at: preferredURL) {
            return preferredURL
        }

        if let declaredIconURL = declaredBundleIconURL(
            bundle: bundle,
            applicationURL: applicationURL
        ), canLoadImage(at: declaredIconURL) {
            return declaredIconURL
        }

        // Gemini's modern asset-catalog icon may not exist as a standalone file.
        // The app bundle itself remains the verified source for NSWorkspace.
        if agent == .gemini, applicationIconLoader(applicationURL) != nil {
            return applicationURL
        }
        return nil
    }

    private func containedResource(
        _ relativePath: String,
        applicationURL: URL
    ) -> URL? {
        let resourcesURL = applicationURL
            .appendingPathComponent("Contents/Resources", isDirectory: true)
            .standardizedFileURL
        let candidate = resourcesURL
            .appendingPathComponent(relativePath, isDirectory: false)
            .standardizedFileURL
        guard candidate.path.hasPrefix(resourcesURL.path + "/"),
              fileManager.fileExists(atPath: candidate.path) else {
            return nil
        }
        return candidate
    }

    private func declaredBundleIconURL(
        bundle: Bundle,
        applicationURL: URL
    ) -> URL? {
        guard let declaredName = bundle.object(forInfoDictionaryKey: "CFBundleIconFile") as? String,
              !declaredName.isEmpty else {
            return nil
        }
        let candidates = declaredName.hasSuffix(".icns")
            ? [declaredName]
            : [declaredName, declaredName + ".icns"]
        return candidates.lazy.compactMap {
            containedResource($0, applicationURL: applicationURL)
        }.first
    }

    private func canLoadImage(at url: URL) -> Bool {
        NSImage(contentsOf: url) != nil
    }

    private static func vendorApplication(for agent: AgentKind) -> VendorApplication? {
        switch agent {
        case .codex:
            VendorApplication(
                bundleIdentifier: "com.openai.codex",
                preferredResourcePath: "icon-codex-dark-color.png"
            )
        case .claude:
            VendorApplication(
                bundleIdentifier: "com.anthropic.claudefordesktop",
                preferredResourcePath: "ion-dist/images/claude_app_icon.png"
            )
        case .gemini:
            VendorApplication(
                bundleIdentifier: "com.google.GeminiMacOS",
                preferredResourcePath: nil
            )
        case .shell:
            nil
        }
    }

    private static func monogram(for agent: AgentKind) -> String {
        switch agent {
        case .codex: "CX"
        case .claude: "CL"
        case .gemini: "GM"
        case .shell: "SH"
        }
    }
}
