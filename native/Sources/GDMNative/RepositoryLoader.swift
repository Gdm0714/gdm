import Foundation

enum RepositoryLoader {
    struct WorkspaceLoadResult: Sendable {
        let tasks: [WorkspaceTask]
        let warnings: [String]
    }

    static func loadWorks(from repositoryURL: URL) throws -> [WorkDocument] {
        let root = repositoryURL.appendingPathComponent(".gdm", isDirectory: true)
        guard WorkspaceRegistry.pathExistsIncludingDanglingSymlink(root.path) else { return [] }
        try WorkspaceStatePathBoundary.validateWorkspaceDirectory(root)

        let directories = try FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )

        let decoder = JSONDecoder()
        return directories.compactMap { directory in
            let checksFile = directory.appendingPathComponent("checks.json", isDirectory: false)
            guard (try? WorkspaceStatePathBoundary.validateWorkspaceDirectory(directory)) != nil,
                  (try? WorkspaceStatePathBoundary.validateRequiredRegularFile(checksFile)) != nil,
                  let data = try? Data(contentsOf: checksFile) else {
                return nil
            }
            guard let work = try? decoder.decode(WorkDocument.self, from: data),
                  work.slug == directory.lastPathComponent else {
                return nil
            }
            return work
        }
        .sorted { lhs, rhs in lhs.createdAt > rhs.createdAt }
    }

    static func loadWork(slug: String, from workspaceURL: URL) throws -> WorkDocument {
        let paths = try WorkspaceStatePathBoundary.validate(
            workspaceURL: workspaceURL,
            slug: slug,
            requirement: .checksRequired
        )
        let data = try Data(contentsOf: paths.checksFile)
        let work = try JSONDecoder().decode(WorkDocument.self, from: data)
        guard work.slug == slug else {
            throw NSError(
                domain: "GDMNative.RepositoryLoader",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "registry slug와 checks.json slug가 다릅니다."]
            )
        }
        return work
    }

    static func loadTasks(
        from repositoryURL: URL,
        registry: WorkspaceRegistryDocument
    ) throws -> WorkspaceLoadResult {
        var tasks = try loadWorks(from: repositoryURL).map { WorkspaceTask.legacy($0, root: repositoryURL) }
        var warnings: [String] = []
        var slugs = Set(tasks.map(\.slug))

        for record in registry.tasks.sorted(by: { $0.createdAt > $1.createdAt }) {
            if slugs.contains(record.slug) {
                if let existingIndex = tasks.firstIndex(where: { $0.slug == record.slug }) {
                    let existing = tasks[existingIndex]
                    tasks[existingIndex] = WorkspaceTask(
                        id: existing.id,
                        slug: existing.slug,
                        document: existing.document,
                        location: existing.location,
                        health: .conflicted,
                        statusMessage: "같은 slug가 root 또는 다른 worktree에 중복 등록되었습니다."
                    )
                }
                tasks.append(.mapped(
                    record: record,
                    document: nil,
                    health: .conflicted,
                    message: "같은 slug가 root 또는 다른 worktree에 이미 있습니다."
                ))
                warnings.append("\(record.slug): duplicate slug 충돌")
                continue
            }
            slugs.insert(record.slug)

            let worktreeURL = URL(fileURLWithPath: record.worktreePath, isDirectory: true).standardizedFileURL
            do {
                try WorkspaceStatePathBoundary.validateWorkspaceDirectory(worktreeURL)
            } catch {
                let health: WorkspaceHealth
                if let pathError = error as? WorkspaceStatePathValidationError,
                   pathError.isUnsafeType {
                    health = .conflicted
                } else {
                    health = .disconnected
                }
                tasks.append(.mapped(
                    record: record,
                    document: nil,
                    health: health,
                    message: "등록된 worktree 경로가 안전한 실제 디렉터리가 아닙니다: \(error.localizedDescription)"
                ))
                warnings.append("\(record.slug): worktree 연결 끊김")
                continue
            }

            let actualBranch = branch(at: worktreeURL)
            guard actualBranch == record.branch else {
                tasks.append(.mapped(
                    record: record,
                    document: nil,
                    health: .conflicted,
                    message: "예상 branch \(record.branch), 실제 \(actualBranch.isEmpty ? "detached" : actualBranch)"
                ))
                warnings.append("\(record.slug): branch 불일치")
                continue
            }

            let actualCommonDirectory = gitCommonDirectory(at: worktreeURL)
            if !record.gitCommonDirectory.isEmpty && actualCommonDirectory != record.gitCommonDirectory {
                tasks.append(.mapped(
                    record: record,
                    document: nil,
                    health: .conflicted,
                    message: "다른 Git repository의 worktree입니다."
                ))
                warnings.append("\(record.slug): git common directory 불일치")
                continue
            }

            do {
                let work = try loadWork(slug: record.slug, from: worktreeURL)
                let health: WorkspaceHealth
                switch record.phase {
                case .ready: health = .ready
                case .creating: health = .creating
                case .failed: health = .failed
                }
                tasks.append(.mapped(
                    record: record,
                    document: work,
                    health: health,
                    message: record.lastError
                ))
            } catch {
                let health: WorkspaceHealth
                if let pathError = error as? WorkspaceStatePathValidationError,
                   pathError.isUnsafeType {
                    health = .conflicted
                } else if record.phase == .failed {
                    health = .failed
                } else {
                    health = .disconnected
                }
                tasks.append(.mapped(
                    record: record,
                    document: nil,
                    health: health,
                    message: "GDM state를 읽지 못했습니다: \(error.localizedDescription)"
                ))
                warnings.append("\(record.slug): checks.json 없음 또는 손상")
            }
        }

        return WorkspaceLoadResult(
            tasks: tasks.sorted { lhs, rhs in
                let left = lhs.document?.createdAt ?? lhs.location.registryRecord?.createdAt ?? ""
                let right = rhs.document?.createdAt ?? rhs.location.registryRecord?.createdAt ?? ""
                return left > right
            },
            warnings: warnings
        )
    }

    static func branch(at repositoryURL: URL) -> String {
        CommandRunner.run(
            executable: "/usr/bin/env",
            arguments: ["git", "symbolic-ref", "--quiet", "HEAD"],
            directory: repositoryURL
        ).output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func gitCommonDirectory(at repositoryURL: URL) -> String {
        let result = CommandRunner.run(
            executable: "/usr/bin/env",
            arguments: ["git", "rev-parse", "--git-common-dir"],
            directory: repositoryURL
        )
        let value = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard result.exitCode == 0, !value.isEmpty else { return "" }
        let url = URL(fileURLWithPath: value, relativeTo: repositoryURL)
            .resolvingSymlinksInPath()
            .standardizedFileURL
        return url.path
    }

    static func diff(at repositoryURL: URL) -> String {
        let result = CommandRunner.run(
            executable: "/usr/bin/env",
            arguments: ["git", "diff", "--no-ext-diff", "--unified=2"],
            directory: repositoryURL
        )
        let untracked = CommandRunner.run(
            executable: "/usr/bin/env",
            arguments: ["git", "status", "--short"],
            directory: repositoryURL
        )
        let body = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        let status = untracked.output.trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty && status.isEmpty { return "변경된 파일이 없습니다." }
        if body.isEmpty { return status }
        if status.isEmpty { return body }
        return "\(status)\n\n\(body)"
    }

    static func journal(for slug: String, at repositoryURL: URL) -> String {
        guard let paths = try? WorkspaceStatePathBoundary.validate(
            workspaceURL: repositoryURL,
            slug: slug,
            requirement: .checksRequired
        ) else {
            return "GDM state 경로가 안전하지 않아 저널을 읽지 않았습니다."
        }
        let url = paths.workDirectory.appendingPathComponent("journal.jsonl")
        guard (try? WorkspaceStatePathBoundary.validateOptionalRegularFile(url)) == true,
              let contents = try? String(contentsOf: url, encoding: .utf8) else {
            return "저널 기록이 없습니다."
        }
        return contents.split(separator: "\n").suffix(80).joined(separator: "\n")
    }
}

