#!/usr/bin/env swift

import AppKit
import ApplicationServices
import Darwin
import Foundation

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: accessibility-smoke.swift <Gidem executable> <repository>\n".utf8))
    exit(64)
}
guard AXIsProcessTrusted() else {
    FileHandle.standardError.write(Data("Accessibility permission is required for AX tree verification.\n".utf8))
    exit(77)
}

let executable = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
let repository = URL(
    fileURLWithPath: CommandLine.arguments[2],
    isDirectory: true
).standardizedFileURL
guard FileManager.default.isExecutableFile(atPath: executable.path) else {
    FileHandle.standardError.write(Data("Gidem executable is not runnable: \(executable.path)\n".utf8))
    exit(66)
}

let process = Process()
process.executableURL = executable
process.arguments = [
    "--repo", repository.path,
    "--demo",
    "--demo-state", "agent-operations-popover",
    "--background-qa",
    "--reduce-motion",
    "--width", "1440",
    "--height", "900"
]
try process.run()

func terminateOwnedProcess() {
    if process.isRunning {
        NSRunningApplication(processIdentifier: process.processIdentifier)?.terminate()
        let deadline = Date(timeIntervalSinceNow: 2)
        while process.isRunning, Date() < deadline {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        }
        if process.isRunning { process.terminate() }
    }
}

defer { terminateOwnedProcess() }

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    // `exit` does not unwind Swift `defer` scopes. Clean up the exact process
    // started by this smoke before returning a failing status.
    terminateOwnedProcess()
    Darwin.exit(code)
}

let application = AXUIElementCreateApplication(process.processIdentifier)

func attribute(_ name: String, of element: AXUIElement) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

struct AccessibleNode {
    let element: AXUIElement
    let labels: [String]
    let identifier: String?
}

func accessibleNodes(in application: AXUIElement) -> [AccessibleNode] {
    var result: [AccessibleNode] = []
    // SwiftUI may replace its hosted accessibility hierarchy after an action.
    // Ask AX for a fresh application root on every traversal so a stale bridge
    // object cannot make the whole window appear to have no children.
    let currentApplication = AXUIElementCreateApplication(process.processIdentifier)
    func visit(_ element: AXUIElement, depth: Int) {
        guard depth < 48 else { return }
        var nodeLabels: [String] = []
        for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXValueAttribute] {
            if let value = attribute(name, of: element) as? String,
               !value.isEmpty,
               value.utf8.count <= 2_048 {
                nodeLabels.append(value)
            }
        }
        result.append(AccessibleNode(
            element: element,
            labels: nodeLabels,
            identifier: attribute(kAXIdentifierAttribute, of: element) as? String
        ))
        guard let children = attribute(kAXChildrenAttribute, of: element) as? [AXUIElement] else {
            return
        }
        for child in children { visit(child, depth: depth + 1) }
    }
    visit(currentApplication, depth: 0)
    return result
}

func actionNames(of element: AXUIElement) -> [String] {
    var value: CFArray?
    guard AXUIElementCopyActionNames(element, &value) == .success else { return [] }
    return value as? [String] ?? []
}

func flattenedLabels(_ nodes: [AccessibleNode]) -> [String] {
    nodes.flatMap(\.labels)
}

func waitForNodes(
    timeout: TimeInterval,
    matching predicate: ([AccessibleNode]) -> Bool
) -> [AccessibleNode]? {
    let deadline = Date(timeIntervalSinceNow: timeout)
    repeat {
        let nodes = accessibleNodes(in: application)
        if predicate(nodes) { return nodes }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    } while process.isRunning && Date() < deadline
    return nil
}

