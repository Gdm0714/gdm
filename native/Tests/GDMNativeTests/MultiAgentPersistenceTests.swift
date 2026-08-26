import Foundation
import XCTest
@testable import GDMNative

final class MultiAgentPersistenceTests: XCTestCase {
    func testSessionHelpersPersistEveryLaneAndMaintainCompatibilityProjection() throws {
        let fixture = try RegistryFixture()
        defer { fixture.remove() }
        let record = fixture.makeRecord(lastSession: fixture.session(
            kind: "legacy",
            startedAt: "2026-08-11T08:00:00.000Z",
            endedAt: "2026-08-11T08:10:00.000Z",
            outcome: .ended
        ))
        try fixture.registry.save(WorkspaceRegistryDocument(tasks: [record]))

        let ended = fixture.session(
            kind: "codex",
            startedAt: "2026-08-11T09:00:00.000Z",
            endedAt: "2026-08-11T09:30:00.000Z",
            outcome: .ended
        )
        var updated = try fixture.registry.updateSession(
            recordID: record.id,
            laneID: "lane-ended",
            session: ended
        )
        XCTAssertEqual(updated.sessionsByLane, ["lane-ended": ended])
        XCTAssertEqual(updated.lastSession, ended, "The first map write must replace lane-less legacy state.")

        let olderActive = fixture.session(
            kind: "claude",
            startedAt: "2026-08-11T08:45:00.000Z",
            outcome: .active
        )
        updated = try fixture.registry.updateSession(
            recordID: record.id,
            laneID: "lane-active-old",
            session: olderActive
        )
        XCTAssertEqual(updated.lastSession, olderActive, "An active lane wins over an ended lane.")

        let newerActive = fixture.session(
            kind: "gemini",
            startedAt: "2026-08-11T10:00:00.000Z",
            outcome: .active
        )
        updated = try fixture.registry.updateSession(
            recordID: record.id,
            laneID: "lane-active-new",
            session: newerActive
        )
        XCTAssertEqual(updated.sessionsByLane?.count, 3)
        XCTAssertEqual(updated.lastSession, newerActive, "The latest active lane is the compatibility row.")

        updated = try fixture.registry.removeSession(
            recordID: record.id,
            laneID: "lane-active-new"
        )
        XCTAssertEqual(updated.lastSession, olderActive)
        updated = try fixture.registry.removeSession(
            recordID: record.id,
            laneID: "lane-active-old"
        )
        XCTAssertEqual(updated.lastSession, ended, "The latest ended lane is used when no lane is active.")
        updated = try fixture.registry.removeSession(
            recordID: record.id,
            laneID: "lane-ended"
        )
        XCTAssertEqual(updated.sessionsByLane, [:])
        XCTAssertNil(updated.lastSession)
    }

    func testRecoveryInterruptsEveryActiveCanonicalLane() throws {
        let fixture = try RegistryFixture()
        defer { fixture.remove() }
        let first = fixture.session(
            kind: "codex",
            startedAt: "2026-08-11T09:00:00.000Z",
            outcome: .active
        )
        let second = fixture.session(
            kind: "claude",
            startedAt: "2026-08-11T10:00:00.000Z",
            outcome: .active
        )
        let ended = fixture.session(
            kind: "gemini",
            startedAt: "2026-08-11T07:00:00.000Z",
            endedAt: "2026-08-11T08:00:00.000Z",
            outcome: .ended
        )
        let staleLegacy = fixture.session(
            kind: "stale",
            startedAt: "2026-08-11T11:00:00.000Z",
            outcome: .active
        )
        let record = fixture.makeRecord(
            lastSession: staleLegacy,
            sessionsByLane: ["first": first, "second": second, "ended": ended]
        )
        try fixture.registry.save(WorkspaceRegistryDocument(tasks: [record]))

        let recovered = try fixture.registry.recoverInterruptedSessions()
        let actual = try XCTUnwrap(recovered.tasks.first)

        XCTAssertEqual(actual.sessionsByLane?["first"]?.outcome, .interrupted)
        XCTAssertEqual(actual.sessionsByLane?["second"]?.outcome, .interrupted)
        XCTAssertEqual(actual.sessionsByLane?["ended"]?.outcome, .ended)
        XCTAssertNil(actual.sessionsByLane?["first"]?.endedAt)
        XCTAssertNil(actual.sessionsByLane?["second"]?.endedAt)
        XCTAssertEqual(actual.lastSession?.kind, "claude")
        XCTAssertNotEqual(actual.lastSession?.kind, "stale", "A present map must ignore stale legacy state.")
    }

    func testPresentEmptyMapIsCanonicalAndDoesNotFallBackToLegacySession() throws {
        let fixture = try RegistryFixture()
        defer { fixture.remove() }
        let legacy = fixture.session(
            kind: "legacy",
            startedAt: "2026-08-11T09:00:00.000Z",
            outcome: .active
        )
        let record = fixture.makeRecord(lastSession: legacy, sessionsByLane: [:])
        try fixture.registry.save(WorkspaceRegistryDocument(tasks: [record]))

        let recovered = try fixture.registry.recoverInterruptedSessions()
        let actual = try XCTUnwrap(recovered.tasks.first)

        XCTAssertEqual(actual.sessionsByLane, [:])
        XCTAssertNil(actual.lastSession, "Map presence, including an empty map, is canonical.")
    }

    func testNilMapKeepsLegacyRecoveryCompatibility() throws {
        let fixture = try RegistryFixture()
        defer { fixture.remove() }
        let legacy = fixture.session(
            kind: "legacy",
            startedAt: "2026-08-11T09:00:00.000Z",
            outcome: .active
        )
        let record = fixture.makeRecord(lastSession: legacy)
        try fixture.registry.save(WorkspaceRegistryDocument(tasks: [record]))

        let recovered = try fixture.registry.recoverInterruptedSessions()
        let actual = try XCTUnwrap(recovered.tasks.first)

        XCTAssertNil(actual.sessionsByLane)
        XCTAssertEqual(actual.lastSession?.outcome, .interrupted)
        XCTAssertNil(actual.lastSession?.endedAt)
    }
}

private struct RegistryFixture {
    let root: URL
    let registry: WorkspaceRegistry

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gidem-multi-agent-persistence-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        registry = WorkspaceRegistry(repositoryURL: root)
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }

    func session(
        kind: String,
        startedAt: String,
        endedAt: String? = nil,
        outcome: PersistedSessionOutcome
    ) -> PersistedSessionRecord {
        PersistedSessionRecord(
            kind: kind,
            startedAt: startedAt,
            endedAt: endedAt,
            outcome: outcome
        )
    }

    func makeRecord(
        lastSession: PersistedSessionRecord?,
        sessionsByLane: [String: PersistedSessionRecord]? = nil
    ) -> WorkspaceRegistryRecord {
        WorkspaceRegistryRecord(
            id: UUID(),
            slug: "multi-agent-persistence",
            worktreePath: root.appendingPathComponent("worktree", isDirectory: true).path,
            branch: "refs/heads/gdm/multi-agent-persistence",
            baseOID: String(repeating: "a", count: 40),
            gitCommonDirectory: root.appendingPathComponent(".git", isDirectory: true).path,
            phase: .ready,
            selectedAgent: AgentKind.codex.rawValue,
            lastSession: lastSession,
            sessionsByLane: sessionsByLane,
            lastError: nil,
            createdAt: "2026-08-11T07:00:00.000Z"
        )
    }
}
