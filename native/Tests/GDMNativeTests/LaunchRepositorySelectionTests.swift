import Foundation
import XCTest
@testable import GDMNative

final class LaunchRepositorySelectionTests: XCTestCase {
    func testLaunchWithoutRepositoryRequiresSelection() {
        let launchRoot = URL(fileURLWithPath: "/", isDirectory: true)

        let options = LaunchOptions(
            arguments: ["Gidem"],
            currentDirectoryURL: launchRoot,
            rememberedRepositoryURL: nil,
            isRepositoryRoot: { _ in false }
        )

        XCTAssertEqual(options.repositoryURL, launchRoot)
        XCTAssertTrue(options.requiresRepositorySelection)
        XCTAssertFalse(options.shouldPersistRepositorySelection)
    }

    func testExplicitRepositoryCanBeRemembered() {
        let repository = URL(fileURLWithPath: "/tmp/gidem-explicit-repository", isDirectory: true)

        let options = LaunchOptions(
            arguments: ["Gidem", "--repo", repository.path],
            currentDirectoryURL: URL(fileURLWithPath: "/", isDirectory: true),
            rememberedRepositoryURL: nil,
            isRepositoryRoot: { $0.standardizedFileURL == repository.standardizedFileURL }
        )

        XCTAssertEqual(options.repositoryURL, repository.standardizedFileURL)
        XCTAssertFalse(options.requiresRepositorySelection)
        XCTAssertTrue(options.shouldPersistRepositorySelection)
    }

    func testRememberedRepositoryAvoidsFirstLaunchPrompt() {
        let repository = URL(fileURLWithPath: "/tmp/gidem-remembered-repository", isDirectory: true)

        let options = LaunchOptions(
            arguments: ["Gidem"],
            currentDirectoryURL: URL(fileURLWithPath: "/", isDirectory: true),
            rememberedRepositoryURL: repository,
            isRepositoryRoot: { $0.standardizedFileURL == repository.standardizedFileURL }
        )

        XCTAssertEqual(options.repositoryURL, repository.standardizedFileURL)
        XCTAssertFalse(options.requiresRepositorySelection)
        XCTAssertFalse(options.shouldPersistRepositorySelection)
    }

    @MainActor
    func testNewTaskIsBlockedUntilRepositorySelection() throws {
        let temporaryRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("gidem-launch-selection-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporaryRoot) }

        let store = WorkspaceStore(
            repositoryURL: temporaryRoot,
            requiresRepositorySelection: true
        )

        store.presentNewTask()

        XCTAssertFalse(store.isNewTaskPresented)
        XCTAssertEqual(store.errorMessage, WorkspaceStore.repositorySelectionRequiredMessage)
    }
}
