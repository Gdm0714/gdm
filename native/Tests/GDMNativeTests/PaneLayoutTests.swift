import XCTest
@testable import GDMNative

final class PaneLayoutTests: XCTestCase {
    func testDirectionalSplitsInsertOnRequestedSide() {
        let original = UUID()
        let left = UUID()
        let up = UUID()
        var layout = PaneLayoutRecord.single(
            paneID: original,
            content: .terminal(TerminalPaneState()),
            focusedPaneID: original
        )

        XCTAssertTrue(layout.split(
            paneID: original,
            direction: .left,
            newPaneID: left,
            content: .terminal(TerminalPaneState())
        ))
        XCTAssertEqual(layout.root.orderedLeafIDs, [left, original])
        XCTAssertEqual(layout.focusedPaneID, left)

        XCTAssertTrue(layout.split(
            paneID: original,
            direction: .up,
            newPaneID: up,
            content: .terminal(TerminalPaneState())
        ))
        XCTAssertEqual(layout.root.orderedLeafIDs, [left, up, original])
        XCTAssertEqual(layout.focusedPaneID, up)
    }

    func testDirectionalFocusFollowsVisibleTwoByTwoGeometry() {
        let topLeft = UUID()
        let topRight = UUID()
        let bottomLeft = UUID()
        let bottomRight = UUID()
        var layout = PaneLayoutRecord.single(
            paneID: topLeft,
            content: .terminal(TerminalPaneState()),
            focusedPaneID: topLeft
        )
        XCTAssertTrue(layout.split(
            paneID: topLeft,
            direction: .right,
            newPaneID: topRight,
            content: .terminal(TerminalPaneState())
        ))
        XCTAssertTrue(layout.split(
            paneID: topLeft,
            direction: .down,
            newPaneID: bottomLeft,
            content: .terminal(TerminalPaneState())
        ))
        XCTAssertTrue(layout.split(
            paneID: topRight,
            direction: .down,
            newPaneID: bottomRight,
            content: .terminal(TerminalPaneState())
        ))

        layout.focus(topLeft)
        XCTAssertTrue(layout.focus(.direction(.right)))
        XCTAssertEqual(layout.focusedPaneID, topRight)
        XCTAssertTrue(layout.focus(.direction(.down)))
        XCTAssertEqual(layout.focusedPaneID, bottomRight)
        XCTAssertTrue(layout.focus(.direction(.left)))
        XCTAssertEqual(layout.focusedPaneID, bottomLeft)
        XCTAssertTrue(layout.focus(.direction(.up)))
        XCTAssertEqual(layout.focusedPaneID, topLeft)
        XCTAssertFalse(layout.focus(.direction(.up)), "An outer edge must be a no-op")
    }

    func testGhosttyStyleResizeUsesNearestMatchingAncestorAndEqualizeUsesPaneWeights() throws {
        let first = UUID()
        let second = UUID()
        let third = UUID()
        let innerID = UUID()
        let rootID = UUID()
        var layout = PaneLayoutRecord(
            root: .split(PaneSplitRecord(
                id: rootID,
                axis: .horizontal,
                fraction: 0.7,
                first: .leaf(PaneLeafRecord(id: first, content: .files)),
                second: .split(PaneSplitRecord(
                    id: innerID,
                    axis: .horizontal,
                    fraction: 0.3,
                    first: .leaf(PaneLeafRecord(id: second, content: .diff)),
                    second: .leaf(PaneLeafRecord(id: third, content: .proof))
                ))
            )),
            focusedPaneID: third
        )

        XCTAssertTrue(layout.resizeFocused(
            direction: .left,
            amount: 100,
            splitLength: 1_000,
            displayedFraction: 0.3
        ))
        XCTAssertEqual(try XCTUnwrap(layout.root.fraction(forSplitID: innerID)), 0.2, accuracy: 0.000_001)
        XCTAssertEqual(try XCTUnwrap(layout.root.fraction(forSplitID: rootID)), 0.7, accuracy: 0.000_001)

        XCTAssertTrue(layout.equalizeSplits())
        XCTAssertEqual(try XCTUnwrap(layout.root.fraction(forSplitID: rootID)), 1.0 / 3.0, accuracy: 0.000_001)
        XCTAssertEqual(try XCTUnwrap(layout.root.fraction(forSplitID: innerID)), 0.5, accuracy: 0.000_001)
    }

