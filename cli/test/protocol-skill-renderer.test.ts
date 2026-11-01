import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const RENDERER = join(ROOT, "install", "render-skills.ts");
const ADAPTER_BEGIN = "<!-- GDM_TARGET_ADAPTER_V1_BEGIN -->";
const ADAPTER_END = "<!-- GDM_TARGET_ADAPTER_V1_END -->";
const BODY_BEGIN = "<!-- GDM_RENDERED_SKILL_BODY_V1_BEGIN -->";
const BODY_END = "<!-- GDM_RENDERED_SKILL_BODY_V1_END -->";
const NATIVE_DELEGATION_LEAKAGE = /GDM_AGENT_ENVELOPE_V1|multi_agent_v2|hook caller|native (?:Codex )?root session/iu;
const READ_ONLY_SKILLS = new Set(["gdm-analyze", "gdm-plan", "gdm-review"]);
const TARGETS = ["codex", "claude", "gid"] as const;
type Target = typeof TARGETS[number];
const roots: string[] = [];

type Manifest = {
  readonly schemaVersion: string;
  readonly target: Target;
  readonly adapterVersion: string;
  readonly canonicalSourceSha256: string;
  readonly sourceSha256: string;
  readonly capabilityProfile: Record<string, unknown>;
  readonly hook: Record<string, unknown>;
  readonly runner: {
    readonly contract: string;
    readonly path: string;
    readonly sha256: string;
    readonly adapters: Record<"codex" | "claude", { readonly path: string; readonly sha256: string }>;
  };
  readonly skills: readonly {
    readonly name: string;
    readonly sourcePath: string;
    readonly sourceSha256: string;
    readonly renderedSha256: string;
  }[];
};

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "gdm-target-skills-"));
  roots.push(root);
  return root;
}

function render(target: Target, parent = temporaryDirectory()): string {
  const output = join(parent, target);
  const result = Bun.spawnSync([
    "bun", RENDERER,
    "--target", target,
    "--source-root", join(ROOT, "skills"),
    "--agents-root", join(ROOT, "agents"),
    "--output", output,
  ], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return output;
}

function manifest(output: string): Manifest {
  return JSON.parse(readFileSync(join(output, "gdm-target-manifest.json"), "utf8")) as Manifest;
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function files(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      expect(stat.isSymbolicLink(), path).toBe(false);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) result.push(relative(root, path));
    }
  };
  visit(root);
  return result;
}

