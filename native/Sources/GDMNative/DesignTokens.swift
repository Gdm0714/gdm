import Foundation
import SwiftUI

private struct GDMReduceMotionEnvironmentKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var gdmReduceMotion: Bool {
        get { self[GDMReduceMotionEnvironmentKey.self] }
        set { self[GDMReduceMotionEnvironmentKey.self] = newValue }
    }
}

enum DesignTokens {
    private static let values: [String: String] = {
        guard let url = Bundle.module.url(forResource: "design-tokens", withExtension: "css"),
              let css = try? String(contentsOf: url, encoding: .utf8) else {
            return [:]
        }

        var result: [String: String] = [:]
        for rawLine in css.split(separator: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("--"), let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colon])
            let valueStart = line.index(after: colon)
            let value = line[valueStart...]
                .trimmingCharacters(in: .whitespaces)
                .replacingOccurrences(of: ";", with: "")
            result[key] = value
        }
        return result
    }()

    static func raw(_ name: String) -> String? { values[name] }

    static func number(_ name: String) -> CGFloat {
        guard let raw = values[name] else { return .zero }
        let filtered = raw.filter { $0.isNumber || $0 == "." || $0 == "-" }
        return CGFloat(Double(filtered) ?? .zero)
    }

    static func milliseconds(_ name: String) -> TimeInterval {
        TimeInterval(number(name)) / 1_000
    }

    static func color(_ name: String) -> Color {
        guard let value = values[name] else { return .clear }
        return Color(tokenHex: value)
    }

    static let surfaceTerminal = color("--surface-terminal")
    static let surfaceStatusBar = color("--surface-status-bar")
    static let surfaceApp = color("--surface-app")
    static let surfacePanel = color("--surface-panel")
    static let surfaceBar = color("--surface-bar")
    static let surfaceHover = color("--surface-hover")
    static let surfaceRaised = color("--surface-raised")
    static let surfaceSelected = color("--surface-selected")

    static let lineStructure = color("--line-structure")
    static let lineSoft = color("--line-soft")
    static let lineControl = color("--line-control")

    static let textStrong = color("--text-strong")
    static let textPrimary = color("--text-primary")
    static let textSecondary = color("--text-secondary")
    static let textTertiary = color("--text-tertiary")
    static let textDisabled = color("--text-disabled")

    static let proven = color("--signal-proven")
    static let active = color("--signal-active")
    static let attention = color("--signal-attention")
    static let blocked = color("--signal-blocked")

    static let labelSize = number("--font-size-label")
    static let metaSize = number("--font-size-meta")
    static let rowSize = number("--font-size-row")
    static let bodySize = number("--font-size-body")
    static let terminalSize = number("--font-size-terminal")
    static let titleSize = number("--font-size-title")

    static let space1 = number("--space-1")
    static let space2 = number("--space-2")
    static let space3 = number("--space-3")
    static let space4 = number("--space-4")
    static let space5 = number("--space-5")

    static let toolbarHeight = number("--toolbar-height")
    static let paneHeaderHeight = number("--pane-header-height")
    static let statusBarHeight = number("--status-bar-height")
    static let taskRailWidth = number("--task-rail-width")
    static let taskRailMinimumWidth = number("--task-rail-min-width")
    static let proofRailWidth = number("--proof-rail-width")
    static let drawerHeight = number("--drawer-height")
    static let rowHeight = number("--row-height")
    static let controlMinimumHeight = number("--control-min-height")
    static let compactBreakpoint = number("--compact-breakpoint")
    static let agentActivityBreakpoint = number("--agent-activity-breakpoint")
    static let agentActivityPopoverWidth = number("--agent-activity-popover-width")
    static let paletteWidth = number("--palette-width")
    static let controlRadius = number("--radius-control")
    static let overlayRadius = number("--radius-overlay")
    static let focusRingWidth = number("--focus-ring-width")
}

