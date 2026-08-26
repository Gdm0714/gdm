import Foundation

enum PaneSplitAxis: String, Codable, CaseIterable, Sendable {
    /// Places panes side by side and moves the divider horizontally.
    case horizontal
    /// Stacks panes from top to bottom and moves the divider vertically.
    case vertical
}

/// Matches Ghostty's spatial split vocabulary so the embedded terminal can
/// hand pane keybindings to the native workbench without translating them to
/// a lossy "next pane" operation.
enum PaneDirection: String, CaseIterable, Equatable, Sendable {
    case left
    case right
    case up
    case down

    var axis: PaneSplitAxis {
        switch self {
        case .left, .right: .horizontal
        case .up, .down: .vertical
        }
    }

    var insertsBefore: Bool {
        self == .left || self == .up
    }
}

enum PaneFocusTarget: Equatable, Sendable {
    case direction(PaneDirection)
    case previous
    case next
    case index(Int)
}

enum PaneSplitSizing {
    static func constrainedFraction(
        _ proposed: Double,
        length: Double,
        firstMinimum: Double,
        secondMinimum: Double
    ) -> Double {
        guard length.isFinite, length > 0 else { return 0.5 }
        let safeProposed = proposed.isFinite ? proposed : 0.5
        let safeFirstMinimum = firstMinimum.isFinite ? max(0, firstMinimum) : 0
        let safeSecondMinimum = secondMinimum.isFinite ? max(0, secondMinimum) : 0
        let lower = max(PaneLayoutRecord.minimumFraction, safeFirstMinimum / length)
        let upper = min(PaneLayoutRecord.maximumFraction, 1 - (safeSecondMinimum / length))

        if lower <= upper {
            return min(upper, max(lower, safeProposed))
        }

        // CenterPaneView normally switches to compact tabs before this path.
        // Keep corrupted or transiently undersized layouts proportional until
        // the next layout pass instead of letting either subtree consume all space.
        let totalMinimum = safeFirstMinimum + safeSecondMinimum
        let proportional = totalMinimum > 0 ? safeFirstMinimum / totalMinimum : safeProposed
        return min(
            PaneLayoutRecord.maximumFraction,
            max(PaneLayoutRecord.minimumFraction, proportional)
        )
    }
}

enum PaneContentChoice: String, CaseIterable, Identifiable, Sendable {
    case files
    case editor
    case terminal
    case diff
    case logs
    case evidence
    case proof

    var id: String { rawValue }
    var title: String { rawValue.uppercased() }

    var systemImage: String {
        switch self {
        case .files: "folder"
        case .editor: "doc.text"
        case .terminal: "terminal"
        case .diff: "arrow.left.arrow.right"
        case .logs: "list.bullet.rectangle"
        case .evidence: "checkmark.seal"
        case .proof: "shield.checkered"
        }
    }

    func content(agent: AgentKind) -> PaneContent {
        switch self {
        case .files: .files
        case .editor: .editor(EditorPaneState())
        case .terminal: .terminal(TerminalPaneState(agent: agent))
        case .diff: .diff
        case .logs: .logs
        case .evidence: .evidence
        case .proof: .proof
        }
    }
}

struct EditorTabState: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    var relativePath: String

    init(id: UUID = UUID(), relativePath: String) {
        self.id = id
        self.relativePath = relativePath
    }
}

struct EditorPaneState: Codable, Equatable, Sendable {
    var tabs: [EditorTabState]
    var selectedTabID: UUID?

    init(tabs: [EditorTabState] = [], selectedTabID: UUID? = nil) {
        self.tabs = tabs
        self.selectedTabID = selectedTabID ?? tabs.first?.id
    }

    var selectedTab: EditorTabState? {
        guard let selectedTabID else { return tabs.first }
        return tabs.first(where: { $0.id == selectedTabID }) ?? tabs.first
    }

