import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const TARGETS = ["codex", "claude", "gid"] as const;
const MARKER = "<!-- GDM_AUTOMATIC_ENTRY_V1 -->";
const BEGIN = "<!-- GDM_AUTOMATIC_ENTRY_BODY_V1_BEGIN -->";
const END = "<!-- GDM_AUTOMATIC_ENTRY_BODY_V1_END -->";
const roots: string[] = [];
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "gdm-entry-render-"));
  roots.push(path);
  return path;
}
function render(target: typeof TARGETS[number], source = join(ROOT, "skills")) {
  const output = join(temp(), target);
  const run = Bun.spawnSync(["bun", join(ROOT, "install/render-skills.ts"), "--target", target,
    "--output", output, "--source-root", source, "--agents-root", join(ROOT, "agents")],
  { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { output, code: run.exitCode, error: run.stderr.toString() };
}
function text(output: string, skill: string): string {
  return readFileSync(join(output, `gdm-${skill}`, "SKILL.md"), "utf8");
}
function body(source: string): string {
  expect(source.split(BEGIN)).toHaveLength(2);
  expect(source.split(END)).toHaveLength(2);
  return source.split(BEGIN)[1]!.split(END)[0]!;
}
function ordered(source: string, values: string[]): void {
  let position = -1;
  for (const value of values) {
    const next = source.indexOf(value, position + 1);
    expect(next, `missing or out of order: ${value}`).toBeGreaterThan(position);
    position = next;
  }
}
function fixture(): string {
  const source = join(temp(), "skills");
  cpSync(join(ROOT, "skills"), source, { recursive: true });
  return source;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("automatic request entry rendering", () => {
  test("publishes identical shared entry workflow exactly once in go/full for every host", () => {
    const shared = readFileSync(join(ROOT, "skills/_shared/automatic-entry.md"), "utf8").trimEnd();
    const bodies: string[] = [];
    for (const target of TARGETS) {
      const result = render(target);
      expect(result.code, result.error).toBe(0);
      const manifest = JSON.parse(readFileSync(join(result.output, "gdm-target-manifest.json"), "utf8"));
      for (const skill of manifest.skills) {
        const source = readFileSync(join(result.output, skill.name, "SKILL.md"), "utf8");
        expect(source).not.toContain(MARKER);
        expect(createHash("sha256").update(source).digest("hex")).toBe(skill.renderedSha256);
        if (["gdm-go", "gdm-full"].includes(skill.name)) {
          expect(source).toContain(shared);
          bodies.push(body(source));
        } else {
          expect(source).not.toContain(BEGIN);
        }
      }
    }
    expect(new Set(bodies).size).toBe(1);
  });

  test("bridges model decision, safe continuation, adaptive planning and actual native acceptance in order", () => {
    for (const target of TARGETS) {
      const result = render(target);
      expect(result.code, result.error).toBe(0);
      for (const skill of ["go", "full"]) {
        const workflow = body(text(result.output, skill));
        ordered(workflow, ["gdm entry status", "--kind question", "--kind optout", "--kind work",
          "activeWorkSlug", "gdm protocol export", "gdm plan init", "--slug <s>",
          "gdm team auto", "single/coordinated", "gdm team claim", "gdm team report",
          "gdm pass", "gdm team review", "독립 verification", "gdm done"]);
        for (const required of ["현재 대화 모델", "원문·대화 맥락", "별도 유료 분류기", "기본 `gdm-go`",
          "Work·check·team planner는 만들지 않는다", "기존 Work는 보존", "다음 요청은 다시 판단",
          "임의 세션이나 token", "미완료 결속을 조용히 교체", "새 Work·새 planner",
          "실제 가용 슬롯", "사용자 비용", "고정", "상속 route", "blocked", "모델을 몰래 바꾸",
          "spawn **전에**", "유일한 assignee·attempt", "실패 artifact", "현재 `--attempt`",
          "artifact-review", "GDM_ENTRY_DISABLED=1", "native 작업자는 새 루트 Work를 만들지 않고",
          "의미가 맞다는 기계적 증명이 아니다"]) expect(workflow).toContain(required);
      }
    }
  });

  test("exposes callable host tools and truthful event and enforcement boundaries", () => {
    const sources = Object.fromEntries(TARGETS.map(target => {
      const result = render(target);
      expect(result.code, result.error).toBe(0);
      return [target, text(result.output, "go")];
    }));
    for (const target of TARGETS) {
      expect(sources[target]).toContain("gdm-entry-v1");
      expect(sources[target]).toContain("GDM_AUTOMATIC_ENTRY_V1");
    }
    for (const required of ["UserPromptSubmit", "spawn_agent", "followup_task", "agent_id", "PreToolUse", "Stop",
      "shell·MCP", "설치 성공만으로 활성 세션의 자동 진입을 보장하지 않는다"]) expect(sources.codex).toContain(required);
    for (const required of ["UserPromptSubmit", "`Agent`", "실제 tool metadata", "PreToolUse", "Stop", "안정적인 turn ID",
      "정확히 한 번 전달을 보장하지 않는다", "quota·권한 실패"]) expect(sources.claude).toContain(required);
    for (const required of ["`input`", "`before_turn`", "`delegate_tasks`", "tasks: [{id, prompt, paths, access, deliverable, acceptance}]",
      "1–3개", "상속하는 leaf", "context-only", "block_reason", "세션에 결속된 coordinated Work",
      "gid extension add <manifest> --trust", "기존 permission mode", "Claude ACP"]) expect(sources.gid).toContain(required);
    expect(sources.gid).not.toContain("spawn_agent");
    expect(sources.claude).not.toContain("spawn_agent");
  });

  test("rejects missing, duplicate and wrongly scoped entry markers instead of publishing incomplete skills", () => {
    for (const [name, transform] of [
      ["go", (s: string) => s.replace(MARKER, "")],
      ["full", (s: string) => s.replace(MARKER, `${MARKER}\n${MARKER}`)],
      ["review", (s: string) => `${s}\n${MARKER}\n`],
    ] as const) {
      const source = fixture();
      const path = join(source, name, "SKILL.md");
      writeFileSync(path, transform(readFileSync(path, "utf8")));
      const result = render("codex", source);
      expect(result.code).not.toBe(0);
      expect(result.error).toContain(`automatic entry fragment count mismatch: ${name}`);
    }
  });

  test("rejects absent or symlinked shared entry assets and binds shared changes to manifest hashes", () => {
    for (const symlink of [false, true]) {
      const source = fixture();
      const path = join(source, "_shared/automatic-entry.md");
      rmSync(path);
      if (symlink) symlinkSync(join(ROOT, "skills/_shared/automatic-entry.md"), path);
      expect(render("gid", source).code).not.toBe(0);
    }
    const source = fixture();
    const before = render("claude", source);
    expect(before.code, before.error).toBe(0);
    const path = join(source, "_shared/automatic-entry.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nEntry fixture revision.\n`);
    const after = render("claude", source);
    expect(after.code, after.error).toBe(0);
    const manifest = (output: string) => JSON.parse(readFileSync(join(output, "gdm-target-manifest.json"), "utf8"));
    expect(manifest(after.output).sourceSha256).not.toBe(manifest(before.output).sourceSha256);
    expect(text(after.output, "go")).toContain("Entry fixture revision.");
    expect(text(after.output, "go")).not.toBe(text(before.output, "go"));
    expect(text(after.output, "review")).toBe(text(before.output, "review"));
  });
});
