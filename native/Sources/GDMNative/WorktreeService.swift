import Darwin
import Foundation

enum WorkspaceStatePathRequirement: Equatable, Sendable {
    case existingComponentsOnly
    case checksRequired
}

struct WorkspaceStatePaths: Equatable, Sendable {
    let gdmDirectory: URL
    let workDirectory: URL
    let checksFile: URL
}

enum WorkspaceStatePathValidationError: Error, LocalizedError, Sendable {
    case invalidSlug(String)
    case missing(path: String, expected: String)
    case wrongType(path: String, expected: String, actual: String)
    case systemCall(path: String, code: Int32)

    var errorDescription: String? {
        switch self {
        case .invalidSlug(let slug):
            return "GDM state slug가 올바르지 않습니다: \(slug)"
        case .missing(let path, let expected):
            return "GDM state 경로가 없습니다 (\(expected)): \(path)"
        case .wrongType(let path, let expected, let actual):
            return "GDM state 경로 타입이 올바르지 않습니다 (기대: \(expected), 실제: \(actual)): \(path)"
        case .systemCall(let path, let code):
            return "GDM state 경로를 lstat할 수 없습니다: \(path) (\(WorkspaceRegistry.posixMessage(code)))"
        }
    }

    var isUnsafeType: Bool {
        if case .wrongType = self { return true }
        return false
    }
}

/// One immediate, no-follow boundary for every app-side GDM state read or mutation.
///
/// Each path component is checked with `lstat`, so `.gdm`, the slug directory,
/// and `checks.json` must be real directory/directory/regular-file nodes rather
/// than symlinks. This is intentionally an app-level immediate revalidation; a
/// complete fd-relative TOCTOU defense would also require changing the GDM CLI's
/// file-opening boundary and is outside the native app contract.
enum WorkspaceStatePathBoundary {
    static func validate(
        workspaceURL: URL,
        slug: String,
        requirement: WorkspaceStatePathRequirement
    ) throws -> WorkspaceStatePaths {
        guard slug.range(of: "^[a-z0-9][a-z0-9-]{1,50}$", options: .regularExpression) != nil else {
            throw WorkspaceStatePathValidationError.invalidSlug(slug)
        }

        let paths = WorkspaceStatePaths(
            gdmDirectory: workspaceURL.appendingPathComponent(".gdm", isDirectory: true),
            workDirectory: workspaceURL
                .appendingPathComponent(".gdm", isDirectory: true)
                .appendingPathComponent(slug, isDirectory: true),
            checksFile: workspaceURL
                .appendingPathComponent(".gdm", isDirectory: true)
                .appendingPathComponent(slug, isDirectory: true)
                .appendingPathComponent("checks.json", isDirectory: false)
        )

        guard try require(
            paths.gdmDirectory,
            expected: .directory,
            mayBeMissing: requirement == .existingComponentsOnly
        ) else { return paths }
        guard try require(
            paths.workDirectory,
            expected: .directory,
            mayBeMissing: requirement == .existingComponentsOnly
        ) else { return paths }
        _ = try require(
            paths.checksFile,
            expected: .regularFile,
            mayBeMissing: requirement == .existingComponentsOnly
        )
        return paths
    }

    static func validateWorkspaceDirectory(_ workspaceURL: URL) throws {
        _ = try require(workspaceURL, expected: .directory, mayBeMissing: false)
    }

    static func validateOptionalRegularFile(_ fileURL: URL) throws -> Bool {
        try require(fileURL, expected: .regularFile, mayBeMissing: true)
    }

    static func validateRequiredRegularFile(_ fileURL: URL) throws {
        _ = try require(fileURL, expected: .regularFile, mayBeMissing: false)
    }

    private static func require(
        _ url: URL,
        expected: NodeKind,
        mayBeMissing: Bool
    ) throws -> Bool {
        let actual = try nodeKind(at: url)
        if actual == .missing, mayBeMissing { return false }
        guard actual != .missing else {
            throw WorkspaceStatePathValidationError.missing(
                path: url.path,
                expected: expected.description
            )
        }
        guard actual == expected else {
            throw WorkspaceStatePathValidationError.wrongType(
                path: url.path,
                expected: expected.description,
                actual: actual.description
            )
        }
        return true
    }