    mutating func open(relativePath: String) {
        if let existing = tabs.first(where: { $0.relativePath == relativePath }) {
            selectedTabID = existing.id
            return
        }
        let tab = EditorTabState(relativePath: relativePath)
        tabs.append(tab)
        selectedTabID = tab.id
    }

    mutating func close(tabID: UUID) {
        guard let index = tabs.firstIndex(where: { $0.id == tabID }) else { return }
        tabs.remove(at: index)
        if selectedTabID == tabID {
            guard !tabs.isEmpty else {
                selectedTabID = nil
                return
            }
            selectedTabID = tabs[min(index, tabs.count - 1)].id
        }
    }
}

struct TerminalPaneState: Codable, Equatable, Sendable {
    let laneID: UUID
    var agent: AgentKind

    init(laneID: UUID = UUID(), agent: AgentKind = .shell) {
        self.laneID = laneID
        self.agent = agent
    }
}

enum PaneContent: Codable, Equatable, Sendable {
    case files
    case editor(EditorPaneState)
    case terminal(TerminalPaneState)
    case diff
    case logs
    case evidence
    case proof

    var title: String {
        switch self {
        case .files: "FILES"
        case .editor(let editor): editor.selectedTab?.relativePath ?? "EDITOR"
        case .terminal(let terminal): terminal.agent.displayName.uppercased()
        case .diff: "DIFF"
        case .logs: "LOGS"
        case .evidence: "EVIDENCE"
        case .proof: "PROOF"
        }
    }

    var isTerminal: Bool {
        if case .terminal = self { return true }
        return false
    }
}

struct PaneLeafRecord: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    var content: PaneContent
}

struct PaneSplitRecord: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    var axis: PaneSplitAxis
    var fraction: Double
    var first: PaneNode
    var second: PaneNode
}

private struct PositionedPaneLeaf {
    let leaf: PaneLeafRecord
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let insertionOrder: Int

    var minX: Double { x }
    var maxX: Double { x + width }
    var minY: Double { y }
    var maxY: Double { y + height }
    var midX: Double { x + (width / 2) }
    var midY: Double { y + (height / 2) }
}

