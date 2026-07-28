import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_ENVELOPE_PREFIX,
  AGENT_SESSION_ATTEMPT_LIMIT,
  parseAgentEnvelope,
} from "../src/codex-agent-hook.ts";
import { RECOMMENDED_CONCURRENT_LIMIT } from "../src/codex-agent-limit.ts";

const ROOT = join(import.meta.dir, "..", "..");
const ORDINARY_WORKFLOWS = ["go", "full", "plan", "review", "analyze", "research"];
const ENVELOPE_FIELDS = [
  "taskId",
  "parentId",
  "role",
  "scope",
  "ownership",
  "deliverable",
  "verify",
  "stopWhen",
  "canDelegate",
  "childQuota",
  "depth",
  "blockedBy",
].sort();
const ENVELOPE_ADAPTATION_INSTRUCTION =
  "아래 한 줄은 형식 예시일 뿐이다. 복사하기 전에 `taskId`, `parentId`, `role`, `scope`, `ownership.mode/resources`, `deliverable`, `verify`, `stopWhen`, `canDelegate`, `childQuota`(quota), `depth`, `blockedBy` 값을 작업에 맞게 모두 바꾼다.";
const HARD_FUSE =
  "훅이 실행되는 하나의 네이티브 Codex 루트 세션 트리에서 누적 12는 하드 상한이고, 동시 4는 현재 세션의 유효 Codex 설정이 4일 때 네이티브 하드 상한이다.";

function skill(name: string): string {
  return readFileSync(join(ROOT, "skills", name, "SKILL.md"), "utf8");
}

