import XCTest
@testable import GDMNative

#if canImport(GhosttyKit)
import GhosttyKit

@MainActor
final class GhosttyHostActionTests: XCTestCase {
    func testPinnedGhosttyActionsDecodeToNativePaneOperations() {
        XCTAssertEqual(
            GhosttyRuntime.hostAction(for: action(
                tag: GHOSTTY_ACTION_NEW_SPLIT,
                configure: { $0.new_split = GHOSTTY_SPLIT_DIRECTION_LEFT }
            )),
            .split(.left)
        )
        XCTAssertEqual(
            GhosttyRuntime.hostAction(for: action(
                tag: GHOSTTY_ACTION_GOTO_SPLIT,
                configure: { $0.goto_split = GHOSTTY_GOTO_SPLIT_DOWN }
            )),
            .focus(.direction(.down))
        )
        XCTAssertEqual(
            GhosttyRuntime.hostAction(for: action(
                tag: GHOSTTY_ACTION_RESIZE_SPLIT,
                configure: {
                    $0.resize_split = ghostty_action_resize_split_s(
                        amount: 100,
                        direction: GHOSTTY_RESIZE_SPLIT_RIGHT
                    )
                }
            )),
            .resize(.right, amount: 100)
        )
        XCTAssertEqual(
            GhosttyRuntime.hostAction(for: action(tag: GHOSTTY_ACTION_EQUALIZE_SPLITS)),
            .equalizeSplits
        )
        XCTAssertEqual(
            GhosttyRuntime.hostAction(for: action(tag: GHOSTTY_ACTION_NEW_TAB)),
            .split(.right)
        )
        XCTAssertEqual(
            GhosttyRuntime.hostAction(for: action(
                tag: GHOSTTY_ACTION_GOTO_TAB,
                configure: { $0.goto_tab = GHOSTTY_GOTO_TAB_PREVIOUS }
            )),
            .focus(.previous)
        )
        XCTAssertEqual(
            GhosttyRuntime.hostAction(for: action(tag: GHOSTTY_ACTION_CLOSE_TAB)),
            .closePane
        )
    }

    func testCloseSurfaceRequestRoutesToHostWithoutFakingChildExit() {
        let driver = GhosttyTerminalDriver(runtime: .shared)
        var receivedAction: TerminalHostAction?
        var terminationWasReported = false
        driver.setHostActionHandler {
            receivedAction = $0
            return true
        }
        driver.onProcessTerminated = { _ in terminationWasReported = true }

        driver.surfaceView.surfaceRequestedClose(requiresConfirmation: false)

        XCTAssertEqual(receivedAction, .closePane)
        XCTAssertFalse(terminationWasReported)
    }

    func testKeySequenceBadgeTracksGhosttyLeaderStateWithoutAWindow() {
        let surface = GhosttyTerminalDriver(runtime: .shared).surfaceView

        surface.setKeySequenceActive(true)
        XCTAssertTrue(surface.isKeySequenceActive)
        XCTAssertTrue(surface.subviews.contains {
            $0.accessibilityLabel() == "Ghostty pane key sequence active"
        })

        surface.setKeySequenceActive(false)
        XCTAssertFalse(surface.isKeySequenceActive)
        XCTAssertFalse(surface.subviews.contains {
            $0.accessibilityLabel() == "Ghostty pane key sequence active"
        })
    }