indirect enum PaneNode: Codable, Equatable, Sendable, Identifiable {
    case leaf(PaneLeafRecord)
    case split(PaneSplitRecord)

    var id: UUID {
        switch self {
        case .leaf(let leaf): leaf.id
        case .split(let split): split.id
        }
    }

    var orderedLeafIDs: [UUID] {
        switch self {
        case .leaf(let leaf): [leaf.id]
        case .split(let split): split.first.orderedLeafIDs + split.second.orderedLeafIDs
        }
    }

    var splitIDs: [UUID] {
        switch self {
        case .leaf: []
        case .split(let split): [split.id] + split.first.splitIDs + split.second.splitIDs
        }
    }

    var leaves: [PaneLeafRecord] {
        switch self {
        case .leaf(let leaf): [leaf]
        case .split(let split): split.first.leaves + split.second.leaves
        }
    }

    /// Orders panes the way they are read on screen: top to bottom, then left
    /// to right. A depth-first tree walk groups nested columns, which can make
    /// compact tabs disagree with the same layout's visible 2×2 arrangement.
    var presentationLeaves: [PaneLeafRecord] {
        positionedLeaves.sorted { lhs, rhs in
            let rowDelta = lhs.y - rhs.y
            if abs(rowDelta) > 0.000_001 { return rowDelta < 0 }
            let columnDelta = lhs.x - rhs.x
            if abs(columnDelta) > 0.000_001 { return columnDelta < 0 }
            return lhs.insertionOrder < rhs.insertionOrder
        }.map(\.leaf)
    }

    fileprivate var positionedLeaves: [PositionedPaneLeaf] {
        var result: [PositionedPaneLeaf] = []
        collectPositionedLeaves(
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            into: &result
        )
        return result
    }

    func minimumPresentationSize(
        paneWidth: Double,
        paneHeight: Double,
        divider: Double
    ) -> (width: Double, height: Double) {
        switch self {
        case .leaf:
            return (paneWidth, paneHeight)
        case .split(let split):
            let first = split.first.minimumPresentationSize(
                paneWidth: paneWidth,
                paneHeight: paneHeight,
                divider: divider
            )
            let second = split.second.minimumPresentationSize(
                paneWidth: paneWidth,
                paneHeight: paneHeight,
                divider: divider
            )
            switch split.axis {
            case .horizontal:
                return (first.width + divider + second.width, max(first.height, second.height))
            case .vertical:
                return (max(first.width, second.width), first.height + divider + second.height)
            }
        }
    }

    func leaf(id: UUID) -> PaneLeafRecord? {
        switch self {
        case .leaf(let leaf): leaf.id == id ? leaf : nil
        case .split(let split): split.first.leaf(id: id) ?? split.second.leaf(id: id)
        }
    }

    func fraction(forSplitID id: UUID) -> Double? {
        switch self {
        case .leaf: return nil
        case .split(let split):
            if split.id == id { return split.fraction }
            return split.first.fraction(forSplitID: id) ?? split.second.fraction(forSplitID: id)
        }
    }

    fileprivate func replacingLeaf(
        id: UUID,
        transform: (PaneLeafRecord) -> PaneNode
    ) -> (node: PaneNode, changed: Bool) {
        switch self {
        case .leaf(let leaf):
            guard leaf.id == id else { return (self, false) }
            return (transform(leaf), true)
        case .split(var split):
            let firstResult = split.first.replacingLeaf(id: id, transform: transform)
            if firstResult.changed {
                split.first = firstResult.node
                return (.split(split), true)
            }
            let secondResult = split.second.replacingLeaf(id: id, transform: transform)
            if secondResult.changed {
                split.second = secondResult.node
                return (.split(split), true)
            }
            return (self, false)
        }
    }

    fileprivate func removingLeaf(id: UUID) -> (node: PaneNode?, changed: Bool) {
        switch self {
        case .leaf(let leaf):
            return leaf.id == id ? (nil, true) : (self, false)
        case .split(var split):
            let firstResult = split.first.removingLeaf(id: id)
            if firstResult.changed {
                guard let first = firstResult.node else { return (split.second, true) }
                split.first = first
                return (.split(split), true)
            }
            let secondResult = split.second.removingLeaf(id: id)
            if secondResult.changed {
                guard let second = secondResult.node else { return (split.first, true) }
                split.second = second
                return (.split(split), true)
            }
            return (self, false)
        }
    }

    fileprivate func resizing(splitID: UUID, fraction: Double) -> (node: PaneNode, changed: Bool) {
        switch self {
        case .leaf: return (self, false)
        case .split(var split):
            if split.id == splitID {
                split.fraction = fraction
                return (.split(split), true)
            }
            let firstResult = split.first.resizing(splitID: splitID, fraction: fraction)
            if firstResult.changed {
                split.first = firstResult.node
                return (.split(split), true)
            }
            let secondResult = split.second.resizing(splitID: splitID, fraction: fraction)
            if secondResult.changed {
                split.second = secondResult.node
                return (.split(split), true)
            }
            return (self, false)
        }
    }

    private func collectPositionedLeaves(
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        into result: inout [PositionedPaneLeaf]
    ) {
        switch self {
        case .leaf(let leaf):
            result.append(PositionedPaneLeaf(
                leaf: leaf,
                x: x,
                y: y,
                width: width,
                height: height,
                insertionOrder: result.count
            ))
        case .split(let split):
            let fraction = min(
                PaneLayoutRecord.maximumFraction,
                max(PaneLayoutRecord.minimumFraction, split.fraction)
            )
            switch split.axis {
            case .horizontal:
                let firstWidth = width * fraction
                split.first.collectPositionedLeaves(
                    x: x,
                    y: y,
                    width: firstWidth,
                    height: height,
                    into: &result
                )
                split.second.collectPositionedLeaves(
                    x: x + firstWidth,
                    y: y,
                    width: width - firstWidth,
                    height: height,
                    into: &result
                )
            case .vertical:
                let firstHeight = height * fraction
                split.first.collectPositionedLeaves(
                    x: x,
                    y: y,
                    width: width,
                    height: firstHeight,
                    into: &result
                )
                split.second.collectPositionedLeaves(
                    x: x,
                    y: y + firstHeight,
                    width: width,
                    height: height - firstHeight,
                    into: &result
                )
            }
        }
    }
}

