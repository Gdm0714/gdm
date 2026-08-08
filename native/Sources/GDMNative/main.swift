import AppKit
import Foundation
import SwiftUI

struct LaunchOptions {
    let repositoryURL: URL
    let demo: Bool
    let demoState: String?
    let screenshotURL: URL?
    let width: CGFloat
    let height: CGFloat

    init(arguments: [String]) {
        func value(after flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
            return arguments[index + 1]
        }

        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        if let repository = value(after: "--repo") {
            repositoryURL = URL(fileURLWithPath: repository, isDirectory: true).standardizedFileURL
        } else if FileManager.default.fileExists(atPath: cwd.appendingPathComponent(".gdm").path) {
            repositoryURL = cwd
        } else if FileManager.default.fileExists(atPath: cwd.deletingLastPathComponent().appendingPathComponent(".gdm").path) {
            repositoryURL = cwd.deletingLastPathComponent()
        } else {
            repositoryURL = cwd
        }

        demo = arguments.contains("--demo")
        demoState = value(after: "--demo-state")
        screenshotURL = value(after: "--screenshot").map { URL(fileURLWithPath: $0) }
        width = CGFloat(Double(value(after: "--width") ?? "1440") ?? 1440)
        height = CGFloat(Double(value(after: "--height") ?? "900") ?? 900)
    }
}

@MainActor
final class GDMApplicationDelegate: NSObject, NSApplicationDelegate {
    private let options: LaunchOptions
    private var window: NSWindow?
    private var store: WorkspaceStore?
    private let terminationCoordinator = ApplicationTerminationCoordinator()

    init(options: LaunchOptions) {
        self.options = options
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let store = WorkspaceStore(
            repositoryURL: options.repositoryURL,
            demoState: options.demoState,
            isDemo: options.demo
        )
        self.store = store
        let content = WorkspaceView(store: store)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: options.width, height: options.height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "gdm native"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 1024, height: 700)
        window.contentView = NSHostingView(rootView: content)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        self.window = window
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let store else { return .terminateNow }
        return terminationCoordinator.requestTermination(
            hasActiveSessions: store.terminalSessions.hasActiveSessions,
            terminateAll: { await store.terminateAllSessions() },
            reply: { sender.reply(toApplicationShouldTerminate: $0) }
        )
    }
}

@MainActor
func renderScreenshot(options: LaunchOptions, destination: URL) throws {
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    let store = WorkspaceStore(
        repositoryURL: options.repositoryURL,
        demoState: options.demoState,
        isDemo: options.demo
    )
    let rootView = WorkspaceView(store: store)
        .frame(width: options.width, height: options.height)
    let hostingView = NSHostingView(rootView: rootView)
    hostingView.frame = NSRect(x: 0, y: 0, width: options.width, height: options.height)

    let window = NSWindow(
        contentRect: hostingView.frame,
        styleMask: [.borderless],
        backing: .buffered,
        defer: false
    )
    window.contentView = hostingView
    window.orderBack(nil)
    hostingView.layoutSubtreeIfNeeded()
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.15))
    hostingView.layoutSubtreeIfNeeded()

    guard let representation = hostingView.bitmapImageRepForCachingDisplay(in: hostingView.bounds) else {
        throw NSError(domain: "GDMNative", code: 1, userInfo: [NSLocalizedDescriptionKey: "렌더 버퍼를 만들지 못했습니다."])
    }
    hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
    guard let data = representation.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "GDMNative", code: 2, userInfo: [NSLocalizedDescriptionKey: "PNG 인코딩에 실패했습니다."])
    }
    try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: destination, options: .atomic)
    window.orderOut(nil)
}

let options = LaunchOptions(arguments: CommandLine.arguments)
if let destination = options.screenshotURL {
    do {
        try renderScreenshot(options: options, destination: destination)
        print("rendered \(Int(options.width))x\(Int(options.height)) -> \(destination.path)")
    } catch {
        FileHandle.standardError.write(Data("render failed: \(error.localizedDescription)\n".utf8))
        exit(1)
    }
} else {
    let application = NSApplication.shared
    let delegate = GDMApplicationDelegate(options: options)
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.run()
}