    private static func nodeKind(at url: URL) throws -> NodeKind {
        var info = stat()
        let result = url.path.withCString { Darwin.lstat($0, &info) }
        if result != 0 {
            let code = errno
            if code == ENOENT { return .missing }
            throw WorkspaceStatePathValidationError.systemCall(path: url.path, code: code)
        }
        switch info.st_mode & mode_t(S_IFMT) {
        case mode_t(S_IFDIR): return .directory
        case mode_t(S_IFREG): return .regularFile
        case mode_t(S_IFLNK): return .symbolicLink
        default: return .other
        }
    }

    private enum NodeKind: Equatable {
        case missing
        case directory
        case regularFile
        case symbolicLink
        case other

        var description: String {
            switch self {
            case .missing: "missing"
            case .directory: "directory"
            case .regularFile: "regular file"
            case .symbolicLink: "symbolic link"
            case .other: "other"
            }
        }
    }
}

struct WorktreeProvisioningRequest: Equatable, Sendable {
    let slug: String
    let brief: String
    let required: [String]
    let forbidden: [String]
    let risk: String
    let verification: String
    let simplificationRequired: Bool
    let auditRequired: Bool
    let selectedAgent: String?

    init(
        slug: String,
        brief: String,
        required: [String] = [],
        forbidden: [String] = [],
        risk: String = "low",
        verification: String = "deterministic",
        simplificationRequired: Bool = true,
        auditRequired: Bool = false,
        selectedAgent: String? = nil
    ) {
        self.slug = slug
        self.brief = brief
        self.required = required
        self.forbidden = forbidden
        self.risk = risk
        self.verification = verification
        self.simplificationRequired = simplificationRequired
        self.auditRequired = auditRequired
        self.selectedAgent = selectedAgent
    }
}

/// Truthful boundaries emitted by `WorktreeService.provision`. A caller may
/// present these stages, but must not advance them independently with a timer.
enum WorktreeProvisioningStep: String, Equatable, Sendable {
    case worktree
    case gdmContract
    case ready

    var order: Int {
        switch self {
        case .worktree: 0
        case .gdmContract: 1
        case .ready: 2
        }
    }
}

struct WorktreeCommandRunner: Sendable {
    private let body: @Sendable (String, [String], URL, [String: String]?) -> CommandResult

    init(
        _ body: @escaping @Sendable (
            _ executable: String,
            _ arguments: [String],
            _ directory: URL,
            _ environment: [String: String]?
        ) -> CommandResult
    ) {
        self.body = body
    }

    func run(
        executable: String,
        arguments: [String],
        directory: URL,
        environment: [String: String]? = nil
    ) -> CommandResult {
        body(executable, arguments, directory, environment)
    }

    static let live = WorktreeCommandRunner { executable, arguments, directory, environment in
        CommandRunner.run(
            executable: executable,
            arguments: arguments,
            directory: directory,
            environment: environment
        )
    }
}

enum WorktreeServiceError: Error, LocalizedError {
    case invalidSlug(String)
    case emptyBrief
    case invalidRisk(String)
    case invalidVerification(String)
    case invalidConstraint(String)
    case repositoryMismatch(expected: String, actual: String)
    case gdmUnavailable(String)
    case registryCollision(String)
    case legacyCollision(String)
    case branchCollision(String)
    case destinationCollision(String)
    case gitWorktreeCollision(String)
    case commandFailed(command: String, exitCode: Int32, output: String)
    case verificationFailed(String)
    case checksMissing(String)
    case checksInvalid(String)
    case failedToRecordProvisioningError(original: String, registry: String)

