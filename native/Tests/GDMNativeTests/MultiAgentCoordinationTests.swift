import XCTest
@testable import GDMNative

final class MultiAgentCoordinationTests: XCTestCase {
    @MainActor
    func testSemanticEventsRejectReplayAndStaleIdentityWithoutParsingTerminalOutput() throws {
        let coordinator = AgentCoordinator()
        let identity = makeIdentity(lane: "implement", generation: 4)
        let token = AgentCoordinator.makeRunToken()
        XCTAssertTrue(coordinator.register(
            identity: identity,
            runToken: token,
            worktreePath: "/tmp/gidem-worktree"
        ))

        let needsYou = event(
            identity: identity,
            token: token,
            sequence: 1,
            kind: .needsInput,
            summary: "Approve the migration plan"
        )
        XCTAssertEqual(coordinator.accept(needsYou), .accepted(sequence: 1))
        XCTAssertEqual(
            coordinator.status(
                taskID: identity.taskID,
                laneID: identity.laneID,
                generation: identity.generation
            )?.semanticState,
            .needsYou
        )
        XCTAssertEqual(
            coordinator.status(
                taskID: identity.taskID,
                laneID: identity.laneID,
                generation: identity.generation
            )?.semanticState.activityState,
            .needsYou
        )

        XCTAssertEqual(
            coordinator.accept(needsYou),
            .rejected(.replayedSequence, lastSequence: 1)
        )
        let stale = event(
            identity: AgentRunIdentity(
                sessionID: UUID(),
                taskID: identity.taskID,
                laneID: identity.laneID,
                generation: identity.generation - 1
            ),
            token: token,
            sequence: 2,
            kind: .working
        )
        XCTAssertEqual(
            coordinator.accept(stale),
            .rejected(.staleIdentity, lastSequence: 1)
        )
    }

    @MainActor
    func testSameWorktreeHasOnePrimaryCoordinationRoleAndExplicitHandoff() {
        let coordinator = AgentCoordinator()
        let implementer = makeIdentity(lane: "implement", generation: 1)
        let reviewer = makeIdentity(lane: "review", generation: 1)
        let worktree = "/tmp/gidem-shared"
        XCTAssertTrue(coordinator.register(
            identity: implementer,
            runToken: AgentCoordinator.makeRunToken(),
            worktreePath: worktree
        ))
        XCTAssertTrue(coordinator.register(
            identity: reviewer,
            runToken: AgentCoordinator.makeRunToken(),
            worktreePath: worktree
        ))

        XCTAssertEqual(status(coordinator, implementer)?.coordinationRole, .primary)
        XCTAssertEqual(status(coordinator, reviewer)?.coordinationRole, .secondary)
        XCTAssertEqual(
            coordinator.handoffCoordinationRole(from: implementer, to: reviewer),
            .handedOff
        )
        XCTAssertEqual(status(coordinator, implementer)?.coordinationRole, .secondary)
        XCTAssertEqual(status(coordinator, reviewer)?.coordinationRole, .primary)
    }

    @MainActor
    func testInputOwnershipIsSingularAndFinishedRunsReleaseRoles() {
        let coordinator = AgentCoordinator()
        let first = makeIdentity(lane: "first", generation: 1)
        let second = makeIdentity(lane: "second", generation: 1)
        for identity in [first, second] {
            XCTAssertTrue(coordinator.register(
                identity: identity,
                runToken: AgentCoordinator.makeRunToken(),
                worktreePath: "/tmp/gidem-input"
            ))
        }

        XCTAssertTrue(coordinator.claimInput(first))
        XCTAssertTrue(status(coordinator, first)?.ownsInput == true)
        XCTAssertTrue(coordinator.claimInput(second))
        XCTAssertTrue(status(coordinator, first)?.ownsInput == false)
        XCTAssertTrue(status(coordinator, second)?.ownsInput == true)

        coordinator.finish(sessionID: second.sessionID)
        XCTAssertNil(status(coordinator, second))
        XCTAssertTrue(status(coordinator, first)?.ownsInput == false)
    }

