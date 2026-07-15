import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "cli", "src", "cli.ts");
const PUBLIC_PATHS = ["README.md", "DESIGN.md", "GITFLOW.md", "skills", "agents", "cli/src", "install"] as const;
const BANNED_PATTERNS = [
  { label: "lazycodex", pattern: /lazycodex/i },
  { label: "oh-my-codex", pattern: /oh[- ]?my[- ]?codex/i },
  { label: "omo", pattern: /(^|[^a-z])omo([^a-z]|$)/i },
  { label: "omx", pattern: /(^|[^a-z])omx([^a-z]|$)/i },
  { label: "ultrawork", pattern: /ultrawork/i },
  { label: "ralph", pattern: /ralph/i },
  { label: "momus", pattern: /momus/i },
  { label: "oracle", pattern: /oracle/i },
  { label: "대체 맵", pattern: /대체 맵/ },
] as const;

function collectFiles(path: string): readonly string[] {
  const absolute = join(ROOT, path);
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute).flatMap((name) => collectFiles(join(path, name)));
}

function findBanned(text: string): readonly string[] {
  return BANNED_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

describe("original public identity", () => {
  test("gdm opens as a personal evidence loop", () => {
    // Given: only the public README, design, and CLI opening surfaces.
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const design = readFileSync(join(ROOT, "DESIGN.md"), "utf8");

    // When: a first-time reader opens the repository or CLI help.
    const bare = Bun.spawnSync(["bun", CLI], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const help = Bun.spawnSync(["bun", CLI, "--help"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const decoder = new TextDecoder();
    const bareHelp = decoder.decode(bare.stderr);

    // Then: every opening tells the same evidence-to-habit story.
    expect(readme).toContain("작업 증거가 다음 습관을 바꾸는 개인 AI 워크플로우");
    expect(design).toContain("약속 → 증명 → 관찰 → 습관 → 비교");
    expect(bare.exitCode).toBe(0);
    expect(help.exitCode).toBe(0);
    expect(bareHelp).toContain("작업 증거가 다음 습관을 바꾸는 개인 AI 워크플로우");
    expect(decoder.decode(help.stderr)).toBe(bareHelp);
  });

  test("public product files contain no borrowed brand vocabulary", () => {
    // Given: all tracked public product surfaces.
    const files = PUBLIC_PATHS.flatMap(collectFiles);

    // When: their text is checked against the originality denylist.
    const findings = files.flatMap((file) =>
      findBanned(readFileSync(file, "utf8")).map((token) => `${relative(ROOT, file)}:${token}`),
    );

    // Then: no public file is identified through another workflow's brand.
    expect(findings).toEqual([]);
  });

  test("banned public token fails the gate", () => {
    // Given: a seeded public description that names another product.
    const seeded = "powered by oh-my-codex";

    // When: the same denylist scans it.
    const findings = findBanned(seeded);

    // Then: the gate reports the offending vocabulary.
    expect(findings).toEqual(["oh-my-codex"]);
  });
});
