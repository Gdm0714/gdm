import Foundation
import XCTest
@testable import GDMNative

final class TaskRailIntegrationTests: XCTestCase {
    func testPriorityKeepsEveryUnfinishedTaskAndPinsSelectedProvenTask() {
        let root = URL(fileURLWithPath: "/tmp/gdm-task-rail", isDirectory: true)
        let tasks = [
            makeTask("current", root: root),
            makeTask("proven-new", root: root),
            makeTask("selected-proven", root: root),
            makeTask("blocked", root: root),
            makeTask("proven-old", root: root)
        ]
        let states: [String: TaskDisplayState] = [
            "current": .planned,
            "proven-new": .proven,
            "selected-proven": .proven,
            "blocked": .blocked,
            "proven-old": .proven
        ]

        let sections = TaskRailSections.resolve(
            tasks: tasks,
            selectedTaskKey: tasks[2].id,
            stateFor: { states[$0.slug] ?? .disconnected }
        )

        XCTAssertEqual(sections.priority.map(\.slug), ["current", "selected-proven", "blocked"])
        XCTAssertEqual(sections.provenHistory.map(\.slug), ["proven-new", "proven-old"])
        XCTAssertEqual(
            Set((sections.priority + sections.provenHistory).map(\.id)),
            Set(tasks.map(\.id))
        )
    }

    func testProvenHistoryPreservesLoaderOrderWithoutASelection() {
        let root = URL(fileURLWithPath: "/tmp/gdm-task-rail", isDirectory: true)
        let tasks = [
            makeTask("newest-proven", root: root),
            makeTask("older-proven", root: root)
        ]

        let sections = TaskRailSections.resolve(
            tasks: tasks,
            selectedTaskKey: nil,
            stateFor: { _ in .proven }
        )

        XCTAssertTrue(sections.priority.isEmpty)
        XCTAssertEqual(sections.provenHistory.map(\.slug), ["newest-proven", "older-proven"])
    }

    private func makeTask(_ slug: String, root: URL) -> WorkspaceTask {
        WorkspaceTask.legacy(
            WorkDocument(
                slug: slug,
                brief: "fixture",
                createdAt: "2026-08-07T00:00:00.000Z",
                done: false,
                doneAt: nil,
                auditRequired: false,
                audit: nil,
                delivery: nil,
                checks: [],
                contract: WorkContractRecord(
                    required: [],
                    forbidden: [],
                    commit: "forbidden",
                    risk: "low",
                    verification: "deterministic"
                )
            ),
            root: root
        )
    }
}

@MainActor
final class WorkspaceStoreLiveDataTests: XCTestCase {
    func testLiveStoreReadsOnlyRepositoryTasksAndDoesNotMutateTheirDocuments() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let work = makeWork(slug: "live-only-task")
        let checksURL = root.appendingPathComponent(
            ".gdm/\(work.slug)/checks.json",
            isDirectory: false
        )
        try FileManager.default.createDirectory(
            at: checksURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoded = try JSONEncoder().encode(work)
        try encoded.write(to: checksURL)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = WorkspaceStore(repositoryURL: root, isDemo: false)

        XCTAssertFalse(store.isDemo)
        XCTAssertEqual(store.tasks.map(\.slug), ["live-only-task"])
        XCTAssertEqual(try Data(contentsOf: checksURL), encoded)

        store.refresh()
        XCTAssertEqual(store.tasks.map(\.slug), ["live-only-task"])
        XCTAssertEqual(try Data(contentsOf: checksURL), encoded)
    }

    func testDemoStoreIgnoresConflictingRepositoryTask() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let work = makeWork(slug: "live-only-task")
        let checksURL = root.appendingPathComponent(
            ".gdm/\(work.slug)/checks.json",
            isDirectory: false
        )
        try FileManager.default.createDirectory(
            at: checksURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(work).write(to: checksURL)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = WorkspaceStore(
            repositoryURL: root,
            demoState: "activity-popover",
            isDemo: true
        )

        XCTAssertTrue(store.isDemo)
        XCTAssertFalse(store.tasks.contains { $0.slug == "live-only-task" })
        XCTAssertTrue(store.tasks.contains { $0.slug == "fix-login-regression" })
    }

    private func makeWork(slug: String) -> WorkDocument {
        WorkDocument(
            slug: slug,
            brief: "live fixture",
            createdAt: "2026-08-07T00:00:00.000Z",
            done: false,
            doneAt: nil,
            auditRequired: false,
            audit: nil,
            delivery: nil,
            checks: [],
            contract: WorkContractRecord(
                required: [],
                forbidden: [],
                commit: "forbidden",
                risk: "low",
                verification: "deterministic"
            )
        )
    }
}
