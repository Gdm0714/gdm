import Foundation

struct DemoWorkspace: Sendable {
    let works: [WorkDocument]
    let mappedRecords: [String: WorkspaceRegistryRecord]
    let selectedSlug: String?
    let taskStates: [String: TaskDisplayState]
    let runningCheckID: String?
    let failedCheckIDs: Set<String>
    let sessionState: SessionDisplayState
    let console: String
    let diff: String
    let journal: String
}

enum DemoData {
    static let agentActivityReferenceDate: Date = {
        ISO8601DateFormatter().date(from: "2026-08-07T13:34:12Z")
            ?? Date(timeIntervalSince1970: 0)
    }()

    static func workspace(state: String?) -> DemoWorkspace {
        if state == "empty" {
            return DemoWorkspace(
                works: [],
                mappedRecords: [:],
                selectedSlug: nil,
                taskStates: [:],
                runningCheckID: nil,
                failedCheckIDs: [],
                sessionState: .ready,
                console: "",
                diff: "",
                journal: ""
            )
        }

        if state == "worktree-loop" || state == "worktree-loop-proof" {
            return worktreeLoopWorkspace
        }

        let selectedState = taskState(for: state)
        let selected = loginWork(state: state)
        let tasks = [selected, provenWork, shellWork, releaseWork]
        let running = state == nil || state == "verifying" ? "c3" : nil
        let failed: Set<String> = state == "failed-check" ? ["c3"] : []

        return DemoWorkspace(
            works: tasks,
            mappedRecords: [:],
            selectedSlug: selected.slug,
            taskStates: [
                selected.slug: selectedState,
                provenWork.slug: .proven,
                shellWork.slug: .working,
                releaseWork.slug: .waitingCI
            ],
            runningCheckID: running,
            failedCheckIDs: failed,
            sessionState: sessionState(for: state),
            console: """
            $ bun test cli/test/session.test.ts
            bun test v1.1.30
            17 pass
            1 fail

            FAIL refreshes an expired session and retries once
            Expected request count: 2
            Received request count: 3

            agent · 재시도 경로에서 refresh 요청까지 일반 API 요청으로 계산되고 있습니다.
            agent · 수정 범위: cli/src/session.ts, cli/test/session.test.ts

            $
            """,
            diff: """
            M cli/src/session.ts
            M cli/src/auth.ts
            M cli/test/session.test.ts

            @@ -48,7 +48,11 @@ export async function withSession(
            - if (isExpired(token)) await refresh();
            + if (isExpired(token)) {
            +   await refresh({ countAsRequest: false });
            +   return retryOnce(command);
            + }
            """,
            journal: """
            2026-08-07T12:34:12Z  check c1  red evidence captured  sha 7a44d0e9…
            2026-08-07T12:41:33Z  check c2  proven                sha 2f91ca42…
            2026-08-07T12:49:01Z  check c3  started               bun test cli
            """
        )
    }

    private static var worktreeLoopWorkspace: DemoWorkspace {
        let record = WorkspaceRegistryRecord(
            id: UUID(uuidString: "3DC94F67-3CF7-4BCA-A71F-799027EC6C9F")!,
            slug: worktreeWork.slug,
            worktreePath: "/Users/godongmin/projects/gdm-worktrees/native-agent-loop",
            branch: "refs/heads/gdm/native-agent-loop",
            baseOID: "cb044a4",
            gitCommonDirectory: "/Users/godongmin/projects/gdm/.git",
            phase: .ready,
            selectedAgent: AgentKind.claude.rawValue,
            lastSession: PersistedSessionRecord(
                kind: AgentKind.claude.rawValue,
                startedAt: timestamp,
                endedAt: nil,
                outcome: .active
            ),
            lastError: nil,
            createdAt: timestamp
        )
        return DemoWorkspace(
            works: [worktreeWork, provenWork, shellWork, releaseWork],
            mappedRecords: [worktreeWork.slug: record],
            selectedSlug: worktreeWork.slug,
            taskStates: [
                worktreeWork.slug: .working,
                provenWork.slug: .proven,
                shellWork.slug: .working,
                releaseWork.slug: .waitingCI
            ],
            runningCheckID: nil,
            failedCheckIDs: [],
            sessionState: .running,
            console: """
            Claude Code · interactive PTY
            cwd  /Users/godongmin/projects/gdm-worktrees/native-agent-loop
            branch  gdm/native-agent-loop

            > Implement the next open check and keep the proof local to this worktree.

            ● I found the PTY lifecycle boundary. I am updating the focused tests first.
            ● c1 red evidence is preserved in .gdm/native-agent-loop/evidence/.

            ▌
            """,
            diff: """
            M native/Sources/GDMNative/TerminalSession.swift
            M native/Sources/GDMNative/WorkspaceStore.swift
            A native/Tests/GDMNativeTests/AgentLaunchIntegrationTests.swift

            @@ -88,6 +88,9 @@ final class WorkspaceStore {
            + let directory = task.workingDirectory
            + let session = terminalSessions.start(taskID: task.id, specification: spec)
            + persistSession(task: task, outcome: .active)
            """,
            journal: """
            2026-08-07T12:34:12Z  worktree  ready     refs/heads/gdm/native-agent-loop
            2026-08-07T12:36:04Z  agent     claude    interactive PTY attached
            2026-08-07T12:41:33Z  check c1  red       evidence saved in task worktree
            """
        )
    }

