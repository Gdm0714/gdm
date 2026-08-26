import AppKit
import Darwin
import Foundation
import XCTest
@testable import GDMNative

#if canImport(GhosttyKit)
@MainActor
final class GhosttyTerminalCompatibilityTests: XCTestCase {
    func testProgrammaticPromptPasteUsesBracketedBoundaryBeforeSubmit() throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let scriptURL = root.appendingPathComponent("programmatic-paste.py")
        try #"""
        import os
        import select
        import sys
        import termios
        import time
        import tty

        fd = sys.stdin.fileno()
        previous = termios.tcgetattr(fd)

        def emit(value):
            os.write(sys.stdout.fileno(), value)

        def read_until(suffix, timeout=5.0):
            data = b""
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                readable, _, _ = select.select([fd], [], [], 0.05)
                if readable:
                    data += os.read(fd, 4096)
                    if data.endswith(suffix):
                        break
            return data

        try:
            tty.setraw(fd)
            emit(b"\x1b[?2004hGIDEM_PROGRAMMATIC_PASTE_READY\r\n")
            pasted = read_until(b"\x1b[201~")
            submitted = read_until(b"\r")
            expected = b"\x1b[200~GIDEM_AUTOMATION_PROMPT\x1b[201~"
            if pasted == expected and submitted == b"\r":
                emit(b"GIDEM_PROGRAMMATIC_PASTE_OK\r\n")
            else:
                emit(
                    b"GIDEM_PROGRAMMATIC_PASTE_FAILED="
                    + pasted.hex().encode("ascii")
                    + b":"
                    + submitted.hex().encode("ascii")
                    + b"\r\n"
                )
        finally:
            emit(b"\x1b[?2004l")
            termios.tcsetattr(fd, termios.TCSANOW, previous)
        """#.write(to: scriptURL, atomically: true, encoding: .utf8)

        let python = try XCTUnwrap(resolveExecutable("python3"))
        let harness = GhosttyCompatibilityHarness(
            specification: specification(
                executable: python,
                arguments: [scriptURL.path],
                currentDirectory: root
            )
        )
        defer { harness.close() }

        XCTAssertTrue(
            harness.waitForScreen("GIDEM_PROGRAMMATIC_PASTE_READY", timeout: 8),
            harness.surface.screenText()
        )
        harness.driver.sendPaste("GIDEM_AUTOMATION_PROMPT")
        harness.send([0x0D])
        XCTAssertTrue(
            harness.waitForScreen("GIDEM_PROGRAMMATIC_PASTE_OK", timeout: 8),
            harness.surface.screenText()
        )
        XCTAssertTrue(harness.waitForExit(timeout: 8), harness.surface.screenText())
        XCTAssertEqual(harness.exitReason, .exited(0))
    }

    func testRealGhosttyRunsVimNeovimLessFzfTopAndTmuxTUIs() throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let markerFile = root.appendingPathComponent("tui-marker.txt")
        try "GIDEM_VIM_REAL_SURFACE\nGIDEM_FZF_REAL_SURFACE\nsecond line\n".write(
            to: markerFile,
            atomically: true,
            encoding: .utf8
        )

        for executableName in ["vim", "nvim"] {
            let executable = try XCTUnwrap(resolveExecutable(executableName), "\(executableName) is required by the compatibility matrix")
            let harness = GhosttyCompatibilityHarness(
                specification: specification(
                    executable: executable,
                    arguments: ["-Nu", "NONE", "-n", markerFile.path],
                    currentDirectory: root
                )
            )
            defer { harness.close() }
            XCTAssertTrue(harness.waitForScreen("GIDEM_VIM_REAL_SURFACE", timeout: 8))
            harness.send([0x1B])
            harness.send(":qa!\r")
            XCTAssertTrue(harness.waitForExit(timeout: 8), harness.surface.screenText())
            XCTAssertEqual(harness.exitReason, .exited(0))
            harness.close()
        }

        let less = try XCTUnwrap(resolveExecutable("less"))
        let lessHarness = GhosttyCompatibilityHarness(
            specification: specification(executable: less, arguments: [markerFile.path], currentDirectory: root)
        )
        XCTAssertTrue(lessHarness.waitForScreen("GIDEM_VIM_REAL_SURFACE", timeout: 8))
        lessHarness.send("q")
        XCTAssertTrue(lessHarness.waitForExit(timeout: 8))
        XCTAssertEqual(lessHarness.exitReason, .exited(0))
        lessHarness.close()

        let fzf = try XCTUnwrap(resolveExecutable("fzf"), "fzf is required by the compatibility matrix")
        let fzfHarness = GhosttyCompatibilityHarness(
            specification: specification(
                executable: URL(fileURLWithPath: "/bin/zsh"),
                arguments: [
                    "-f", "-c",
                    "/bin/cat \"$1\" | \"$2\" --no-mouse --query GIDEM_FZF",
                    "gidem-fzf", markerFile.path, fzf.path
                ],
                currentDirectory: root
            )
        )
        XCTAssertTrue(fzfHarness.waitForScreen("GIDEM_FZF", timeout: 8))
        fzfHarness.send("\r")
        XCTAssertTrue(fzfHarness.waitForExit(timeout: 8))
        XCTAssertEqual(fzfHarness.exitReason, .exited(0))
        fzfHarness.close()

        let top = try XCTUnwrap(resolveExecutable("top"))
        let topHarness = GhosttyCompatibilityHarness(
            specification: specification(
                executable: top,
                arguments: ["-l", "1", "-n", "1", "-stats", "pid,command,cpu"],
                currentDirectory: root
            )
        )
        XCTAssertTrue(topHarness.waitForExit(timeout: 12))
        let topText = topHarness.surface.screenText()
        XCTAssertTrue(topText.contains("PID") || topText.contains("Processes"), topText)
        XCTAssertEqual(topHarness.exitReason, .exited(0))
        topHarness.close()

        let tmux = try XCTUnwrap(resolveExecutable("tmux"), "tmux is required by the compatibility matrix")
        let tmuxProgram = root.appendingPathComponent("tmux-fixture.zsh")
        try #"""
        #!/bin/zsh -f
        print GIDEM_TMUX_REAL_SURFACE
        IFS= read -r reply
        [[ "$reply" == quit ]]
        """#.write(to: tmuxProgram, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: tmuxProgram.path)
        let socketName = "gidem-qa-\(UUID().uuidString)"
        let tmuxHarness = GhosttyCompatibilityHarness(
            specification: specification(
                executable: tmux,
                arguments: ["-L", socketName, "new-session", tmuxProgram.path],
                currentDirectory: root
            )
        )
        defer {
            tmuxHarness.close()
            runProcess(tmux, ["-L", socketName, "kill-server"])
        }
        XCTAssertTrue(tmuxHarness.waitForScreen("GIDEM_TMUX_REAL_SURFACE", timeout: 10))
        tmuxHarness.send("quit\r")
        XCTAssertTrue(tmuxHarness.waitForExit(timeout: 10))
        XCTAssertEqual(tmuxHarness.exitReason, .exited(0))
    }

    func testRealGhosttyRunsSSHProtocolFixture() throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let ready = root.appendingPathComponent("ssh-port")
        let python = try XCTUnwrap(resolveExecutable("python3"))
        let server = Process()
        server.executableURL = python
        server.arguments = [
            "-c",
            #"""
            import os, socket, sys, time
            server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            with open(sys.argv[1], "w", encoding="utf-8") as output:
                output.write(str(server.getsockname()[1]))
                output.flush()
                os.fsync(output.fileno())
            client, _ = server.accept()
            client.sendall(b"SSH-2.0-GidemFixture\r\n")
            time.sleep(0.35)
            client.close()
            server.close()
            """#,
            ready.path
        ]
        try server.run()
        defer {
            if server.isRunning { server.terminate() }
            server.waitUntilExit()
        }
        XCTAssertTrue(waitUntil(timeout: 5) { FileManager.default.fileExists(atPath: ready.path) })
        let port = try String(contentsOf: ready, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)

        let ssh = try XCTUnwrap(resolveExecutable("ssh"))
        let harness = GhosttyCompatibilityHarness(
            specification: specification(
                executable: ssh,
                arguments: [
                    "-vv", "-F", "/dev/null", "-o", "ConnectTimeout=3",
                    "-o", "StrictHostKeyChecking=no", "-p", port, "127.0.0.1"
                ],
                currentDirectory: root
            )
        )
        defer { harness.close() }
        XCTAssertTrue(harness.waitForScreen("GidemFixture", timeout: 8), harness.surface.screenText())
        XCTAssertTrue(harness.waitForExit(timeout: 8))
        XCTAssertEqual(
            harness.exitReason,
            .exited(255),
            "backendExitCode=\(String(describing: harness.surface.backendExitCode)) rawStatus=\(String(describing: harness.rawStatus))"
        )
    }

    func testMousePasteOSCLinksScrollbackSearchAndRapidRetinaResizeOnRealSurface() throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let scriptURL = root.appendingPathComponent("surface-matrix.py")
        let winchProof = root.appendingPathComponent("sigwinch-proof")
        try #"""
        import base64, os, select, signal, sys, termios, time, tty

