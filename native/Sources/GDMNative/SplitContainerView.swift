import SwiftUI

struct SplitContainerView: View {
    let node: PaneNode
    let focusedPaneID: UUID
    let canClosePane: Bool
    let onFocus: (UUID) -> Void
    let onChangeContent: (UUID, PaneContentChoice) -> Void
    let onSplit: (UUID, PaneSplitAxis) -> Void
    let onClose: (UUID) -> Void
    let onResize: (UUID, Double) -> Void
    let onMeasureSplit: (UUID, Double, Double) -> Void
    let leafContent: (PaneLeafRecord) -> AnyView

    var body: some View {
        switch node {
        case .leaf(let leaf):
            PaneChromeView(
                leaf: leaf,
                focused: leaf.id == focusedPaneID,
                canClose: canClosePane,
                onFocus: { onFocus(leaf.id) },
                onChangeContent: { onChangeContent(leaf.id, $0) },
                onSplit: { onSplit(leaf.id, $0) },
                onClose: { onClose(leaf.id) }
            ) {
                leafContent(leaf)
            }
        case .split(let split):
            SplitBranchView(
                split: split,
                focusedPaneID: focusedPaneID,
                canClosePane: canClosePane,
                onFocus: onFocus,
                onChangeContent: onChangeContent,
                onSplit: onSplit,
                onClose: onClose,
                onResize: onResize,
                onMeasureSplit: onMeasureSplit,
                leafContent: leafContent
            )
        }
    }
}

private struct SplitBranchView: View {
    let split: PaneSplitRecord
    let focusedPaneID: UUID
    let canClosePane: Bool
    let onFocus: (UUID) -> Void
    let onChangeContent: (UUID, PaneContentChoice) -> Void
    let onSplit: (UUID, PaneSplitAxis) -> Void
    let onClose: (UUID) -> Void
    let onResize: (UUID, Double) -> Void
    let onMeasureSplit: (UUID, Double, Double) -> Void
    let leafContent: (PaneLeafRecord) -> AnyView

    @State private var dragStartFraction: Double?

    var body: some View {
        GeometryReader { geometry in
            if split.axis == .horizontal {
                horizontalBody(size: geometry.size)
            } else {
                verticalBody(size: geometry.size)
            }
        }
        .clipped()
    }

    private func horizontalBody(size: CGSize) -> some View {
        let available = max(1, size.width - DesignTokens.splitDividerHitSize)
        let fraction = constrainedFraction(split.fraction, length: available)
        return HStack(spacing: 0) {
            child(split.first)
                .frame(width: available * fraction)
                .clipped()
            SplitDivider(
                axis: .horizontal,
                fraction: fraction,
                onDragChanged: { translation in
                    resize(
                        translation: translation.width,
                        available: available,
                        displayedFraction: fraction
                    )
                },
                onDragEnded: finishResize,
                onAccessibilityAdjust: { delta in
                    onResize(split.id, constrainedFraction(fraction + delta, length: available))
                }
            )
            child(split.second)
                .frame(width: available * (1 - fraction))
                .clipped()
        }
        .onAppear { onMeasureSplit(split.id, Double(available), fraction) }
        .onChange(of: available) { _, value in
            onMeasureSplit(split.id, Double(value), fraction)
        }
        .onChange(of: fraction) { _, value in
            onMeasureSplit(split.id, Double(available), value)
        }
    }

    private func verticalBody(size: CGSize) -> some View {
        let available = max(1, size.height - DesignTokens.splitDividerHitSize)
        let fraction = constrainedFraction(split.fraction, length: available)
        return VStack(spacing: 0) {
            child(split.first)
                .frame(height: available * fraction)
                .clipped()
            SplitDivider(
                axis: .vertical,
                fraction: fraction,
                onDragChanged: { translation in
                    resize(
                        translation: translation.height,
                        available: available,
                        displayedFraction: fraction
                    )
                },
                onDragEnded: finishResize,
                onAccessibilityAdjust: { delta in
                    onResize(split.id, constrainedFraction(fraction + delta, length: available))
                }
            )
            child(split.second)
                .frame(height: available * (1 - fraction))
                .clipped()
        }
        .onAppear { onMeasureSplit(split.id, Double(available), fraction) }
        .onChange(of: available) { _, value in
            onMeasureSplit(split.id, Double(value), fraction)
        }
        .onChange(of: fraction) { _, value in
            onMeasureSplit(split.id, Double(available), value)
        }
    }

    private func child(_ node: PaneNode) -> some View {
        SplitContainerView(
            node: node,
            focusedPaneID: focusedPaneID,
            canClosePane: canClosePane,
            onFocus: onFocus,
            onChangeContent: onChangeContent,
            onSplit: onSplit,
            onClose: onClose,
            onResize: onResize,
            onMeasureSplit: onMeasureSplit,
            leafContent: leafContent
        )
    }

    private func resize(
        translation: CGFloat,
        available: CGFloat,
        displayedFraction: Double
    ) {
        let start = dragStartFraction ?? displayedFraction
        if dragStartFraction == nil { dragStartFraction = start }
        let proposed = start + Double(translation / max(1, available))
        onResize(split.id, constrainedFraction(proposed, length: available))
    }

    private func finishResize() {
        dragStartFraction = nil
    }

    private func constrainedFraction(_ proposed: Double, length: CGFloat) -> Double {
        let firstMinimum = minimumLength(for: split.first)
        let secondMinimum = minimumLength(for: split.second)
        return PaneSplitSizing.constrainedFraction(
            proposed,
            length: Double(length),
            firstMinimum: firstMinimum,
            secondMinimum: secondMinimum
        )
    }

    private func minimumLength(for node: PaneNode) -> Double {
        let size = node.minimumPresentationSize(
            paneWidth: Double(DesignTokens.paneMinimumWidth),
            paneHeight: Double(DesignTokens.paneMinimumHeight),
            divider: Double(DesignTokens.splitDividerHitSize)
        )
        return split.axis == .horizontal ? size.width : size.height
    }
}

private struct SplitDivider: View {
    let axis: PaneSplitAxis
    let fraction: Double
    let onDragChanged: (CGSize) -> Void
    let onDragEnded: () -> Void
    let onAccessibilityAdjust: (Double) -> Void

    var body: some View {
        Rectangle()
            .fill(DesignTokens.lineStructure)
            .frame(
                width: axis == .horizontal ? DesignTokens.splitDividerWidth : nil,
                height: axis == .vertical ? DesignTokens.splitDividerWidth : nil
            )
            .frame(
                width: axis == .horizontal ? DesignTokens.splitDividerHitSize : nil,
                height: axis == .vertical ? DesignTokens.splitDividerHitSize : nil
            )
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { onDragChanged($0.translation) }
                    .onEnded { _ in onDragEnded() }
            )
            .accessibilityElement()
            .accessibilityLabel(axis == .horizontal ? "가로 pane divider" : "세로 pane divider")
            .accessibilityValue("\(Int((fraction * 100).rounded())) percent")
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: onAccessibilityAdjust(0.05)
                case .decrement: onAccessibilityAdjust(-0.05)
                @unknown default: break
                }
            }
    }
}
