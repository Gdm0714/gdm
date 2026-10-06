import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();
const AGENT_HOOK_SPAWN_MATCHER =
  "^(Agent|spawn_agent|collaborationspawn_agent|collaboration\\.spawn_agent|[A-Za-z0-9_-]{1,64}spawn_agent)$";
const SKILL_NAMES = [
  "go",
  "full",
  "plan",
  "review",
  "analyze",
  "research",
  "pr",
  "ui",
  "db",
  "design",
  "reflect",
  "email",
  "document",
] as const;

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function runCli(cwd: string, args: readonly string[], env?: Record<string, string>): CliResult {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : undefined,
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "gdm-improve-test-"));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function testGdmLauncher(directory: string): string {
  const launcher = join(directory, "gdm-test-launcher");
  writeFileSync(
    launcher,
    process.env.GDM_NATIVE_TEST_BINARY
      ? `#!/bin/sh\nexec ${shellQuote(process.env.GDM_NATIVE_TEST_BINARY)} "$@"\n`
      : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(CLI)} "$@"\n`,
  );
  chmodSync(launcher, 0o755);
  // Separate cold executable startup from the production 3-second hook probe.
  expect(Bun.spawnSync([launcher, "--version"], { timeout: 20_000 }).exitCode).toBe(0);
  return launcher;
}

type AgentGateHandlerFixture = {
  type: string;
  command: string;
  timeout: number;
};

type AgentGateGroupFixture = {
  matcher?: string;
  hooks: AgentGateHandlerFixture[];
};

type AgentGateFixture = {
  hooks: Record<
    "PreToolUse" | "PostToolUse" | "SubagentStart" | "SubagentStop" | "Stop",
    AgentGateGroupFixture[]
  >;
};

function writeCodexAgentGateAt(
  codex: string,
  hooksEnabled: boolean,
  mutate?: (fixture: AgentGateFixture) => void,
): void {
  mkdirSync(codex, { recursive: true });
  const handler = (): AgentGateHandlerFixture => ({
    type: "command",
    command: `'${process.env.GDM_NATIVE_TEST_BINARY ?? process.execPath}' agent hook --handler-id gdm-agent-gate-v1`,
    timeout: 10,
  });
  const fixture: AgentGateFixture = {
    hooks: {
      PreToolUse: [{ matcher: AGENT_HOOK_SPAWN_MATCHER, hooks: [handler()] }],
      PostToolUse: [{ matcher: AGENT_HOOK_SPAWN_MATCHER, hooks: [handler()] }],
      SubagentStart: [{ hooks: [handler()] }],
      SubagentStop: [{ hooks: [handler()] }],
      Stop: [{ hooks: [handler()] }],
    },
  };
  mutate?.(fixture);
  writeFileSync(
    join(codex, "hooks.json"),
    `${JSON.stringify(fixture, null, 2)}\n`,
  );
  writeFileSync(join(codex, "config.toml"), `[features]\nhooks = ${hooksEnabled}\n`);
}

function writeCodexAgentGate(home: string, hooksEnabled: boolean): void {
  writeCodexAgentGateAt(join(home, ".codex"), hooksEnabled);
}

const BRIEF = `# 계획: 샘플

## 검증 항목 초안
gdm plan add에 그대로 쓸 수 있는 형태:
- desc: 빌드 성공 / cmd: \`printf ok\` / expect: ok 출력
- desc: 화면 확인 (manual) / expect: 스크린샷 일치

## 작업 계약 초안
- require: 기존 동작 보존
`;

describe("plan add --from-brief", () => {
  test("dry-run은 등록 없이 미리 보여주고, 본 실행은 일괄 등록한다", () => {
    // Given: 검증 항목 초안이 있는 brief로 시작한 작업.
    const cwd = tempRepo();
    writeFileSync(join(cwd, "brief.md"), BRIEF);
    expect(runCli(cwd, ["plan", "init", "--slug", "sample", "--brief-file", "brief.md", "--forbid", "자동 커밋"]).exitCode).toBe(0);

    // When: dry-run 후 본 실행.
    const dry = runCli(cwd, ["plan", "add", "--slug", "sample", "--from-brief", "--dry-run"]);
    const afterDry = runCli(cwd, ["plan", "list", "--slug", "sample"]);
    const real = runCli(cwd, ["plan", "add", "--slug", "sample", "--from-brief"]);
    const list = runCli(cwd, ["plan", "list", "--slug", "sample"]);

    // Then: dry-run은 상태를 바꾸지 않고, 본 실행은 2개를 등록한다.
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("dry-run");
    expect(afterDry.stdout).toContain("(0/0)");
    expect(real.exitCode).toBe(0);
    expect(real.stdout).toContain("2개 항목 등록");
    expect(list.stdout).toContain("c1 빌드 성공");
    expect(list.stdout).toContain("c2 화면 확인");
    expect(list.stdout).toContain("(수동 확인)");
  });

  test("형식 오류면 어떤 항목도 등록하지 않는다", () => {
    // Given: 두 번째 항목이 깨진 brief.
    const cwd = tempRepo();
    writeFileSync(
      join(cwd, "brief.md"),
      "## 검증 항목 초안\n- desc: 좋은 항목 / cmd: printf ok / expect: exit 0\n- desc: 나쁜 항목 / cmd: printf bad\n",
    );
    runCli(cwd, ["plan", "init", "--slug", "sample", "--brief-file", "brief.md", "--forbid", "자동 커밋"]);

    // When: 일괄 등록을 시도한다.
    const result = runCli(cwd, ["plan", "add", "--slug", "sample", "--from-brief"]);
    const list = runCli(cwd, ["plan", "list", "--slug", "sample"]);

    // Then: usage 계열(exit 2)로 실패하고 등록 0건.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("파싱 실패");
    expect(list.stdout).toContain("(0/0)");
  });

  test("--from-brief와 --desc는 함께 쓸 수 없다", () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, "brief.md"), BRIEF);
    runCli(cwd, ["plan", "init", "--slug", "sample", "--brief-file", "brief.md", "--forbid", "자동 커밋"]);
    const result = runCli(cwd, ["plan", "add", "--slug", "sample", "--from-brief", "--desc", "중복"]);
    expect(result.exitCode).toBe(2);
  });
});