        fd = sys.stdin.fileno()
        previous = termios.tcgetattr(fd)
        tty.setraw(fd)

        def emit(value):
            os.write(sys.stdout.fileno(), value)

        def read_until(needle, timeout=5.0):
            result = b""
            deadline = time.time() + timeout
            while time.time() < deadline and needle not in result:
                readable, _, _ = select.select([fd], [], [], 0.1)
                if readable:
                    result += os.read(fd, 4096)
            return result

        def winch(_signal, _frame):
            with open(sys.argv[1], "a", encoding="utf-8") as output:
                output.write("WINCH\n")
            emit(b"\r\nGIDEM_SIGWINCH_OK\r\n")

        signal.signal(signal.SIGWINCH, winch)
        try:
            cwd = os.getcwd().encode("utf-8")
            emit(b"\x1b]0;GIDEM_OSC_TITLE\x07")
            emit(b"\x1b]7;file://localhost" + cwd + b"\x07")
            emit(b"\x1b]8;;https://example.com/gidem\x1b\\GIDEM_OSC8_LINK\x1b]8;;\x1b\\\r\n")
            emit(b"\x1b]8;;file:///tmp/gidem-proof\x1b\\GIDEM_FILE_URL\x1b]8;;\x1b\\\r\n")
            emit("\x1b[38;2;12;200;99mGIDEM_TRUECOLOR_한글🙂é\x1b[0m\r\n".encode("utf-8"))
            emit(b"\x1b[?1003h\x1b[?1006hGIDEM_MOUSE_READY\r\n")
            mouse = read_until(b"M")
            if b"\x1b[<" in mouse and mouse.endswith(b"M"):
                emit(b"GIDEM_MOUSE_REPORT_OK\r\n")
            else:
                emit(b"GIDEM_MOUSE_REPORT_FAILED=" + mouse.hex().encode("ascii") + b"\r\n")

