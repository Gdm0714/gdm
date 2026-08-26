import Foundation

/// Focus-free release probe for the packaged GDM helper and provisioning path.
enum ToolchainSmokeCLI {
    static let marker = "GIDEM_TOOLCHAIN_SMOKE_OK"
    private static let slug = "toolchain-smoke"

    static func isInvocation(_ arguments: [String]) -> Bool {
        arguments.contains("--toolchain-smoke")
    }

    static func run(arguments: [String]) -> Int32 {
        guard let repositoryPath = value(after: "--repo", in: arguments),
              !repositoryPath.isEmpty else {
            writeError("toolchain smoke requires --repo <Git root>")
            return 64
        }

        let invocation: CommandInvocation
        do {
            invocation = try GDMToolchainLocator.require()
        } catch {
            writeError("toolchain smoke could not resolve Gidem's GDM helper: \(error.localizedDescription)")
            return 78
        }

        let repositoryURL = URL(
            fileURLWithPath: repositoryPath,
            isDirectory: true
        ).standardizedFileURL
        let record: WorkspaceRegistryRecord
        do {
            record = try WorktreeService(
                repositoryURL: repositoryURL,
                gdmInvocation: invocation
            ).provision(
                WorktreeProvisioningRequest(
                    slug: slug,
                    brief: "verify the packaged Gidem GDM toolchain",
                    required: ["use the app-owned GDM executable"],
                    forbidden: ["use repository-local or PATH GDM executables"]
                )
            )
        } catch {
            writeError("toolchain smoke provisioning failed: \(error.localizedDescription)")
            return 1
        }

        guard record.phase == .ready,
              record.checksApprovalRequired == true else {
            writeError("toolchain smoke provisioning returned an invalid registry record")
            return 1
        }

        print(
            "\(marker) toolchain=\(invocation.executable) "
                + "worktree=\(record.worktreePath) approval_required=true"
        )
        return 0
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag),
              arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    private static func writeError(_ message: String) {
        FileHandle.standardError.write(Data("\(message)\n".utf8))
    }
}