struct PaneLayoutRecord: Codable, Equatable, Sendable {
    static let currentVersion = 1
    static let minimumFraction = 0.15
    static let maximumFraction = 0.85
    /// Keep repeated splits from producing a pane narrower than a usable
    /// desktop column at the smallest supported workbench width.
    static let maximumAdjacentSplits = 3

    var version: Int
    var root: PaneNode
    var focusedPaneID: UUID

    init(version: Int = currentVersion, root: PaneNode, focusedPaneID: UUID) {
        self.version = version
        self.root = root
        self.focusedPaneID = root.orderedLeafIDs.contains(focusedPaneID)
            ? focusedPaneID
            : (root.orderedLeafIDs.first ?? focusedPaneID)
    }

    static func single(paneID: UUID = UUID(), content: PaneContent, focusedPaneID: UUID? = nil) -> Self {
        PaneLayoutRecord(
            root: .leaf(PaneLeafRecord(id: paneID, content: content)),
            focusedPaneID: focusedPaneID ?? paneID
        )
    }

    static func defaultLayout() -> Self {
        let filesID = UUID()
        let editorID = UUID()
        let terminalID = UUID()
        let editorAndTerminal = PaneNode.split(PaneSplitRecord(
            id: UUID(),
            axis: .vertical,
            fraction: 0.66,
            first: .leaf(PaneLeafRecord(id: editorID, content: .editor(EditorPaneState()))),
            second: .leaf(PaneLeafRecord(
                id: terminalID,
                content: .terminal(TerminalPaneState(agent: .shell))
            ))
        ))
        return PaneLayoutRecord(
            root: .split(PaneSplitRecord(
                id: UUID(),
                axis: .horizontal,
                fraction: 0.23,
                first: .leaf(PaneLeafRecord(id: filesID, content: .files)),
                second: editorAndTerminal
            )),
            focusedPaneID: editorID
        )
    }

    var focusedLeaf: PaneLeafRecord? { root.leaf(id: focusedPaneID) }

    @discardableResult
    mutating func split(
        paneID: UUID,
        axis: PaneSplitAxis,
        newPaneID: UUID = UUID(),
        content: PaneContent
    ) -> Bool {
        split(
            paneID: paneID,
            direction: axis == .horizontal ? .right : .down,
            newPaneID: newPaneID,
            content: content
        )
    }

    @discardableResult
    mutating func split(
        paneID: UUID,
        direction: PaneDirection,
        newPaneID: UUID = UUID(),
        content: PaneContent
    ) -> Bool {
        guard let target = root.leaf(id: paneID), target.id == paneID else { return false }
        guard root.adjacentSplitDepth(containing: paneID, axis: direction.axis) < Self.maximumAdjacentSplits else {
            return false
        }
        let result = root.replacingLeaf(id: paneID) { original in
            let originalNode = PaneNode.leaf(original)
            let newNode = PaneNode.leaf(PaneLeafRecord(id: newPaneID, content: content))
            return .split(PaneSplitRecord(
                id: UUID(),
                axis: direction.axis,
                fraction: 0.5,
                first: direction.insertsBefore ? newNode : originalNode,
                second: direction.insertsBefore ? originalNode : newNode
            ))
        }
        guard result.changed else { return false }
        root = result.node
        focusedPaneID = newPaneID
        return true
    }