enum MotionTokens {
    static let fadeOut = DesignTokens.milliseconds("--motion-fade-out")
    static let fadeIn = DesignTokens.milliseconds("--motion-fade-in")
    static let state = DesignTokens.milliseconds("--motion-state")
    static let settle = DesignTokens.milliseconds("--motion-settle")
    static let progress = DesignTokens.milliseconds("--motion-progress")
    static let panel = DesignTokens.milliseconds("--motion-panel")
    static let pulse = DesignTokens.milliseconds("--motion-pulse")
    static let counterOut = DesignTokens.milliseconds("--motion-counter-out")
    static let counterIn = DesignTokens.milliseconds("--motion-counter-in")
    static let overlayBackdrop = DesignTokens.milliseconds("--motion-overlay-backdrop")
    static let overlaySelector = DesignTokens.milliseconds("--motion-overlay-selector")
    static let overlayPopover = DesignTokens.milliseconds("--motion-overlay-popover")
    static let overlaySheet = DesignTokens.milliseconds("--motion-overlay-sheet")

    static func duration(_ duration: TimeInterval, reduceMotion: Bool) -> TimeInterval {
        reduceMotion ? 0 : duration
    }
}

enum MotionAnimations {
    static func fadeOut(reduceMotion: Bool) -> Animation? {
        easeOut(MotionTokens.fadeOut, reduceMotion: reduceMotion)
    }

    static func fadeIn(reduceMotion: Bool) -> Animation? {
        easeOut(MotionTokens.fadeIn, reduceMotion: reduceMotion)
    }

    static func state(reduceMotion: Bool) -> Animation? {
        easeOut(MotionTokens.state, reduceMotion: reduceMotion)
    }

    static func settle(reduceMotion: Bool) -> Animation? {
        easeOut(MotionTokens.settle, reduceMotion: reduceMotion)
    }

    static func progress(reduceMotion: Bool) -> Animation? {
        guard !reduceMotion else { return nil }
        return .linear(duration: MotionTokens.progress)
    }

    static func panel(reduceMotion: Bool) -> Animation? {
        guard !reduceMotion else { return nil }
        return .timingCurve(0.2, 0, 0, 1, duration: MotionTokens.panel)
    }

    static func hover(reduceMotion: Bool) -> Animation? {
        easeOut(MotionTokens.fadeIn, reduceMotion: reduceMotion)
    }

    static func counterOut(reduceMotion: Bool) -> Animation? {
        easeOut(MotionTokens.counterOut, reduceMotion: reduceMotion)
    }

    static func counterIn(reduceMotion: Bool) -> Animation? {
        easeOut(MotionTokens.counterIn, reduceMotion: reduceMotion)
    }

    static func pulse(isUnsettled: Bool, reduceMotion: Bool) -> Animation? {
        guard MotionPolicy.allowsPulse(isUnsettled: isUnsettled, reduceMotion: reduceMotion) else {
            return nil
        }
        return .easeInOut(duration: MotionTokens.pulse / 2).repeatForever(autoreverses: true)
    }

    static func mount(duration: TimeInterval, reduceMotion: Bool) -> Animation? {
        easeOut(duration, reduceMotion: reduceMotion)
    }

    private static func easeOut(_ duration: TimeInterval, reduceMotion: Bool) -> Animation? {
        guard !reduceMotion else { return nil }
        return .easeOut(duration: duration)
    }
}

enum MotionPolicy {
    static func allowsPulse(isUnsettled: Bool, reduceMotion: Bool) -> Bool {
        isUnsettled && !reduceMotion
    }

    static func shouldSettleCheck(from oldState: CheckDisplayState, to newState: CheckDisplayState) -> Bool {
        guard oldState == .running else { return false }
        return newState == .proven || newState == .redCaptured || newState == .failed
    }

    static func usesExpandedAgentActivity(width: CGFloat) -> Bool {
        width >= DesignTokens.agentActivityBreakpoint
    }
}

private extension Color {
    init(tokenHex value: String) {
        let hex = value.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        guard hex.count == 6, let integer = UInt64(hex, radix: 16) else {
            self = .clear
            return
        }
        let red = Double((integer >> 16) & 255) / 255
        let green = Double((integer >> 8) & 255) / 255
        let blue = Double(integer & 255) / 255
        self.init(.sRGB, red: red, green: green, blue: blue, opacity: 1)
    }
}
