import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const temporary = mkdtempSync(join(tmpdir(), "gdm-claude-coordinator-"));
const output = join(temporary, "skills");
const render = Bun.spawnSync(["bun", join(ROOT, "install/render-skills.ts"), "--target", "claude", "--output", output], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
const installed = (name: string) => readFileSync(join(output, `gdm-${name}`, "SKILL.md"), "utf8");

describe("Claude Code standalone GDM coordinator", () => {
  test("installs all workflows with discoverable original descriptions and executable bodies", () => {
    expect(render.exitCode, render.stderr.toString()).toBe(0);
    for (const name of readdirSync(join(ROOT, "skills")).filter((name) => !name.startsWith("_"))) {
      const canonical = readFileSync(join(ROOT, "skills", name, "SKILL.md"), "utf8");
      const rendered = installed(name);
      expect(rendered.split("\n---\n")[0]).toBe(canonical.split("\n---\n")[0]);
      expect(rendered).not.toContain("비실행 stub");
      expect(rendered).not.toContain("지원되는 coordinator로 반환");
      expect(rendered).not.toContain("bundle-only");
      expect(rendered).not.toContain("Codex coordinator에게 반환");
      expect(rendered).not.toContain("GDM_AGENT_ENVELOPE_V1");
      expect(rendered).not.toContain("`gdm_delegate`");
    }
    expect(installed("go")).toContain("gdm plan init");
    expect(installed("go")).toContain("gdm pass");
    expect(installed("go")).toContain("gdm done");
    expect(installed("plan")).toContain(".gdm/plans");
    expect(installed("pr")).toContain("git");
    expect(installed("db")).toContain("스키마");
    expect(installed("design")).toContain("claude.ai/design");
  });

  test("separates the Claude writer from bounded specialists without weakening full or delivery gates", () => {
    const go = installed("go");
    expect(go).toContain("Claude Code coordinator contract");
    expect(go).toContain("현재 Claude Code 세션");
    expect(go).toContain("--provider claude");
    expect(go).toContain("다른 공급자의 로그인이나 실행 파일을 요구하지 않는다");
    expect(go).toContain("`.gdm/` 아래 파일을 직접 쓰거나 고치지 않는다");
    expect(go).not.toContain("codex-fallback");
    expect(go).not.toContain("Astra medium");
    const full = installed("full");
    expect(full).toContain("실제 구현 모델과 다른 모델");
    expect(full).toContain("같은 Claude 공급자");
    expect(full).toContain("INDEPENDENCE_BLOCKED");
    expect(full).toContain("MAX_AUDITORS_PER_PASS: 1");
    expect(full).toContain("--commit explicitly-approved");
    expect(full).toContain("gdm-read-only-specialist/v1");
    expect(full).toContain("GDM_RECEIVER_ACK_V1=");
    expect(installed("plan")).toContain("coordinator-direct");
    expect(installed("design")).toContain("**다른 모델**");
    expect(installed("design")).not.toContain("다른 벤더");
  });
});