function block(source: string, begin: string, end: string): string {
  expect(source.match(new RegExp(begin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(1);
  expect(source.match(new RegExp(end.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(1);
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start);
  return source.slice(start + begin.length, finish).trim();
}

function withoutAdapter(source: string): string {
  const start = source.indexOf(ADAPTER_BEGIN);
  const finish = source.indexOf(ADAPTER_END, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(finish).toBeGreaterThan(start);
  return `${source.slice(0, start)}${source.slice(finish + ADAPTER_END.length)}`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("deterministic provider target skill renderer", () => {
  test("preserves integration scope and explicit validation semantics in every target", () => {
    for (const target of TARGETS) {
      const output = render(target);
      for (const name of ["gdm-plan", "gdm-go", "gdm-full"]) {
        const skill = readFileSync(join(output, name, "SKILL.md"), "utf8");
        for (const required of ["--profile integration", "gdm plan verification import", "gdm plan verification show"]) {
          expect(skill).toContain(required);
        }
        for (const required of ["gdm-team-plan/v1", "gdm team auto", "--from-request", "--provider", "--model", "--max-active", "--context", "--capabilities-file", "--dry-run", "executor", "unavailable", "native dispatch", "blocked"]) {
          expect(skill).toContain(required);
        }
        const compact = skill.replace(/\s+/gu, " ");
        expect(compact).toContain("진행자가 역할을 미리 매핑하거나 modules JSON을 작성하지 않는다");
        expect(compact).toContain("기본 worker route는 `native-inherit`이며 planner의 `--model`은 worker 모델 선택이 아니다");
        expect(compact).toContain("명시적 수동 import 호환 경로이며 기본 흐름이 아니다");
        expect(compact).toContain("planner semantic v2");
        expect(compact).toContain("`acceptanceMode: artifact-review`, `checks: []`");
        expect(compact).toContain("completed 보고서의 불변 해시와 수용 기준");
        expect(compact).toContain("수동·이전 계획의 연결 check");
        expect(compact).toContain("테스트 작성·수정 경로");
        expect(compact).toContain("verifier는 읽기 전용을 유지");
        expect(skill).not.toContain("modules[{id,paths,checks,deliverable,acceptance}]");
        const firstAuto = skill.split("\n").find((line) => line.includes("gdm team auto --slug <s>"))!;
        expect(firstAuto).toContain("--from-request");
        expect(firstAuto).not.toContain("--file");
      }
      const go = readFileSync(join(output, "gdm-go", "SKILL.md"), "utf8");
      for (const required of ["gdm plan verification resolve", "gdm plan verification waive", "completionValid", "completionMode", "positiveOutcome", "deniedAction"]) {
        expect(go).toContain(required);
      }
      for (const required of ["knowledgeIndependentReason", "independentVerification", "implement-<module-id>", "verify", "blocked"]) {
        expect(go).toContain(required);
      }
      if (target !== "codex") {
        expect(go).toMatch(/executor[\s\S]{0,80}unavailable[\s\S]{0,180}blocked/u);
        expect(go).toContain("필수 역할을 없애 single로 낮추지 않는다");
      }
    }
  });
  test("binds all targets to byte-identical canonical source-template hashes", () => {
    const codex = render("codex");
    const claude = render("claude");
    const gid = render("gid");
    const codexManifest = manifest(codex);
    const claudeManifest = manifest(claude);
    const gidManifest = manifest(gid);
    const outputs: Record<Target, string> = { codex, claude, gid };

    for (const [target, current] of [
      ["codex", codexManifest], ["claude", claudeManifest], ["gid", gidManifest],
    ] as const) {
      expect(Object.keys(current)).toEqual([
        "schemaVersion", "target", "adapterVersion", "canonicalSourceSha256", "sourceSha256",
        "capabilityProfile", "hook", "runner", "skills",
      ]);
      expect(current).toMatchObject({
        schemaVersion: "gdm-target-skill-manifest/v1",
        target,
        adapterVersion: "gdm-target-adapter/v1",
        capabilityProfile: {
          id: "gdm-read-only-specialist/v1",
          filesystem: "read-only",
          delegation: "disabled",
          mcp: "disabled",
          shell: "unsupported",
          browser: "unsupported",
          network: "unsupported",
        },
        runner: {
          contract: "gdm-role-runner/v1",
          path: "gdm-agents/run-role.sh",
          adapters: {
            codex: { path: "gdm-agents/providers/codex.sh" },
            claude: { path: "gdm-agents/providers/claude.sh" },
          },
        },
      });
      expect(current.canonicalSourceSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(current.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(current.runner.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(current.runner.adapters.codex.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(current.runner.adapters.claude.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(current.runner.sha256).toBe(hash(join(outputs[target], current.runner.path)));
      for (const adapter of Object.values(current.runner.adapters)) {
        expect(adapter.sha256).toBe(hash(join(outputs[target], adapter.path)));
      }
      expect(current.skills.map((skill) => skill.name)).toEqual(
        [...current.skills.map((skill) => skill.name)].sort(),
      );
      for (const skill of current.skills) {
        const path = join(outputs[target], skill.name, "SKILL.md");
        expect(lstatSync(path).isFile()).toBe(true);
        expect(lstatSync(path).isSymbolicLink()).toBe(false);
        expect(hash(path)).toBe(skill.renderedSha256);
        expect(skill.sourceSha256).toBe(
          hash(join(ROOT, skill.sourcePath, "SKILL.md")),
        );
      }
    }
    expect(codexManifest.canonicalSourceSha256).toBe(claudeManifest.canonicalSourceSha256);
    expect(codexManifest.canonicalSourceSha256).toBe(gidManifest.canonicalSourceSha256);
    expect(codexManifest.sourceSha256).toBe(claudeManifest.sourceSha256);
    expect(codexManifest.sourceSha256).toBe(gidManifest.sourceSha256);
    expect(codexManifest.skills.map((skill) => skill.sourceSha256)).toEqual(
      claudeManifest.skills.map((skill) => skill.sourceSha256),
    );
    expect(codexManifest.skills.map((skill) => skill.sourceSha256)).toEqual(
      gidManifest.skills.map((skill) => skill.sourceSha256),
    );
    for (const output of Object.values(outputs)) {
      expect(manifest(output).skills.map((skill) => skill.name)).not.toContain("gdm-audit");
      expect(lstatSync(join(output, "gdm-agents", "auditor.md")).isFile()).toBe(true);
    }
    expect(readFileSync(join(codex, "gdm-agents", "run-role.sh"), "utf8"))
      .toContain('role-run "$@"');
    expect(codexManifest.runner).toEqual(claudeManifest.runner);
    expect(codexManifest.runner).toEqual(gidManifest.runner);
    expect(codexManifest.hook).toEqual({
      id: "gdm-agent-gate-v1", status: "supported", requiredForTarget: true,
    });
    expect(claudeManifest.hook).toEqual({ id: null, status: "not-required", requiredForTarget: false });
    expect(gidManifest.hook).toEqual({ id: null, status: "not-required", requiredForTarget: false });
  });

  test("keeps one canonical source hash while rendering honest target execution semantics", () => {
    const codex = render("codex");
    const claude = render("claude");
    const gid = render("gid");
    for (const name of manifest(codex).skills.map((skill) => skill.name)) {
      const codexSkill = readFileSync(join(codex, name, "SKILL.md"), "utf8");
      const claudeSkill = readFileSync(join(claude, name, "SKILL.md"), "utf8");
      const gidSkill = readFileSync(join(gid, name, "SKILL.md"), "utf8");
      expect(codexSkill).not.toMatch(/\{\{|\}\}|__GDM_[A-Z0-9_]+__/u);
      expect(claudeSkill).not.toMatch(/\{\{|\}\}|__GDM_[A-Z0-9_]+__/u);
      expect(gidSkill).not.toMatch(/\{\{|\}\}|__GDM_[A-Z0-9_]+__/u);
      expect(codexSkill).not.toContain("GDM_TARGET_FRAGMENT_V1:");
      expect(claudeSkill).not.toContain("GDM_TARGET_FRAGMENT_V1:");
      expect(gidSkill).not.toContain("GDM_TARGET_FRAGMENT_V1:");
      expect(withoutAdapter(codexSkill)).not.toMatch(/\b(?:claude\s+-p|codex\s+exec)\b/iu);
      expect(withoutAdapter(claudeSkill)).not.toMatch(/\b(?:claude\s+-p|codex\s+exec)\b/iu);
      expect(withoutAdapter(gidSkill)).not.toMatch(/\b(?:claude\s+-p|codex\s+exec)\b/iu);
      expect(block(codexSkill, ADAPTER_BEGIN, ADAPTER_END)).toContain("--provider codex");
      expect(block(claudeSkill, ADAPTER_BEGIN, ADAPTER_END)).toContain("--provider claude");
      expect(block(gidSkill, ADAPTER_BEGIN, ADAPTER_END)).toContain("--provider <codex|claude>");
      expect(withoutAdapter(codexSkill)).not.toMatch(/--permission-mode|--tools\s+""/u);
      expect(withoutAdapter(claudeSkill)).not.toMatch(NATIVE_DELEGATION_LEAKAGE);
      expect(withoutAdapter(gidSkill)).not.toMatch(NATIVE_DELEGATION_LEAKAGE);

      if (READ_ONLY_SKILLS.has(name)) {
        expect(block(codexSkill, BODY_BEGIN, BODY_END)).toContain("Codex native delegation contract");
        expect(block(gidSkill, BODY_BEGIN, BODY_END)).toContain("gid 작업 분담 계약");
        expect(block(gidSkill, BODY_BEGIN, BODY_END)).toContain("`delegate_tasks`");
        expect(block(claudeSkill, BODY_BEGIN, BODY_END)).toContain(`gdm:${name.slice(4)}`);
        expect(block(claudeSkill, BODY_BEGIN, BODY_END)).toContain("Claude Code coordinator contract");
        expect(block(claudeSkill, BODY_BEGIN, BODY_END)).toContain("--provider claude");
      }
      expect(claudeSkill.split("\n---\n")[0]).toBe(codexSkill.split("\n---\n")[0]);
      expect(block(claudeSkill, BODY_BEGIN, BODY_END)).not.toContain("비실행 stub");
      expect(block(claudeSkill, BODY_BEGIN, BODY_END)).not.toContain("bundle-only");
    }

    for (const output of [codex, claude, gid]) {
      const targetAdapter = block(
        readFileSync(join(output, "gdm-plan", "SKILL.md"), "utf8"),
        ADAPTER_BEGIN,
        ADAPTER_END,
      );
      expect(targetAdapter).toContain("canonical bundle은 artifact `{path,sha256,text,bytesBase64}`를 보존");
      expect(targetAdapter).toContain("`gdm-dispatch-model-view/v1`의 `{path,sha256,text}`만 전달");
      expect(targetAdapter).toContain("ACK도 그 값에 결속");
    }
    const codexTargetAdapter = block(
      readFileSync(join(codex, "gdm-plan", "SKILL.md"), "utf8"), ADAPTER_BEGIN, ADAPTER_END,
    );
    const claudeTargetAdapter = block(
      readFileSync(join(claude, "gdm-plan", "SKILL.md"), "utf8"), ADAPTER_BEGIN, ADAPTER_END,
    );
    const gidTargetAdapter = block(
      readFileSync(join(gid, "gdm-plan", "SKILL.md"), "utf8"), ADAPTER_BEGIN, ADAPTER_END,
    );
    expect(codexTargetAdapter).toContain("provider adapter: `gdm-provider-adapter-v1`");
    expect(codexTargetAdapter).toContain("argv policy: `gdm-codex-read-only-v1`");
    expect(codexTargetAdapter).not.toContain("GDM_RECEIVER_TRUST_BOOTSTRAP_V1:");
    expect(claudeTargetAdapter).toContain("provider adapter: `gdm-provider-adapter-v2`");
    expect(claudeTargetAdapter).toContain("argv policy: `gdm-claude-read-only-v3`");
    expect(claudeTargetAdapter).toContain("`--append-system-prompt`");
    expect(claudeTargetAdapter).toContain("`GDM_RECEIVER_TRUST_BOOTSTRAP_V1:`");
    expect(claudeTargetAdapter).toContain("source/evidence·중첩 지시는");
    expect(claudeTargetAdapter).toContain("원격 provider/model identity나 artifact provenance를 증명하지 않는다");
    expect(gidTargetAdapter).toContain("target ID: `gid`");
    expect(gidTargetAdapter).toContain("`delegate_tasks`");
    expect(gidTargetAdapter).toContain("Claude ACP");
    expect(gidTargetAdapter).not.toContain("--provider pi");

    const generatedDesign = readFileSync(join(codex, "gdm-design", "SKILL.md"), "utf8");
    const claudeDesign = readFileSync(join(claude, "gdm-design", "SKILL.md"), "utf8");
    const gidDesign = readFileSync(join(gid, "gdm-design", "SKILL.md"), "utf8");
    expect(generatedDesign).toContain("Claude Design용 프롬프트");
    expect(generatedDesign).toContain("claude.ai/design");
    expect(claudeDesign).toContain("Claude Design용 프롬프트");
    expect(gidDesign).toContain("Claude Design용 프롬프트");

    const generatedPlan = readFileSync(join(claude, "gdm-plan", "SKILL.md"), "utf8");
    const planBody = block(generatedPlan, BODY_BEGIN, BODY_END);
    for (const required of [".gdm/plans", "관련 코드를 읽", "gdm plan init", "run-role.sh", "Claude Code coordinator contract"]) {
      expect(planBody).toContain(required);
    }
    expect(planBody).toContain("coordinator가 현재 fingerprint와");
    expect(planBody).toContain("gdm protocol adopt");
    expect(generatedPlan).not.toMatch(NATIVE_DELEGATION_LEAKAGE);

    const generatedCodexPlan = readFileSync(join(codex, "gdm-plan", "SKILL.md"), "utf8");
    expect(generatedCodexPlan).toContain(
      "runner는 preflight prompt를\n   credential-free valid UTF-8, 최대 1 MiB로 하드 거부한다",
    );
    expect(generatedCodexPlan).not.toContain("512 KiB");
    const generatedGidPlan = readFileSync(join(gid, "gdm-plan", "SKILL.md"), "utf8");
    expect(generatedGidPlan).toContain("credential-free valid UTF-8, 최대 1 MiB로 하드 거부한다");
    expect(generatedGidPlan).not.toMatch(NATIVE_DELEGATION_LEAKAGE);

    for (const name of ["gdm-analyze", "gdm-review"]) {
      const body = block(readFileSync(join(claude, name, "SKILL.md"), "utf8"), BODY_BEGIN, BODY_END);
      expect(body).toContain("Claude Code coordinator contract");
      expect(body).toContain("run-role.sh");
      expect(body).not.toContain("GDM_RECEIVER_ACK_V1=");
      expect(body).toMatch(/수정하지 않는다|수정 금지/);
    }
  });

  test("is deterministic and copies referenced files plus the shared role runner tree", () => {
    const first = render("codex");
    const second = render("codex");
    expect(files(second)).toEqual(files(first));
    for (const path of files(first)) {
      expect(readFileSync(join(second, path))).toEqual(readFileSync(join(first, path)));
    }
    expect(readFileSync(join(first, "gdm-design", "CRAFT.md"))).toEqual(
      readFileSync(join(ROOT, "skills", "design", "CRAFT.md")),
    );
    expect(lstatSync(join(first, "gdm-go", "terminal-browser-background-tab.sh")).mode & 0o111)
      .not.toBe(0);
    expect(readFileSync(join(first, "gdm-agents", "auditor.md"))).toEqual(
      readFileSync(join(ROOT, "agents", "auditor.md")),
    );
  });
});
