import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type JsonObject = { readonly [key: string]: unknown };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runCli(cwd: string, args: readonly string[]): CliResult {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "gdm-contract-test-"));
}

function parseObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error("expected a JSON object");
  return value;
}

function readWork(cwd: string, slug = "sample"): JsonObject {
  return parseObject(readFileSync(join(cwd, ".gdm", slug, "checks.json"), "utf8"));
}

function objectField(value: JsonObject, key: string): JsonObject {
  const field = value[key];
  if (!isJsonObject(field)) throw new Error(`expected object field: ${key}`);
  return field;
}

function arrayField(value: JsonObject, key: string): readonly unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) throw new Error(`expected array field: ${key}`);
  return field;
}

function initArgs(slug = "sample"): readonly string[] {
  return [
    "plan",
    "init",
    "--slug",
    slug,
    "--brief",
    "계약 테스트",
    "--require",
    "기존 변경 보존",
    "--forbid",
    "자동 커밋",
  ];
}

function writeLegacyWork(cwd: string, proven = false): void {
  const dir = join(cwd, ".gdm", "legacy");
  mkdirSync(dir, { recursive: true });
  const checks = proven
    ? [
        {
          id: "c1",
          desc: "기존 검증",
          cmd: "true",
          expect: "exit 0",
          manual: false,
          status: "proven",
          evidence: {
            observed: "out/c1.txt",
            sha256: "legacy-hash",
            manual: false,
            at: "2026-07-01T00:00:00.000Z",
          },
        },
      ]
    : [];
  writeFileSync(
    join(dir, "checks.json"),
    `${JSON.stringify(
      {
        slug: "legacy",
        brief: "기존 작업",
        createdAt: "2026-07-01T00:00:00.000Z",
        done: false,
        checks,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "journal.jsonl"), "");
}

function stateBytes(cwd: string, slug: string): readonly [string, string] {
  const dir = join(cwd, ".gdm", slug);
  return [readFileSync(join(dir, "checks.json"), "utf8"), readFileSync(join(dir, "journal.jsonl"), "utf8")];
}

describe("work contract", () => {
  test("new work requires at least one explicit constraint", () => {
    // Given: an empty repository and a constraint-free plan request.
    const cwd = tempRepo();

    // When: plan init is invoked without required or forbidden intent.
    const result = runCli(cwd, ["plan", "init", "--slug", "sample", "--brief", "계약 없음"]);

    // Then: usage is rejected before any work state is created.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("constraint_required");
    expect(existsSync(join(cwd, ".gdm"))).toBe(false);
  });

  test("repeated constraints preserve order and trim values", () => {
    // Given: repeated required and forbidden constraints with surrounding spaces.
    const cwd = tempRepo();
    const result = runCli(cwd, [
      "plan",
      "init",
      "--slug",
      "sample",
      "--brief",
      "순서 테스트",
      "--require",
      "  기존 변경 보존  ",
      "--require",
      "검증 증거 남기기",
      "--forbid",
      "  자동 커밋  ",
      "--forbid",
      "원문 기록",
    ]);

    // When: the persisted contract is read.
    const contract = objectField(readWork(cwd), "contract");

    // Then: each list is ordered, trimmed, and delivery is forbidden by default.
    expect(result.exitCode).toBe(0);
    expect(contract).toMatchObject({
      required: ["기존 변경 보존", "검증 증거 남기기"],
      forbidden: ["자동 커밋", "원문 기록"],
      activeHabits: [],
      commit: "forbidden",
    });
    expect(readFileSync(join(cwd, ".gdm", "sample", "work.md"), "utf8")).toContain("자동 커밋");
  });

  test("constraint inputs reject atomically without reflection", () => {
    // Given: representative secret, path, transcript, code, diff, URI, and multiline inputs.
    const unsafe = [
      "sk-secretvalue",
      "/Users/person/private",
      "user: hidden prompt",
      "const hidden",
      "diff --git private",
      "https://private.example",
      "first line\nsecond line",
    ];

    // When: each value enters both initialization and a legacy contract upgrade.
    for (const value of unsafe) {
      const initCwd = tempRepo();
      const init = runCli(initCwd, [
        "plan",
        "init",
        "--slug",
        "sample",
        "--brief",
        "비공개 입력",
        "--require",
        value,
      ]);
      expect(init.exitCode).toBe(5);
      expect(`${init.stdout}${init.stderr}`).not.toContain(value);
      expect(existsSync(join(initCwd, ".gdm"))).toBe(false);

      const legacyCwd = tempRepo();
      writeLegacyWork(legacyCwd);
      const before = stateBytes(legacyCwd, "legacy");
      const upgrade = runCli(legacyCwd, [
        "plan",
        "contract",
        "--slug",
        "legacy",
        "--forbid",
        value,
      ]);
      expect(upgrade.exitCode).toBe(5);
      expect(`${upgrade.stdout}${upgrade.stderr}`).not.toContain(value);
      expect(stateBytes(legacyCwd, "legacy")).toEqual(before);
    }

    // Then: every rejection is exit 5, non-reflecting, and byte-atomic.
    expect(unsafe).toHaveLength(7);
  });

  test("legacy contract can upgrade only before a passed check", () => {
    // Given: one untouched legacy work and one legacy work with a passed check.
    const openCwd = tempRepo();
    writeLegacyWork(openCwd);
    const passedCwd = tempRepo();
    writeLegacyWork(passedCwd, true);
    const passedBefore = stateBytes(passedCwd, "legacy");

    // When: the same constraint is added to both.
    const open = runCli(openCwd, [
      "plan",
      "contract",
      "--slug",
      "legacy",
      "--require",
      "기존 변경 보존",
      "--forbid",
      "자동 커밋",
    ]);
    const passed = runCli(passedCwd, [
      "plan",
      "contract",
      "--slug",
      "legacy",
      "--require",
      "기존 변경 보존",
    ]);

    // Then: only the pre-pass work changes.
    expect(open.exitCode).toBe(0);
    expect(objectField(readWork(openCwd, "legacy"), "contract")).toMatchObject({
      required: ["기존 변경 보존"],
      forbidden: ["자동 커밋"],
      commit: "forbidden",
    });
    expect(passed.exitCode).toBe(3);
    expect(passed.stderr).toContain("contract_locked");
    expect(stateBytes(passedCwd, "legacy")).toEqual(passedBefore);
  });

  test("explicit commit approval is journaled without git mutation", () => {
    // Given: a constrained work whose default commit state is forbidden.
    const cwd = tempRepo();
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd }).exitCode).toBe(0);
    writeFileSync(join(cwd, "sentinel.txt"), "tracked\n");
    expect(Bun.spawnSync(["git", "add", "sentinel.txt"], { cwd }).exitCode).toBe(0);
    const headBefore = readFileSync(join(cwd, ".git", "HEAD"));
    const indexBefore = readFileSync(join(cwd, ".git", "index"));
    expect(runCli(cwd, initArgs()).exitCode).toBe(0);
    const denied = runCli(cwd, ["plan", "contract", "--slug", "sample", "--check-commit"]);
    const missingReason = runCli(cwd, [
      "plan",
      "contract",
      "--slug",
      "sample",
      "--commit",
      "explicitly-approved",
    ]);
    const beforeUnsafeReason = stateBytes(cwd, "sample");
    const unsafeReason = "Bearer private-token";
    const rejectedReason = runCli(cwd, [
      "plan",
      "contract",
      "--slug",
      "sample",
      "--commit",
      "explicitly-approved",
      "--reason",
      unsafeReason,
    ]);
    const afterRejectedReason = stateBytes(cwd, "sample");

    // When: approval, exact replay, revocation, and later reapproval are requested.
    const approved = runCli(cwd, [
      "plan",
      "contract",
      "--slug",
      "sample",
      "--commit",
      "explicitly-approved",
      "--reason",
      "사용자 명시 승인",
    ]);
    const afterApproval = stateBytes(cwd, "sample");
    const replay = runCli(cwd, [
      "plan",
      "contract",
      "--slug",
      "sample",
      "--commit",
      "explicitly-approved",
      "--reason",
      "사용자 명시 승인",
    ]);
    const afterReplay = stateBytes(cwd, "sample");
    const allowed = runCli(cwd, ["plan", "contract", "--slug", "sample", "--check-commit"]);
    const revoked = runCli(cwd, [
      "plan",
      "contract",
      "--slug",
      "sample",
      "--commit",
      "forbidden",
      "--reason",
      "전달 승인 취소",
    ]);
    const reapproved = runCli(cwd, [
      "plan",
      "contract",
      "--slug",
      "sample",
      "--commit",
      "explicitly-approved",
      "--reason",
      "사용자 명시 승인",
    ]);

    // Then: check is Git-free, immediate replay is a no-op, and revisions are monotonic.
    expect(denied.exitCode).toBe(4);
    expect(missingReason.exitCode).toBe(2);
    expect(rejectedReason.exitCode).toBe(5);
    expect(`${rejectedReason.stdout}${rejectedReason.stderr}`).not.toContain(unsafeReason);
    expect(afterRejectedReason).toEqual(beforeUnsafeReason);
    expect(approved.exitCode).toBe(0);
    expect(replay.exitCode).toBe(0);
    expect(afterReplay).toEqual(afterApproval);
    expect(allowed.exitCode).toBe(0);
    expect(revoked.exitCode).toBe(0);
    expect(reapproved.exitCode).toBe(0);
    const contract = objectField(readWork(cwd), "contract");
    expect(contract.commit).toBe("explicitly-approved");
    expect(objectField(contract, "latestCommitTransition")).toMatchObject({
      transitionRevision: 3,
      to: "explicitly-approved",
      reason: "사용자 명시 승인",
    });
    const journal = readFileSync(join(cwd, ".gdm", "sample", "journal.jsonl"), "utf8");
    expect(journal.match(/contract\.commit/g)).toHaveLength(3);
    expect(readFileSync(join(cwd, ".git", "HEAD"))).toEqual(headBefore);
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(indexBefore);
  });

  test("read surfaces expose the latest contract and done never approves commit", () => {
    // Given: a constrained work with one executable check.
    const cwd = tempRepo();
    expect(runCli(cwd, initArgs()).exitCode).toBe(0);
    expect(
      runCli(cwd, [
        "plan",
        "add",
        "--slug",
        "sample",
        "--desc",
        "명령 성공",
        "--cmd",
        "true",
        "--expect",
        "exit 0",
      ]).exitCode,
    ).toBe(0);

    // When: every JSON read surface is queried and the work is completed.
    const listed = runCli(cwd, ["plan", "list", "--slug", "sample", "--json"]);
    const status = runCli(cwd, ["status", "--json"]);
    const resumed = runCli(cwd, ["resume", "--slug", "sample", "--json"]);
    const audit = runCli(cwd, ["audit", "brief", "--slug", "sample", "--json"]);
    expect(runCli(cwd, ["pass", "c1", "--slug", "sample"]).exitCode).toBe(0);
    expect(runCli(cwd, ["done", "--slug", "sample"]).exitCode).toBe(0);

    // Then: all readers include the contract and completion preserves forbidden delivery.
    expect(listed.stdout).toContain('"contract"');
    expect(status.stdout).toContain('"contract"');
    expect(resumed.stdout).toContain('"contract"');
    expect(audit.stdout).toContain('"contract"');
    expect(objectField(readWork(cwd), "contract").commit).toBe("forbidden");
    expect(arrayField(objectField(readWork(cwd), "contract"), "activeHabits")).toEqual([]);
    expect(runCli(cwd, ["plan", "contract", "--slug", "sample", "--check-commit"]).exitCode).toBe(4);
  });

  test("legacy read normalizes a forbidden empty contract", () => {
    // Given: a state file written by gdm before work contracts existed.
    const cwd = tempRepo();
    writeLegacyWork(cwd);

    // When: it is read through resume JSON.
    const result = runCli(cwd, ["resume", "--slug", "legacy", "--json"]);

    // Then: callers receive a safe default without requiring an on-disk migration.
    expect(result.exitCode).toBe(0);
    const payload = parseObject(result.stdout);
    expect(objectField(objectField(payload, "work"), "contract")).toMatchObject({
      required: [],
      forbidden: [],
      activeHabits: [],
      commit: "forbidden",
    });
  });
});
