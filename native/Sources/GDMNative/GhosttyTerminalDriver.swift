#if canImport(GhosttyKit)
import AppKit
import Darwin
import Foundation
import GhosttyKit

private func gidemGhosttyWakeup(_ userdata: UnsafeMutableRawPointer?) {
    GhosttyRuntime.wakeupCallback(userdata)
}

private func gidemGhosttyAction(
    _ app: ghostty_app_t?,
    _ target: ghostty_target_s,
    _ action: ghostty_action_s
) -> Bool {
    GhosttyRuntime.actionCallback(app, target: target, action: action)
}

private func gidemGhosttyReadClipboard(
    _ userdata: UnsafeMutableRawPointer?,
    _ location: ghostty_clipboard_e,
    _ state: UnsafeMutableRawPointer?
) -> Bool {
    GhosttyRuntime.readClipboardCallback(userdata, location: location, state: state)
}

private func gidemGhosttyConfirmClipboardRead(
    _ userdata: UnsafeMutableRawPointer?,
    _ string: UnsafePointer<CChar>?,
    _ state: UnsafeMutableRawPointer?,
    _ request: ghostty_clipboard_request_e
) {
    GhosttyRuntime.confirmClipboardReadCallback(
        userdata,
        string: string,
        state: state,
        request: request
    )
}

private func gidemGhosttyWriteClipboard(
    _ userdata: UnsafeMutableRawPointer?,
    _ location: ghostty_clipboard_e,
    _ content: UnsafePointer<ghostty_clipboard_content_s>?,
    _ count: Int,
    _ requiresConfirmation: Bool
) {
    GhosttyRuntime.writeClipboardCallback(
        userdata,
        location: location,
        content: content,
        count: count,
        requiresConfirmation: requiresConfirmation
    )
}

private func gidemGhosttyCloseSurface(
    _ userdata: UnsafeMutableRawPointer?,
    _ requiresConfirmation: Bool
) {
    GhosttyRuntime.closeSurfaceCallback(userdata, requiresConfirmation: requiresConfirmation)
}

/// The Ghostty C API is pinned by `ghostty.lock.json`. This adapter is original
/// Gidem code; behavioral details of the public API were checked against the
/// upstream MIT-licensed macOS host named in THIRD_PARTY_NOTICES.md.
@MainActor
final class GhosttyTerminalDriver: TerminalDriving {
    let surfaceView: GhosttySurfaceView
    var onProcessTerminated: ((Int32?) -> Void)?

    init(runtime: GhosttyRuntime = .shared) {
        surfaceView = GhosttySurfaceView(runtime: runtime)
        surfaceView.onProcessTerminated = { [weak self] exitCode in
            guard let self else { return }
            // Ghostty reports the native wait status, not only WEXITSTATUS.
            // Preserve it so non-zero exits and signal deaths decode correctly.
            let rawStatus = exitCode.map(Int32.init(bitPattern:))
            onProcessTerminated?(rawStatus)
        }
    }

    var hostedView: NSView { surfaceView }
    var lifecycleOwnership: TerminalLifecycleOwnership { .terminalDriver }
    var isRunning: Bool { surfaceView.isProcessRunning }
    var processIdentifier: pid_t { surfaceView.foregroundProcessIdentifier }

    func start(_ specification: AgentLaunchSpecification) {
        surfaceView.start(specification)
    }

    func terminate() {
        surfaceView.destroySurface()
    }

    func send(_ bytes: [UInt8]) {
        surfaceView.send(bytes)
    }

    func sendPaste(_ text: String) {
        surfaceView.sendPaste(text)
    }

    func resize(to size: NSSize) {
        surfaceView.resizeSurface(to: size)
    }

    func setHostActionHandler(_ handler: ((TerminalHostAction) -> Bool)?) {
        surfaceView.onHostAction = handler
    }
}

@MainActor
final class GhosttyRuntime {
    static let shared = GhosttyRuntime()

    nonisolated(unsafe) private(set) var app: ghostty_app_t?
    nonisolated(unsafe) private var config: ghostty_config_t?
    private(set) var initializationError: String?

    var isReady: Bool { app != nil }

    private init() {
        guard let resources = GhosttyResourceLocator.liveLocation() else {
            initializationError = "pinned Ghostty resources are unavailable"
            return
        }
        guard setenv(
            "GHOSTTY_RESOURCES_DIR",
            resources.ghosttyDirectory.path,
            1
        ) == 0 else {
            initializationError = "failed to activate pinned Ghostty resources"
            return
        }
        guard ghostty_init(UInt(CommandLine.argc), CommandLine.unsafeArgv) == GHOSTTY_SUCCESS else {
            initializationError = "ghostty_init failed"
            return
        }
        guard let config = ghostty_config_new() else {
            initializationError = "ghostty_config_new failed"
            return
        }
        self.config = config
        ghostty_config_load_default_files(config)
        ghostty_config_load_recursive_files(config)
        ghostty_config_finalize(config)

        var runtimeConfig = ghostty_runtime_config_s(
            userdata: Unmanaged.passUnretained(self).toOpaque(),
            supports_selection_clipboard: false,
            wakeup_cb: gidemGhosttyWakeup,
            action_cb: gidemGhosttyAction,
            read_clipboard_cb: gidemGhosttyReadClipboard,
            confirm_read_clipboard_cb: gidemGhosttyConfirmClipboardRead,
            write_clipboard_cb: gidemGhosttyWriteClipboard,
            close_surface_cb: gidemGhosttyCloseSurface
        )
        guard let app = ghostty_app_new(&runtimeConfig, config) else {
            initializationError = "ghostty_app_new failed"
            return
        }
        self.app = app
        ghostty_app_set_focus(app, NSApplication.shared.isActive)
    }

    deinit {
        if let app { ghostty_app_free(app) }
        if let config { ghostty_config_free(config) }
    }