            emit(b"\x1b[?2004hGIDEM_BRACKETED_PASTE_READY\r\n")
            pasted = read_until(b"\x1b[201~")
            expected = "GIDEM_PASTE_한글".encode("utf-8")
            if b"\x1b[200~" in pasted and expected in pasted and pasted.endswith(b"\x1b[201~"):
                emit(b"GIDEM_BRACKETED_PASTE_OK\r\n")
            else:
                emit(b"GIDEM_BRACKETED_PASTE_FAILED=" + pasted.hex().encode("ascii") + b"\r\n")

            emit(b"GIDEM_OSC52_WAIT\r\n")
            os.read(fd, 1)
            payload = base64.b64encode(b"GIDEM_OSC52_HIJACK")
            emit(b"\x1b]52;c;" + payload + b"\x07GIDEM_OSC52_EMITTED\r\n")
            for index in range(420):
                marker = " GIDEM_SEARCH_NEEDLE" if index in (17, 350) else ""
                emit((f"scrollback-{index:04d}{marker}\r\n").encode("utf-8"))
            emit(b"GIDEM_SEARCH_READY\r\n")
            read_until(b"q", timeout=30.0)
        finally:
            emit(b"\x1b[?2004l\x1b[?1003l\x1b[?1006l")
            termios.tcsetattr(fd, termios.TCSANOW, previous)
        """#.write(to: scriptURL, atomically: true, encoding: .utf8)

        let python = try XCTUnwrap(resolveExecutable("python3"))
        let harness = GhosttyCompatibilityHarness(
            specification: specification(
                executable: python,
                arguments: [scriptURL.path, winchProof.path],
                currentDirectory: root
            )
        )
        defer { harness.close() }
        let surface = harness.surface

        XCTAssertTrue(harness.waitForScreen("GIDEM_MOUSE_READY", timeout: 8))
        XCTAssertTrue(surface.isMouseReportingEnabled)
        surface.injectCompatibilityMouse(position: NSPoint(x: 24, y: 24), pressed: true)
        XCTAssertTrue(harness.waitForScreen("GIDEM_MOUSE_REPORT_OK", timeout: 5), surface.screenText())

        XCTAssertTrue(harness.waitForScreen("GIDEM_BRACKETED_PASTE_READY", timeout: 5))
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("GIDEM_PASTE_한글", forType: .string)
        surface.paste(nil)
        XCTAssertTrue(harness.waitForScreen("GIDEM_BRACKETED_PASTE_OK", timeout: 5), surface.screenText())

        XCTAssertTrue(harness.waitForScreen("GIDEM_OSC52_WAIT", timeout: 5))
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("GIDEM_CLIPBOARD_SENTINEL", forType: .string)
        harness.send("x")
        XCTAssertTrue(harness.waitForScreen("GIDEM_OSC52_EMITTED", timeout: 5))
        _ = waitUntil(timeout: 0.25) { false }
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), "GIDEM_CLIPBOARD_SENTINEL")

        XCTAssertTrue(harness.waitForScreen("GIDEM_SEARCH_READY", timeout: 8))
        XCTAssertEqual(surface.terminalTitle, "GIDEM_OSC_TITLE")
        XCTAssertEqual(
            URL(fileURLWithPath: surface.currentDirectory ?? "").resolvingSymlinksInPath(),
            root.resolvingSymlinksInPath()
        )
        let screen = surface.screenText()
        XCTAssertTrue(screen.contains("GIDEM_OSC8_LINK"))
        XCTAssertTrue(screen.contains("GIDEM_FILE_URL"))
        XCTAssertTrue(screen.contains("GIDEM_TRUECOLOR_한글🙂é"))
        XCTAssertNotNil(GhosttySurfaceView.allowedExternalURL("https://example.com/gidem"))
        XCTAssertNotNil(GhosttySurfaceView.allowedExternalURL("file:///tmp/gidem-proof"))
        XCTAssertNil(GhosttySurfaceView.allowedExternalURL("javascript:alert(1)"))
        XCTAssertNil(GhosttySurfaceView.allowedExternalURL("data:text/plain,secret"))

        surface.selectAll(nil)
        surface.copy(nil)
        XCTAssertTrue(waitUntil(timeout: 2) {
            NSPasteboard.general.string(forType: .string)?.contains("GIDEM_SEARCH_READY") == true
        })

        surface.beginSearch(with: "GIDEM_SEARCH_NEEDLE")
        XCTAssertTrue(waitUntil(timeout: 5) { surface.searchMatchCount == 2 })
        XCTAssertTrue(surface.performBinding("navigate_search:next"))
        XCTAssertTrue(surface.performBinding("navigate_search:previous"))
        surface.injectCompatibilityScroll(deltaY: -180)

        let identity = try XCTUnwrap(surface.surfaceIdentity)
        for index in 0..<48 {
            let size = NSSize(width: 420 + index * 9, height: 240 + index * 5)
            surface.applyCompatibilityGeometry(size: size, scale: index.isMultiple(of: 2) ? 1 : 2)
        }
        surface.applyCompatibilityGeometry(size: NSSize(width: 800, height: 500), scale: 2)
        XCTAssertTrue(waitUntil(timeout: 3) {
            surface.surfaceGeometry?.widthPixels == 1_600 && surface.surfaceGeometry?.heightPixels == 1_000
        })
        let geometry = try XCTUnwrap(surface.surfaceGeometry)
        XCTAssertGreaterThan(geometry.columns, 0)
        XCTAssertGreaterThan(geometry.rows, 0)
        XCTAssertEqual(surface.surfaceIdentity, identity)
        XCTAssertTrue(waitUntil(timeout: 3) { FileManager.default.fileExists(atPath: winchProof.path) })
        XCTAssertTrue(harness.waitForScreen("GIDEM_SIGWINCH_OK", timeout: 3), surface.screenText())

        surface.endSearch()
        XCTAssertTrue(surface.performBinding("clear_screen"))
        XCTAssertTrue(waitUntil(timeout: 3) { !surface.screenText().contains("GIDEM_SEARCH_NEEDLE") })
        harness.send("q")
        XCTAssertTrue(harness.waitForExit(timeout: 8))
        XCTAssertEqual(harness.exitReason, .exited(0))
    }

    func testIMEDeadKeyEmojiAndDraggedFilePathUseTerminalInputPath() throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let result = root.appendingPathComponent("ime-result")
        let ready = root.appendingPathComponent("ime-ready")
        let script = """
        /usr/bin/printf ready > "$1"
        IFS= read -r value
        /usr/bin/printf '%s' "$value" > "$2"
        """
        let harness = GhosttyCompatibilityHarness(
            specification: specification(
                executable: URL(fileURLWithPath: "/bin/zsh"),
                arguments: ["-f", "-c", script, "gidem-ime", ready.path, result.path],
                currentDirectory: root
            )
        )
        defer { harness.close() }
        XCTAssertTrue(waitUntil(timeout: 5) { FileManager.default.fileExists(atPath: ready.path) })
        harness.surface.setMarkedText("한", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(harness.surface.hasMarkedText())
        harness.surface.insertText("한글🙂é", replacementRange: NSRange(location: NSNotFound, length: 0))
        harness.send("\n")
        XCTAssertTrue(harness.waitForExit(timeout: 8))
        XCTAssertEqual(try String(contentsOf: result, encoding: .utf8), "한글🙂é")

        let draggedResult = root.appendingPathComponent("dragged-result")
        let draggedProgram = root.appendingPathComponent("dragged file.zsh")
        try "#!/bin/zsh\n/usr/bin/printf dragged > '\(draggedResult.path)'\n".write(
            to: draggedProgram,
            atomically: true,
            encoding: .utf8
        )
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: draggedProgram.path)
        let shellHarness = GhosttyCompatibilityHarness(
            specification: specification(
                executable: URL(fileURLWithPath: "/bin/zsh"),
                arguments: ["-f"],
                currentDirectory: root,
                extraEnvironment: ["PS1": "GIDEM_DRAG> ", "RPS1": ""]
            )
        )
        defer { shellHarness.close() }
        XCTAssertTrue(waitUntil(timeout: 8) {
            let text = shellHarness.surface.screenText(viewportOnly: true)
            return text.contains("Last login:") && text.contains("% ")
        })
        shellHarness.send("PS1='GIDEM_DRAG> '; print GIDEM_DRAG_READY\n")
        XCTAssertTrue(shellHarness.waitForScreen("GIDEM_DRAG_READY", timeout: 8))
        XCTAssertTrue(shellHarness.surface.pasteDraggedFileURLs([draggedProgram]))
        shellHarness.send("\n")
        XCTAssertTrue(waitUntil(timeout: 5) { FileManager.default.fileExists(atPath: draggedResult.path) })
        shellHarness.send([0x04])
        XCTAssertTrue(shellHarness.waitForExit(timeout: 8))
    }

    func testCtrlCJobControlCtrlDAndDriverOwnedForcedCleanup() throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let shellHarness = GhosttyCompatibilityHarness(
            specification: specification(
                executable: URL(fileURLWithPath: "/bin/zsh"),
                arguments: ["-f"],
                currentDirectory: root,
                extraEnvironment: ["PS1": "GIDEM_JOB> ", "RPS1": ""]
            )
        )
        defer { shellHarness.close() }
        XCTAssertTrue(waitUntil(timeout: 8) {
            let text = shellHarness.surface.screenText(viewportOnly: true)
            return text.contains("Last login:") && text.contains("% ")
        })
        shellHarness.send("PS1='GIDEM_JOB> '; print GIDEM_JOB_READY\n")
        XCTAssertTrue(shellHarness.waitForScreen("GIDEM_JOB_READY", timeout: 8))
        let shellPID = shellHarness.driver.processIdentifier
        shellHarness.send("sleep 30\n")
        XCTAssertTrue(waitUntil(timeout: 5) {
            shellHarness.driver.processIdentifier > 0 && shellHarness.driver.processIdentifier != shellPID
        })
        shellHarness.send([0x1A])
        XCTAssertTrue(waitUntil(timeout: 5) {
            shellHarness.surface.screenText().lowercased().contains("suspended")
        }, shellHarness.surface.screenText())
        shellHarness.send("bg\n")
        XCTAssertTrue(waitUntil(timeout: 5) {
            let text = shellHarness.surface.screenText().lowercased()
            return text.contains("continued") || text.contains("running")
        }, shellHarness.surface.screenText())
        shellHarness.send("fg\n")
        XCTAssertTrue(waitUntil(timeout: 5) { shellHarness.driver.processIdentifier != shellPID })
        shellHarness.send([0x03])
        XCTAssertTrue(waitUntil(timeout: 5) { shellHarness.driver.processIdentifier == shellPID })
        shellHarness.send("cat >/dev/null\n")
        XCTAssertTrue(waitUntil(timeout: 5) { shellHarness.driver.processIdentifier != shellPID })
        shellHarness.send([0x04])
        XCTAssertTrue(waitUntil(timeout: 5) { shellHarness.driver.processIdentifier == shellPID })
        shellHarness.send([0x04])
        XCTAssertTrue(shellHarness.waitForExit(timeout: 8))
        XCTAssertEqual(shellHarness.exitReason, .exited(0))

        let ready = root.appendingPathComponent("forced-ready")
        let forcedScript = #"""
        import os, signal, sys, time
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        with open(sys.argv[1], "w", encoding="utf-8") as output:
            output.write(str(os.getpid()))
            output.flush()
            os.fsync(output.fileno())
        while True:
            time.sleep(1)
        """#
        let python = try XCTUnwrap(resolveExecutable("python3"))
        let forcedHarness = GhosttyCompatibilityHarness(
            specification: specification(
                executable: python,
                arguments: ["-c", forcedScript, ready.path],
                currentDirectory: root
            )
        )
        XCTAssertTrue(waitUntil(timeout: 5) { FileManager.default.fileExists(atPath: ready.path) })
        let pid = pid_t(try XCTUnwrap(Int32(String(contentsOf: ready, encoding: .utf8))))
        forcedHarness.close()
        let wasReaped = waitUntil(timeout: 8) { Darwin.kill(pid, 0) == -1 && errno == ESRCH }
        if !wasReaped { _ = Darwin.kill(pid, SIGKILL) }
        XCTAssertTrue(wasReaped, "Ghostty must own and reap even a TERM-resistant PTY child")
    }

    private func specification(
        executable: URL,
        arguments: [String],
        currentDirectory: URL,
        extraEnvironment: [String: String] = [:]
    ) -> AgentLaunchSpecification {
        var environment = [
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": "en_US.UTF-8",
            "LC_ALL": "en_US.UTF-8"
        ]
        environment.merge(extraEnvironment) { _, replacement in replacement }
        return AgentLaunchSpecification(
            agent: .shell,
            executableURL: executable,
            arguments: arguments,
            environment: environment,
            currentDirectory: currentDirectory
        )
    }

    private func makeTemporaryDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "gidem-ghostty-matrix-\(UUID().uuidString)",
            isDirectory: true
        )
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func resolveExecutable(_ name: String) -> URL? {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        return path.split(separator: ":")
            .map { URL(fileURLWithPath: String($0), isDirectory: true).appendingPathComponent(name) }
            .first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }

    private func runProcess(_ executable: URL, _ arguments: [String]) {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
    }

    private func waitUntil(timeout: TimeInterval, condition: () -> Bool) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.01))
        }
        return condition()
    }
}

@MainActor
private final class GhosttyCompatibilityHarness {
    let driver: GhosttyTerminalDriver
    let surface: GhosttySurfaceView
    let window: NSWindow
    private(set) var rawStatus: Int32?
    private var didExit = false
    private var closed = false

    var exitReason: TerminalTermination? {
        guard didExit else { return nil }
        return TerminalSession.decodeWaitStatus(rawStatus)
    }

    init(specification: AgentLaunchSpecification) {
        driver = GhosttyTerminalDriver(runtime: .shared)
        surface = driver.surfaceView
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 480),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = surface
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(surface)
        driver.resize(to: NSSize(width: 760, height: 480))
        driver.onProcessTerminated = { [weak self] status in
            self?.rawStatus = status
            self?.didExit = true
        }
        driver.start(specification)
    }

    func send(_ value: String) { driver.send(Array(value.utf8)) }
    func send(_ bytes: [UInt8]) { driver.send(bytes) }

    func waitForScreen(_ marker: String, timeout: TimeInterval) -> Bool {
        waitUntil(timeout: timeout) { surface.screenText().contains(marker) }
    }

    func waitForExit(timeout: TimeInterval) -> Bool {
        waitUntil(timeout: timeout) { didExit }
    }

    func close() {
        guard !closed else { return }
        closed = true
        driver.terminate()
        window.contentView = nil
        window.orderOut(nil)
    }

    private func waitUntil(timeout: TimeInterval, condition: () -> Bool) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.01))
        }
        return condition()
    }
}
#endif
