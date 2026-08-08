import AppKit

/// Coordinates AppKit's asynchronous termination handshake. Once cleanup has
/// started, repeated termination requests join the same handshake and can never
/// trigger a second cleanup or reply.
@MainActor
final class ApplicationTerminationCoordinator {
    private enum State {
        case idle
        case pending
        case replied
    }

    private var state: State = .idle
    private var terminationTask: Task<Void, Never>?

    var isPending: Bool { state == .pending }

    func requestTermination(
        hasActiveSessions: Bool,
        terminateAll: @escaping @MainActor () async -> Bool,
        reply: @escaping @MainActor (Bool) -> Void
    ) -> NSApplication.TerminateReply {
        switch state {
        case .pending, .replied:
            return .terminateLater
        case .idle:
            guard hasActiveSessions else { return .terminateNow }
        }

        state = .pending
        terminationTask = Task { [weak self] in
            let shouldTerminate = await terminateAll()
            guard let self, self.state == .pending else { return }
            self.state = shouldTerminate ? .replied : .idle
            self.terminationTask = nil
            reply(shouldTerminate)
        }
        return .terminateLater
    }
}
