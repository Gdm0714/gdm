import Foundation

enum AgentEventCLI {
    static func isInvocation(_ arguments: [String]) -> Bool {
        arguments.contains("--agent-event") || arguments.contains("--agent-event-help")
    }

    static func run(
        arguments: [String],
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Int32 {
        if arguments.contains("--agent-event-help") {
            print(usage)
            return 0
        }
        guard let eventIndex = arguments.firstIndex(of: "--agent-event"),
              arguments.indices.contains(eventIndex + 1),
              let kind = eventKind(arguments[eventIndex + 1]),
              let socketPath = environment["GIDEM_AGENT_EVENT_SOCKET"],
              let runToken = environment["GIDEM_AGENT_RUN_TOKEN"],
              let taskID = environment["GIDEM_AGENT_TASK_ID"],
              let laneID = environment["GIDEM_AGENT_LANE_ID"],
              let generationText = environment["GIDEM_AGENT_GENERATION"],
              let generation = UInt64(generationText) else {
            FileHandle.standardError.write(Data("Invalid agent event invocation. Use --agent-event-help.\n".utf8))
            return 64
        }

        let summary = value(after: "--summary", in: arguments)
        let paths = values(after: "--path", in: arguments)
        let sequence = value(after: "--sequence", in: arguments).flatMap(UInt64.init)
            ?? DispatchTime.now().uptimeNanoseconds
        let sessionID = environment["GIDEM_AGENT_SESSION_ID"].flatMap(UUID.init(uuidString:))
        let event = AgentEventEnvelope(
            schemaVersion: AgentEventEnvelope.currentSchemaVersion,
            runToken: runToken,
            sessionID: sessionID,
            taskID: taskID,
            laneID: laneID,
            generation: generation,
            sequence: sequence,
            kind: kind,
            summary: summary,
            relativePaths: paths
        )
        do {
            let receipt = try AgentEventSocketClient.exchange(event, at: socketPath)
            let output = try JSONEncoder().encode(receipt)
            FileHandle.standardOutput.write(output)
            FileHandle.standardOutput.write(Data([0x0A]))
            return receipt.accepted ? 0 : 2
        } catch {
            FileHandle.standardError.write(
                Data("Agent event delivery failed: \(error.localizedDescription)\n".utf8)
            )
            return 1
        }
    }

    static let usage = """
    Gidem agent event client

      gdm-native --agent-event <started|working|needs-input|resumed|handoff|verifying|completed|failed|heartbeat>
                 [--summary <text>] [--path <relative-path>] [--sequence <uint64>]

    The GIDEM_AGENT_* connection variables are injected into attached agent sessions.
    """

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag),
              arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    private static func values(after flag: String, in arguments: [String]) -> [String] {
        arguments.indices.compactMap { index in
            guard arguments[index] == flag, arguments.indices.contains(index + 1) else { return nil }
            return arguments[index + 1]
        }
    }

    private static func eventKind(_ value: String) -> AgentEventKind? {
        switch value.lowercased() {
        case "started": .started
        case "working": .working
        case "needs-input", "needs-you": .needsInput
        case "resumed": .resumed
        case "handoff", "handoff-requested": .handoffRequested
        case "verifying": .verifying
        case "completed": .completed
        case "failed": .failed
        case "heartbeat": .heartbeat
        default: nil
        }
    }
}
