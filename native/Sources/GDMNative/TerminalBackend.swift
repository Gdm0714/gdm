import Foundation

enum TerminalBackendKind: String, Equatable, Sendable {
    case ghostty
    case swiftTerm
}

enum TerminalBackendPreference: Equatable, Sendable {
    case automatic
    case ghostty
    case swiftTerm

    init(environmentValue: String?) {
        switch environmentValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "ghostty": self = .ghostty
        case "swiftterm", "swift-term", "fallback": self = .swiftTerm
        default: self = .automatic
        }
    }
}

/// UI operations requested by Ghostty keybindings. Keeping this boundary
/// backend-neutral lets the workbench honor the user's Ghostty configuration
/// without teaching SwiftUI how to parse multi-key sequences.
enum TerminalHostAction: Equatable, Sendable {
    case split(PaneDirection)
    case focus(PaneFocusTarget)
    case resize(PaneDirection, amount: UInt16)
    case equalizeSplits
    case closePane
}

enum TerminalBackendResolver {
    static func resolve(
        preference: TerminalBackendPreference,
        ghosttyAvailable: Bool
    ) -> TerminalBackendKind {
        switch preference {
        case .swiftTerm:
            return .swiftTerm
        case .automatic, .ghostty:
            // An explicit Ghostty request still fails safely when a build does
            // not contain the pinned framework. This keeps recovery possible.
            return ghosttyAvailable ? .ghostty : .swiftTerm
        }
    }
}

@MainActor
enum TerminalBackendFactory {
    static var ghosttyAvailable: Bool {
        #if canImport(GhosttyKit)
        true
        #else
        false
        #endif
    }

    static func makeDefault(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> any TerminalDriving {
        let preference = TerminalBackendPreference(
            environmentValue: environment["GIDEM_TERMINAL_BACKEND"]
        )
        switch TerminalBackendResolver.resolve(
            preference: preference,
            ghosttyAvailable: ghosttyAvailable
        ) {
        case .ghostty:
            #if canImport(GhosttyKit)
            let runtime = GhosttyRuntime.shared
            guard runtime.isReady else { return SwiftTermTerminalDriver() }
            return GhosttyTerminalDriver(runtime: runtime)
            #else
            return SwiftTermTerminalDriver()
            #endif
        case .swiftTerm:
            return SwiftTermTerminalDriver()
        }
    }
}