func layoutState(in nodes: [AccessibleNode]) -> (paneCount: Int, focus: Int)? {
    let expression = try! NSRegularExpression(
        pattern: #"^Workbench layout, ([0-9]+) panes, focus ([0-9]+)$"#
    )
    for label in flattenedLabels(nodes) {
        let range = NSRange(label.startIndex..<label.endIndex, in: label)
        guard let match = expression.firstMatch(in: label, range: range),
              let countRange = Range(match.range(at: 1), in: label),
              let focusRange = Range(match.range(at: 2), in: label),
              let paneCount = Int(label[countRange]),
              let focus = Int(label[focusRange]) else { continue }
        return (paneCount, focus)
    }
    return nil
}

func sendKey(_ keyCode: CGKeyCode, flags: CGEventFlags) {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        fail("Could not create a keyboard event.")
    }
    down.flags = flags
    up.flags = flags
    down.postToPid(process.processIdentifier)
    up.postToPid(process.processIdentifier)
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.08))
}

func actionElement(titled title: String, in nodes: [AccessibleNode]) -> AccessibleNode? {
    let identifierPrefix = "gidem.agent-activity.action."
    let identifierSuffix = ".\(title.lowercased())"
    return nodes.first { node in
        node.identifier?.hasPrefix(identifierPrefix) == true
            && node.identifier?.hasSuffix(identifierSuffix) == true
            && !actionNames(of: node.element).isEmpty
    } ?? nodes.first { node in
        node.labels.contains { $0.compare(title, options: .caseInsensitive) == .orderedSame }
            && !actionNames(of: node.element).isEmpty
    }
}

func hasActivityPopover(in nodes: [AccessibleNode]) -> Bool {
    nodes.contains { $0.identifier == "gidem.agent-activity.popover" }
}

func activityDiagnostic(in nodes: [AccessibleNode]) -> String {
    let actionRows = nodes.compactMap { node -> String? in
        guard node.identifier?.hasPrefix("gidem.agent-activity") == true
                || node.labels.contains(where: { ["Focus", "Diff", "Proof", "Handoff", "Stop"].contains($0) })
        else { return nil }
        return "id=\(node.identifier ?? "-") labels=\(node.labels.joined(separator: " | ")) actions=\(actionNames(of: node.element).joined(separator: ","))"
    }
    let runningApplication = NSRunningApplication(processIdentifier: process.processIdentifier)
    let ownedWindows = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? [])
        .filter { ($0[kCGWindowOwnerPID as String] as? Int32) == process.processIdentifier }
        .map { window in
            let number = window[kCGWindowNumber as String] ?? "-"
            let layer = window[kCGWindowLayer as String] ?? "-"
            let onScreen = window[kCGWindowIsOnscreen as String] ?? "-"
            return "number=\(number),layer=\(layer),onScreen=\(onScreen)"
        }
        .joined(separator: ";")
    let header = "processRunning=\(process.isRunning) nodeCount=\(nodes.count) "
        + "active=\(runningApplication?.isActive ?? false) hidden=\(runningApplication?.isHidden ?? false) "
        + "terminated=\(runningApplication?.isTerminated ?? true) windows=[\(ownedWindows)]"
    if actionRows.isEmpty {
        let samples = flattenedLabels(nodes).prefix(24).joined(separator: " | ")
        return "\(header)\nno Agent Activity AX nodes\nsampleLabels=\(samples)"
    }
    return "\(header)\n" + actionRows.joined(separator: "\n")
}

@discardableResult
func performKeyboardAccessibleAction(titled title: String) -> Bool {
    guard let nodes = waitForNodes(timeout: 2, matching: { actionElement(titled: title, in: $0) != nil }),
          let node = actionElement(titled: title, in: nodes) else { return false }
    let supported = actionNames(of: node.element)
    let action = [kAXPressAction, kAXShowMenuAction].first(where: supported.contains)
    guard let action else { return false }
    return AXUIElementPerformAction(node.element, action as CFString) == .success
}