describe("privacy 거부 상세 안내", () => {
  test("문자셋 위반은 위반 문자·허용 목록·플래그 반복 힌트를 알려준다", () => {
    // Given: 가운뎃점으로 조건을 이어 붙인 require.
    const cwd = tempRepo();

    // When: plan init이 privacy 경계에서 거부된다.
    const result = runCli(cwd, [
      "plan",
      "init",
      "--slug",
      "sample",
      "--brief",
      "테스트",
      "--require",
      "조건1 · 조건2",
    ]);

    // Then: 기존 접두는 유지되고 원인이 덧붙는다.
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("privacyPolicyVersion=1 field=require");
    expect(result.stderr).toContain('허용되지 않는 문자 "·"');
    expect(result.stderr).toContain("플래그를 반복");
  });

  test("민감정보 검출 거부는 기존처럼 원인을 밝히지 않는다", () => {
    const cwd = tempRepo();
    const result = runCli(cwd, [
      "plan",
      "init",
      "--slug",
      "sample",
      "--brief",
      "테스트",
      "--require",
      "토큰은 sk-abcdef",
    ]);
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("privacyPolicyVersion=1 field=require count=1");
    expect(result.stderr).not.toContain("허용되지 않는 문자");
  });
});

describe("status --checks", () => {
  test("JSON에 brief 없이 check 상세가 포함된다", () => {
    // Given: check 하나가 등록된 작업.
    const cwd = tempRepo();
    runCli(cwd, ["plan", "init", "--slug", "sample", "--brief", "상세확인용브리프본문", "--forbid", "자동 커밋"]);
    runCli(cwd, ["plan", "add", "--slug", "sample", "--desc", "명령 성공", "--cmd", "printf ok", "--expect", "ok 출력"]);

    // When: 상세 상태를 조회한다.
    const withChecks = runCli(cwd, ["status", "--json", "--checks"]);
    const withoutChecks = runCli(cwd, ["status", "--json"]);

    // Then: --checks에서만 check 배열이 나오고 brief는 어느 쪽에도 없다.
    expect(withChecks.exitCode).toBe(0);
    const parsed = JSON.parse(withChecks.stdout) as {
      slug: string;
      blockers: { code: string; message: string }[];
      checks?: { id: string; cmd: string | null; status: string }[];
    }[];
    expect(parsed[0]!.blockers).toEqual([
      expect.objectContaining({ code: "unproven", message: expect.stringContaining("c1") }),
    ]);
    expect(parsed[0]!.checks![0]!.id).toBe("c1");
    expect(parsed[0]!.checks![0]!.cmd).toBe("printf ok");
    expect(parsed[0]!.checks![0]!.status).toBe("open");
    expect(withChecks.stdout).not.toContain("상세확인용브리프본문");
    expect(JSON.parse(withoutChecks.stdout)[0].checks).toBeUndefined();
  });

  test("retro --all --json은 Work가 없어도 동일한 zero schema를 반환한다", () => {
    const result = runCli(tempRepo(), ["retro", "--all", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      works: 0,
      done: 0,
      events: 0,
      denied: {},
      misses: [],
      feedback: { good: 0, bad: 0, total: 0 },
      evalCandidates: [],
      editCount: 0,
      recheckFails: 0,
      suggestions: [],
      habitCandidates: 0,
      habitAdopted: 0,
      habitNext: "gdm habit harvest",
    });
  });
});