struct CommandResult: Sendable {
    let exitCode: Int32
    let output: String
}

struct CommandInvocation: Sendable {
    let executable: String
    let prefixArguments: [String]
}

enum CommandRunner {
    static func run(
        executable: String,
        arguments: [String],
        directory: URL,
        environment: [String: String]? = nil
    ) -> CommandResult {
        let process = Process()
        let outputPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = directory
        process.standardOutput = outputPipe
        process.standardError = outputPipe
        if let environment { process.environment = environment }

        do {
            try process.run()
            let data = outputPipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return CommandResult(
                exitCode: process.terminationStatus,
                output: String(decoding: data, as: UTF8.self).strippingANSI
            )
        } catch {
            return CommandResult(exitCode: 127, output: "명령을 시작하지 못했습니다: \(error.localizedDescription)")
        }
    }

    static func gdm(at repositoryURL: URL) -> CommandInvocation {
        let compiled = repositoryURL.appendingPathComponent("cli/dist/gdm")
        if FileManager.default.isExecutableFile(atPath: compiled.path) {
            return CommandInvocation(executable: compiled.path, prefixArguments: [])
        }

        let source = repositoryURL.appendingPathComponent("cli/src/cli.ts")
        if FileManager.default.fileExists(atPath: source.path) {
            return CommandInvocation(
                executable: "/usr/bin/env",
                prefixArguments: ["bun", source.path]
            )
        }

        return CommandInvocation(executable: "/usr/bin/env", prefixArguments: ["gdm"])
    }
}

private extension String {
    var strippingANSI: String {
        replacingOccurrences(
            of: "\u{001B}\\[[0-9;]*[A-Za-z]",
            with: "",
            options: .regularExpression
        )
    }
}