    private static func sessionState(for state: String?) -> SessionDisplayState {
        switch state {
        case "waiting-input": .waitingInput
        case "disconnected": .disconnected
        case "reconnecting": .reconnecting
        default: .ready
        }
    }

    private static func taskState(for state: String?) -> TaskDisplayState {
        switch state {
        case "working": .working
        case "waiting-input": .waitingInput
        case "failed-check": .blocked
        case "all-proven": .proven
        case "audit-required": .blocked
        case "audit-rejected": .rejected
        case "disconnected", "reconnecting": .disconnected
        default: .verifying
        }
    }

    private static func loginWork(state: String?) -> WorkDocument {
        let allProven = state == "all-proven"
        let auditRequired = state == "audit-required" || state == "audit-rejected"
        let audit: AuditRecord? = state == "audit-rejected"
            ? AuditRecord(result: "fail", report: "재시도 횟수의 경계 조건 증거가 부족합니다.", at: timestamp)
            : nil

        return WorkDocument(
            slug: "fix-login-regression",
            brief: "로그인 세션이 만료된 상태에서 명령을 실행하면 토큰을 갱신하고 원래 명령을 한 번만 재시도한다.",
            createdAt: timestamp,
            done: allProven,
            doneAt: allProven ? timestamp : nil,
            auditRequired: auditRequired,
            audit: audit,
            delivery: DeliveryRecord(
                issue: "142",
                branch: "fix/login-regression",
                head: "28a73ef",
                preparedAt: timestamp,
                pr: nil,
                ci: nil,
                mergeApproval: nil,
                merged: nil
            ),
            checks: [
                check(
                    id: "c1",
                    desc: "로그인 회귀 재현",
                    command: "bun test cli/test/session.test.ts",
                    kind: "regression",
                    proven: allProven,
                    red: evidence(sha: "7a44d0e9", exitCode: 1),
                    proof: allProven ? evidence(sha: "c2e11a92", exitCode: 0) : nil
                ),
                check(
                    id: "c2",
                    desc: "만료된 세션을 한 번만 갱신",
                    command: "bun test cli/test/session.test.ts -t \"refreshes once\"",
                    kind: "behavior",
                    proven: true,
                    proof: evidence(sha: "2f91ca42", exitCode: 0)
                ),
                check(
                    id: "c3",
                    desc: "전체 CLI 테스트",
                    command: "bun test cli",
                    kind: "behavior",
                    proven: allProven,
                    proof: allProven ? evidence(sha: "9f3b21ae", exitCode: 0) : nil
                ),
                check(
                    id: "c4",
                    desc: "범위 밖 변경 없음",
                    command: "git diff --check && git status --short",
                    kind: "static",
                    proven: allProven,
                    proof: allProven ? evidence(sha: "aa78409b", exitCode: 0) : nil
                )
            ],
            contract: contract(risk: auditRequired ? "high" : "medium")
        )
    }

