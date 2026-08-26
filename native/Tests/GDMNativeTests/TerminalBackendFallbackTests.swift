import XCTest
@testable import GDMNative

final class TerminalBackendFallbackTests: XCTestCase {
    func testAutomaticUsesFallbackWhenGhosttyIsNotCompiled() {
        XCTAssertEqual(
            TerminalBackendResolver.resolve(
                preference: .automatic,
                ghosttyAvailable: false
            ),
            .swiftTerm
        )
    }

    func testExplicitGhosttyRequestStillFallsBackSafely() {
        XCTAssertEqual(
            TerminalBackendResolver.resolve(
                preference: .ghostty,
                ghosttyAvailable: false
            ),
            .swiftTerm
        )
    }

    func testForcedFallbackWinsEvenWhenGhosttyExists() {
        XCTAssertEqual(
            TerminalBackendResolver.resolve(
                preference: .swiftTerm,
                ghosttyAvailable: true
            ),
            .swiftTerm
        )
    }

    @MainActor
    func testFallbackFactoryKeepsHostReaperOwnership() {
        let driver = TerminalBackendFactory.makeDefault(
            environment: ["GIDEM_TERMINAL_BACKEND": "swiftterm"]
        )
        XCTAssertEqual(driver.lifecycleOwnership, .hostReaper)
    }
}
