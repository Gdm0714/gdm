import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const roots: string[] = [];
const OUTCOME = {
  bottleneck: "검증 피드백 지연",
  desiredOutcome: "회귀 검토 시간 단축",
  baseline: "주당 4건",
  target: "주당 1건",
  unit: "회귀 후보 수",
  interveneIf: "주당 3건 초과",
} as const;
const OUTCOME_ARGS = [
  "--bottleneck", OUTCOME.bottleneck,
  "--desired-outcome", OUTCOME.desiredOutcome,
  "--baseline", OUTCOME.baseline,
  "--target", OUTCOME.target,
  "--unit", OUTCOME.unit,
  "--intervene-if", OUTCOME.interveneIf,
] as const;

setDefaultTimeout(15_000);

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function tempRepository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "gdm-protocol-"));
  roots.push(cwd);
  const initialized = Bun.spawnSync(["git", "init", "-q"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(initialized.exitCode).toBe(0);
  writeFileSync(join(cwd, "src.txt"), "stable source\n");
  return cwd;
}

function runCli(cwd: string, args: readonly string[]): CliResult {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function initializeWork(cwd: string, extraPlanArgs: readonly string[] = []): void {
  const initialized = runCli(cwd, [
    "plan",
    "init",
    "--slug",
    "sample",
    "--brief",
    "두 모델이 같은 계약으로 작업",
    "--require",
    "기존 동작 보존",
    "--forbid",
    "자동 커밋",
    "--assume",
    "Git 저장소",
    "--uncertain",
    "외부 adapter는 후속 단계",
    "--allow-path",
    "src.txt",
    "--forbid-path",
    "vendor",
    "--stop-if",
    "계약을 보존할 수 없음",
    "--risk",
    "medium",
    "--verification",
    "inspectable",
    "--simplify",
    ...extraPlanArgs,
  ]);
  expect(initialized).toMatchObject({ exitCode: 0, stderr: "" });
  const added = runCli(cwd, [
    "plan",
    "add",
    "--slug",
    "sample",
    "--desc",
    "source 확인",
    "--cmd",
    "test -f src.txt",
    "--expect",
    "exit 0",
    "--kind",
    "behavior",
  ]);
  expect(added).toMatchObject({ exitCode: 0, stderr: "" });
}

function journalEvents(cwd: string): Record<string, any>[] {
  return readFileSync(join(cwd, ".gdm", "sample", "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function protocolEvents(cwd: string): Record<string, any>[] {
  return journalEvents(cwd).filter((event) => event.event === "protocol_handoff");
}

function exportSnapshot(cwd: string): Record<string, any> {
  const result = runCli(cwd, ["protocol", "export", "--slug", "sample"]);
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  return JSON.parse(result.stdout) as Record<string, any>;
}

function handoffArgs(
  id: string,
  intent: string,
  extra: readonly string[] = [],
): string[] {
  return [
    "protocol",
    "handoff",
    "--slug",
    "sample",
    "--handoff-id",
    id,
    "--from-role",
    "implementer",
    "--from-provider",
    "codex",
    "--to-role",
    "auditor",
    "--to-provider",
    "claude",
    "--intent",
    intent,
    ...extra,
  ];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("work protocol CLI", () => {
  test("exports a deterministic actionable snapshot", () => {
    const cwd = tempRepository();
    initializeWork(cwd);

    const first = runCli(cwd, ["protocol", "export", "--slug", "sample"]);
    const second = runCli(cwd, ["protocol", "export", "--slug", "sample"]);

    expect(first).toMatchObject({ exitCode: 0, stderr: "" });
    expect(second).toMatchObject({ exitCode: 0, stderr: "" });
    expect(second.stdout).toBe(first.stdout);

    const snapshot = JSON.parse(first.stdout) as Record<string, any>;
    const guarded = runCli(cwd, [
      "protocol",
      "export",
      "--slug",
      "sample",
      "--expected-plan-fingerprint",
      snapshot.work.planFingerprint,
      "--expected-state-fingerprint",
      snapshot.work.stateFingerprint,
      "--expected-source-fingerprint",
      snapshot.work.sourceFingerprint.sha256,
    ]);
    expect(guarded).toMatchObject({ exitCode: 0, stderr: "", stdout: first.stdout });
    expect(snapshot.schemaVersion).toBe("gdm-work-snapshot/v1");
    expect(snapshot.work).toMatchObject({
      slug: "sample",
      brief: "두 모델이 같은 계약으로 작업",
      doneAt: null,
      phase: "executing",
      planSourceFingerprint: null,
    });
    expect(snapshot.work.planFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(snapshot.work.stateFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(snapshot.work.sourceFingerprint).toMatchObject({ schemaVersion: 1 });
    expect(snapshot.contract).toMatchObject({
      required: ["기존 동작 보존"],
      forbidden: ["자동 커밋"],
      assumptions: ["Git 저장소"],
      uncertainties: ["외부 adapter는 후속 단계"],
      allowedPaths: ["src.txt"],
      forbiddenPaths: ["vendor"],
      stopConditions: ["계약을 보존할 수 없음"],
      risk: "medium",
      verification: "inspectable",
      simplificationRequired: true,
      activeHabits: [],
      commit: { state: "forbidden", latestTransition: null },
      scopeAmendments: [],
    });
    expect(Object.hasOwn(snapshot.contract, "outcome")).toBe(false);
    expect(snapshot.checks).toEqual([
      {
        id: "c1",
        kind: "behavior",
        description: "source 확인",
        status: "open",
        command: "test -f src.txt",
        expect: "exit 0",
        manual: false,
        expert: false,
        redEvidence: null,
        evidence: null,
      },
    ]);
    expect(snapshot.audit).toEqual({ required: false, state: "not-required", record: null });
    expect(snapshot.completion.state).toBe("blocked");
    expect(snapshot.completion.blockers.map((entry: { code: string }) => entry.code)).toEqual([
      "unproven",
      "simplification_required",
    ]);
    expect(snapshot.completion.validationCommand).toBe("gdm done --slug sample");
    expect(snapshot.latestHandoff).toBeNull();
  });

  test("exports the complete declared outcome from CLI-owned Work state", () => {
    const cwd = tempRepository();
    initializeWork(cwd, OUTCOME_ARGS);

    const snapshot = exportSnapshot(cwd);
    expect(snapshot.contract.outcome).toEqual(OUTCOME);
    const persisted = JSON.parse(
      readFileSync(join(cwd, ".gdm", "sample", "checks.json"), "utf8"),
    ) as Record<string, any>;
    expect(persisted.contract.outcome).toEqual(OUTCOME);
  });

  test("records idempotent causal handoffs and reports staleness", () => {
    const cwd = tempRepository();
    initializeWork(cwd);
    writeFileSync(join(cwd, "handoff.md"), "review only this artifact\n");

    const before = exportSnapshot(cwd);
    const expected = [
      "--expected-plan-fingerprint",
      before.work.planFingerprint,
      "--expected-state-fingerprint",
      before.work.stateFingerprint,
      "--expected-source-fingerprint",
      before.work.sourceFingerprint.sha256,
    ];
    const args = handoffArgs("implementation-to-audit-1", "검증 항목과 diff를 독립 검수", [
      "--artifact",
      "handoff.md",
      ...expected,
    ]);
    const first = runCli(cwd, args);
    expect(first).toMatchObject({ exitCode: 0, stderr: "" });
    const event = JSON.parse(first.stdout) as Record<string, any>;
    expect(event).toMatchObject({
      schemaVersion: "gdm-handoff/v1",
      event: "protocol_handoff",
      handoffId: "implementation-to-audit-1",
      revision: 1,
      predecessorEventId: null,
      slug: "sample",
      from: { role: "implementer", provider: "codex" },
      to: { role: "auditor", provider: "claude" },
      intent: "검증 항목과 diff를 독립 검수",
      artifact: {
        path: "handoff.md",
        sha256: createHash("sha256").update("review only this artifact\n").digest("hex"),
      },
      planFingerprint: before.work.planFingerprint,
      stateFingerprint: before.work.stateFingerprint,
      sourceFingerprint: before.work.sourceFingerprint.sha256,
    });
    expect(event.eventId).toMatch(/^h-[0-9a-f]{16}$/u);

    const replay = runCli(cwd, args);
    expect(replay).toMatchObject({ exitCode: 0, stderr: "", stdout: first.stdout });
    expect(protocolEvents(cwd)).toHaveLength(1);
    expect(JSON.stringify(protocolEvents(cwd))).not.toContain("review only this artifact");

    const conflict = runCli(
      cwd,
      handoffArgs("implementation-to-audit-1", "다른 의미로 같은 id 재사용"),
    );
    expect(conflict.exitCode).toBe(3);
    expect(conflict.stderr).toContain("오류(handoff_id_conflict)");
    expect(protocolEvents(cwd)).toHaveLength(1);

    const second = runCli(
      cwd,
      handoffArgs("audit-to-implementation-1", "독립 검수 결과를 구현자에게 전달"),
    );
    expect(second).toMatchObject({ exitCode: 0, stderr: "" });
    const secondEvent = JSON.parse(second.stdout) as Record<string, any>;
    expect(secondEvent.revision).toBe(2);
    expect(secondEvent.predecessorEventId).toBe(event.eventId);
    expect(protocolEvents(cwd)).toHaveLength(2);

    const fresh = exportSnapshot(cwd);
    expect(fresh.latestHandoff).toMatchObject({
      eventId: secondEvent.eventId,
      revision: 2,
      stale: false,
      staleReasons: [],
    });

    const passed = runCli(cwd, ["pass", "c1", "--slug", "sample"]);
    expect(passed.exitCode).toBe(0);
    const stateStale = exportSnapshot(cwd);
    expect(stateStale.latestHandoff.stale).toBe(true);
    expect(stateStale.latestHandoff.staleReasons).toEqual(["state_changed"]);

    const evidenceBound = runCli(
      cwd,
      handoffArgs("proven-evidence-bound", "통과 상태와 증거를 현재 인계에 결속"),
    );
    expect(evidenceBound).toMatchObject({ exitCode: 0, stderr: "" });
    const evidenceEvent = JSON.parse(evidenceBound.stdout) as Record<string, any>;
    expect(evidenceEvent).toMatchObject({
      revision: 3,
      predecessorEventId: secondEvent.eventId,
    });
    const refreshedEvidence = runCli(cwd, ["recheck", "--check", "c1", "--slug", "sample"]);
    expect(refreshedEvidence.exitCode).toBe(0);
    const evidenceStale = exportSnapshot(cwd);
    expect(evidenceStale.latestHandoff.staleReasons).toEqual(["state_changed"]);

    writeFileSync(join(cwd, "src.txt"), "changed source\n");
    const sourceStale = exportSnapshot(cwd);
    expect(sourceStale.latestHandoff.stale).toBe(true);
    expect(sourceStale.latestHandoff.staleReasons).toEqual(["state_changed", "source_changed"]);
  });

  test("rejects a persisted first handoff before Work creation", () => {
    const cwd = tempRepository();
    initializeWork(cwd);
    const args = handoffArgs("precreation-boundary", "최초 handoff 경계 검증");
    expect(runCli(cwd, args)).toMatchObject({ exitCode: 0, stderr: "" });

    const workPath = join(cwd, ".gdm", "sample", "checks.json");
    const work = JSON.parse(readFileSync(workPath, "utf8")) as Record<string, any>;
    const journalPath = join(cwd, ".gdm", "sample", "journal.jsonl");
    const events = journalEvents(cwd);
    const firstHandoff = events.find((event) => event.event === "protocol_handoff");
    expect(firstHandoff).toBeDefined();
    firstHandoff!.ts = new Date(Date.parse(work.createdAt) - 1).toISOString();
    writeFileSync(journalPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const corruptedJournal = readFileSync(journalPath, "utf8");

    const attempts = [
      runCli(cwd, ["protocol", "export", "--slug", "sample"]),
      runCli(cwd, args),
      runCli(cwd, handoffArgs("after-corruption", "손상된 journal 뒤 기록 시도")),
    ];
    for (const result of attempts) {
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("오류(state_corrupt)");
      expect(readFileSync(journalPath, "utf8")).toBe(corruptedJournal);
    }
  });

  test("allows a journal-only handoff after completion", () => {
    const cwd = tempRepository();
    initializeWork(cwd);
    const staticCheck = runCli(cwd, [
      "plan",
      "add",
      "--slug",
      "sample",
      "--desc",
      "단순화 확인",
      "--cmd",
      "test -f src.txt",
      "--expect",
      "exit 0",
      "--kind",
      "static",
    ]);
    expect(staticCheck.exitCode).toBe(0);
    expect(runCli(cwd, ["pass", "c1", "--slug", "sample"]).exitCode).toBe(0);
    expect(runCli(cwd, ["pass", "c2", "--slug", "sample"]).exitCode).toBe(0);
    expect(runCli(cwd, ["done", "--slug", "sample"]).exitCode).toBe(0);

    const beforeRepeatedDone = journalEvents(cwd);
    const repeatedDone = runCli(cwd, ["done", "--slug", "sample"]);
    expect(repeatedDone.exitCode).toBe(1);
    expect(repeatedDone.stderr).toContain("오류(work_done): 이미 완료된 작업입니다");
    const repeatedDoneEvents = journalEvents(cwd).slice(beforeRepeatedDone.length);
    expect(repeatedDoneEvents).toEqual([
      expect.objectContaining({
        event: "denied",
        action: "done",
        code: "work_done",
        message: "이미 완료된 작업입니다",
      }),
    ]);
    expect(repeatedDoneEvents.some((event) => event.event === "recheck")).toBe(false);

    const handoff = runCli(
      cwd,
      handoffArgs("completed-to-reader", "완료된 작업 상태를 읽기 전용으로 전달"),
    );
    expect(handoff).toMatchObject({ exitCode: 0, stderr: "" });
    const snapshot = exportSnapshot(cwd);
    expect(snapshot.work.phase).toBe("completed");
    expect(snapshot.completion).toMatchObject({
      state: "completed",
      validationCommand: null,
    });
    expect(snapshot.latestHandoff).toMatchObject({
      handoffId: "completed-to-reader",
      stale: false,
    });

    const persisted = JSON.parse(
      readFileSync(join(cwd, ".gdm", "sample", "checks.json"), "utf8"),
    ) as Record<string, any>;
    writeFileSync(join(cwd, persisted.checks[0].evidence.observed), "tampered completed evidence\n");
    const corruptExport = runCli(cwd, ["protocol", "export", "--slug", "sample"]);
    expect(corruptExport).toMatchObject({ exitCode: 2, stdout: "" });
    expect(corruptExport.stderr).toContain("오류(state_corrupt)");
  });

  test("completed audited work rejects a changed audit report during export", () => {
    const cwd = tempRepository();
    expect(runCli(cwd, [
      "plan", "init", "--slug", "sample", "--brief", "완료 audit 무결성", "--audit",
      "--require", "보고서 보존", "--forbid", "완료 후 변경",
    ])).toMatchObject({ exitCode: 0, stderr: "" });
    expect(runCli(cwd, [
      "plan", "add", "--slug", "sample", "--desc", "source 확인",
      "--cmd", "test -f src.txt", "--expect", "exit 0", "--kind", "behavior",
    ])).toMatchObject({ exitCode: 0, stderr: "" });
    expect(runCli(cwd, ["pass", "c1", "--slug", "sample"])).toMatchObject({ exitCode: 0, stderr: "" });
    const report = ".gdm/sample/audit-report.md";
    writeFileSync(join(cwd, report), "**판정: 통과**\nimplementationModel: Codex\nauditModel: Claude\n");
    expect(runCli(cwd, [
      "audit", "verdict", "--pass", "--report", report,
      "--implementation-model", "Codex", "--audit-model", "Claude", "--slug", "sample",
    ])).toMatchObject({ exitCode: 0, stderr: "" });
    expect(runCli(cwd, ["done", "--slug", "sample"])).toMatchObject({ exitCode: 0, stderr: "" });
    expect(exportSnapshot(cwd).work.phase).toBe("completed");

    writeFileSync(join(cwd, report), "changed\nimplementationModel: Codex\nauditModel: Claude\n");
    const corruptExport = runCli(cwd, ["protocol", "export", "--slug", "sample"]);
    expect(corruptExport).toMatchObject({ exitCode: 2, stdout: "" });
    expect(corruptExport.stderr).toContain("오류(state_corrupt)");
  });

  test("rejects credential-like values loaded from persisted work", () => {
    const cases: readonly {
      readonly name: string;
      readonly mutate: (persisted: Record<string, any>) => void;
    }[] = [
      {
        name: "brief",
        mutate: (persisted) => {
          persisted.brief = "Bearer definitely-secret-value";
        },
      },
      {
        name: "command",
        mutate: (persisted) => {
          persisted.checks[0].cmd = "printf Bearer definitely-secret-value";
        },
      },
      {
        name: "expectation",
        mutate: (persisted) => {
          persisted.checks[0].expect = "Bearer definitely-secret-value";
        },
      },
      {
        name: "reviewer",
        mutate: (persisted) => {
          persisted.checks[0].status = "proven";
          persisted.checks[0].evidence = {
            observed: ".gdm/sample/evidence/c1.out",
            sha256: "0".repeat(64),
            exitCode: 0,
            manual: false,
            reviewer: "Bearer definitely-secret-value",
            at: persisted.createdAt,
          };
        },
      },
      {
        name: "evidence path",
        mutate: (persisted) => {
          persisted.checks[0].status = "proven";
          persisted.checks[0].evidence = {
            observed: "Bearer definitely-secret-value",
            sha256: "0".repeat(64),
            exitCode: 0,
            manual: false,
            at: persisted.createdAt,
          };
        },
      },
    ];

    for (const current of cases) {
      const cwd = tempRepository();
      initializeWork(cwd);
      const workPath = join(cwd, ".gdm", "sample", "checks.json");
      const persisted = JSON.parse(readFileSync(workPath, "utf8")) as Record<string, any>;
      current.mutate(persisted);
      writeFileSync(workPath, JSON.stringify(persisted, null, 2) + "\n");

      const exported = runCli(cwd, ["protocol", "export", "--slug", "sample"]);
      expect(exported.exitCode, current.name).toBe(5);
      expect(exported.stdout, current.name).toBe("");
      expect(exported.stderr, current.name).toContain("오류(privacy_rejected)");
    }
  });

  test("rejects stale private or uncontained handoff input", () => {
    const cwd = tempRepository();
    initializeWork(cwd);
    writeFileSync(join(cwd, "artifact.md"), "safe artifact content\n");
    writeFileSync(join(cwd, "target.md"), "target content\n");
    symlinkSync("target.md", join(cwd, "artifact-link.md"));
    const snapshot = exportSnapshot(cwd);
    const wrong = "0".repeat(64);

    const lockPath = join(cwd, ".gdm.lock");
    symlinkSync("target.md", lockPath);
    try {
      const readWhileLocked = runCli(cwd, ["protocol", "export", "--slug", "sample"]);
      expect(readWhileLocked.exitCode).toBe(1);
      expect(readWhileLocked.stderr).toContain("오류(state_lock_rejected)");
      const statusWhileLocked = runCli(cwd, ["protocol", "status", "--slug", "sample"]);
      expect(statusWhileLocked.exitCode).toBe(1);
      expect(statusWhileLocked.stderr).toContain("오류(state_lock_rejected)");
      const lockedHandoff = runCli(cwd, handoffArgs("locked-handoff", "repository lock 확인"));
      expect(lockedHandoff.exitCode).toBe(1);
      expect(lockedHandoff.stderr).toContain("오류(state_lock_rejected)");
    } finally {
      unlinkSync(lockPath);
    }

    const staleInputs: readonly [string, string][] = [
      ["expected-plan-fingerprint", "plan_fingerprint_mismatch"],
      ["expected-state-fingerprint", "state_fingerprint_mismatch"],
      ["expected-source-fingerprint", "source_fingerprint_mismatch"],
    ];
    for (const [flag, code] of staleInputs) {
      const exported = runCli(cwd, [
        "protocol",
        "export",
        "--slug",
        "sample",
        `--${flag}`,
        wrong,
      ]);
      expect(exported.exitCode).toBe(4);
      expect(exported.stderr).toContain(`오류(${code})`);

      const result = runCli(
        cwd,
        handoffArgs(`stale-${flag}`, "지문 불일치 거부 확인", [`--${flag}`, wrong]),
      );
      expect(result.exitCode).toBe(4);
      expect(result.stderr).toContain(`오류(${code})`);
    }
    const malformed = runCli(
      cwd,
      handoffArgs("malformed-fingerprint", "지문 형식 거부 확인", [
        "--expected-state-fingerprint",
        "not-a-fingerprint",
      ]),
    );
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr).toContain("오류(usage)");

    const secret = runCli(
      cwd,
      handoffArgs("private-intent", "Bearer definitely-secret-value"),
    );
    expect(secret.exitCode).toBe(5);
    expect(secret.stderr).toContain("오류(privacy_rejected)");

    for (const [flag, value] of [
      ["from-role", "not a role"],
      ["from-provider", "bad/provider"],
      ["to-role", "not a role"],
      ["to-provider", "bad/provider"],
    ] as const) {
      const args = handoffArgs(`invalid-${flag}`, "opaque id 거부 확인");
      const index = args.indexOf(`--${flag}`);
      args[index + 1] = value;
      const result = runCli(cwd, args);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("오류(usage)");
    }

    for (const [id, artifact] of [
      ["absolute-artifact", join(cwd, "artifact.md")],
      ["traversal-artifact", "../artifact.md"],
      ["symlink-artifact", "artifact-link.md"],
      ["missing-artifact", "missing.md"],
    ] as const) {
      const result = runCli(cwd, handoffArgs(id, "artifact containment 확인", ["--artifact", artifact]));
      expect(result.exitCode).toBe(5);
      expect(result.stderr).toMatch(/오류\((?:path_rejected|privacy_rejected)\)/u);
    }

    expect(protocolEvents(cwd)).toHaveLength(0);
    expect(snapshot.work.planFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });
});