    var errorDescription: String? {
        switch self {
        case .invalidSlug(let slug):
            return "슬러그는 소문자 영문/숫자/하이픈 2~51자여야 합니다: \"\(slug)\""
        case .emptyBrief:
            return "brief(작업 설명)가 비어 있습니다"
        case .invalidRisk(let risk):
            return "지원하지 않는 risk입니다: \(risk)"
        case .invalidVerification(let verification):
            return "지원하지 않는 verification입니다: \(verification)"
        case .invalidConstraint(let message):
            return "작업 계약이 올바르지 않습니다: \(message)"
        case .repositoryMismatch(let expected, let actual):
            return "선택한 저장소 root와 Git top-level이 다릅니다 (기대: \(expected), 실제: \(actual))"
        case .gdmUnavailable(let root):
            return "root 저장소에서 GDM executable을 찾지 못했습니다: \(root)/cli/dist/gdm 또는 cli/src/cli.ts"
        case .registryCollision(let message):
            return "workspace registry 충돌: \(message)"
        case .legacyCollision(let slug):
            return "root legacy GDM 작업과 slug가 충돌합니다: \(slug)"
        case .branchCollision(let branch):
            return "이미 존재하는 branch를 덮어쓸 수 없습니다: \(branch)"
        case .destinationCollision(let path):
            return "worktree destination이 이미 존재하거나 symlink입니다: \(path)"
        case .gitWorktreeCollision(let message):
            return "기존 Git worktree와 충돌합니다: \(message)"
        case .commandFailed(let command, let exitCode, let output):
            let detail = output.trimmingCharacters(in: .whitespacesAndNewlines)
            return detail.isEmpty
                ? "\(command) 실패 (exit \(exitCode))"
                : "\(command) 실패 (exit \(exitCode)): \(detail)"
        case .verificationFailed(let message):
            return "생성된 worktree 검증에 실패했습니다: \(message)"
        case .checksMissing(let path):
            return "GDM checks.json이 생성되지 않았습니다: \(path)"
        case .checksInvalid(let message):
            return "GDM checks.json 검증에 실패했습니다: \(message)"
        case .failedToRecordProvisioningError(let original, let registry):
            return "provisioning 실패(\(original)) 후 registry 실패 상태 저장도 실패했습니다: \(registry)"
        }
    }
}

struct WorktreeInspection: Equatable, Sendable {
    let record: WorkspaceRegistryRecord
    let health: WorkspaceHealth
    let document: WorkDocument?
    let message: String?
}

struct WorktreeRecoveryResult: Equatable, Sendable {
    let record: WorkspaceRegistryRecord
    let health: WorkspaceHealth
    let promotedToReady: Bool
    let message: String?
}

struct WorktreeService: Sendable {
    let repositoryURL: URL
    let registry: WorkspaceRegistry
    let runner: WorktreeCommandRunner
    private let injectedGDMInvocation: CommandInvocation?

    private let gitExecutable = "/usr/bin/git"

    init(
        repositoryURL: URL,
        registry: WorkspaceRegistry? = nil,
        runner: WorktreeCommandRunner = .live,
        gdmInvocation: CommandInvocation? = nil
    ) {
        let root = repositoryURL.standardizedFileURL
        self.repositoryURL = root
        self.registry = registry ?? WorkspaceRegistry(repositoryURL: root)
        self.runner = runner
        self.injectedGDMInvocation = gdmInvocation
    }