    func testRealGhosttyBindingPipelineRoutesPaneActionsWithoutOpeningAWindow() throws {
        let driver = GhosttyTerminalDriver(runtime: .shared)
        var actions: [TerminalHostAction] = []
        var terminationWasReported = false
        driver.setHostActionHandler {
            actions.append($0)
            return true
        }
        driver.onProcessTerminated = { _ in terminationWasReported = true }
        driver.start(AgentLaunchSpecification(
            agent: .shell,
            executableURL: URL(fileURLWithPath: "/bin/cat"),
            arguments: [],
            environment: [
                "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "LANG": "en_US.UTF-8"
            ],
            currentDirectory: FileManager.default.temporaryDirectory
        ))
        defer { driver.terminate() }
        XCTAssertTrue(driver.isRunning)

        let bindings: [(String, TerminalHostAction)] = [
            ("new_split:right", .split(.right)),
            ("goto_split:left", .focus(.direction(.left))),
            ("resize_split:right,100", .resize(.right, amount: 100)),
            ("equalize_splits", .equalizeSplits),
            ("close_surface", .closePane)
        ]
        for (binding, expected) in bindings {
            actions.removeAll()
            XCTAssertTrue(driver.surfaceView.performBinding(binding), binding)
            XCTAssertEqual(actions, [expected], binding)
        }
        XCTAssertFalse(terminationWasReported)
    }

    func testInstalledGhosttyCtrlGLeaderRoutesThroughRealKeyParserWithoutAWindow() throws {
        let configURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/ghostty/config")
        let config = try? String(contentsOf: configURL, encoding: .utf8)
        guard config?.contains("keybind = ctrl+g>h=goto_split:left") == true else {
            throw XCTSkip("Installed Ghostty config does not declare the Ctrl+G H pane binding")
        }

        let driver = GhosttyTerminalDriver(runtime: .shared)
        var actions: [TerminalHostAction] = []
        driver.setHostActionHandler {
            actions.append($0)
            return true
        }
        driver.start(AgentLaunchSpecification(
            agent: .shell,
            executableURL: URL(fileURLWithPath: "/bin/cat"),
            arguments: [],
            environment: [
                "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "LANG": "en_US.UTF-8"
            ],
            currentDirectory: FileManager.default.temporaryDirectory
        ))
        defer { driver.terminate() }

        // A headless NSEvent can have semantic characters while Cocoa's
        // keyboard-layout translation is unavailable. Force that state so
        // this test does not depend on process-global input-source timing.
        let unavailableLayoutKeyCode = UInt16.max
        let leader = try XCTUnwrap(keyEvent(
            type: .keyDown,
            keyCode: unavailableLayoutKeyCode,
            characters: "\u{7}",
            charactersIgnoringModifiers: "g",
            modifiers: .control
        ))
        XCTAssertNotEqual(leader.charactersIgnoringModifiers, "")
        XCTAssertEqual(leader.characters(byApplyingModifiers: []), "")
        driver.surfaceView.keyDown(with: leader)
        driver.surfaceView.keyUp(with: try XCTUnwrap(keyEvent(
            type: .keyUp,
            keyCode: unavailableLayoutKeyCode,
            characters: "\u{7}",
            charactersIgnoringModifiers: "g",
            modifiers: .control
        )))
        driver.surfaceView.keyDown(with: try XCTUnwrap(keyEvent(
            type: .keyDown,
            keyCode: 4,
            characters: "h",
            charactersIgnoringModifiers: "h"
        )))
        driver.surfaceView.keyUp(with: try XCTUnwrap(keyEvent(
            type: .keyUp,
            keyCode: 4,
            characters: "h",
            charactersIgnoringModifiers: "h"
        )))

        XCTAssertEqual(actions, [.focus(.direction(.left))])
        XCTAssertFalse(driver.surfaceView.isKeySequenceActive)
    }

    private func action(
        tag: ghostty_action_tag_e,
        configure: (inout ghostty_action_u) -> Void = { _ in }
    ) -> ghostty_action_s {
        var payload = ghostty_action_u()
        configure(&payload)
        return ghostty_action_s(tag: tag, action: payload)
    }

    private func keyEvent(
        type: NSEvent.EventType,
        keyCode: UInt16,
        characters: String,
        charactersIgnoringModifiers: String,
        modifiers: NSEvent.ModifierFlags = []
    ) -> NSEvent? {
        NSEvent.keyEvent(
            with: type,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: 0,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: charactersIgnoringModifiers,
            isARepeat: false,
            keyCode: keyCode
        )
    }
}
#endif