describe("doctor 버전 드리프트", () => {
  test("스킬 심링크가 가리키는 저장소와 바이너리 버전이 다르면 경고한다", () => {
    // Given: 버전 9.9.9 저장소를 가리키는 가짜 HOME의 스킬 심링크.
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-improve-home-"));
    const repo = mkdtempSync(join(tmpdir(), "gdm-improve-repo-"));
    mkdirSync(join(repo, "skills", "go"), { recursive: true });
    mkdirSync(join(repo, "cli"), { recursive: true });
    writeFileSync(join(repo, "cli", "package.json"), JSON.stringify({ version: "9.9.9" }));
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(repo, "skills", "go"), join(home, ".claude", "skills", "gdm-go"));

    // When: doctor를 실행한다.
    const result = runCli(cwd, ["doctor"], { HOME: home });

    // Then: 저장소 버전과 재설치 안내가 출력된다.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("저장소: 9.9.9");
    expect(result.stdout).toContain("다릅니다");
    expect(result.stdout).toContain("install.sh");
  });

  test("스킬 심링크가 없으면 버전 줄 없이 조용히 넘어간다", () => {
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-improve-home-"));
    const result = runCli(cwd, ["doctor"], { HOME: home });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("저장소:");
  });
});

describe("doctor Codex 서브에이전트 상한", () => {
  test("공식 agents 설정의 4개 상한을 권장 범위로 보고한다", () => {
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-agent-limit-home-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      "[agents]\nmax_concurrent_threads_per_session = 4\n",
    );

    const result = runCli(cwd, ["doctor"], { HOME: home });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Codex 서브에이전트 사용자 설정: 동시 활성 4개 (권장 범위)",
    );
    expect(result.stdout).toContain("현재 세션 유효값");
    expect(result.stdout).toContain("/debug-config");
    expect(result.stdout).not.toContain("구형 상한 설정");
  });

  test("구형 multi_agent_v2의 1000개 상한을 위험으로 경고한다", () => {
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-agent-limit-legacy-home-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      "[features.multi_agent_v2]\nmax_concurrent_threads_per_session = 1000\n",
    );

    const result = runCli(cwd, ["doctor"], { HOME: home });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Codex 서브에이전트 사용자 설정: legacy 동시 활성 1000개 (위험 — 8개 초과)",
    );
    expect(result.stdout).toContain("[agents] max_concurrent_threads_per_session = 4만 유지");
  });

  test("명시 상한이 없으면 안전한 설정 예시를 안내한다", () => {
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-agent-limit-unset-home-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "model = \"gpt-5\"\n");

    const result = runCli(cwd, ["doctor"], { HOME: home });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Codex 서브에이전트 사용자 설정: 명시 상한 없음 (현재 세션 유효값 미확인)",
    );
    expect(result.stdout).toContain("16GB급 장비 권장: [agents] max_concurrent_threads_per_session = 4");
  });
});

