import AppKit
import Foundation
import SwiftUI

struct LaunchOptions {
    let repositoryURL: URL
    let requiresRepositorySelection: Bool
    let shouldPersistRepositorySelection: Bool
    let demo: Bool
    let demoState: String?
    let screenshotURL: URL?
    let backgroundQA: Bool
    let width: CGFloat
    let height: CGFloat

    init(arguments: [String]) {
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        let rememberedRepository = UserDefaults.standard
            .string(forKey: GidemPreferences.lastRepositoryPathKey)
            .map { URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL }
        self.init(
            arguments: arguments,
            currentDirectoryURL: cwd,
            rememberedRepositoryURL: rememberedRepository,
            isRepositoryRoot: Self.isRepositoryRoot
        )
    }

    init(
        arguments: [String],
        currentDirectoryURL: URL,
        rememberedRepositoryURL: URL?,
        isRepositoryRoot: (URL) -> Bool
    ) {
        func value(after flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
            return arguments[index + 1]
        }

        let cwd = currentDirectoryURL.standardizedFileURL
        if let repository = value(after: "--repo") {
            let explicitRepository = URL(fileURLWithPath: repository, isDirectory: true).standardizedFileURL
            repositoryURL = explicitRepository
            requiresRepositorySelection = !isRepositoryRoot(explicitRepository)
            shouldPersistRepositorySelection = !requiresRepositorySelection
        } else if let rememberedRepository = rememberedRepositoryURL?.standardizedFileURL,
                  isRepositoryRoot(rememberedRepository) {
            repositoryURL = rememberedRepository
            requiresRepositorySelection = false
            shouldPersistRepositorySelection = false
        } else if isRepositoryRoot(cwd) {
            repositoryURL = cwd
            requiresRepositorySelection = false
            shouldPersistRepositorySelection = true
        } else if isRepositoryRoot(cwd.deletingLastPathComponent()) {
            repositoryURL = cwd.deletingLastPathComponent().standardizedFileURL
            requiresRepositorySelection = false
            shouldPersistRepositorySelection = true
        } else {
            repositoryURL = cwd
            requiresRepositorySelection = true
            shouldPersistRepositorySelection = false
        }

        demo = arguments.contains("--demo")
        demoState = value(after: "--demo-state")
        screenshotURL = value(after: "--screenshot").map { URL(fileURLWithPath: $0) }
        backgroundQA = arguments.contains("--background-qa")
        width = CGFloat(Double(value(after: "--width") ?? "1440") ?? 1440)
        height = CGFloat(Double(value(after: "--height") ?? "900") ?? 900)
    }

    private static func isRepositoryRoot(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
              isDirectory.boolValue else { return false }
        let result = CommandRunner.run(
            executable: "/usr/bin/git",
            arguments: ["rev-parse", "--show-toplevel"],
            directory: url
        )
        guard result.exitCode == 0 else { return false }
        let discovered = URL(
            fileURLWithPath: result.output.trimmingCharacters(in: .whitespacesAndNewlines),
            isDirectory: true
        ).resolvingSymlinksInPath().standardizedFileURL
        return discovered.path == url.resolvingSymlinksInPath().standardizedFileURL.path
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
        GidemApplicationMenu.install()
        if let icon = GidemBrandAssets.applicationIconImage {
            NSApplication.shared.applicationIconImage = icon
        }
        let store = WorkspaceStore(
            repositoryURL: options.repositoryURL,
            requiresRepositorySelection: options.requiresRepositorySelection,
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
        window.title = GidemBrandAssets.productName
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 1024, height: 700)
        window.contentView = NSHostingView(rootView: content)
        window.center()
        if options.backgroundQA {
            // Interactive QA posts keyboard and accessibility actions directly
            // to this process. Keep the window mounted for AX inspection without
            // interrupting the user's foreground application.
            window.orderBack(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        self.window = window
        if !options.demo, options.shouldPersistRepositorySelection {
            UserDefaults.standard.set(
                options.repositoryURL.path,
                forKey: GidemPreferences.lastRepositoryPathKey
            )
        }
        if !options.demo, !options.backgroundQA, options.requiresRepositorySelection {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .gidemOpenRepository, object: nil)
            }
        }
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
        requiresRepositorySelection: options.requiresRepositorySelection,
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
    // The longest mount transition is 240 ms. Capture only after every
    // overlay has reached its settled state so visual QA is deterministic.
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.35))
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

if ToolchainSmokeCLI.isInvocation(CommandLine.arguments) {
    exit(ToolchainSmokeCLI.run(arguments: CommandLine.arguments))
}
if AgentEventCLI.isInvocation(CommandLine.arguments) {
    exit(AgentEventCLI.run(arguments: CommandLine.arguments))
}
if TerminalSmokeCLI.isInvocation(CommandLine.arguments) {
    exit(TerminalSmokeCLI.run(arguments: CommandLine.arguments))
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
    application.setActivationPolicy(options.backgroundQA ? .accessory : .regular)
    application.run()
}
