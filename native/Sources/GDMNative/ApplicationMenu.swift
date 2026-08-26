import AppKit
import Foundation

extension Notification.Name {
    static let gidemOpenRepository = Notification.Name("Gidem.openRepository")
    static let gidemSaveFocusedFile = Notification.Name("Gidem.saveFocusedFile")
    static let gidemNewTask = Notification.Name("Gidem.newTask")
    static let gidemStartFocusedAgent = Notification.Name("Gidem.startFocusedAgent")
    static let gidemRunVerification = Notification.Name("Gidem.runVerification")
    static let gidemShowCommandPalette = Notification.Name("Gidem.showCommandPalette")
    static let gidemShowTerminal = Notification.Name("Gidem.showTerminal")
    static let gidemShowProof = Notification.Name("Gidem.showProof")
    static let gidemSplitPaneRight = Notification.Name("Gidem.splitPaneRight")
    static let gidemSplitPaneDown = Notification.Name("Gidem.splitPaneDown")
    static let gidemCloseFocusedPane = Notification.Name("Gidem.closeFocusedPane")
}

@MainActor
enum GidemApplicationMenu {
    // NSMenuItem does not retain its target, so keep one dispatcher alive for the
    // lifetime of the application menu.
    private static let dispatcher = GidemApplicationMenuDispatcher()

    static func install(on application: NSApplication = .shared) {
        application.mainMenu = make()
    }

    static func make() -> NSMenu {
        let mainMenu = NSMenu(title: "Main")

        let applicationItem = NSMenuItem()
        applicationItem.submenu = applicationMenu()
        mainMenu.addItem(applicationItem)

        let fileItem = NSMenuItem()
        fileItem.submenu = fileMenu()
        mainMenu.addItem(fileItem)

        let editItem = NSMenuItem()
        editItem.submenu = editMenu()
        mainMenu.addItem(editItem)

        let workspaceItem = NSMenuItem()
        workspaceItem.submenu = workspaceMenu()
        mainMenu.addItem(workspaceItem)

        let viewItem = NSMenuItem()
        viewItem.submenu = viewMenu()
        mainMenu.addItem(viewItem)

        return mainMenu
    }

    private static func applicationMenu() -> NSMenu {
        let menu = NSMenu(title: GidemBrandAssets.productName)
        menu.addItem(NSMenuItem(
            title: "About \(GidemBrandAssets.productName)",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        ))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(
            title: "Hide \(GidemBrandAssets.productName)",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        ))
        menu.addItem(NSMenuItem(
            title: "Quit \(GidemBrandAssets.productName)",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        ))
        return menu
    }

    private static func fileMenu() -> NSMenu {
        let menu = NSMenu(title: "File")
        menu.addItem(commandItem(
            "Open Repository…",
            action: #selector(GidemApplicationMenuDispatcher.gidemOpenRepository(_:)),
            key: "o"
        ))
        menu.addItem(commandItem(
            "Save Focused File",
            action: #selector(GidemApplicationMenuDispatcher.gidemSaveFocusedFile(_:)),
            key: "s"
        ))
        return menu
    }

    private static func editMenu() -> NSMenu {
        let menu = NSMenu(title: "Edit")
        menu.addItem(editItem("Undo", action: Selector(("undo:")), key: "z"))
        let redo = editItem("Redo", action: Selector(("redo:")), key: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        menu.addItem(redo)
        menu.addItem(.separator())
        menu.addItem(editItem("Cut", action: #selector(NSText.cut(_:)), key: "x"))
        menu.addItem(editItem("Copy", action: #selector(NSText.copy(_:)), key: "c"))
        menu.addItem(editItem("Paste", action: #selector(NSText.paste(_:)), key: "v"))
        menu.addItem(editItem("Select All", action: #selector(NSText.selectAll(_:)), key: "a"))
        return menu
    }

    private static func workspaceMenu() -> NSMenu {
        let menu = NSMenu(title: "Workspace")
        menu.addItem(commandItem(
            "New Task…",
            action: #selector(GidemApplicationMenuDispatcher.gidemNewTask(_:)),
            key: "n"
        ))
        menu.addItem(commandItem(
            "Start Focused Agent",
            action: #selector(GidemApplicationMenuDispatcher.gidemStartFocusedAgent(_:)),
            key: "\r"
        ))
        menu.addItem(commandItem(
            "Run or Review Verification",
            action: #selector(GidemApplicationMenuDispatcher.gidemRunVerification(_:)),
            key: "r"
        ))
        menu.addItem(.separator())
        menu.addItem(commandItem(
            "Command Palette…",
            action: #selector(GidemApplicationMenuDispatcher.gidemShowCommandPalette(_:)),
            key: "k"
        ))
        return menu
    }

    private static func viewMenu() -> NSMenu {
        let menu = NSMenu(title: "View")
        menu.addItem(commandItem(
            "Show Terminal",
            action: #selector(GidemApplicationMenuDispatcher.gidemShowTerminal(_:)),
            key: "j"
        ))
        menu.addItem(commandItem(
            "Show Proof",
            action: #selector(GidemApplicationMenuDispatcher.gidemShowProof(_:)),
            key: "p"
        ))
        menu.addItem(.separator())
        menu.addItem(commandItem(
            "Split Pane Right",
            action: #selector(GidemApplicationMenuDispatcher.gidemSplitPaneRight(_:)),
            key: "d"
        ))
        menu.addItem(commandItem(
            "Split Pane Down",
            action: #selector(GidemApplicationMenuDispatcher.gidemSplitPaneDown(_:)),
            key: "d",
            modifiers: [.command, .shift]
        ))
        menu.addItem(commandItem(
            "Close Focused Pane",
            action: #selector(GidemApplicationMenuDispatcher.gidemCloseFocusedPane(_:)),
            key: "k",
            modifiers: [.command, .shift]
        ))
        return menu
    }

    private static func editItem(_ title: String, action: Selector, key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = [.command]
        return item
    }

    private static func commandItem(
        _ title: String,
        action: Selector,
        key: String,
        modifiers: NSEvent.ModifierFlags = [.command]
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = dispatcher
        return item
    }
}

@MainActor
private final class GidemApplicationMenuDispatcher: NSObject {
    @objc func gidemOpenRepository(_ sender: Any?) {
        post(.gidemOpenRepository)
    }

    @objc func gidemSaveFocusedFile(_ sender: Any?) {
        post(.gidemSaveFocusedFile)
    }

    @objc func gidemNewTask(_ sender: Any?) {
        post(.gidemNewTask)
    }

    @objc func gidemStartFocusedAgent(_ sender: Any?) {
        post(.gidemStartFocusedAgent)
    }

    @objc func gidemRunVerification(_ sender: Any?) {
        post(.gidemRunVerification)
    }

    @objc func gidemShowCommandPalette(_ sender: Any?) {
        post(.gidemShowCommandPalette)
    }

    @objc func gidemShowTerminal(_ sender: Any?) {
        post(.gidemShowTerminal)
    }

    @objc func gidemShowProof(_ sender: Any?) {
        post(.gidemShowProof)
    }

    @objc func gidemSplitPaneRight(_ sender: Any?) {
        post(.gidemSplitPaneRight)
    }

    @objc func gidemSplitPaneDown(_ sender: Any?) {
        post(.gidemSplitPaneDown)
    }

    @objc func gidemCloseFocusedPane(_ sender: Any?) {
        post(.gidemCloseFocusedPane)
    }

    private func post(_ name: Notification.Name) {
        NotificationCenter.default.post(name: name, object: nil)
    }
}
