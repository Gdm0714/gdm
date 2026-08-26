import Foundation

struct WorkspaceSourceFingerprint: Decodable, Equatable, Sendable {
    let schemaVersion: Int
    let sha256: String
    let fileCount: Int
}

enum WorkspaceSourceFingerprintError: Error, LocalizedError, Equatable, Sendable {
    case commandFailed(exitCode: Int32, output: String)
    case oversizedOutput(Int)
    case malformedOutput
    case unsupportedSchema(Int)
    case invalidDigest
    case invalidFileCount(Int)

    var errorDescription: String? {
        switch self {
        case .commandFailed(let exitCode, let output):
            let detail = output.trimmingCharacters(in: .whitespacesAndNewlines)
            return "현재 소스와 Git index를 확인하지 못했습니다 (exit \(exitCode))\(detail.isEmpty ? "" : ": \(detail)")"
        case .oversizedOutput(let count):
            return "소스 fingerprint 응답이 허용 크기를 넘었습니다: \(count) bytes"
        case .malformedOutput:
            return "소스 fingerprint 응답을 읽을 수 없습니다."
        case .unsupportedSchema(let version):
            return "지원하지 않는 소스 fingerprint 형식입니다: schema \(version)"
        case .invalidDigest:
            return "소스 fingerprint SHA-256 형식이 올바르지 않습니다."
        case .invalidFileCount(let count):
            return "소스 fingerprint 파일 수가 올바르지 않습니다: \(count)"
        }
    }
}

struct WorkspaceSourceFingerprintProvider: Sendable {
    private static let maximumResponseBytes = 64 * 1024
    private static let maximumFileCount = 10_000_000

    private let body: @Sendable (URL) async throws -> WorkspaceSourceFingerprint

    init(_ body: @escaping @Sendable (URL) async throws -> WorkspaceSourceFingerprint) {
        self.body = body
    }

    func capture(at workspaceURL: URL) async throws -> WorkspaceSourceFingerprint {
        try await body(workspaceURL)
    }

    static func live(
        invocation: CommandInvocation,
        runner: WorktreeCommandRunner
    ) -> WorkspaceSourceFingerprintProvider {
        WorkspaceSourceFingerprintProvider { workspaceURL in
            let result = await Task.detached {
                runner.run(
                    executable: invocation.executable,
                    arguments: invocation.prefixArguments + ["workspace", "fingerprint", "--json"],
                    directory: workspaceURL
                )
            }.value
            guard result.exitCode == 0 else {
                throw WorkspaceSourceFingerprintError.commandFailed(
                    exitCode: result.exitCode,
                    output: result.output
                )
            }
            let data = Data(result.output.utf8)
            guard data.count <= maximumResponseBytes else {
                throw WorkspaceSourceFingerprintError.oversizedOutput(data.count)
            }
            guard let object = try? JSONSerialization.jsonObject(with: data),
                  let dictionary = object as? [String: Any],
                  Set(dictionary.keys) == Set(["schemaVersion", "sha256", "fileCount"]) else {
                throw WorkspaceSourceFingerprintError.malformedOutput
            }
            guard let fingerprint = try? JSONDecoder().decode(WorkspaceSourceFingerprint.self, from: data) else {
                throw WorkspaceSourceFingerprintError.malformedOutput
            }
            guard fingerprint.schemaVersion == 1 else {
                throw WorkspaceSourceFingerprintError.unsupportedSchema(fingerprint.schemaVersion)
            }
            guard fingerprint.sha256.range(
                of: "^[0-9a-f]{64}$",
                options: .regularExpression
            ) != nil else {
                throw WorkspaceSourceFingerprintError.invalidDigest
            }
            guard (0...maximumFileCount).contains(fingerprint.fileCount) else {
                throw WorkspaceSourceFingerprintError.invalidFileCount(fingerprint.fileCount)
            }
            return fingerprint
        }
    }
}