describe("doctor Codex 에이전트 게이트", () => {
  test("5개 handler와 hooks=true면 설치됨으로 보고하되 enforcement 신뢰는 단정하지 않는다", () => {
    // Given: 다섯 lifecycle 지점에 gdm handler가 설치되고 Codex hooks 기능도 켜진 HOME.
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-agent-hook-installed-home-"));
    writeCodexAgentGate(home, true);

    // When: doctor로 실제 로컬 설치 상태를 진단한다.
    const result = runCli(cwd, ["doctor"], { HOME: home });

    // Then: 파일 설치와 Codex의 사용자 신뢰 승인을 구분해 보고한다.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Codex 에이전트 게이트: 설치됨");
    expect(result.stdout).toContain("현재 세션 유효값 미확인");
    expect(result.stdout).toContain("/debug-config");
    expect(result.stdout).toContain("/hooks");
    expect(result.stdout).toContain("신뢰");
  });

  test("handler가 없으면 미설치와 재설치 명령을 안내한다", () => {
    // Given: hooks 기능은 켰지만 gdm handler가 없는 HOME.
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-agent-hook-missing-home-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "hooks.json"), '{"hooks":{}}\n');
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");

    const result = runCli(cwd, ["doctor"], { HOME: home });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Codex 에이전트 게이트: 미설치");
    expect(result.stdout).toContain("gdm agent hook-install");
  });

  test("handler가 있어도 hooks=false면 비활성화 상태를 경고한다", () => {
    // Given: handler 파일은 완전하지만 Codex hooks 기능이 명시적으로 꺼진 HOME.
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-agent-hook-disabled-home-"));
    writeCodexAgentGate(home, false);

    const result = runCli(cwd, ["doctor"], { HOME: home });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Codex 에이전트 게이트: 비활성화");
    expect(result.stdout).toContain("[features] hooks = true");
  });

  test("잘못된 handler type, matcher, command 불일치는 설치로 인정하지 않는다", () => {
    const fixtures: readonly {
      name: string;
      mutate: (fixture: AgentGateFixture) => void;
      expectedInvalidEvent?: string;
      commandsConsistent: boolean;
    }[] = [
      {
        name: "prompt-type",
        mutate: (fixture) => {
          fixture.hooks.PreToolUse[0]!.hooks[0]!.type = "prompt";
        },
        expectedInvalidEvent: "PreToolUse",
        commandsConsistent: true,
      },
      {
        name: "wrong-matcher",
        mutate: (fixture) => {
          fixture.hooks.PostToolUse[0]!.matcher = "Agent|spawn_agent";
        },
        expectedInvalidEvent: "PostToolUse",
        commandsConsistent: true,
      },
      {
        name: "divergent-command",
        mutate: (fixture) => {
          fixture.hooks.Stop[0]!.hooks[0]!.command =
            "/tmp/other-gdm agent hook --handler-id gdm-agent-gate-v1";
        },
        commandsConsistent: false,
      },
    ];

    for (const fixture of fixtures) {
      const cwd = tempRepo();
      const home = mkdtempSync(join(tmpdir(), `gdm-agent-hook-${fixture.name}-home-`));
      writeCodexAgentGateAt(join(home, ".codex"), true, fixture.mutate);

      const status = runCli(cwd, ["agent", "hook-status", "--json"], { HOME: home });
      const doctor = runCli(cwd, ["doctor"], { HOME: home });

      expect(status.exitCode).toBe(0);
      const parsed = JSON.parse(status.stdout) as {
        installed: boolean;
        hooks: {
          invalidEvents: string[];
          commandsConsistent: boolean;
        };
      };
      expect(parsed.installed).toBe(false);
      expect(parsed.hooks.commandsConsistent).toBe(fixture.commandsConsistent);
      if (fixture.expectedInvalidEvent !== undefined) {
        expect(parsed.hooks.invalidEvents).toContain(fixture.expectedInvalidEvent);
      }
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stdout).toContain("Codex 에이전트 게이트: 미설치");
    }
  });
});