    nonisolated static func wakeupCallback(_ userdata: UnsafeMutableRawPointer?) {
        guard let userdata else { return }
        let runtime = Unmanaged<GhosttyRuntime>.fromOpaque(userdata).takeUnretainedValue()
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                guard let app = runtime.app else { return }
                ghostty_app_tick(app)
            }
        }
    }

    nonisolated static func actionCallback(
        _ app: ghostty_app_t?,
        target: ghostty_target_s,
        action: ghostty_action_s
    ) -> Bool {
        _ = app
        guard Thread.isMainThread else { return false }
        return MainActor.assumeIsolated {
            performAction(target: target, action: action)
        }
    }

    nonisolated static func readClipboardCallback(
        _ userdata: UnsafeMutableRawPointer?,
        location: ghostty_clipboard_e,
        state: UnsafeMutableRawPointer?
    ) -> Bool {
        guard Thread.isMainThread else { return false }
        let userdataBits = userdata.map(UInt.init(bitPattern:)) ?? 0
        let stateBits = state.map(UInt.init(bitPattern:)) ?? 0
        return MainActor.assumeIsolated {
            readClipboard(
                UnsafeMutableRawPointer(bitPattern: userdataBits),
                location: location,
                state: UnsafeMutableRawPointer(bitPattern: stateBits)
            )
        }
    }

    nonisolated static func confirmClipboardReadCallback(
        _ userdata: UnsafeMutableRawPointer?,
        string: UnsafePointer<CChar>?,
        state: UnsafeMutableRawPointer?,
        request: ghostty_clipboard_request_e
    ) {
        guard Thread.isMainThread else { return }
        let userdataBits = userdata.map(UInt.init(bitPattern:)) ?? 0
        let stringBits = string.map { UInt(bitPattern: UnsafeRawPointer($0)) } ?? 0
        let stateBits = state.map(UInt.init(bitPattern:)) ?? 0
        MainActor.assumeIsolated {
            confirmClipboardRead(
                UnsafeMutableRawPointer(bitPattern: userdataBits),
                string: UnsafePointer<CChar>(bitPattern: stringBits),
                state: UnsafeMutableRawPointer(bitPattern: stateBits),
                request: request
            )
        }
    }

    nonisolated static func writeClipboardCallback(
        _ userdata: UnsafeMutableRawPointer?,
        location: ghostty_clipboard_e,
        content: UnsafePointer<ghostty_clipboard_content_s>?,
        count: Int,
        requiresConfirmation: Bool
    ) {
        guard Thread.isMainThread else { return }
        let userdataBits = userdata.map(UInt.init(bitPattern:)) ?? 0
        let contentBits = content.map { UInt(bitPattern: UnsafeRawPointer($0)) } ?? 0
        MainActor.assumeIsolated {
            writeClipboard(
                UnsafeMutableRawPointer(bitPattern: userdataBits),
                location: location,
                content: UnsafePointer<ghostty_clipboard_content_s>(bitPattern: contentBits),
                count: count,
                requiresConfirmation: requiresConfirmation
            )
        }
    }

    nonisolated static func closeSurfaceCallback(
        _ userdata: UnsafeMutableRawPointer?,
        requiresConfirmation: Bool
    ) {
        guard Thread.isMainThread else { return }
        let userdataBits = userdata.map(UInt.init(bitPattern:)) ?? 0
        MainActor.assumeIsolated {
            surfaceRequestedClose(
                UnsafeMutableRawPointer(bitPattern: userdataBits),
                requiresConfirmation: requiresConfirmation
            )
        }
    }

    private static func surface(from userdata: UnsafeMutableRawPointer?) -> GhosttySurfaceView? {
        guard let userdata else { return nil }
        return Unmanaged<GhosttySurfaceView>.fromOpaque(userdata).takeUnretainedValue()
    }

    private static func surface(from target: ghostty_target_s) -> GhosttySurfaceView? {
        guard target.tag == GHOSTTY_TARGET_SURFACE,
              let handle = target.target.surface,
              let userdata = ghostty_surface_userdata(handle) else { return nil }
        return Unmanaged<GhosttySurfaceView>.fromOpaque(userdata).takeUnretainedValue()
    }

    private static func performAction(
        target: ghostty_target_s,
        action: ghostty_action_s
    ) -> Bool {
        guard let view = surface(from: target) else { return false }
        if let hostAction = hostAction(for: action) {
            return view.performHostAction(hostAction)
        }
        switch action.tag {
        case GHOSTTY_ACTION_SHOW_CHILD_EXITED:
            view.processDidExit(exitCode: action.action.child_exited.exit_code)
            return true
        case GHOSTTY_ACTION_OPEN_URL:
            return view.openURL(action.action.open_url)
        case GHOSTTY_ACTION_SET_TITLE, GHOSTTY_ACTION_SET_TAB_TITLE:
            let value = action.tag == GHOSTTY_ACTION_SET_TITLE
                ? action.action.set_title.title
                : action.action.set_tab_title.title
            view.setTerminalTitle(value.map(String.init(cString:)) ?? "")
            return true
        case GHOSTTY_ACTION_PWD:
            view.setCurrentDirectory(action.action.pwd.pwd.map(String.init(cString:)))
            return true
        case GHOSTTY_ACTION_CELL_SIZE:
            view.setCellSize(
                width: action.action.cell_size.width,
                height: action.action.cell_size.height
            )
            return true
        case GHOSTTY_ACTION_MOUSE_SHAPE:
            view.setPointerShape(action.action.mouse_shape)
            return true
        case GHOSTTY_ACTION_MOUSE_VISIBILITY:
            view.setPointerVisible(action.action.mouse_visibility == GHOSTTY_MOUSE_VISIBLE)
            return true
        case GHOSTTY_ACTION_RING_BELL:
            NSSound.beep()
            return true
        case GHOSTTY_ACTION_START_SEARCH:
            let needle = action.action.start_search.needle.map(String.init(cString:)) ?? ""
            view.beginSearch(with: needle)
            return true
        case GHOSTTY_ACTION_END_SEARCH:
            view.endSearch()
            return true
        case GHOSTTY_ACTION_SEARCH_TOTAL:
            view.setSearchMatchCount(action.action.search_total.total)
            return true
        case GHOSTTY_ACTION_SEARCH_SELECTED:
            view.setSearchSelectedIndex(action.action.search_selected.selected)
            return true
        case GHOSTTY_ACTION_KEY_SEQUENCE:
            view.setKeySequenceActive(action.action.key_sequence.active)
            return true
        case GHOSTTY_ACTION_RENDER, GHOSTTY_ACTION_SELECTION_CHANGED,
             GHOSTTY_ACTION_PROGRESS_REPORT, GHOSTTY_ACTION_COMMAND_FINISHED:
            return true
        default:
            return false
        }
    }

    static func hostAction(for action: ghostty_action_s) -> TerminalHostAction? {
        switch action.tag {
        case GHOSTTY_ACTION_NEW_TAB:
            // Gidem has task workspaces instead of terminal window tabs. The
            // user's Ghostty "new tab" leader therefore opens a sibling lane.
            return .split(.right)
        case GHOSTTY_ACTION_NEW_SPLIT:
            return paneDirection(action.action.new_split).map(TerminalHostAction.split)
        case GHOSTTY_ACTION_GOTO_SPLIT:
            return paneFocusTarget(action.action.goto_split).map(TerminalHostAction.focus)
        case GHOSTTY_ACTION_GOTO_TAB:
            let tab = action.action.goto_tab.rawValue
            if tab == GHOSTTY_GOTO_TAB_PREVIOUS.rawValue { return .focus(.previous) }
            if tab == GHOSTTY_GOTO_TAB_NEXT.rawValue { return .focus(.next) }
            if tab == GHOSTTY_GOTO_TAB_LAST.rawValue { return .focus(.index(Int.max)) }
            return tab > 0 ? .focus(.index(Int(tab))) : nil
        case GHOSTTY_ACTION_RESIZE_SPLIT:
            guard let direction = paneDirection(action.action.resize_split.direction) else {
                return nil
            }
            return .resize(direction, amount: action.action.resize_split.amount)
        case GHOSTTY_ACTION_EQUALIZE_SPLITS:
            return .equalizeSplits
        case GHOSTTY_ACTION_CLOSE_TAB, GHOSTTY_ACTION_CLOSE_WINDOW:
            return .closePane
        default:
            return nil
        }
    }

    private static func paneDirection(
        _ direction: ghostty_action_split_direction_e
    ) -> PaneDirection? {
        switch direction {
        case GHOSTTY_SPLIT_DIRECTION_LEFT: .left
        case GHOSTTY_SPLIT_DIRECTION_RIGHT: .right
        case GHOSTTY_SPLIT_DIRECTION_UP: .up
        case GHOSTTY_SPLIT_DIRECTION_DOWN: .down
        default: nil
        }
    }

    private static func paneDirection(
        _ direction: ghostty_action_resize_split_direction_e
    ) -> PaneDirection? {
        switch direction {
        case GHOSTTY_RESIZE_SPLIT_LEFT: .left
        case GHOSTTY_RESIZE_SPLIT_RIGHT: .right
        case GHOSTTY_RESIZE_SPLIT_UP: .up
        case GHOSTTY_RESIZE_SPLIT_DOWN: .down
        default: nil
        }
    }

    private static func paneFocusTarget(
        _ direction: ghostty_action_goto_split_e
    ) -> PaneFocusTarget? {
        switch direction {
        case GHOSTTY_GOTO_SPLIT_PREVIOUS: .previous
        case GHOSTTY_GOTO_SPLIT_NEXT: .next
        case GHOSTTY_GOTO_SPLIT_LEFT: .direction(.left)
        case GHOSTTY_GOTO_SPLIT_RIGHT: .direction(.right)
        case GHOSTTY_GOTO_SPLIT_UP: .direction(.up)
        case GHOSTTY_GOTO_SPLIT_DOWN: .direction(.down)
        default: nil
        }
    }

    private static func readClipboard(
        _ userdata: UnsafeMutableRawPointer?,
        location: ghostty_clipboard_e,
        state: UnsafeMutableRawPointer?
    ) -> Bool {
        guard location == GHOSTTY_CLIPBOARD_STANDARD,
              let view = surface(from: userdata),
              let surface = view.surface,
              let value = NSPasteboard.general.string(forType: .string) else { return false }
        value.withCString {
            ghostty_surface_complete_clipboard_request(surface, $0, state, false)
        }
        return true
    }

    private static func confirmClipboardRead(
        _ userdata: UnsafeMutableRawPointer?,
        string: UnsafePointer<CChar>?,
        state: UnsafeMutableRawPointer?,
        request: ghostty_clipboard_request_e
    ) {
        guard let view = surface(from: userdata), let surface = view.surface else { return }
        // User-initiated paste is allowed. Terminal-initiated OSC 52 reads and
        // writes are denied unless Gidem gains an explicit confirmation UI.
        let approved = request == GHOSTTY_CLIPBOARD_REQUEST_PASTE
        let value = approved ? (string.map(String.init(cString:)) ?? "") : ""
        value.withCString {
            ghostty_surface_complete_clipboard_request(surface, $0, state, approved)
        }
    }

    private static func writeClipboard(
        _ userdata: UnsafeMutableRawPointer?,
        location: ghostty_clipboard_e,
        content: UnsafePointer<ghostty_clipboard_content_s>?,
        count: Int,
        requiresConfirmation: Bool
    ) {
        _ = requiresConfirmation
        guard location == GHOSTTY_CLIPBOARD_STANDARD,
              let view = surface(from: userdata),
              view.consumeClipboardWriteAuthorization(),
              let content,
              count > 0 else { return }
        let maximumClipboardBytes = 1_048_576
        for index in 0..<count {
            let item = content[index]
            guard let mime = item.mime,
                  String(cString: mime) == "text/plain",
                  let data = item.data else { continue }
            let value = String(cString: data)
            guard value.utf8.count <= maximumClipboardBytes else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(value, forType: .string)
            return
        }
    }

    private static func surfaceRequestedClose(
        _ userdata: UnsafeMutableRawPointer?,
        requiresConfirmation: Bool
    ) {
        surface(from: userdata)?.surfaceRequestedClose(
            requiresConfirmation: requiresConfirmation
        )
    }
}