let requiredFragments = [
    "Agent Activity",
    "Agent Activity 상세",
    "대화형 PTY 세션",
    "Codex, Needs You",
    "Claude, active",
    "Gemini, verifying",
    "Shell, handing off",
    "Focus",
    "Stop",
    "Handoff",
    "Diff",
    "Proof"
]
let deadline = Date(timeIntervalSinceNow: 8)
var observedLabels: [String] = []
var missing = requiredFragments

repeat {
    observedLabels = flattenedLabels(accessibleNodes(in: application))
    missing = requiredFragments.filter { fragment in
        !observedLabels.contains { $0.localizedCaseInsensitiveContains(fragment) }
    }
    if missing.isEmpty { break }
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
} while process.isRunning && Date() < deadline

guard process.isRunning else {
    fail("Gidem exited before accessibility verification completed.", code: 70)
}
guard missing.isEmpty else {
    let diagnostic = """
    Accessibility labels missing: \(missing.joined(separator: ", "))
    Observed labels:
    \(Array(Set(observedLabels)).sorted().joined(separator: "\n"))
    """
    fail(diagnostic)
}

guard let initialNodes = waitForNodes(timeout: 2, matching: { layoutState(in: $0)?.paneCount == 4 }),
      let initialLayout = layoutState(in: initialNodes) else {
    fail("The live four-pane workbench state was not exposed to accessibility.")
}

// Exercise the same shortcuts a keyboard-only operator uses. The dynamic AX
// summary proves that SwiftUI received each command and changed live state.
sendKey(0x02, flags: [.maskCommand]) // ⌘D · split right
guard waitForNodes(timeout: 2, matching: { layoutState(in: $0)?.paneCount == 5 }) != nil else {
    fail("⌘D did not create a fifth pane.")
}
sendKey(0x28, flags: [.maskCommand, .maskShift]) // ⇧⌘K · close pane
guard let restoredNodes = waitForNodes(timeout: 2, matching: { layoutState(in: $0)?.paneCount == 4 }),
      let restoredLayout = layoutState(in: restoredNodes) else {
    fail("⇧⌘K did not restore the four-pane layout.")
}
sendKey(0x7C, flags: [.maskAlternate, .maskCommand]) // ⌥⌘→ · next pane
guard let nextNodes = waitForNodes(timeout: 2, matching: {
    guard let state = layoutState(in: $0) else { return false }
    return state.paneCount == 4 && state.focus != restoredLayout.focus
}), let nextLayout = layoutState(in: nextNodes) else {
    fail("⌥⌘→ did not move pane focus.")
}
sendKey(0x7B, flags: [.maskAlternate, .maskCommand]) // ⌥⌘← · previous pane
guard waitForNodes(timeout: 2, matching: {
    guard let state = layoutState(in: $0) else { return false }
    return state.paneCount == 4 && state.focus == restoredLayout.focus
}) != nil else {
    fail("⌥⌘← did not restore pane focus.")
}

// AXPress/AXShowMenu are the activation paths used by VoiceOver and keyboard
// accessibility. Invoke every Activity row action against the live demo.
for title in ["Focus", "Diff", "Proof", "Handoff", "Stop"] {
    guard performKeyboardAccessibleAction(titled: title) else {
        let nodes = accessibleNodes(in: application)
        fail("Activity action is not keyboard-accessible: \(title)\n\(activityDiagnostic(in: nodes))")
    }
    if title == "Handoff" {
        sendKey(0x35, flags: []) // Escape closes the menu without changing ownership.
    }
    guard waitForNodes(timeout: 2, matching: { hasActivityPopover(in: $0) }) != nil else {
        let nodes = accessibleNodes(in: application)
        fail("Agent Activity popover disappeared after \(title).\n\(activityDiagnostic(in: nodes))")
    }
}

print(
    "Accessibility interaction smoke passed: "
        + "AX actions Focus/Stop/Handoff/Diff/Proof; "
        + "pane shortcuts 4→5→4 and focus \(restoredLayout.focus)→\(nextLayout.focus)→\(restoredLayout.focus) "
        + "(initial focus \(initialLayout.focus))"
)