    @discardableResult
    func provision(
        _ request: WorktreeProvisioningRequest,
        onProgress: (@Sendable (WorktreeProvisioningStep) -> Void)? = nil
    ) throws -> WorkspaceRegistryRecord {
        try validate(request)
        let gdmInvocation = try resolveGDMInvocation()
        let destination = destinationURL(for: request.slug)
        let branchName = "gdm/\(request.slug)"
        let branchRef = "refs/heads/\(branchName)"
        let id = UUID()
        let createdAt = WorkspaceRegistry.timestamp(Date())
        var reservation: WorkspaceRegistryRecord?

        _ = try registry.update { document in
            let root = try inspectRootRepository()
            try preflight(
                request: request,
                destination: destination,
                branchRef: branchRef,
                registryDocument: document
            )
            let record = WorkspaceRegistryRecord(
                id: id,
                slug: request.slug,
                worktreePath: destination.path,
                branch: branchRef,
                baseOID: root.headOID,
                gitCommonDirectory: root.commonDirectory.path,
                phase: .creating,
                selectedAgent: request.selectedAgent,
                lastSession: nil,
                lastError: nil,
                createdAt: createdAt
            )
            document.tasks.append(record)
            reservation = record
        }

        guard let reservation else {
            throw WorktreeServiceError.verificationFailed("creating reservation이 저장되지 않았습니다")
        }

        do {
            onProgress?(.worktree)
            try createWorktreeContainer()
            let add = runner.run(
                executable: gitExecutable,
                arguments: [
                    "worktree", "add", "-b", branchName, "--",
                    destination.path, reservation.baseOID
                ],
                directory: repositoryURL
            )
            guard add.exitCode == 0 else {
                throw WorktreeServiceError.commandFailed(
                    command: "git worktree add",
                    exitCode: add.exitCode,
                    output: Self.boundedOutput(add.output)
                )
            }

            _ = try verifyGitArtifacts(for: reservation, requireBaseOID: true)
            _ = try WorkspaceStatePathBoundary.validate(
                workspaceURL: destination,
                slug: reservation.slug,
                requirement: .existingComponentsOnly
            )
            onProgress?(.gdmContract)
            let arguments = gdmInvocation.prefixArguments + planInitArguments(for: request)
            let plan = runner.run(
                executable: gdmInvocation.executable,
                arguments: arguments,
                directory: destination
            )
            guard plan.exitCode == 0 else {
                throw WorktreeServiceError.commandFailed(
                    command: "gdm plan init",
                    exitCode: plan.exitCode,
                    output: Self.boundedOutput(plan.output)
                )
            }

            _ = try decodeChecks(for: reservation)
            let readyRecord = try registry.markReadyAndSelect(id: reservation.id)
            onProgress?(.ready)
            return readyRecord
        } catch {
            let summary = Self.registryFailureSummary(error)
            do {
                _ = try registry.markFailed(id: reservation.id, error: summary)
            } catch let registryError {
                throw WorktreeServiceError.failedToRecordProvisioningError(
                    original: summary,
                    registry: registryError.localizedDescription
                )
            }
            throw error
        }
    }

    /// Inspects only the mapped path. A missing mapped worktree never falls back
    /// to the root repository even when a root `.gdm/<slug>` happens to exist.
    func inspect(_ record: WorkspaceRegistryRecord) -> WorktreeInspection {
        do {
            let document = try validateMappedWorkspace(record)
            return WorktreeInspection(
                record: record,
                health: .ready,
                document: document,
                message: nil
            )
        } catch {
            let health: WorkspaceHealth
            if !WorkspaceRegistry.pathExistsIncludingDanglingSymlink(record.worktreePath) {
                health = .disconnected
            } else if let pathError = error as? WorkspaceStatePathValidationError,
                      pathError.isUnsafeType {
                health = .conflicted
            } else if record.phase == .creating {
                health = .creating
            } else if record.phase == .failed {
                health = .failed
            } else {
                health = .conflicted
            }
            return WorktreeInspection(
                record: record,
                health: health,
                document: nil,
                message: error.localizedDescription
            )
        }
    }

    /// Revalidates Git identity and the no-follow state boundary from disk.
    /// Mutation callers invoke this immediately before every mapped GDM command.
    func validateMappedWorkspace(_ record: WorkspaceRegistryRecord) throws -> WorkDocument {
        _ = try verifyGitArtifacts(for: record)
        return try decodeChecks(for: record)
    }

    /// Promotes preserved creating/failed records only when Git identity and the
    /// exact worktree-local checks document are already complete and valid.
    /// Incomplete or conflicting artifacts are retained without modification.
    func recoverProvisioning() throws -> [WorktreeRecoveryResult] {
        let snapshot = try registry.load()
        var results: [WorktreeRecoveryResult] = []
        for record in snapshot.tasks where record.phase != .ready {
            let inspection = inspect(record)
            guard inspection.health == .ready, inspection.document != nil else {
                results.append(
                    WorktreeRecoveryResult(
                        record: record,
                        health: inspection.health,
                        promotedToReady: false,
                        message: inspection.message
                    )
                )
                continue
            }
            let updated = try registry.markReady(id: record.id, select: false)
            results.append(
                WorktreeRecoveryResult(
                    record: updated,
                    health: .ready,
                    promotedToReady: true,
                    message: nil
                )
            )
        }
        return results
    }

    func destinationURL(for slug: String) -> URL {
        worktreeContainerURL.appendingPathComponent(slug, isDirectory: true).standardizedFileURL
    }