    @discardableResult
    mutating func close(paneID: UUID) -> Bool {
        let before = root.orderedLeafIDs
        guard before.count > 1, let removedIndex = before.firstIndex(of: paneID) else { return false }
        let result = root.removingLeaf(id: paneID)
        guard result.changed, let newRoot = result.node else { return false }
        root = newRoot
        if focusedPaneID == paneID || !root.orderedLeafIDs.contains(focusedPaneID) {
            let remaining = root.orderedLeafIDs
            focusedPaneID = remaining[min(removedIndex, remaining.count - 1)]
        }
        return true
    }

    @discardableResult
    mutating func resize(splitID: UUID, fraction: Double) -> Bool {
        let clamped = min(Self.maximumFraction, max(Self.minimumFraction, fraction))
        let result = root.resizing(splitID: splitID, fraction: clamped)
        guard result.changed else { return false }
        root = result.node
        return true
    }

    @discardableResult
    mutating func resizeFocused(
        direction: PaneDirection,
        amount: UInt16,
        splitLength: Double,
        displayedFraction: Double
    ) -> Bool {
        guard amount > 0, splitLength.isFinite, splitLength > 0,
              displayedFraction.isFinite,
              let split = nearestResizeSplit(direction: direction) else { return false }
        let delta = Double(amount) / splitLength
        let signedDelta = direction == .left || direction == .up ? -delta : delta
        return resize(splitID: split.id, fraction: displayedFraction + signedDelta)
    }

    func nearestResizeSplit(direction: PaneDirection) -> PaneSplitRecord? {
        root.nearestAncestorSplit(
            containing: focusedPaneID,
            axis: direction.axis
        )
    }

    @discardableResult
    mutating func equalizeSplits() -> Bool {
        let equalized = root.equalizedSplits()
        guard equalized != root else { return false }
        root = equalized
        return true
    }

    @discardableResult
    mutating func updateContent(paneID: UUID, _ transform: (inout PaneContent) -> Void) -> Bool {
        let result = root.replacingLeaf(id: paneID) { leaf in
            var updated = leaf
            transform(&updated.content)
            return .leaf(updated)
        }
        guard result.changed else { return false }
        root = result.node
        return true
    }

    mutating func focus(_ paneID: UUID) {
        guard root.orderedLeafIDs.contains(paneID) else { return }
        focusedPaneID = paneID
    }

    mutating func focusNext(reverse: Bool = false) {
        let ids = root.orderedLeafIDs
        guard ids.count > 1, let index = ids.firstIndex(of: focusedPaneID) else {
            if let first = ids.first { focusedPaneID = first }
            return
        }
        let delta = reverse ? -1 : 1
        focusedPaneID = ids[(index + delta + ids.count) % ids.count]
    }

    @discardableResult
    mutating func focus(_ target: PaneFocusTarget) -> Bool {
        let previous = focusedPaneID
        switch target {
        case .previous:
            focusNext(reverse: true)
        case .next:
            focusNext()
        case .index(let oneBasedIndex):
            let leaves = root.presentationLeaves
            guard !leaves.isEmpty else { return false }
            let index = min(max(1, oneBasedIndex), leaves.count) - 1
            focusedPaneID = leaves[index].id
        case .direction(let direction):
            guard let destination = directionalFocusTarget(direction) else { return false }
            focusedPaneID = destination
        }
        return focusedPaneID != previous
    }