    func testGhosttyResizeAmountUsesActualSplitPixelsAndZeroIsNoOp() throws {
        let first = UUID()
        let second = UUID()
        let splitID = UUID()
        var narrow = PaneLayoutRecord(
            root: .split(PaneSplitRecord(
                id: splitID,
                axis: .horizontal,
                fraction: 0.5,
                first: .leaf(PaneLeafRecord(id: first, content: .files)),
                second: .leaf(PaneLeafRecord(id: second, content: .proof))
            )),
            focusedPaneID: second
        )
        var wide = narrow

        XCTAssertTrue(narrow.resizeFocused(
            direction: .right,
            amount: 100,
            splitLength: 500,
            displayedFraction: 0.5
        ))
        XCTAssertTrue(wide.resizeFocused(
            direction: .right,
            amount: 100,
            splitLength: 1_000,
            displayedFraction: 0.5
        ))
        XCTAssertEqual(try XCTUnwrap(narrow.root.fraction(forSplitID: splitID)), 0.7, accuracy: 0.000_001)
        XCTAssertEqual(try XCTUnwrap(wide.root.fraction(forSplitID: splitID)), 0.6, accuracy: 0.000_001)
        XCTAssertFalse(wide.resizeFocused(
            direction: .right,
            amount: 0,
            splitLength: 1_000,
            displayedFraction: 0.6
        ))

        var visuallyConstrained = PaneLayoutRecord(
            root: .split(PaneSplitRecord(
                id: splitID,
                axis: .horizontal,
                fraction: 0.2,
                first: .leaf(PaneLeafRecord(id: first, content: .files)),
                second: .leaf(PaneLeafRecord(id: second, content: .proof))
            )),
            focusedPaneID: second
        )
        XCTAssertTrue(visuallyConstrained.resizeFocused(
            direction: .right,
            amount: 100,
            splitLength: 1_000,
            displayedFraction: 0.4
        ))
        XCTAssertEqual(
            try XCTUnwrap(visuallyConstrained.root.fraction(forSplitID: splitID)),
            0.5,
            accuracy: 0.000_001,
            "Keyboard resize must begin at the fraction actually shown on screen"
        )
    }

    func testNestedSplitKeepsStableLeafIDsAndClampsFractions() throws {
        let initialPaneID = UUID(uuidString: "10000000-0000-0000-0000-000000000001")!
        let rightPaneID = UUID(uuidString: "10000000-0000-0000-0000-000000000002")!
        let bottomPaneID = UUID(uuidString: "10000000-0000-0000-0000-000000000003")!
        var layout = PaneLayoutRecord.single(
            paneID: initialPaneID,
            content: .files,
            focusedPaneID: initialPaneID
        )

        XCTAssertTrue(layout.split(
            paneID: initialPaneID,
            axis: .horizontal,
            newPaneID: rightPaneID,
            content: .editor(EditorPaneState())
        ))
        XCTAssertTrue(layout.split(
            paneID: rightPaneID,
            axis: .vertical,
            newPaneID: bottomPaneID,
            content: .terminal(TerminalPaneState(
                laneID: UUID(uuidString: "20000000-0000-0000-0000-000000000001")!,
                agent: .claude
            ))
        ))

        XCTAssertEqual(layout.root.orderedLeafIDs, [initialPaneID, rightPaneID, bottomPaneID])
        XCTAssertEqual(Set(layout.root.orderedLeafIDs).count, 3)
        XCTAssertEqual(layout.focusedPaneID, bottomPaneID)

        let splitIDs = layout.root.splitIDs
        XCTAssertEqual(splitIDs.count, 2)
        XCTAssertTrue(layout.resize(splitID: splitIDs[0], fraction: 0.99))
        XCTAssertEqual(layout.root.fraction(forSplitID: splitIDs[0]), PaneLayoutRecord.maximumFraction)
        XCTAssertTrue(layout.resize(splitID: splitIDs[0], fraction: 0.01))
        XCTAssertEqual(layout.root.fraction(forSplitID: splitIDs[0]), PaneLayoutRecord.minimumFraction)
    }

    func testCloseCollapsesParentAndMovesFocusToNearestLeaf() {
        let first = UUID(uuidString: "30000000-0000-0000-0000-000000000001")!
        let second = UUID(uuidString: "30000000-0000-0000-0000-000000000002")!
        var layout = PaneLayoutRecord.single(paneID: first, content: .files, focusedPaneID: first)
        XCTAssertTrue(layout.split(
            paneID: first,
            axis: .horizontal,
            newPaneID: second,
            content: .diff
        ))

        XCTAssertTrue(layout.close(paneID: second))
        XCTAssertEqual(layout.root.orderedLeafIDs, [first])
        XCTAssertEqual(layout.focusedPaneID, first)
        XCTAssertFalse(layout.close(paneID: first), "The last pane must not disappear")
    }

    func testLayoutCodableRoundTripPreservesIDsContentAndFractions() throws {
        let original = PaneLayoutRecord.defaultLayout()
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(PaneLayoutRecord.self, from: encoded)

        XCTAssertEqual(decoded, original)
        XCTAssertFalse(decoded.root.orderedLeafIDs.isEmpty)
        XCTAssertEqual(Set(decoded.root.orderedLeafIDs).count, decoded.root.orderedLeafIDs.count)
    }