    private var worktreeContainerURL: URL {
        repositoryURL
            .deletingLastPathComponent()
            .appendingPathComponent("\(repositoryURL.lastPathComponent)-worktrees", isDirectory: true)
            .standardizedFileURL
    }

    private func validate(_ request: WorktreeProvisioningRequest) throws {
        let slugPattern = try NSRegularExpression(pattern: "^[a-z0-9][a-z0-9-]{1,50}$")
        let range = NSRange(request.slug.startIndex..<request.slug.endIndex, in: request.slug)
        guard slugPattern.firstMatch(in: request.slug, range: range)?.range == range else {
            throw WorktreeServiceError.invalidSlug(request.slug)
        }
        guard !request.brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw WorktreeServiceError.emptyBrief
        }
        guard ["low", "medium", "high"].contains(request.risk) else {
            throw WorktreeServiceError.invalidRisk(request.risk)
        }
        guard ["deterministic", "inspectable", "opaque"].contains(request.verification) else {
            throw WorktreeServiceError.invalidVerification(request.verification)
        }
        if let empty = (request.required + request.forbidden).first(where: {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }) {
            throw WorktreeServiceError.invalidConstraint("빈 require/forbid 값은 사용할 수 없습니다: \(empty)")
        }
    }

    private func resolveGDMInvocation() throws -> CommandInvocation {
        if let injectedGDMInvocation {
            return injectedGDMInvocation
        }

        let compiled = repositoryURL.appendingPathComponent("cli/dist/gdm", isDirectory: false)
        if FileManager.default.isExecutableFile(atPath: compiled.path) {
            return CommandInvocation(executable: compiled.path, prefixArguments: [])
        }

        let source = repositoryURL.appendingPathComponent("cli/src/cli.ts", isDirectory: false)
        if FileManager.default.fileExists(atPath: source.path) {
            return CommandInvocation(
                executable: "/usr/bin/env",
                prefixArguments: ["bun", source.path]
            )
        }

        throw WorktreeServiceError.gdmUnavailable(repositoryURL.path)
    }

    private func preflight(
        request: WorktreeProvisioningRequest,
        destination: URL,
        branchRef: String,
        registryDocument: WorkspaceRegistryDocument
    ) throws {
        if registryDocument.tasks.contains(where: { $0.slug == request.slug }) {
            throw WorktreeServiceError.registryCollision("slug \(request.slug)")
        }
        if registryDocument.tasks.contains(where: { $0.branch == branchRef }) {
            throw WorktreeServiceError.registryCollision("branch \(branchRef)")
        }
        let destinationPath = WorkspaceRegistry.normalizedPath(destination.path)
        if registryDocument.tasks.contains(where: {
            WorkspaceRegistry.normalizedPath($0.worktreePath) == destinationPath
        }) {
            throw WorktreeServiceError.registryCollision("path \(destination.path)")
        }

        let legacyPath = repositoryURL
            .appendingPathComponent(".gdm", isDirectory: true)
            .appendingPathComponent(request.slug, isDirectory: true)
        if WorkspaceRegistry.pathExistsIncludingDanglingSymlink(legacyPath.path) {
            throw WorktreeServiceError.legacyCollision(request.slug)
        }

        if WorkspaceRegistry.pathExistsIncludingDanglingSymlink(destination.path) {
            throw WorktreeServiceError.destinationCollision(destination.path)
        }
        try validateContainerIfPresent()

        let branch = runner.run(
            executable: gitExecutable,
            arguments: ["show-ref", "--verify", "--quiet", branchRef],
            directory: repositoryURL
        )
        if branch.exitCode == 0 {
            throw WorktreeServiceError.branchCollision(branchRef)
        }
        if branch.exitCode != 1 {
            throw WorktreeServiceError.commandFailed(
                command: "git show-ref",
                exitCode: branch.exitCode,
                output: Self.boundedOutput(branch.output)
            )
        }

        let list = try runGit(["worktree", "list", "--porcelain", "-z"], command: "git worktree list")
        for entry in Self.parseWorktreeList(list) {
            if WorkspaceRegistry.normalizedPath(entry.path) == destinationPath {
                throw WorktreeServiceError.gitWorktreeCollision("path \(destination.path)")
            }
            if entry.branch == branchRef {
                throw WorktreeServiceError.gitWorktreeCollision("branch \(branchRef)")
            }
        }
    }

    private func inspectRootRepository() throws -> RootRepositoryIdentity {
        let topLevel = try runGit(["rev-parse", "--show-toplevel"], command: "git rev-parse --show-toplevel")
        let actualRoot = Self.absoluteURL(fromGitOutput: topLevel, relativeTo: repositoryURL)
        let expectedRoot = repositoryURL.resolvingSymlinksInPath().standardizedFileURL
        guard actualRoot.path == expectedRoot.path else {
            throw WorktreeServiceError.repositoryMismatch(
                expected: expectedRoot.path,
                actual: actualRoot.path
            )
        }
        let headOID = try runGit(
            ["rev-parse", "--verify", "HEAD^{commit}"],
            command: "git rev-parse HEAD"
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !headOID.isEmpty else {
            throw WorktreeServiceError.verificationFailed("HEAD commit OID가 비어 있습니다")
        }
        let common = try runGit(
            ["rev-parse", "--git-common-dir"],
            command: "git rev-parse --git-common-dir"
        )
        return RootRepositoryIdentity(
            headOID: headOID,
            commonDirectory: Self.absoluteURL(fromGitOutput: common, relativeTo: repositoryURL)
        )
    }

    private func createWorktreeContainer() throws {
        try FileManager.default.createDirectory(
            at: worktreeContainerURL,
            withIntermediateDirectories: true
        )
        try validateContainerIfPresent()
    }

    private func validateContainerIfPresent() throws {
        guard WorkspaceRegistry.pathExistsIncludingDanglingSymlink(worktreeContainerURL.path) else {
            return
        }
        do {
            try WorkspaceStatePathBoundary.validateWorkspaceDirectory(worktreeContainerURL)
        } catch {
            throw WorktreeServiceError.destinationCollision(worktreeContainerURL.path)
        }
    }

    @discardableResult
    private func verifyGitArtifacts(
        for record: WorkspaceRegistryRecord,
        requireBaseOID: Bool = false
    ) throws -> URL {
        let worktree = URL(fileURLWithPath: record.worktreePath, isDirectory: true).standardizedFileURL
        do {
            try WorkspaceStatePathBoundary.validateWorkspaceDirectory(worktree)
        } catch {
            throw WorktreeServiceError.verificationFailed(error.localizedDescription)
        }

        let topLevel = try runGit(
            ["rev-parse", "--show-toplevel"],
            command: "git rev-parse --show-toplevel",
            directory: worktree
        )
        let actualTopLevel = Self.absoluteURL(fromGitOutput: topLevel, relativeTo: worktree)
        let expectedTopLevel = worktree.resolvingSymlinksInPath().standardizedFileURL
        guard actualTopLevel.path == expectedTopLevel.path else {
            throw WorktreeServiceError.verificationFailed(
                "top-level 불일치 (기대: \(expectedTopLevel.path), 실제: \(actualTopLevel.path))"
            )
        }

        let actualBranch = try runGit(
            ["symbolic-ref", "--quiet", "HEAD"],
            command: "git symbolic-ref HEAD",
            directory: worktree
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        guard actualBranch == record.branch else {
            throw WorktreeServiceError.verificationFailed(
                "branch 불일치 (기대: \(record.branch), 실제: \(actualBranch))"
            )
        }

        if requireBaseOID {
            let actualOID = try runGit(
                ["rev-parse", "--verify", "HEAD^{commit}"],
                command: "git rev-parse HEAD",
                directory: worktree
            ).trimmingCharacters(in: .whitespacesAndNewlines)
            guard actualOID == record.baseOID else {
                throw WorktreeServiceError.verificationFailed(
                    "base OID 불일치 (기대: \(record.baseOID), 실제: \(actualOID))"
                )
            }
        }

        let common = try runGit(
            ["rev-parse", "--git-common-dir"],
            command: "git rev-parse --git-common-dir",
            directory: worktree
        )
        let actualCommon = Self.absoluteURL(fromGitOutput: common, relativeTo: worktree)
        let expectedCommon = URL(fileURLWithPath: record.gitCommonDirectory, isDirectory: true)
            .resolvingSymlinksInPath()
            .standardizedFileURL
        guard actualCommon.path == expectedCommon.path else {
            throw WorktreeServiceError.verificationFailed(
                "git common directory 불일치 (기대: \(expectedCommon.path), 실제: \(actualCommon.path))"
            )
        }
        return worktree
    }

    private func decodeChecks(for record: WorkspaceRegistryRecord) throws -> WorkDocument {
        let worktree = URL(fileURLWithPath: record.worktreePath, isDirectory: true)
        do {
            let paths = try WorkspaceStatePathBoundary.validate(
                workspaceURL: worktree,
                slug: record.slug,
                requirement: .checksRequired
            )
            let document = try JSONDecoder().decode(
                WorkDocument.self,
                from: Data(contentsOf: paths.checksFile)
            )
            guard document.slug == record.slug else {
                throw WorktreeServiceError.checksInvalid(
                    "디렉터리 slug(\(record.slug))와 문서 slug(\(document.slug))가 다릅니다"
                )
            }
            return document
        } catch let error as WorkspaceStatePathValidationError {
            throw error
        } catch let error as WorktreeServiceError {
            throw error
        } catch {
            throw WorktreeServiceError.checksInvalid(error.localizedDescription)
        }
    }

    private func planInitArguments(for request: WorktreeProvisioningRequest) -> [String] {
        var arguments = [
            "plan", "init",
            "--slug", request.slug,
            "--brief", request.brief,
            "--risk", request.risk,
            "--verification", request.verification
        ]
        for value in request.required {
            arguments += ["--require", value]
        }
        for value in request.forbidden {
            arguments += ["--forbid", value]
        }
        if request.auditRequired { arguments.append("--audit") }
        if request.simplificationRequired { arguments.append("--simplify") }
        return arguments
    }

    private func runGit(
        _ arguments: [String],
        command: String,
        directory: URL? = nil
    ) throws -> String {
        let result = runner.run(
            executable: gitExecutable,
            arguments: arguments,
            directory: directory ?? repositoryURL
        )
        guard result.exitCode == 0 else {
            throw WorktreeServiceError.commandFailed(
                command: command,
                exitCode: result.exitCode,
                output: Self.boundedOutput(result.output)
            )
        }
        return result.output
    }

    private static func absoluteURL(fromGitOutput output: String, relativeTo directory: URL) -> URL {
        let path = output.trimmingCharacters(in: .whitespacesAndNewlines)
        let url: URL
        if (path as NSString).isAbsolutePath {
            url = URL(fileURLWithPath: path, isDirectory: true)
        } else {
            url = directory.appendingPathComponent(path, isDirectory: true)
        }
        return url.resolvingSymlinksInPath().standardizedFileURL
    }

    private static func parseWorktreeList(_ output: String) -> [GitWorktreeEntry] {
        var entries: [GitWorktreeEntry] = []
        var path: String?
        var branch: String?
        for field in output.split(separator: "\0", omittingEmptySubsequences: false) {
            if field.isEmpty {
                if let path {
                    entries.append(GitWorktreeEntry(path: path, branch: branch))
                }
                path = nil
                branch = nil
            } else if field.hasPrefix("worktree ") {
                path = String(field.dropFirst("worktree ".count))
            } else if field.hasPrefix("branch ") {
                branch = String(field.dropFirst("branch ".count))
            }
        }
        if let path {
            entries.append(GitWorktreeEntry(path: path, branch: branch))
        }
        return entries
    }

    private static func boundedOutput(_ output: String) -> String {
        String(output.prefix(4_000))
    }

    private static func registryFailureSummary(_ error: Error) -> String {
        guard let serviceError = error as? WorktreeServiceError else {
            return "provisioning failed (\(String(describing: type(of: error))))"
        }
        switch serviceError {
        case .commandFailed(let command, let exitCode, _):
            return "\(command) failed (exit \(exitCode))"
        case .verificationFailed:
            return "worktree verification failed"
        case .checksMissing:
            return "checks.json missing"
        case .checksInvalid:
            return "checks.json invalid"
        default:
            return "provisioning failed"
        }
    }
}

private struct RootRepositoryIdentity {
    let headOID: String
    let commonDirectory: URL
}

private struct GitWorktreeEntry {
    let path: String
    let branch: String?
}