    @MainActor
    func testPayloadBoundaryRejectsTraversalOversizeAndTooManyPaths() {
        let coordinator = AgentCoordinator()
        let identity = makeIdentity(lane: "proof", generation: 2)
        let token = AgentCoordinator.makeRunToken()
        XCTAssertTrue(coordinator.register(
            identity: identity,
            runToken: token,
            worktreePath: "/tmp/gidem-payload"
        ))

        XCTAssertEqual(
            coordinator.accept(event(
                identity: identity,
                token: token,
                sequence: 1,
                kind: .working,
                summary: String(repeating: "x", count: 513)
            )),
            .rejected(.invalidPayload, lastSequence: 0)
        )
        XCTAssertEqual(
            coordinator.accept(event(
                identity: identity,
                token: token,
                sequence: 2,
                kind: .verifying,
                paths: ["../secret"]
            )),
            .rejected(.invalidPayload, lastSequence: 0)
        )
    }

    @MainActor
    func testOlderGenerationCannotReplaceCurrentLaneRegistration() {
        let coordinator = AgentCoordinator()
        let current = makeIdentity(lane: "review", generation: 8)
        XCTAssertTrue(coordinator.register(
            identity: current,
            runToken: AgentCoordinator.makeRunToken(),
            worktreePath: "/tmp/gidem-generation"
        ))
        let stale = makeIdentity(lane: "review", generation: 7)
        XCTAssertFalse(coordinator.register(
            identity: stale,
            runToken: AgentCoordinator.makeRunToken(),
            worktreePath: "/tmp/gidem-generation"
        ))
        XCTAssertNotNil(status(coordinator, current))
        XCTAssertNil(status(coordinator, stale))
    }

    @MainActor
    func testPrivateSocketAcceptsAuthenticatedSemanticEvent() async throws {
        let coordinator = AgentCoordinator()
        let identity = makeIdentity(lane: "socket", generation: 1)
        let token = AgentCoordinator.makeRunToken()
        XCTAssertTrue(coordinator.register(
            identity: identity,
            runToken: token,
            worktreePath: "/tmp/gidem-socket"
        ))
        let server = try AgentEventSocketServer { event in
            await coordinator.accept(event)
        }
        defer { server.stop() }

        let directoryMode = try fileMode(server.directoryURL)
        let socketMode = try fileMode(server.socketURL)
        XCTAssertEqual(directoryMode & 0o777, 0o700)
        XCTAssertEqual(socketMode & 0o777, 0o600)

        let request = event(
            identity: identity,
            token: token,
            sequence: 1,
            kind: .needsInput,
            summary: "Choose the deployment target"
        )
        let socketPath = server.socketURL.path
        let client = Task.detached { @Sendable in
            try AgentEventSocketClient.exchange(request, at: socketPath)
        }
        let receipt = try await client.value
        XCTAssertEqual(receipt, .accepted(sequence: 1))
        XCTAssertEqual(status(coordinator, identity)?.semanticState, .needsYou)
    }

    private func makeIdentity(lane: String, generation: UInt64) -> AgentRunIdentity {
        AgentRunIdentity(
            sessionID: UUID(),
            taskID: "task-a",
            laneID: lane,
            generation: generation
        )
    }

    private func event(
        identity: AgentRunIdentity,
        token: String,
        sequence: UInt64,
        kind: AgentEventKind,
        summary: String? = nil,
        paths: [String] = []
    ) -> AgentEventEnvelope {
        AgentEventEnvelope(
            schemaVersion: AgentEventEnvelope.currentSchemaVersion,
            runToken: token,
            sessionID: identity.sessionID,
            taskID: identity.taskID,
            laneID: identity.laneID,
            generation: identity.generation,
            sequence: sequence,
            kind: kind,
            summary: summary,
            relativePaths: paths
        )
    }

    private func fileMode(_ url: URL) throws -> mode_t {
        var info = stat()
        guard lstat(url.path, &info) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        return info.st_mode
    }

    @MainActor
    private func status(
        _ coordinator: AgentCoordinator,
        _ identity: AgentRunIdentity
    ) -> AgentCoordinationStatus? {
        coordinator.status(
            taskID: identity.taskID,
            laneID: identity.laneID,
            generation: identity.generation
        )
    }
}
