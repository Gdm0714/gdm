import XCTest
@testable import GDMNative

@MainActor
final class CompactProofCommandTests: XCTestCase {
    func testCompactProofCreatesAndFocusesExactlyOnePaneAndReusesIt() {
        let workbench = WorkbenchState()
        let store = WorkspaceStore(repositoryURL: temporaryDirectory(), workbench: workbench)
        let before = workbench.layout.root.orderedLeafIDs.count

        store.toggleProof(compact: true)
        XCTAssertEqual(workbench.layout.root.orderedLeafIDs.count, before + 1)
        XCTAssertTrue(store.isFocusedProofPane)
        let proofID = workbench.focusedPaneID

        store.toggleProof(compact: true)
        XCTAssertEqual(workbench.layout.root.orderedLeafIDs.count, before + 1)
        XCTAssertEqual(workbench.focusedPaneID, proofID)
    }

    func testCompactProofRefocusesExistingProofPane() {
        let workbench = WorkbenchState()
        let store = WorkspaceStore(repositoryURL: temporaryDirectory(), workbench: workbench)
        store.revealPane(.proof)
        let proofID = workbench.focusedPaneID
        store.focusNextPane()

        store.toggleProof(compact: true)
        XCTAssertEqual(workbench.focusedPaneID, proofID)
        XCTAssertTrue(store.isFocusedProofPane)
    }

    func testWideProofOnlyTogglesRailVisibility() {
        let workbench = WorkbenchState()
        let store = WorkspaceStore(repositoryURL: temporaryDirectory(), workbench: workbench)
        let before = workbench.layout.root.orderedLeafIDs
        let initial = store.isProofRailVisible

        store.toggleProof(compact: false)

        XCTAssertEqual(workbench.layout.root.orderedLeafIDs, before)
        XCTAssertEqual(store.isProofRailVisible, !initial)
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("gidem-compact-proof-\(UUID().uuidString)", isDirectory: true)
    }
}