function normalized(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function capturedNumbers(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((match) => Number(match[1]));
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

  test("ordinary roles allow contextual nested delegation under one shared cap", () => {
    const routing = readFileSync(join(ROOT, "skills", "_shared", "routing.md"), "utf8");
    expect(routing).toContain("일반 역할은 leaf가 아니며");
    expect(routing).toMatch(/새로 발견한 독립 경계[\s\S]*하위 역할을 만들 수 있다/);
    expect(normalized(routing)).toMatch(
      /네이티브 Codex 루트 세션 트리에서[\s\S]*모든 세대의 활성 spawned agent를 합쳐 동시에 최대 4명/,
    );
    expect(routing).toContain("`MAX_ACTIVE_SUBAGENTS: 4`");
    expect(routing).toContain("자식이 만든 자식도");
    expect(routing).not.toContain("외부 역할은 항상 **leaf 실행**");

    for (const name of ORDINARY_WORKFLOWS) {
      const workflow = skill(name);
      expect(workflow).toMatch(/(?:서브에이전트|하위 역할)/);
      expect(workflow).toMatch(/(?:독립|전문성|fresh context)/);
      expect(normalized(workflow)).toMatch(/동시에 최대 4명/);
      expect(workflow).not.toContain("에이전트 팬아웃을 사용하지 않는다");
      expect(workflow).not.toMatch(/(^|[^_])MAX_(?:AGENT_DEPTH|CHILD_AGENTS): 0/);
    }
  });

  test("every installed ordinary skill carries the same parser-valid envelope example", () => {
    const examples: string[] = [];

    for (const name of ORDINARY_WORKFLOWS) {
      const workflow = skill(name);
      const envelopeLines = workflow
        .split(/\r?\n/u)
        .filter((line) => line.startsWith(AGENT_ENVELOPE_PREFIX));
      expect(envelopeLines).toHaveLength(1);

      const example = envelopeLines[0]!;
      examples.push(example);
      const parsed = parseAgentEnvelope(example);
      expect(Object.keys(parsed).sort()).toEqual(ENVELOPE_FIELDS);
      expect(Object.keys(parsed.ownership).sort()).toEqual(["mode", "resources"]);
      expect(parsed.ownership.mode).toBe("read");
      expect(parsed.ownership.resources).toEqual(["docs/example.md"]);
      expect(parsed.canDelegate).toBe(false);
      expect(parsed.childQuota).toBe(0);
      expect(parsed.depth).toBe(1);
      expect(parsed.blockedBy).toEqual([]);
      expect(normalized(workflow)).toContain(ENVELOPE_ADAPTATION_INSTRUCTION);
    }

    expect(new Set(examples).size).toBe(1);
  });

  test("every ordinary workflow carries one bounded delegation lease", () => {
    const routing = readFileSync(join(ROOT, "skills", "_shared", "routing.md"), "utf8");
    const workflows = ORDINARY_WORKFLOWS.map(skill);
    const policies = [routing, ...workflows];

    expect(AGENT_SESSION_ATTEMPT_LIMIT).toBe(12);
    expect(RECOMMENDED_CONCURRENT_LIMIT).toBe(4);
    for (const policy of policies) {
      const compact = normalized(policy);
      expect(policy).toContain("`MAX_TOTAL_SPAWNS_PER_ROOT: 12`");
      expect(policy).toContain("`DEFAULT_CHILD_QUOTA: 1`");
      expect(policy).toContain("`MAX_CHILD_QUOTA: 2`");
      expect(policy).toContain("`MAX_AGENT_DEPTH: 3`");
      expect(policy).toContain("`GDM_AGENT_ENVELOPE_V1=`");
      expect(policy).toContain("spawn 메시지 첫 줄");
      expect(policy).toContain("`blockedBy`");
      expect(policy).toContain("실패·취소된 spawn도 예산을 돌려주지 않는다");
      expect(compact.split(HARD_FUSE)).toHaveLength(2);
      expect(compact).toMatch(
        /caller agent id가 structured 부모와 일대일로 결속될 때 부모별 quota\/depth\/canDelegate를 기계적으로 검사/,
      );
      expect(compact).toMatch(
        /caller id가 없는 호환 런타임(?:에서는|은).*선언한 부모가 있을 때만 (?:그 부모의 )?nonterminal\/quota\/depth\/canDelegate를 검사하는 degraded fallback/,
      );
      expect(compact).toContain("이를 부모 신원 하드 경계라고 주장하지 않는다");
      expect(compact).toMatch(
        /비대화형 CLI[·와 ]+별도 (?:Codex )?세션을 합친 논리 작업 전체의 동시 4·누적 12는 .*협력적 운영 규칙/,
      );
      expect(compact).toContain("canonical scope");
      expect(compact).toContain("write resource");
      expect(compact).toContain("운영체제 파일 lock은 아니다");
      expect(compact).toContain("`completed|failed|cancelled|inconclusive`");
    }

    for (const workflow of workflows) {
      const compact = normalized(workflow);
      expect(compact).toContain("timeout은 대기 호출의 종료일 뿐 workflow 결과 확정이 아니다");
      expect(compact).toMatch(
        /`SubagentStop`은 child turn의 stop 관찰이자 sequencing hint일 뿐 영구 thread 종료나 성공 증명이 아니다/u,
      );
      expect(compact).toMatch(
        /다른 Stop handler가 continuation을 요청할 수 있고, idle thread는 `followup_task`로 재사용될 수 있으며, interrupt는 Stop 관찰을 남기지 않을 수 있다/u,
      );
      expect(compact).toMatch(
        /원장에서 해당 identity에 연결된 `stopped` 관찰은 active\/ownership lease를 협력적으로 해제하고 `blockedBy`를 열 수 있지만 hard runtime proof가 아니다/u,
      );
      expect(compact).toMatch(
        /루트 (?:조율자|진행자)는 deliverable\/verify와 실제 작업 겹침 부재를 확인해야 한다/u,
      );
      expect(compact).toMatch(
        /`failed\|expired`는 active\/ownership lease에서는 빠져도 `blockedBy`를 만족하지 않으며, 30분 lease expiry도 완료가 아니다/u,
      );
      expect(compact).toMatch(
        /`completed\|failed\|cancelled\|inconclusive` 중 하나로 별도 판정한다\. 이 workflow 결과는 lifecycle 관찰과 분리한다/u,
      );
      expect(compact).toMatch(
        /`multi_agent_v2` spawn 응답에는 agent id가 없으므로 unresolved V2가 포함된 identity-ambiguous 구간만 직렬화한다\. unresolved V1끼리는 병렬 가능하고, identity가 연결된 뒤 active agent 실행도 병렬 가능하다/u,
      );
      expect(compact).not.toContain("unresolved identity handshake만 직렬화한다");
      expect(compact).toMatch(
        /same-axis 후속 작업으로 idle thread를 재사용할 수 있지만 훅은 이전 ownership\/delegation을 기계적으로 갱신하지 못한다/u,
      );
      expect(compact).toMatch(
        /루트 (?:조율자|진행자)는 실제 작업 겹침을 피하고 새 bounded delegation이 필요하면 새 lease를 선언해 생성한다/u,
      );
      expect(compact).not.toContain("권위 있게 연결된 `stopped`뿐");
      expect(compact).not.toContain("workflow 결과의 terminal 상태");
    }

    expect(normalized(routing)).toContain(
      "`MAX_TOTAL_SPAWNS_PER_ROOT: 12`에서 ROOT는 하나의 네이티브 Codex root session을 뜻한다.",
    );
    expect(normalized(routing)).toContain(
      "사용자 `config.toml`만으로 유효값을 단정하지 않고 `/debug-config`에서 계층을 확인한다.",
    );
    expect(routing).toContain("새 독립 경계가 예상되는 일반 역할의 기본 `childQuota`는 1");
    expect(routing).toContain("일반 역할을 일괄 leaf로 만들지 않는다");
    expect(routing).toContain("의존하는 단계와 최종 응답");
    expect(routing).toContain("기존 역할에 후속 작업");
    expect(routing).toContain("일반 Codex spawn도 막지 않고 같은 세션 누적 12에만 포함한다");
    expect(routing).toMatch(/Stop 장벽은\s*한 번만 continuation을 요청/u);
  });

  test("hard-boundary wording is conditional and has no unconditional concurrency claim", () => {
    const routing = normalized(
      readFileSync(join(ROOT, "skills", "_shared", "routing.md"), "utf8"),
    );
    const design = normalized(readFileSync(join(ROOT, "DESIGN.md"), "utf8"));
    const contractEntries = [
      { name: "routing", policy: routing },
      ...ORDINARY_WORKFLOWS.map((name) => ({
        name,
        policy: normalized(skill(name)),
      })),
    ];
    const contracts = contractEntries.map(({ policy }) => policy);
    const policies = [design, ...contracts];

    for (const policy of policies) {
      expect(policy).not.toContain("동시 4와 누적 12만 하드 퓨즈");
      expect(policy).not.toContain("Codex 동시 thread 하드 상한 4");
      expect(policy).not.toMatch(/열린 spawned-agent thread 상한 4로 막/u);
      expect(
        capturedNumbers(
          policy,
          /동시\s*(\d+)[^.!?\n]{0,160}?하드(?:\s+상한|\s+퓨즈)/gu,
        ),
      ).toEqual([RECOMMENDED_CONCURRENT_LIMIT]);
      expect(
        capturedNumbers(
          policy,
          /누적\s*(\d+)[^.!?\n]{0,160}?하드(?:\s+상한|\s+퓨즈)/gu,
        ),
      ).toEqual([AGENT_SESSION_ATTEMPT_LIMIT]);
    }
    for (const { name, policy } of contractEntries) {
      expect(
        capturedNumbers(
          policy,
          /`MAX_TOTAL_SPAWNS_PER_ROOT:\s*(\d+)`/gu,
        ),
      ).toEqual([AGENT_SESSION_ATTEMPT_LIMIT]);
      expect(
        capturedNumbers(policy, /`DEFAULT_CHILD_QUOTA:\s*(\d+)`/gu),
      ).toEqual([1]);
      expect(
        capturedNumbers(policy, /`MAX_CHILD_QUOTA:\s*(\d+)`/gu),
      ).toEqual([2]);
      const depthValues = capturedNumbers(
        policy,
        /`MAX_AGENT_DEPTH:\s*(\d+)`/gu,
      );
      expect(depthValues).toEqual(name === "routing" ? [3, 0] : [3]);
      expect(
        capturedNumbers(policy, /`MAX_ACTIVE_SUBAGENTS:\s*(\d+)`/gu),
      ).toEqual(
        name === "routing" || name === "research"
          ? [RECOMMENDED_CONCURRENT_LIMIT]
          : [],
      );
      expect(
        capturedNumbers(policy, /동시에 최대\s*(\d+)명/gu),
      ).toEqual([RECOMMENDED_CONCURRENT_LIMIT]);
    }
    expect(design).toContain(
      "동시 4는 현재 세션의 effective Codex 설정이 4일 때 네이티브 하드 퓨즈다.",
    );
    expect(design).toContain("/debug-config");
  });

  test("delegation envelopes own bounded scope and non-overlapping writes", () => {
    const routing = readFileSync(join(ROOT, "skills", "_shared", "routing.md"), "utf8");
    for (const field of [
      "taskId",
      "parentId",
      "role",
      "scope",
      "ownership",
      "deliverable",
      "verify",
      "stopWhen",
      "canDelegate",
      "childQuota",
      "depth",
      "blockedBy",
    ]) {
      expect(routing).toContain(`\`${field}\``);
    }
    expect(routing).toContain('`ownership.mode`은 `read|write`');
    expect(normalized(routing)).toContain(
      "활성 structured 역할끼리 같은 canonical scope를 다시 맡거나, cwd 기준으로 `.`·`..`·상대/절대 별칭을 정규화했을 때 겹치는 write resource를 소유할 수 없다.",
    );
    expect(routing).toContain("운영체제 파일 lock은 아니다");
    expect(routing).toContain("같은 `tool_use_id`");
  });

  test("implementation can be delegated across disjoint ownership", () => {
    const routing = readFileSync(join(ROOT, "skills", "_shared", "routing.md"), "utf8");
    const go = skill("go");
    const full = skill("full");

    expect(routing).toContain("파일·모듈·조사 축처럼 소유 경계가 독립적이면 구현을 포함해 위임할 수 있다");
    expect(routing).toContain("여러 구현 워커는 겹치지 않는 파일·모듈을 소유");
    expect(go).toContain("**상황에 맞게**");
    expect(go).toContain("여러 구현 워커를 둘 수 있고");
    expect(full).toContain("같은 구현 모델의 에이전트는 여러 명이어도 된다");
    expect(full).toContain("여러 구현 워커에는 겹치지 않는 파일·모듈");

    for (const policy of [routing, go, full]) {
      expect(policy).not.toContain("제품 파일을 쓰는 실제 구현 주체는 한 명으로 유지");
      expect(policy).not.toContain("제품 파일 작성자는 현재 실행자 한 명으로 유지");
      expect(policy).not.toContain("제품 파일 작성자는 한 명이며");
    }
    expect(routing).not.toContain("경량 구현은 현재 실행자가 직접 수행한다");
    expect(go).not.toContain("**조율자(앉은 CLI)가 직접 구현**하는 것이 기본이다");
    expect(full).not.toContain("지정한 제품 작성자 1명");
  });

  test("research delegates only newly found independent child axes", () => {
    const research = skill("research");
    expect(research).toContain("`MAX_ACTIVE_SUBAGENTS: 4`");
    expect(research).toMatch(/모든 종류·모든 세대의[\s\S]*활성 spawned agent를 합쳐 동시에 최대 4명/);
    expect(research).toContain("`하위 위임`");
    expect(research).toContain("같은 세션 상한을 공유한다");
    expect(research).toMatch(/진행 중 새롭고[\s\S]*독립 하위 축을 발견하면[\s\S]*하위 위임할 수 있다/);
    expect(research).toContain("받은 전체 범위를 그대로 다시 맡기는 재위임");
    expect(research).toContain("자기 복제");
    expect(research).toContain("무제한 팬아웃");
    expect(research).toContain("일반 조사 역할은 leaf로 고정하지 않는다");
    expect(research).not.toContain("다른 세션에서의 gdm-research 재호출은 금지한다");
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
    expect(routing).toContain("`MAX_ACTIVE_SUBAGENTS: 4`");
    expect(routing).toContain("일반 역할은 leaf가 아니며");
    expect(routing).toContain("독립 검수는 예외적으로 pass당 정확히 1명의 **leaf 실행**");
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
