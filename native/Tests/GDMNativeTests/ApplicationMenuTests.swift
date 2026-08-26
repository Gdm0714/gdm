import AppKit
import XCTest
@testable import GDMNative

@MainActor
final class ApplicationMenuTests: XCTestCase {
    func testCoreWorkspaceCommandsAreDiscoverableFromTheMenuBar() throws {
        let mainMenu = GidemApplicationMenu.make()
        let fileMenu = try XCTUnwrap(mainMenu.items.first(where: { $0.submenu?.title == "File" })?.submenu)
        let workspaceMenu = try XCTUnwrap(
            mainMenu.items.first(where: { $0.submenu?.title == "Workspace" })?.submenu
        )
        let viewMenu = try XCTUnwrap(mainMenu.items.first(where: { $0.submenu?.title == "View" })?.submenu)

        assertMenuItem(fileMenu, title: "Open Repository…", action: "gidemOpenRepository:", key: "o")
        assertMenuItem(fileMenu, title: "Save Focused File", action: "gidemSaveFocusedFile:", key: "s")
        assertMenuItem(workspaceMenu, title: "New Task…", action: "gidemNewTask:", key: "n")
        assertMenuItem(
            workspaceMenu,
            title: "Start Focused Agent",
            action: "gidemStartFocusedAgent:",
            key: "\r"
        )
        assertMenuItem(
            workspaceMenu,
            title: "Run or Review Verification",
            action: "gidemRunVerification:",
            key: "r"
        )
        assertMenuItem(
            workspaceMenu,
            title: "Command Palette…",
            action: "gidemShowCommandPalette:",
            key: "k"
        )
        assertMenuItem(viewMenu, title: "Show Terminal", action: "gidemShowTerminal:", key: "j")
        assertMenuItem(viewMenu, title: "Show Proof", action: "gidemShowProof:", key: "p")
        assertMenuItem(viewMenu, title: "Split Pane Right", action: "gidemSplitPaneRight:", key: "d")
        assertMenuItem(
            viewMenu,
            title: "Split Pane Down",
            action: "gidemSplitPaneDown:",
            key: "d",
            modifiers: [.command, .shift]
        )
        assertMenuItem(
            viewMenu,
            title: "Close Focused Pane",
            action: "gidemCloseFocusedPane:",
            key: "k",
            modifiers: [.command, .shift]
        )
    }

    func testEditMenuRoutesStandardUndoRedoAndEditingCommands() throws {
        let mainMenu = GidemApplicationMenu.make()
        let editMenu = try XCTUnwrap(mainMenu.items.first(where: { $0.submenu?.title == "Edit" })?.submenu)

        let undo = try XCTUnwrap(editMenu.item(withTitle: "Undo"))
        XCTAssertEqual(undo.action, Selector(("undo:")))
        XCTAssertEqual(undo.keyEquivalent, "z")
        XCTAssertEqual(undo.keyEquivalentModifierMask, [.command])

        let redo = try XCTUnwrap(editMenu.item(withTitle: "Redo"))
        XCTAssertEqual(redo.action, Selector(("redo:")))
        XCTAssertEqual(redo.keyEquivalentModifierMask, [.command, .shift])

        XCTAssertEqual(editMenu.item(withTitle: "Cut")?.action, #selector(NSText.cut(_:)))
        XCTAssertEqual(editMenu.item(withTitle: "Copy")?.action, #selector(NSText.copy(_:)))
        XCTAssertEqual(editMenu.item(withTitle: "Paste")?.action, #selector(NSText.paste(_:)))
        XCTAssertEqual(editMenu.item(withTitle: "Select All")?.action, #selector(NSText.selectAll(_:)))
    }

    private func assertMenuItem(
        _ menu: NSMenu,
        title: String,
        action: String,
        key: String,
        modifiers: NSEvent.ModifierFlags = [.command],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let item = menu.item(withTitle: title) else {
            return XCTFail("missing menu item: \(title)", file: file, line: line)
        }
        XCTAssertEqual(item.action, Selector((action)), file: file, line: line)
        XCTAssertEqual(item.keyEquivalent, key, file: file, line: line)
        XCTAssertEqual(item.keyEquivalentModifierMask, modifiers, file: file, line: line)
    }
}
