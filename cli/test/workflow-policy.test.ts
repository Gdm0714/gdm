import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

function skill(name: string): string {
  return readFileSync(join(ROOT, "skills", name, "SKILL.md"), "utf8");
}

function agent(name: string): string {
  return readFileSync(join(ROOT, "agents", name), "utf8");
}

describe("workflow policy", () => {
  test("go relies on done for the final automatic recheck", () => {
    const go = skill("go");
    expect(go).toContain("직전에 `gdm recheck`를 중복 실행하지 않는다");
    expect(go).toContain("`recheck`는 구현 도중");
  });

  test("full binds audit identity and workspace while PR delivery is machine-gated", () => {
    const full = skill("full");
    const pr = skill("pr");
    expect(full).toContain("--implementation-model <실제 구현 모델> --audit-model <검수 모델>");
    expect(full).toContain("Git 워크트리의 실제 파일 내용 지문");
    expect(pr).toContain("gdm delivery prepare");
    expect(pr).toContain("gdm delivery ci --slug <슬러그> --status passed");
    expect(pr).toContain("gdm delivery check-merge");
    expect(pr).toContain("자동 재실행은 하지 않는다");
  });

  test("research stays in one session without agent fanout", () => {
    const research = skill("research");
    expect(research).toContain("에이전트 팬아웃을 사용하지 않는다");
    expect(research).toContain("`MAX_AGENT_DEPTH: 0`, `MAX_CHILD_AGENTS: 0`");
    expect(research).toContain("현재 세션의 배치 조사");
    expect(research).not.toContain("서브에이전트를 병렬로 스폰");
  });

  test("audit workers are one bounded leaf and cannot sweep user processes", () => {
    const full = skill("full");
    const design = skill("design");
    const routing = readFileSync(join(ROOT, "skills", "_shared", "routing.md"), "utf8");
    const runner = agent("run-auditor.sh");
    for (const prompt of [agent("auditor.md"), agent("design-auditor.md")]) {
      expect(prompt).toContain("`MAX_AGENT_DEPTH: 0`");
      expect(prompt).toContain("`MAX_CHILD_AGENTS: 0`");
      expect(prompt).toContain("NEVER: 서브에이전트 생성");
      expect(prompt).toContain("AUDITOR_RESOURCE_LIMIT");
      expect(prompt).toContain("이름으로 검색해 종료하지 않는다");
    }
    for (const workflow of [full, design]) {
      expect(workflow).toContain("`MAX_AUDITORS_PER_PASS: 1`");
      expect(workflow).toContain("`AUDITOR_MAX_AGENT_DEPTH: 0`");
      expect(workflow).toContain("`AUDITOR_MAX_CHILD_AGENTS: 0`");
      expect(workflow).toContain("gdm-agents/run-auditor.sh");
    }
    expect(routing).toContain("외부 역할은 항상 **leaf 실행**");
    expect(routing).toContain("자신이 시작하지 않은 사용자 터미널");
    expect(runner).toContain("--disable multi_agent --disable multi_agent_v2 --disable enable_fanout");
    expect(runner).toContain('--tools "Read,Glob,Grep"');
    expect(runner).toContain("max_processes");
    expect(runner).toContain("stop_owned_tree");
    expect(runner).not.toContain("pkill");
  });

  test("audit runner kills only its owned tree on a process limit", () => {
    const directory = mkdtempSync(join(tmpdir(), "gdm-auditor-runner-"));
    const bin = join(directory, "bin");
    const pidFile = join(directory, "owned-pids.txt");
    const prompt = join(directory, "prompt.txt");
    const report = join(directory, "report.md");
    const fakeCodex = join(bin, "codex");
    mkdirSync(bin);
    writeFileSync(prompt, "audit this\n");
    writeFileSync(fakeCodex, `#!/usr/bin/env bash
set -eu
echo $$ >"$GDM_FAKE_PID_FILE"
sleep 60 & echo $! >>"$GDM_FAKE_PID_FILE"
sleep 60 & echo $! >>"$GDM_FAKE_PID_FILE"
sleep 60 & echo $! >>"$GDM_FAKE_PID_FILE"
wait
`);
    chmodSync(fakeCodex, 0o755);
    const sentinel = Bun.spawn(["sleep", "30"]);
    try {
      const result = Bun.spawnSync(["bash", join(ROOT, "agents", "run-auditor.sh"), "codex", prompt, report, directory], {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GDM_FAKE_PID_FILE: pidFile,
          GDM_AUDITOR_MAX_SECONDS: "10",
          GDM_AUDITOR_MAX_PROCESSES: "2",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(70);
      expect(new TextDecoder().decode(result.stderr)).toContain("AUDITOR_RESOURCE_LIMIT");
      for (const pid of readFileSync(pidFile, "utf8").trim().split("\n").map(Number)) {
        expect(Bun.spawnSync(["kill", "-0", String(pid)]).exitCode).not.toBe(0);
      }
      expect(Bun.spawnSync(["kill", "-0", String(sentinel.pid)]).exitCode).toBe(0);
    } finally {
      sentinel.kill();
    }
  });
});