    private static let provenWork = WorkDocument(
        slug: "agent-delegation-gate",
        brief: "에이전트 위임은 명시된 역할과 예산 경계 안에서만 실행한다.",
        createdAt: timestamp,
        done: true,
        doneAt: timestamp,
        auditRequired: false,
        audit: nil,
        delivery: nil,
        checks: (1...5).map { index in
            check(
                id: "c\(index)",
                desc: "위임 게이트 \(index)",
                command: "bun test delegation",
                kind: "behavior",
                proven: true,
                proof: evidence(sha: "agent\(index)", exitCode: 0)
            )
        },
        contract: contract(risk: "medium")
    )

    private static let shellWork = WorkDocument(
        slug: "native-workspace-shell",
        brief: "실제 gdm 상태를 읽는 macOS 워크스페이스를 만든다.",
        createdAt: timestamp,
        done: false,
        doneAt: nil,
        auditRequired: false,
        audit: nil,
        delivery: nil,
        checks: (1...4).map { index in
            check(
                id: "c\(index)",
                desc: "네이티브 셸 확인 \(index)",
                command: "swift test",
                kind: "behavior",
                proven: index == 1,
                proof: index == 1 ? evidence(sha: "native1", exitCode: 0) : nil
            )
        },
        contract: contract(risk: "medium")
    )

    private static let worktreeWork = WorkDocument(
        slug: "native-agent-loop",
        brief: "작업별 worktree에서 Codex, Claude, Gemini를 interactive PTY로 실행하고 같은 위치의 GDM 증거를 Proof Rail에 연결한다.",
        createdAt: timestamp,
        done: false,
        doneAt: nil,
        auditRequired: true,
        audit: nil,
        delivery: nil,
        checks: (1...6).map { index in
            check(
                id: "c\(index)",
                desc: [
                    "interactive PTY regression",
                    "worktree to Proof Rail loop",
                    "agent launch cwd and argv",
                    "restart and process safety",
                    "full native QA",
                    "native surface inspection"
                ][index - 1],
                command: index == 6 ? "manual surface inspection" : "swift test --filter native-agent-loop-c\(index)",
                kind: index == 1 ? "regression" : "behavior",
                proven: index <= 2,
                red: index == 1 ? evidence(sha: "pty-red-01", exitCode: 1) : nil,
                proof: index <= 2 ? evidence(sha: "worktree-\(index)", exitCode: 0) : nil
            )
        },
        contract: contract(risk: "high")
    )

    private static let releaseWork = WorkDocument(
        slug: "release-v0.9.2",
        brief: "검증된 변경을 릴리스한다.",
        createdAt: timestamp,
        done: false,
        doneAt: nil,
        auditRequired: false,
        audit: nil,
        delivery: nil,
        checks: (1...6).map { index in
            check(
                id: "c\(index)",
                desc: "릴리스 확인 \(index)",
                command: "bun run verify",
                kind: "static",
                proven: true,
                proof: evidence(sha: "release\(index)", exitCode: 0)
            )
        },
        contract: contract(risk: "medium")
    )

    private static let timestamp = "2026-08-07T12:34:12.000Z"

    private static func contract(risk: String) -> WorkContractRecord {
        WorkContractRecord(
            required: ["기존 동작 보존", "결정적 증거 기록"],
            forbidden: ["자동 커밋"],
            commit: "forbidden",
            risk: risk,
            verification: "deterministic"
        )
    }

    private static func evidence(sha: String, exitCode: Int) -> EvidenceRecord {
        EvidenceRecord(
            observed: exitCode == 0 ? "exit 0" : "회귀 실패 재현",
            sha256: sha,
            exitCode: exitCode,
            manual: false,
            note: nil,
            reviewer: nil,
            at: timestamp
        )
    }

    private static func check(
        id: String,
        desc: String,
        command: String,
        kind: String,
        proven: Bool,
        red: EvidenceRecord? = nil,
        proof: EvidenceRecord? = nil
    ) -> CheckRecord {
        CheckRecord(
            id: id,
            desc: desc,
            cmd: command,
            expect: "exit 0",
            manual: false,
            kind: kind,
            expert: false,
            status: proven ? "proven" : "open",
            redEvidence: red,
            evidence: proof
        )
    }
}