    private func directionalFocusTarget(_ direction: PaneDirection) -> UUID? {
        let leaves = root.positionedLeaves
        guard let current = leaves.first(where: { $0.leaf.id == focusedPaneID }) else { return nil }
        let epsilon = 0.000_001

        struct Candidate {
            let id: UUID
            let primaryGap: Double
            let perpendicularDistance: Double
            let insertionOrder: Int
        }

        let candidates = leaves.compactMap { candidate -> Candidate? in
            guard candidate.leaf.id != current.leaf.id else { return nil }
            let overlapsPerpendicular: Bool
            let primaryGap: Double
            let perpendicularDistance: Double
            switch direction {
            case .left:
                overlapsPerpendicular = min(current.maxY, candidate.maxY)
                    - max(current.minY, candidate.minY) > epsilon
                guard candidate.maxX <= current.minX + epsilon else { return nil }
                primaryGap = max(0, current.minX - candidate.maxX)
                perpendicularDistance = abs(current.midY - candidate.midY)
            case .right:
                overlapsPerpendicular = min(current.maxY, candidate.maxY)
                    - max(current.minY, candidate.minY) > epsilon
                guard candidate.minX >= current.maxX - epsilon else { return nil }
                primaryGap = max(0, candidate.minX - current.maxX)
                perpendicularDistance = abs(current.midY - candidate.midY)
            case .up:
                overlapsPerpendicular = min(current.maxX, candidate.maxX)
                    - max(current.minX, candidate.minX) > epsilon
                guard candidate.maxY <= current.minY + epsilon else { return nil }
                primaryGap = max(0, current.minY - candidate.maxY)
                perpendicularDistance = abs(current.midX - candidate.midX)
            case .down:
                overlapsPerpendicular = min(current.maxX, candidate.maxX)
                    - max(current.minX, candidate.minX) > epsilon
                guard candidate.minY >= current.maxY - epsilon else { return nil }
                primaryGap = max(0, candidate.minY - current.maxY)
                perpendicularDistance = abs(current.midX - candidate.midX)
            }
            guard overlapsPerpendicular else { return nil }
            return Candidate(
                id: candidate.leaf.id,
                primaryGap: primaryGap,
                perpendicularDistance: perpendicularDistance,
                insertionOrder: candidate.insertionOrder
            )
        }

        return candidates.min { lhs, rhs in
            if abs(lhs.primaryGap - rhs.primaryGap) > epsilon {
                return lhs.primaryGap < rhs.primaryGap
            }
            if abs(lhs.perpendicularDistance - rhs.perpendicularDistance) > epsilon {
                return lhs.perpendicularDistance < rhs.perpendicularDistance
            }
            return lhs.insertionOrder < rhs.insertionOrder
        }?.id
    }
}

private extension PaneNode {
    func adjacentSplitDepth(containing leafID: UUID, axis: PaneSplitAxis) -> Int {
        switch self {
        case .leaf(let leaf): return leaf.id == leafID ? 0 : -1
        case .split(let split):
            let childDepth = split.first.adjacentSplitDepth(containing: leafID, axis: axis)
            if childDepth >= 0 { return childDepth + (split.axis == axis ? 1 : 0) }
            let siblingDepth = split.second.adjacentSplitDepth(containing: leafID, axis: axis)
            return siblingDepth >= 0 ? siblingDepth + (split.axis == axis ? 1 : 0) : -1
        }
    }

    func nearestAncestorSplit(containing leafID: UUID, axis: PaneSplitAxis) -> PaneSplitRecord? {
        switch self {
        case .leaf:
            return nil
        case .split(let split):
            if split.first.orderedLeafIDs.contains(leafID) {
                return split.first.nearestAncestorSplit(containing: leafID, axis: axis)
                    ?? (split.axis == axis ? split : nil)
            }
            if split.second.orderedLeafIDs.contains(leafID) {
                return split.second.nearestAncestorSplit(containing: leafID, axis: axis)
                    ?? (split.axis == axis ? split : nil)
            }
            return nil
        }
    }

    func equalizedSplits() -> PaneNode {
        switch self {
        case .leaf:
            return self
        case .split(var split):
            let firstWeight = split.first.weight(for: split.axis)
            let secondWeight = split.second.weight(for: split.axis)
            split.fraction = Double(firstWeight) / Double(firstWeight + secondWeight)
            split.first = split.first.equalizedSplits()
            split.second = split.second.equalizedSplits()
            return .split(split)
        }
    }

    func weight(for axis: PaneSplitAxis) -> Int {
        switch self {
        case .leaf:
            return 1
        case .split(let split):
            guard split.axis == axis else { return 1 }
            return split.first.weight(for: axis) + split.second.weight(for: axis)
        }
    }
}
