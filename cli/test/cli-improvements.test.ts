import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();

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
      checks?: { id: string; cmd: string | null; status: string }[];
    }[];
    expect(parsed[0]!.checks![0]!.id).toBe("c1");
    expect(parsed[0]!.checks![0]!.cmd).toBe("printf ok");
    expect(parsed[0]!.checks![0]!.status).toBe("open");
    expect(withChecks.stdout).not.toContain("상세확인용브리프본문");
    expect(JSON.parse(withoutChecks.stdout)[0].checks).toBeUndefined();
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