@MainActor
final class GhosttySurfaceView:
    NSView,
    @preconcurrency NSTextInputClient,
    NSSearchFieldDelegate
{
    let runtime: GhosttyRuntime
    nonisolated(unsafe) fileprivate var surface: ghostty_surface_t?
    var onProcessTerminated: ((UInt32?) -> Void)?
    var onHostAction: ((TerminalHostAction) -> Bool)?

    private var markedTextStorage = NSMutableAttributedString()
    private var keyTextAccumulator: [String]?
    private var didNotifyProcessExit = false
    private var destroyingSurface = false
    private var cellSize = NSSize(width: 8, height: 16)
    private var searchField: GhosttySearchField?
    private var keySequenceBadge: NSTextField?
    private var trackingAreaReference: NSTrackingArea?
    private var pointerIsHidden = false
    private var clipboardWriteAuthorizationDeadline: Date?
    private var exitStatusDirectoryURL: URL?
    private var exitStatusURL: URL?
    private(set) var currentDirectory: String?
    private(set) var terminalTitle = ""
    private(set) var backendExitCode: UInt32?
    private(set) var searchMatchCount: Int?
    private(set) var searchSelectedIndex: Int?
    private(set) var isKeySequenceActive = false

    init(runtime: GhosttyRuntime) {
        self.runtime = runtime
        super.init(frame: .zero)
        wantsLayer = true
        layerContentsRedrawPolicy = .duringViewResize
        registerForDraggedTypes([.fileURL])
        setAccessibilityRole(.group)
        setAccessibilityLabel("Ghostty terminal surface")
    }

    required init?(coder: NSCoder) { nil }

    deinit {
        if pointerIsHidden { NSCursor.unhide() }
        if let surface { ghostty_surface_free(surface) }
        if let exitStatusDirectoryURL {
            try? FileManager.default.removeItem(at: exitStatusDirectoryURL)
        }
    }

    override var acceptsFirstResponder: Bool { true }
    var hasProcessExited: Bool { surface.map(ghostty_surface_process_exited) ?? false }
    var isProcessRunning: Bool { surface != nil && !hasProcessExited }
    var foregroundProcessIdentifier: pid_t {
        guard let surface else { return 0 }
        return pid_t(exactly: ghostty_surface_foreground_pid(surface)) ?? 0
    }

    func start(_ specification: AgentLaunchSpecification) {
        guard surface == nil, let app = runtime.app else { return }
        let invocation = ([specification.executableURL.path] + specification.arguments)
            .map(Self.shellQuote)
            .joined(separator: " ")
        let command: String
        if Self.shouldCaptureExitStatus(for: specification),
           let statusURL = prepareExitStatusLocation() {
            let wrapper = """
            \(invocation)
            gidem_exit_status=$?
            /usr/bin/printf '%d' "$gidem_exit_status" > \(Self.shellQuote(statusURL.path))
            exit "$gidem_exit_status"
            """
            command = ["/bin/zsh", "-f", "-c", wrapper]
                .map(Self.shellQuote)
                .joined(separator: " ")
        } else {
            command = invocation
        }

        var environment = specification.environment
        environment["TERM"] = "xterm-ghostty"
        environment["COLORTERM"] = "truecolor"
        environment["TERM_PROGRAM"] = "ghostty"
        environment["TERM_PROGRAM_VERSION"] = "1.3.2-dev"

        let workingDirectory = strdup(specification.currentDirectory.path)
        let commandString = strdup(command)
        let pairs = environment.sorted { $0.key < $1.key }.compactMap { key, value -> (UnsafeMutablePointer<CChar>, UnsafeMutablePointer<CChar>)? in
            guard let keyPointer = strdup(key), let valuePointer = strdup(value) else { return nil }
            return (keyPointer, valuePointer)
        }
        defer {
            free(workingDirectory)
            free(commandString)
            for (key, value) in pairs {
                free(key)
                free(value)
            }
        }

        var environmentVariables = pairs.map {
            ghostty_env_var_s(key: UnsafePointer($0.0), value: UnsafePointer($0.1))
        }
        var configuration = ghostty_surface_config_new()
        configuration.platform_tag = GHOSTTY_PLATFORM_MACOS
        configuration.platform = ghostty_platform_u(
            macos: ghostty_platform_macos_s(
                nsview: Unmanaged.passUnretained(self).toOpaque()
            )
        )
        configuration.userdata = Unmanaged.passUnretained(self).toOpaque()
        configuration.scale_factor = Double(
            window?.backingScaleFactor
                ?? NSScreen.main?.backingScaleFactor
                ?? 2
        )
        configuration.working_directory = UnsafePointer(workingDirectory)
        configuration.command = UnsafePointer(commandString)
        configuration.wait_after_command = false
        configuration.context = GHOSTTY_SURFACE_CONTEXT_SPLIT

        surface = environmentVariables.withUnsafeMutableBufferPointer { buffer in
            configuration.env_vars = buffer.baseAddress
            configuration.env_var_count = buffer.count
            return ghostty_surface_new(app, &configuration)
        }
        guard let surface else { return }
        ghostty_surface_set_color_scheme(surface, GHOSTTY_COLOR_SCHEME_DARK)
        updateSurfaceGeometry()
        updateSurfaceFocus()
    }

    func destroySurface() {
        guard let handle = surface, !destroyingSurface else { return }
        destroyingSurface = true
        surface = nil
        ghostty_surface_free(handle)
        destroyingSurface = false
        didNotifyProcessExit = true
        removeExitStatusDirectory()
    }

    func send(_ bytes: [UInt8]) {
        guard surface != nil, !bytes.isEmpty else { return }
        var text: [UInt8] = []
        for byte in bytes {
            if byte < 0x20 || byte == 0x7F {
                if !text.isEmpty {
                    sendCommittedText(text)
                    text.removeAll(keepingCapacity: true)
                }
                sendControlByte(byte)
            } else {
                text.append(byte)
            }
        }
        if !text.isEmpty { sendCommittedText(text) }
    }

    func sendPaste(_ text: String) {
        guard let surface, !text.isEmpty else { return }
        text.withCString {
            ghostty_surface_text(surface, $0, UInt(text.utf8.count))
        }
    }

    private func sendCommittedText(_ bytes: [UInt8]) {
        guard let surface else { return }
        let value = String(decoding: bytes, as: UTF8.self)
        var input = ghostty_input_key_s()
        input.action = GHOSTTY_ACTION_PRESS
        input.mods = GHOSTTY_MODS_NONE
        input.consumed_mods = GHOSTTY_MODS_NONE
        input.keycode = 0
        input.composing = false
        value.withCString {
            input.text = $0
            _ = ghostty_surface_key(surface, input)
        }
    }

    private func sendControlByte(_ byte: UInt8) {
        guard let surface else { return }
        let key: (keyCode: UInt32, modifiers: ghostty_input_mods_e, text: String?)?
        switch byte {
        case 0x09:
            key = (48, GHOSTTY_MODS_NONE, nil)
        case 0x0A, 0x0D:
            key = (36, GHOSTTY_MODS_NONE, nil)
        case 0x08, 0x7F:
            key = (51, GHOSTTY_MODS_NONE, nil)
        case 0x01...0x1A:
            let macKeyCodes: [UInt32] = [
                0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46,
                45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6
            ]
            let index = Int(byte - 1)
            key = (macKeyCodes[index], GHOSTTY_MODS_CTRL, String(UnicodeScalar(97 + index)!))
        case 0x1B:
            key = (53, GHOSTTY_MODS_NONE, nil)
        default:
            key = nil
        }
        guard let key else { return }
        var input = ghostty_input_key_s()
        input.action = GHOSTTY_ACTION_PRESS
        input.mods = key.modifiers
        input.consumed_mods = GHOSTTY_MODS_NONE
        input.keycode = key.keyCode
        if let scalar = key.text?.unicodeScalars.first {
            input.unshifted_codepoint = scalar.value
        }
        if let text = key.text {
            _ = text.withCString {
                input.text = $0
                return ghostty_surface_key(surface, input)
            }
        } else {
            _ = ghostty_surface_key(surface, input)
        }
        input.action = GHOSTTY_ACTION_RELEASE
        input.text = nil
        _ = ghostty_surface_key(surface, input)
    }

    func resizeSurface(to size: NSSize) {
        if frame.size != size { setFrameSize(size) }
        updateSurfaceGeometry()
    }

    func processDidExit(exitCode: UInt32) {
        guard !didNotifyProcessExit, !destroyingSurface else { return }
        didNotifyProcessExit = true
        backendExitCode = exitCode
        onProcessTerminated?(resolvedWaitStatus(fallback: exitCode))
    }

    func performHostAction(_ action: TerminalHostAction) -> Bool {
        onHostAction?(action) == true
    }

    func surfaceRequestedClose(requiresConfirmation: Bool) {
        guard !destroyingSurface else { return }
        if performHostAction(.closePane) { return }
        // Ghostty's bool means "confirmation recommended", not "process is
        // alive". A close request is never termination evidence; only the
        // child-exited action may advance session lifecycle state.
        _ = requiresConfirmation
        NSSound.beep()
    }

    func setTerminalTitle(_ value: String) {
        terminalTitle = String(value.prefix(512))
        setAccessibilityLabel(terminalTitle.isEmpty ? "Ghostty terminal surface" : terminalTitle)
    }

    func setCurrentDirectory(_ value: String?) {
        guard let value, value.utf8.count <= 4_096 else { return }
        currentDirectory = value
    }

    func setSearchMatchCount(_ value: ssize_t) {
        searchMatchCount = max(0, Int(value))
    }

    func setSearchSelectedIndex(_ value: ssize_t) {
        searchSelectedIndex = value < 0 ? nil : Int(value)
    }

    func setKeySequenceActive(_ active: Bool) {
        isKeySequenceActive = active
        guard active else {
            keySequenceBadge?.removeFromSuperview()
            keySequenceBadge = nil
            return
        }
        guard keySequenceBadge == nil else { return }
        let badge = NSTextField(labelWithString: "⌃G  PANE")
        badge.font = .monospacedSystemFont(ofSize: 11, weight: .semibold)
        badge.textColor = .controlAccentColor
        badge.alignment = .center
        badge.wantsLayer = true
        badge.layer?.backgroundColor = NSColor.windowBackgroundColor
            .withAlphaComponent(0.94)
            .cgColor
        badge.layer?.cornerRadius = 4
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.setAccessibilityLabel("Ghostty pane key sequence active")
        addSubview(badge)
        NSLayoutConstraint.activate([
            badge.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            badge.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            badge.heightAnchor.constraint(greaterThanOrEqualToConstant: 24),
            badge.widthAnchor.constraint(greaterThanOrEqualToConstant: 76)
        ])
        keySequenceBadge = badge
    }

    func setCellSize(width: UInt32, height: UInt32) {
        guard width > 0, height > 0 else { return }
        cellSize = NSSize(width: Int(width), height: Int(height))
    }

    func openURL(_ action: ghostty_action_open_url_s) -> Bool {
        guard let pointer = action.url, action.len > 0 else { return false }
        let data = Data(bytes: pointer, count: Int(action.len))
        guard data.count <= 16_384,
              let value = String(data: data, encoding: .utf8),
              let url = Self.allowedExternalURL(value) else { return false }
        return NSWorkspace.shared.open(url)
    }

    static func allowedExternalURL(_ value: String) -> URL? {
        guard value.utf8.count <= 16_384,
              let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              ["https", "http", "mailto", "file"].contains(scheme) else { return nil }
        return url
    }

    func setPointerShape(_ shape: ghostty_action_mouse_shape_e) {
        let cursor: NSCursor
        switch shape {
        case GHOSTTY_MOUSE_SHAPE_POINTER: cursor = .pointingHand
        case GHOSTTY_MOUSE_SHAPE_CROSSHAIR: cursor = .crosshair
        case GHOSTTY_MOUSE_SHAPE_TEXT, GHOSTTY_MOUSE_SHAPE_VERTICAL_TEXT: cursor = .iBeam
        case GHOSTTY_MOUSE_SHAPE_NOT_ALLOWED: cursor = .operationNotAllowed
        case GHOSTTY_MOUSE_SHAPE_GRAB, GHOSTTY_MOUSE_SHAPE_GRABBING: cursor = .openHand
        default: cursor = .arrow
        }
        cursor.set()
    }

    func setPointerVisible(_ visible: Bool) {
        guard visible == pointerIsHidden else { return }
        if visible {
            NSCursor.unhide()
            pointerIsHidden = false
        } else {
            NSCursor.hide()
            pointerIsHidden = true
        }
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateSurfaceGeometry()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateSurfaceGeometry()
        updateSurfaceFocus()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateSurfaceGeometry()
    }

    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        updateSurfaceFocus()
        return result
    }

    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        updateSurfaceFocus()
        return result
    }

    private func updateSurfaceFocus() {
        guard let surface else { return }
        let focused = window?.firstResponder === self && window?.isKeyWindow == true
        ghostty_surface_set_focus(surface, focused)
        if let app = runtime.app { ghostty_app_set_focus(app, NSApplication.shared.isActive) }
    }

    private func updateSurfaceGeometry(scale overrideScale: CGFloat? = nil) {
        guard let surface else { return }
        let scale = overrideScale
            ?? window?.backingScaleFactor
            ?? NSScreen.main?.backingScaleFactor
            ?? 2
        let backingSize = overrideScale.map {
            NSSize(width: bounds.width * $0, height: bounds.height * $0)
        } ?? convertToBacking(bounds).size
        ghostty_surface_set_content_scale(
            surface,
            Double(scale),
            Double(scale)
        )
        ghostty_surface_set_size(
            surface,
            UInt32(clamping: max(1, Int(backingSize.width.rounded()))),
            UInt32(clamping: max(1, Int(backingSize.height.rounded())))
        )
    }

    struct SurfaceGeometry: Equatable {
        let columns: Int
        let rows: Int
        let widthPixels: Int
        let heightPixels: Int
        let cellWidthPixels: Int
        let cellHeightPixels: Int
    }

    var surfaceIdentity: UInt? {
        surface.map { UInt(bitPattern: $0) }
    }

    var surfaceGeometry: SurfaceGeometry? {
        guard let surface else { return nil }
        let value = ghostty_surface_size(surface)
        return SurfaceGeometry(
            columns: Int(value.columns),
            rows: Int(value.rows),
            widthPixels: Int(value.width_px),
            heightPixels: Int(value.height_px),
            cellWidthPixels: Int(value.cell_width_px),
            cellHeightPixels: Int(value.cell_height_px)
        )
    }

    var isMouseReportingEnabled: Bool {
        surface.map(ghostty_surface_mouse_captured) ?? false
    }

    func screenText(viewportOnly: Bool = false) -> String {
        guard let surface else { return "" }
        var text = ghostty_text_s()
        let tag = viewportOnly ? GHOSTTY_POINT_VIEWPORT : GHOSTTY_POINT_SCREEN
        let selection = ghostty_selection_s(
            top_left: ghostty_point_s(
                tag: tag,
                coord: GHOSTTY_POINT_COORD_TOP_LEFT,
                x: 0,
                y: 0
            ),
            bottom_right: ghostty_point_s(
                tag: tag,
                coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT,
                x: 0,
                y: 0
            ),
            rectangle: false
        )
        guard ghostty_surface_read_text(surface, selection, &text),
              let pointer = text.text else { return "" }
        defer { ghostty_surface_free_text(surface, &text) }
        let data = Data(bytes: pointer, count: Int(text.text_len))
        return String(decoding: data, as: UTF8.self)
    }

    func applyCompatibilityGeometry(size: NSSize, scale: CGFloat) {
        setFrameSize(size)
        updateSurfaceGeometry(scale: scale)
    }

    func injectCompatibilityMouse(position: NSPoint, pressed: Bool) {
        guard let surface else { return }
        ghostty_surface_mouse_pos(surface, position.x, position.y, GHOSTTY_MODS_NONE)
        _ = ghostty_surface_mouse_button(
            surface,
            pressed ? GHOSTTY_MOUSE_PRESS : GHOSTTY_MOUSE_RELEASE,
            GHOSTTY_MOUSE_LEFT,
            GHOSTTY_MODS_NONE
        )
    }

    func injectCompatibilityScroll(deltaY: Double) {
        guard let surface else { return }
        ghostty_surface_mouse_scroll(surface, 0, deltaY, 0)
    }

    override func updateTrackingAreas() {
        if let trackingAreaReference { removeTrackingArea(trackingAreaReference) }
        let area = NSTrackingArea(
            rect: .zero,
            options: [.activeInKeyWindow, .inVisibleRect, .mouseMoved, .mouseEnteredAndExited],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingAreaReference = area
        super.updateTrackingAreas()
    }

    override func mouseMoved(with event: NSEvent) { sendMousePosition(event) }
    override func mouseDragged(with event: NSEvent) { sendMousePosition(event) }
    override func rightMouseDragged(with event: NSEvent) { sendMousePosition(event) }
    override func otherMouseDragged(with event: NSEvent) { sendMousePosition(event) }

    override func mouseDown(with event: NSEvent) { sendMouseButton(event, state: GHOSTTY_MOUSE_PRESS) }
    override func mouseUp(with event: NSEvent) { sendMouseButton(event, state: GHOSTTY_MOUSE_RELEASE) }
    override func rightMouseDown(with event: NSEvent) {
        guard let surface, ghostty_surface_mouse_captured(surface) else {
            super.rightMouseDown(with: event)
            return
        }
        sendMouseButton(event, state: GHOSTTY_MOUSE_PRESS)
    }
    override func rightMouseUp(with event: NSEvent) { sendMouseButton(event, state: GHOSTTY_MOUSE_RELEASE) }
    override func otherMouseDown(with event: NSEvent) { sendMouseButton(event, state: GHOSTTY_MOUSE_PRESS) }
    override func otherMouseUp(with event: NSEvent) { sendMouseButton(event, state: GHOSTTY_MOUSE_RELEASE) }

    private func sendMousePosition(_ event: NSEvent) {
        guard let surface else { return }
        let point = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(
            surface,
            point.x,
            bounds.height - point.y,
            Self.modifiers(event.modifierFlags)
        )
    }

    private func sendMouseButton(_ event: NSEvent, state: ghostty_input_mouse_state_e) {
        guard let surface else { return }
        _ = window?.makeFirstResponder(self)
        let button: ghostty_input_mouse_button_e
        switch event.buttonNumber {
        case 0: button = GHOSTTY_MOUSE_LEFT
        case 1: button = GHOSTTY_MOUSE_RIGHT
        case 2: button = GHOSTTY_MOUSE_MIDDLE
        case 3: button = GHOSTTY_MOUSE_FOUR
        case 4: button = GHOSTTY_MOUSE_FIVE
        default: button = GHOSTTY_MOUSE_UNKNOWN
        }
        _ = ghostty_surface_mouse_button(surface, state, button, Self.modifiers(event.modifierFlags))
    }

    override func scrollWheel(with event: NSEvent) {
        guard let surface else { return }
        var x = event.scrollingDeltaX
        var y = event.scrollingDeltaY
        if event.hasPreciseScrollingDeltas {
            x *= 2
            y *= 2
        }
        let momentum = Self.momentumCode(event.momentumPhase)
        let scrollModifiers: ghostty_input_scroll_mods_t =
            (event.hasPreciseScrollingDeltas ? 1 : 0) | (momentum << 1)
        ghostty_surface_mouse_scroll(surface, x, y, scrollModifiers)
    }

    override func keyDown(with event: NSEvent) {
        guard surface != nil else { return }
        let hadMarkedText = hasMarkedText()
        keyTextAccumulator = []
        interpretKeyEvents([event])
        let committedText = keyTextAccumulator ?? []
        keyTextAccumulator = nil
        syncPreedit()
        let composing = hasMarkedText() || hadMarkedText
        let action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS
        if committedText.isEmpty {
            _ = sendKey(action, event: event, text: Self.characters(for: event), composing: composing)
        } else {
            for text in committedText {
                _ = sendKey(action, event: event, text: text, composing: false)
            }
        }
    }

    override func keyUp(with event: NSEvent) {
        _ = sendKey(GHOSTTY_ACTION_RELEASE, event: event, text: nil, composing: false)
    }

    override func flagsChanged(with event: NSEvent) {
        let modifier: UInt32
        switch event.keyCode {
        case 0x39: modifier = GHOSTTY_MODS_CAPS.rawValue
        case 0x38, 0x3C: modifier = GHOSTTY_MODS_SHIFT.rawValue
        case 0x3B, 0x3E: modifier = GHOSTTY_MODS_CTRL.rawValue
        case 0x3A, 0x3D: modifier = GHOSTTY_MODS_ALT.rawValue
        case 0x37, 0x36: modifier = GHOSTTY_MODS_SUPER.rawValue
        default: return
        }
        let pressed = Self.modifiers(event.modifierFlags).rawValue & modifier != 0
        _ = sendKey(
            pressed ? GHOSTTY_ACTION_PRESS : GHOSTTY_ACTION_RELEASE,
            event: event,
            text: nil,
            composing: false
        )
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown, event.modifierFlags.contains(.command) else {
            return super.performKeyEquivalent(with: event)
        }
        return sendKey(
            event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS,
            event: event,
            text: Self.characters(for: event),
            composing: false
        ) || super.performKeyEquivalent(with: event)
    }

    private func sendKey(
        _ action: ghostty_input_action_e,
        event: NSEvent,
        text: String?,
        composing: Bool
    ) -> Bool {
        guard let surface else { return false }
        var input = ghostty_input_key_s()
        input.action = action
        input.mods = Self.modifiers(event.modifierFlags)
        input.consumed_mods = Self.modifiers(
            event.modifierFlags.subtracting([.control, .command])
        )
        input.keycode = UInt32(event.keyCode)
        input.composing = composing
        if let scalar = Self.unshiftedCharacters(for: event)?.unicodeScalars.first {
            input.unshifted_codepoint = scalar.value
        }
        guard let text, !text.isEmpty else {
            return ghostty_surface_key(surface, input)
        }
        return text.withCString {
            input.text = $0
            return ghostty_surface_key(surface, input)
        }
    }

    @IBAction func copy(_ sender: Any?) {
        clipboardWriteAuthorizationDeadline = Date(timeIntervalSinceNow: 1)
        if !performBinding("copy_to_clipboard") {
            clipboardWriteAuthorizationDeadline = nil
        }
    }
    @IBAction func paste(_ sender: Any?) { performBinding("paste_from_clipboard") }
    @IBAction override func selectAll(_ sender: Any?) { performBinding("select_all") }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true
        ]) ? .copy : []
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        guard let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL] else { return false }
        return pasteDraggedFileURLs(urls)
    }

    @discardableResult
    func pasteDraggedFileURLs(_ urls: [URL]) -> Bool {
        let paths = urls.filter(\.isFileURL).map { Self.shellQuote($0.path) }
        guard !paths.isEmpty else { return false }
        send(Array(paths.joined(separator: " ").utf8))
        return true
    }

    func consumeClipboardWriteAuthorization() -> Bool {
        guard let deadline = clipboardWriteAuthorizationDeadline,
              deadline >= Date() else {
            clipboardWriteAuthorizationDeadline = nil
            return false
        }
        clipboardWriteAuthorizationDeadline = nil
        return true
    }

    private func prepareExitStatusLocation() -> URL? {
        removeExitStatusDirectory()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "gidem-terminal-status-\(UUID().uuidString)",
            isDirectory: true
        )
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
            exitStatusDirectoryURL = directory
            let status = directory.appendingPathComponent("status", isDirectory: false)
            exitStatusURL = status
            return status
        } catch {
            exitStatusDirectoryURL = nil
            exitStatusURL = nil
            return nil
        }
    }

    private func resolvedWaitStatus(fallback: UInt32) -> UInt32 {
        defer { removeExitStatusDirectory() }
        guard let exitStatusURL,
              let value = try? String(contentsOf: exitStatusURL, encoding: .utf8),
              let code = UInt32(value.trimmingCharacters(in: .whitespacesAndNewlines)),
              code <= 255 else { return fallback }
        return code << 8
    }

    private func removeExitStatusDirectory() {
        if let exitStatusDirectoryURL {
            try? FileManager.default.removeItem(at: exitStatusDirectoryURL)
        }
        exitStatusDirectoryURL = nil
        exitStatusURL = nil
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu(title: "Terminal")
        menu.addItem(withTitle: "Copy", action: #selector(copy(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "Paste", action: #selector(paste(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Select All", action: #selector(selectAll(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "Find…", action: #selector(showSearchFromMenu(_:)), keyEquivalent: "")
        for item in menu.items { item.target = self }
        return menu
    }

    @objc private func showSearchFromMenu(_ sender: Any?) { beginSearch(with: "") }

    @discardableResult
    func performBinding(_ action: String) -> Bool {
        guard let surface else { return false }
        return action.withCString {
            ghostty_surface_binding_action(surface, $0, UInt(action.utf8.count))
        }
    }

    func beginSearch(with needle: String) {
        searchMatchCount = nil
        searchSelectedIndex = nil
        if let searchField {
            if !needle.isEmpty { searchField.stringValue = needle }
            window?.makeFirstResponder(searchField)
            return
        }
        let field = GhosttySearchField(frame: .zero)
        field.placeholderString = "Find in terminal"
        field.stringValue = needle
        field.delegate = self
        field.onNavigate = { [weak self] backwards in
            self?.performBinding(backwards ? "navigate_search:previous" : "navigate_search:next")
        }
        field.onDismiss = { [weak self] in self?.endSearch() }
        field.translatesAutoresizingMaskIntoConstraints = false
        field.setAccessibilityLabel("Find in terminal")
        addSubview(field)
        NSLayoutConstraint.activate([
            field.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            field.widthAnchor.constraint(equalToConstant: 260)
        ])
        searchField = field
        window?.makeFirstResponder(field)
        updateSearch(field.stringValue)
    }

    func endSearch() {
        guard let field = searchField else { return }
        field.removeFromSuperview()
        searchField = nil
        performBinding("end_search")
        searchMatchCount = nil
        searchSelectedIndex = nil
        window?.makeFirstResponder(self)
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSSearchField else { return }
        updateSearch(field.stringValue)
    }

    private func updateSearch(_ value: String) {
        guard value.utf8.count <= 4_096 else { return }
        performBinding("search:\(value)")
    }

    func hasMarkedText() -> Bool { markedTextStorage.length > 0 }
    func markedRange() -> NSRange {
        hasMarkedText() ? NSRange(location: 0, length: markedTextStorage.length) : NSRange(location: NSNotFound, length: 0)
    }
    func selectedRange() -> NSRange { NSRange(location: NSNotFound, length: 0) }
    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        if let attributed = string as? NSAttributedString {
            markedTextStorage = NSMutableAttributedString(attributedString: attributed)
        } else if let string = string as? String {
            markedTextStorage = NSMutableAttributedString(string: string)
        }
        if keyTextAccumulator == nil { syncPreedit() }
    }
    func unmarkText() {
        markedTextStorage.mutableString.setString("")
        syncPreedit()
    }
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }
    func characterIndex(for point: NSPoint) -> Int { 0 }
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let surface else { return window?.convertToScreen(convert(bounds, to: nil)) ?? bounds }
        var x = 0.0
        var y = 0.0
        var width = Double(cellSize.width)
        var height = Double(cellSize.height)
        ghostty_surface_ime_point(surface, &x, &y, &width, &height)
        let local = NSRect(x: x, y: bounds.height - y, width: width, height: height)
        let windowRect = convert(local, to: nil)
        return window?.convertToScreen(windowRect) ?? windowRect
    }
    func insertText(_ string: Any, replacementRange: NSRange) {
        let value: String
        if let attributed = string as? NSAttributedString { value = attributed.string }
        else if let string = string as? String { value = string }
        else { return }
        markedTextStorage.mutableString.setString("")
        if keyTextAccumulator != nil {
            keyTextAccumulator?.append(value)
        } else {
            send(Array(value.utf8))
            syncPreedit()
        }
    }
    override func doCommand(by selector: Selector) {}

    private func syncPreedit() {
        guard let surface else { return }
        let value = markedTextStorage.string
        value.withCString { ghostty_surface_preedit(surface, $0, UInt(value.utf8.count)) }
    }

    private static func shellQuote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
    }

    private static func shouldCaptureExitStatus(for specification: AgentLaunchSpecification) -> Bool {
        let shellNames: Set<String> = ["sh", "bash", "zsh", "fish"]
        guard shellNames.contains(specification.executableURL.lastPathComponent) else { return true }
        let hasCommandArgument = specification.arguments.contains { argument in
            argument == "--command"
                || (argument.hasPrefix("-") && argument.dropFirst().contains("c"))
        }
        // An outer status-capturing shell would steal job-control ownership
        // from an interactive shell. Ghostty owns that session directly.
        return hasCommandArgument
    }

    private static func characters(for event: NSEvent) -> String? {
        guard let characters = event.characters else { return nil }
        if characters.count == 1, let scalar = characters.unicodeScalars.first {
            if scalar.value < 0x20 {
                let translated = event.characters(
                    byApplyingModifiers: event.modifierFlags.subtracting(.control)
                )
                if let translated, !translated.isEmpty { return translated }
                return event.charactersIgnoringModifiers
            }
            if (0xF700...0xF8FF).contains(scalar.value) { return nil }
        }
        return characters
    }

    private static func unshiftedCharacters(for event: NSEvent) -> String? {
        if let translated = event.characters(byApplyingModifiers: []), !translated.isEmpty {
            return translated
        }
        guard let fallback = event.charactersIgnoringModifiers, !fallback.isEmpty else {
            return nil
        }
        return fallback
    }

    private static func modifiers(_ flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var raw: UInt32 = 0
        if flags.contains(.shift) { raw |= GHOSTTY_MODS_SHIFT.rawValue }
        if flags.contains(.control) { raw |= GHOSTTY_MODS_CTRL.rawValue }
        if flags.contains(.option) { raw |= GHOSTTY_MODS_ALT.rawValue }
        if flags.contains(.command) { raw |= GHOSTTY_MODS_SUPER.rawValue }
        if flags.contains(.capsLock) { raw |= GHOSTTY_MODS_CAPS.rawValue }
        if flags.contains(.numericPad) { raw |= GHOSTTY_MODS_NUM.rawValue }
        return ghostty_input_mods_e(rawValue: raw)
    }

    private static func momentumCode(_ phase: NSEvent.Phase) -> Int32 {
        switch phase {
        case .began: 1
        case .stationary: 2
        case .changed: 3
        case .ended: 4
        case .cancelled: 5
        case .mayBegin: 6
        default: 0
        }
    }
}

@MainActor
private final class GhosttySearchField: NSSearchField {
    var onNavigate: ((Bool) -> Void)?
    var onDismiss: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 36, 76:
            onNavigate?(event.modifierFlags.contains(.shift))
        case 53:
            onDismiss?()
        default:
            super.keyDown(with: event)
        }
    }
}
#endif
