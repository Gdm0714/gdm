import Foundation
import XCTest
@testable import GDMNative

final class MotionContractTests: XCTestCase {
    func testCanonicalTimingConstantsMatchMotionContract() {
        XCTAssertEqual(MotionTokens.fadeOut, 0.090, accuracy: 0.000_1)
        XCTAssertEqual(MotionTokens.fadeIn, 0.140, accuracy: 0.000_1)
        XCTAssertEqual(MotionTokens.state, 0.180, accuracy: 0.000_1)
        XCTAssertEqual(MotionTokens.settle, 0.200, accuracy: 0.000_1)
        XCTAssertEqual(MotionTokens.progress, 0.220, accuracy: 0.000_1)
        XCTAssertEqual(MotionTokens.panel, 0.240, accuracy: 0.000_1)
        XCTAssertEqual(MotionTokens.pulse, 1.400, accuracy: 0.000_1)
        XCTAssertEqual(MotionTokens.counterOut, 0.120, accuracy: 0.000_1)
        XCTAssertEqual(MotionTokens.counterIn, 0.180, accuracy: 0.000_1)
        XCTAssertEqual(MotionTokens.overlayBackdrop, 0.120, accuracy: 0.000_1)
        XCTAssertEqual(MotionTokens.overlaySelector, 0.130, accuracy: 0.000_1)
        XCTAssertEqual(MotionTokens.overlayPopover, 0.140, accuracy: 0.000_1)
        XCTAssertEqual(MotionTokens.overlaySheet, 0.160, accuracy: 0.000_1)
    }

    func testReduceMotionCollapsesEveryDurationAndAnimation() {
        let durations = [
            MotionTokens.fadeOut,
            MotionTokens.fadeIn,
            MotionTokens.state,
            MotionTokens.settle,
            MotionTokens.progress,
            MotionTokens.panel,
            MotionTokens.pulse,
            MotionTokens.counterOut,
            MotionTokens.counterIn,
            MotionTokens.overlayBackdrop,
            MotionTokens.overlaySelector,
            MotionTokens.overlayPopover,
            MotionTokens.overlaySheet
        ]
        for duration in durations {
            XCTAssertEqual(MotionTokens.duration(duration, reduceMotion: true), 0)
        }

        XCTAssertNil(MotionAnimations.fadeOut(reduceMotion: true))
        XCTAssertNil(MotionAnimations.fadeIn(reduceMotion: true))
        XCTAssertNil(MotionAnimations.state(reduceMotion: true))
        XCTAssertNil(MotionAnimations.settle(reduceMotion: true))
        XCTAssertNil(MotionAnimations.progress(reduceMotion: true))
        XCTAssertNil(MotionAnimations.panel(reduceMotion: true))
        XCTAssertNil(MotionAnimations.counterOut(reduceMotion: true))
        XCTAssertNil(MotionAnimations.counterIn(reduceMotion: true))
        XCTAssertNil(MotionAnimations.mount(duration: MotionTokens.overlayPopover, reduceMotion: true))
        XCTAssertNil(MotionAnimations.pulse(isUnsettled: true, reduceMotion: true))
    }

    func testPulseExistsOnlyForTruthfullyUnsettledAgentStates() {
        let allStates: [AgentActivityState] = [
            .unavailable, .idle, .starting, .active, .waiting, .needsYou,
            .handingOff, .verifying,
            .stopping, .interrupted, .launchFailed, .ended
        ]
        let unsettled = allStates.filter(\.isUnsettled)

        XCTAssertEqual(unsettled, [.starting, .handingOff, .stopping])
        for state in allStates {
            XCTAssertEqual(
                MotionPolicy.allowsPulse(isUnsettled: state.isUnsettled, reduceMotion: false),
                state == .starting || state == .handingOff || state == .stopping
            )
        }
        XCTAssertFalse(MotionPolicy.allowsPulse(isUnsettled: true, reduceMotion: true))
        XCTAssertFalse(AgentActivityState.active.isUnsettled)
    }

    func testAgentLivenessNeverUsesProvenGreen() {
        let states: [AgentActivityState] = [
            .unavailable, .idle, .starting, .active, .waiting, .needsYou,
            .handingOff, .verifying,
            .stopping, .interrupted, .launchFailed, .ended
        ]
        XCTAssertFalse(states.contains { $0.tone == .proven })
        XCTAssertEqual(AgentActivityState.active.tone, .active)
    }

    func testAgentActivityCompositionUsesThe1200PointBoundary() {
        XCTAssertEqual(
            AgentActivityComposition.resolve(width: 1024, current: .claude),
            .compact(current: .claude, foldedCount: 2)
        )
        XCTAssertEqual(
            AgentActivityComposition.resolve(width: 1120, current: .claude),
            .compact(current: .claude, foldedCount: 2)
        )
        XCTAssertEqual(
            AgentActivityComposition.resolve(width: 1199, current: .gemini),
            .compact(current: .gemini, foldedCount: 2)
        )
        XCTAssertEqual(
            AgentActivityComposition.resolve(width: 1024, current: .shell),
            .compact(current: .shell, foldedCount: 3)
        )
        XCTAssertEqual(
            AgentActivityComposition.resolve(width: 1200, current: .claude),
            .expanded(agents: [.codex, .claude, .gemini])
        )
        XCTAssertEqual(
            AgentActivityComposition.resolve(width: 1440, current: .shell),
            .expanded(agents: [.codex, .claude, .gemini])
        )
        XCTAssertEqual(
            AgentActivityComposition.resolve(width: 1728, current: .shell),
            .expanded(agents: [.codex, .claude, .gemini])
        )
    }

    func testCheckSettleFlashOnlyFollowsACompletedRunningState() {
        XCTAssertTrue(MotionPolicy.shouldSettleCheck(from: .running, to: .proven))
        XCTAssertTrue(MotionPolicy.shouldSettleCheck(from: .running, to: .redCaptured))
        XCTAssertTrue(MotionPolicy.shouldSettleCheck(from: .running, to: .failed))
        XCTAssertFalse(MotionPolicy.shouldSettleCheck(from: .open, to: .proven))
        XCTAssertFalse(MotionPolicy.shouldSettleCheck(from: .proven, to: .open))
        XCTAssertFalse(MotionPolicy.shouldSettleCheck(from: .running, to: .open))
    }

    func testProvisioningOrderComesFromRealServiceBoundaries() {
        XCTAssertEqual(WorktreeProvisioningStep.worktree.order, 0)
        XCTAssertEqual(WorktreeProvisioningStep.gdmContract.order, 1)
        XCTAssertEqual(WorktreeProvisioningStep.ready.order, 2)
    }
}