describe("doctor custom CODEX_HOME", () => {
  test("상대 CODEX_HOME의 config, hooks, skills를 사용하고 HOME/.codex는 보지 않는다", () => {
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-custom-codex-home-"));
    const codexHome = join(cwd, "custom-codex");
    writeCodexAgentGateAt(codexHome, true);
    writeFileSync(
      join(codexHome, "config.toml"),
      "[agents]\nmax_concurrent_threads_per_session = 4\n\n[features]\nhooks = true\n",
    );
    for (const name of SKILL_NAMES) {
      mkdirSync(join(codexHome, "skills", `gdm-${name}`), { recursive: true });
    }

    const decoy = join(home, ".codex");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(
      join(decoy, "config.toml"),
      "[agents]\nmax_concurrent_threads_per_session = 1000\n\n[features]\nhooks = false\n",
    );
    writeFileSync(join(decoy, "hooks.json"), '{"hooks":{}}\n');

    const result = runCli(cwd, ["doctor"], {
      HOME: home,
      CODEX_HOME: "custom-codex",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Codex 서브에이전트 사용자 설정: 동시 활성 4개 (권장 범위)",
    );
    expect(result.stdout).not.toContain("1000개");
    expect(result.stdout).toContain("Codex 에이전트 게이트: 설치됨");
    expect(result.stdout).not.toContain("Codex 에이전트 게이트: 비활성화");
    expect(result.stdout).not.toContain("codex[없음]");
  });
});

describe("Codex TOML 및 hook 설치 정밀 진단", () => {
  test("inline table의 동시성 상한과 hooks feature를 정식 TOML 값으로 읽는다", () => {
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-inline-toml-home-"));
    const codex = join(home, ".codex");
    writeCodexAgentGateAt(codex, true);
    writeFileSync(
      join(codex, "config.toml"),
      "agents = { max_concurrent_threads_per_session = 4 }\nfeatures = { hooks = true, multi_agent_v2 = true }\n",
    );

    const result = runCli(cwd, ["doctor"], { HOME: home });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("사용자 설정: 동시 활성 4개 (권장 범위)");
    expect(result.stdout).toContain(
      "설정 완료 · 실행 가능 · 사용자 설정 활성",
    );
    expect(result.stdout).toContain("현재 세션 유효값 미확인");
    expect(result.stdout).toContain("/debug-config");
  });

  test("malformed TOML과 canonical/deprecated feature 충돌을 각각 invalid로 보고한다", () => {
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-invalid-toml-home-"));
    const codex = join(home, ".codex");
    writeCodexAgentGateAt(codex, true);
    writeFileSync(join(codex, "config.toml"), "[features\nhooks = true\n");

    const malformed = runCli(cwd, ["doctor"], { HOME: home });
    expect(malformed.exitCode).toBe(0);
    expect(malformed.stdout).toContain("TOML 문법 오류");
    expect(malformed.stdout).toContain("hooks 기능 설정 오류");

    writeFileSync(
      join(codex, "config.toml"),
      "features = { hooks = true, codex_hooks = true }\n",
    );
    const conflict = runCli(cwd, ["agent", "hook-status", "--json"], {
      HOME: home,
    });
    expect(conflict.exitCode).toBe(0);
    expect(JSON.parse(conflict.stdout).feature).toMatchObject({
      state: "invalid",
      invalidKind: "conflict",
    });
  });

  test("hooks.json과 inline hooks가 함께 있으면 multiple-source 경고를 낸다", () => {
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-multiple-hooks-home-"));
    const codex = join(home, ".codex");
    writeCodexAgentGateAt(codex, true);
    writeFileSync(
      join(codex, "config.toml"),
      "[features]\nhooks = true\n\n[hooks]\n",
    );

    const status = runCli(cwd, ["agent", "hook-status", "--json"], {
      HOME: home,
    });
    const doctor = runCli(cwd, ["doctor"], { HOME: home });

    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).hooks.multipleSources).toBe(true);
    expect(doctor.stdout).toContain("hooks.json과 inline [hooks]");
  });

  test("hook-install은 missing, directory, non-executable, non-gdm binary를 domain error로 거부한다", () => {
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-invalid-binary-home-"));
    const missing = join(home, "missing-gdm");
    const directory = join(home, "directory-gdm");
    const nonExecutable = join(home, "non-executable-gdm");
    mkdirSync(directory);
    writeFileSync(nonExecutable, "#!/bin/sh\n");
    chmodSync(nonExecutable, 0o600);

    for (const binary of [missing, directory, nonExecutable, "/bin/sh"]) {
      const result = runCli(
        cwd,
        ["agent", "hook-install", "--binary", binary],
        { HOME: home },
      );

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("오류(agent_hooks_binary_invalid)");
      expect(result.stderr).not.toContain("오류(internal)");
    }
  });

  test("hook-status는 다른 실행 가능한 gdm 경로를 installed로 과장하지 않는다", () => {
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-executable-drift-home-"));
    const otherGdm = testGdmLauncher(home);

    const install = runCli(
      cwd,
      ["agent", "hook-install", "--binary", otherGdm],
      { HOME: home },
    );
    const status = runCli(cwd, ["agent", "hook-status", "--json"], {
      HOME: home,
    });
    const doctor = runCli(cwd, ["doctor"], { HOME: home });

    expect(install.exitCode).toBe(0);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      installed: false,
      configured: true,
      executable: true,
      effective: "executable-drift",
      hooks: {
        matchesCurrentExecutable: false,
      },
    });
    expect(doctor.stdout).toContain("실행 파일 드리프트");
    expect(doctor.stdout).toContain(`handler: ${otherGdm}`);
  }, 30_000);

  test("유효한 gdm launcher를 가리키는 symlink candidate를 허용한다", () => {
    const cwd = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdm-executable-symlink-home-"));
    const launcher = testGdmLauncher(home);
    const binaryLink = join(home, "gdm-link");
    symlinkSync(launcher, binaryLink);
    expect(Bun.spawnSync([binaryLink, "--version"], { timeout: 20_000 }).exitCode).toBe(0);

    const install = runCli(
      cwd,
      ["agent", "hook-install", "--binary", binaryLink],
      { HOME: home },
    );
    const status = runCli(cwd, ["agent", "hook-status", "--json"], {
      HOME: home,
    });
    const human = runCli(cwd, ["agent", "hook-status"], { HOME: home });

    expect(install.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      installed: false,
      configured: true,
      executable: true,
      hooks: {
        executablePath: binaryLink,
        matchesCurrentExecutable: false,
      },
    });
    expect(human.stdout).toContain(
      "caller-bound when agent_id is present",
    );
    expect(human.stdout).toContain(
      "declaration-based compatibility fallback otherwise",
    );
    expect(human.stdout).toContain(
      "lifecycle-only association is provisional",
    );
    expect(human.stdout).not.toContain("declaration-based guardrails");
  }, 30_000);
});