    func testLegacyRegistryRecordWithoutLayoutStillDecodes() throws {
        let json = """
        {
          "id": "40000000-0000-0000-0000-000000000001",
          "slug": "legacy-task",
          "worktreePath": "/tmp/legacy-task",
          "branch": "gdm/legacy-task",
          "baseOID": "abc123",
          "gitCommonDirectory": "/tmp/repo/.git",
          "phase": "ready",
          "selectedAgent": "codex",
          "lastSession": null,
          "lastError": null,
          "createdAt": "2026-08-08T00:00:00.000Z"
        }
        """

        let decoded = try JSONDecoder().decode(WorkspaceRegistryRecord.self, from: Data(json.utf8))
        XCTAssertNil(decoded.layout)
    }

    func testRepeatedAdjacentSplitsStopBeforeUnreadablePaneChain() {
        let first = UUID(); var layout = PaneLayoutRecord.single(paneID: first, content: .terminal(TerminalPaneState()))
        var current = first
        for _ in 0..<PaneLayoutRecord.maximumAdjacentSplits {
            let next = UUID()
            XCTAssertTrue(layout.split(paneID: current, axis: PaneSplitAxis.horizontal, newPaneID: next, content: .terminal(TerminalPaneState())))
            current = next
        }
        let rejected = layout.split(paneID: current, axis: PaneSplitAxis.horizontal, content: .terminal(TerminalPaneState()))
        XCTAssertFalse(rejected)
        XCTAssertEqual(layout.root.orderedLeafIDs.count, PaneLayoutRecord.maximumAdjacentSplits + 1)
    }

    func testMinimumPresentationSizePreservesNestedPanesWithoutCrushingThem() {
        let layout = PaneLayoutRecord.defaultLayout()
        let minimum = layout.root.minimumPresentationSize(
            paneWidth: 220,
            paneHeight: 180,
            divider: 8
        )

        XCTAssertEqual(minimum.width, 448)
        XCTAssertEqual(minimum.height, 368)
    }

    func testSplitSizingReservesSpaceForNestedChildSubtrees() {
        let nested = PaneNode.split(PaneSplitRecord(
            id: UUID(),
            axis: .horizontal,
            fraction: 0.5,
            first: .leaf(PaneLeafRecord(id: UUID(), content: .files)),
            second: .split(PaneSplitRecord(
                id: UUID(),
                axis: .horizontal,
                fraction: 0.5,
                first: .leaf(PaneLeafRecord(id: UUID(), content: .editor(EditorPaneState()))),
                second: .leaf(PaneLeafRecord(id: UUID(), content: .terminal(TerminalPaneState())))
            ))
        ))
        let sibling = PaneNode.leaf(PaneLeafRecord(id: UUID(), content: .proof))
        let firstMinimum = nested.minimumPresentationSize(
            paneWidth: 180,
            paneHeight: 120,
            divider: 10
        ).width
        let secondMinimum = sibling.minimumPresentationSize(
            paneWidth: 180,
            paneHeight: 120,
            divider: 10
        ).width

        let fraction = PaneSplitSizing.constrainedFraction(
            0.23,
            length: 800,
            firstMinimum: firstMinimum,
            secondMinimum: secondMinimum
        )

        XCTAssertEqual(firstMinimum, 560)
        XCTAssertGreaterThanOrEqual(800 * fraction, firstMinimum)
        XCTAssertGreaterThanOrEqual(800 * (1 - fraction), secondMinimum)
    }

    func testCompactPresentationOrderMatchesVisibleTwoByTwoRows() {
        let codex = UUID(uuidString: "50000000-0000-0000-0000-000000000001")!
        let claude = UUID(uuidString: "50000000-0000-0000-0000-000000000002")!
        let gemini = UUID(uuidString: "50000000-0000-0000-0000-000000000003")!
        let shell = UUID(uuidString: "50000000-0000-0000-0000-000000000004")!
        var layout = PaneLayoutRecord.single(
            paneID: codex,
            content: .terminal(TerminalPaneState(agent: .codex)),
            focusedPaneID: codex
        )

        XCTAssertTrue(layout.split(
            paneID: codex,
            axis: .horizontal,
            newPaneID: claude,
            content: .terminal(TerminalPaneState(agent: .claude))
        ))
        XCTAssertTrue(layout.split(
            paneID: codex,
            axis: .vertical,
            newPaneID: gemini,
            content: .terminal(TerminalPaneState(agent: .gemini))
        ))
        XCTAssertTrue(layout.split(
            paneID: claude,
            axis: .vertical,
            newPaneID: shell,
            content: .terminal(TerminalPaneState(agent: .shell))
        ))

        XCTAssertEqual(
            layout.root.leaves.map(\.id),
            [codex, gemini, claude, shell],
            "The persisted tree remains a stable depth-first structure"
        )
        XCTAssertEqual(
            layout.root.presentationLeaves.map(\.id),
            [codex, claude, gemini, shell],
            "Compact tabs must follow the wide layout's visual rows"
        )
    }
}
