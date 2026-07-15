import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const INSTALL = join(ROOT, "install", "install.sh");
const decoder = new TextDecoder();
const PATTERN = "learning.minimal-rule-after-recurrence";

type ProcessResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
type InstalledGdm = { readonly binary: string; readonly home: string; readonly output: string };
type JsonObject = { readonly [key: string]: unknown };

function run(program: string, cwd: string, args: readonly string[], home?: string): ProcessResult {
  const result = Bun.spawnSync([program, ...args], {
    cwd,
    env: home === undefined ? process.env : { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function installGdm(): InstalledGdm {
  const home = tempDirectory("gdm-install-home-");
  const result = run("bash", ROOT, [INSTALL], home);
  expect(result.exitCode).toBe(0);
  return {
    binary: join(home, ".local", "bin", "gdm"),
    home,
    output: `${result.stdout}${result.stderr}`,
  };
}

function skill(name: string): string {
  return readFileSync(join(ROOT, "skills", name, "SKILL.md"), "utf8");
}

function frontmatter(contents: string): string {
  if (!contents.startsWith("---\n")) throw new Error("skill frontmatter must start on byte zero");
  const end = contents.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("skill frontmatter must have a closing delimiter");
  return contents.slice(4, end);
}

function hasDescription(metadata: string): boolean {
  const lines = metadata.split("\n");
  const index = lines.findIndex((line) => line.startsWith("description:"));
  const declaration = index < 0 ? undefined : lines[index];
  if (declaration === undefined) return false;
  const value = declaration.slice("description:".length).trim();
  if (value.length > 0 && value !== "|" && value !== ">") return true;
  return lines.slice(index + 1).some((line) => /^\s+\S/u.test(line));
}

function metadataKeys(metadata: string): readonly string[] {
  return metadata.split("\n").flatMap((line) => {
    const match = /^([a-z][a-z-]*):/u.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonObject {
  if (!isObject(value)) throw new Error("expected object");
  return value;
}

function ledgerEvents(cwd: string): readonly JsonObject[] {
  const bytes = readFileSync(join(cwd, ".gdm", "habits", "ledger.jsonl"), "utf8");
  return bytes.trim().split("\n").map((line) => object(JSON.parse(line)));
}

function observationFixture(): readonly JsonObject[] {
  return [
    {
      schemaVersion: 1,
      pattern: PATTERN,
      taxonomy: "recovery",
      sourceToken: "src-a1",
      sourceGroup: "grp-a1",
      sourceKind: "incident",
    },
    {
      schemaVersion: 1,
      pattern: PATTERN,
      taxonomy: "recovery",
      sourceToken: "src-b1",
      sourceGroup: "grp-b1",
      sourceKind: "principle",
    },
  ];
}

function importFixture(binary: string, home: string, cwd: string): readonly string[] {
  const observations = observationFixture();
  const input = observations.map((value) => JSON.stringify(value)).join("\n");
  writeFileSync(join(cwd, "observations.jsonl"), `${input}\n`);
  expect(run(binary, cwd, ["habit", "import", "--file", "observations.jsonl"], home).exitCode).toBe(0);
  return ledgerEvents(cwd).flatMap((event) =>
    typeof event.eventId === "string" ? [event.eventId] : [],
  );
}

describe("gdm installation and workflow skills", () => {
  test("every skill has discoverable metadata and reflect installs for both hosts", () => {
    // Given: an isolated HOME and every repository skill.
    const installed = installGdm();

    // When: skill metadata and the installed host links are inspected.
    for (const name of readdirSync(join(ROOT, "skills"))) {
      const path = join(ROOT, "skills", name, "SKILL.md");
      if (!existsSync(path)) continue;
      const metadata = frontmatter(readFileSync(path, "utf8"));
      expect(metadataKeys(metadata)).toEqual(["name", "description"]);
      expect(metadata.split("\n")).toContain(`name: gdm-${name}`);
      expect(hasDescription(metadata)).toBe(true);
    }

    // Then: reflect is visible to both hosts and the compiled doctor's output.
    for (const host of [".claude", ".codex"]) {
      expect(lstatSync(join(installed.home, host, "skills", "gdm-reflect")).isSymbolicLink()).toBe(true);
    }
    expect(installed.output).toContain("gdm-reflect: claude[OK] codex[OK]");
    unlinkSync(join(installed.home, ".codex", "skills", "gdm-reflect"));
    const doctor = run(installed.binary, ROOT, ["doctor"], installed.home);
    expect(doctor.stdout).toContain("gdm-reflect: claude[OK] codex[없음]");
    expect(doctor.stdout).toContain("누락 스킬은 install/install.sh 실행으로 설치");
  });

  test("installed gdm skills close a proposed but unadopted reflection loop", () => {
    // Given: the temp-HOME compiled binary and normalized incident/principle observations.
    const installed = installGdm();
    const cwd = tempDirectory("gdm-reflect-loop-");
    const sourceIds = importFixture(installed.binary, installed.home, cwd);

    // When: the installed binary creates the smallest evidence-backed proposal.
    const proposed = run(installed.binary, cwd, [
      "habit", "propose", "--pattern", PATTERN,
      "--statement", "같은 실패가 반복되면 재시도 규칙 하나만 추가한다",
      ...sourceIds.flatMap((eventId) => ["--source-event", eventId]),
    ], installed.home);

    // Then: the candidate exists, adoption does not, and the skill stops at the owner gate.
    expect(proposed.exitCode).toBe(0);
    const events = ledgerEvents(cwd);
    expect(events.some((event) => event.kind === "proposal")).toBe(true);
    expect(events.some((event) => event.kind === "adoption")).toBe(false);
    const reflect = readFileSync(join(installed.home, ".codex", "skills", "gdm-reflect", "SKILL.md"), "utf8");
    expect(reflect).toContain("ADOPTION_REQUIRED");
    expect(reflect).toContain("이 스킬은 `habit adopt`를 실행하지 않는다");
    expect(reflect).toContain("정규화된 여섯 필드 observation");
  });

  test("forbidden delivery and raw source input stop without mutation", () => {
    // Given: a proposed ledger, a temp git repository, and a default-forbidden work contract.
    const installed = installGdm();
    const cwd = tempDirectory("gdm-reflect-denial-");
    expect(run("git", cwd, ["init", "-b", "main"]).exitCode).toBe(0);
    const sourceIds = importFixture(installed.binary, installed.home, cwd);
    expect(run(installed.binary, cwd, [
      "habit", "propose", "--pattern", PATTERN,
      "--statement", "같은 실패가 반복되면 재시도 규칙 하나만 추가한다",
      ...sourceIds.flatMap((eventId) => ["--source-event", eventId]),
    ], installed.home).exitCode).toBe(0);
    const ledgerPath = join(cwd, ".gdm", "habits", "ledger.jsonl");
    const ledgerBefore = readFileSync(ledgerPath, "utf8");
    const headBefore = run("git", cwd, ["symbolic-ref", "HEAD"]);
    const indexBefore = run("git", cwd, ["write-tree"]);
    expect(headBefore.exitCode).toBe(0);
    expect(indexBefore.exitCode).toBe(0);
    expect(run(installed.binary, cwd, [
      "plan", "init", "--slug", "delivery-check", "--brief", "전달 경계",
      "--require", "사용자 소유 변경 보존", "--forbid", "자동 커밋",
    ], installed.home).exitCode).toBe(0);
    const rawPath = "/private/source/transcript.md";
    writeFileSync(join(cwd, "raw.jsonl"), `${JSON.stringify({ ...observationFixture()[0], summary: rawPath })}\n`);

    // When: a raw-path import and the machine-readable delivery gate are attempted.
    const raw = run(installed.binary, cwd, ["habit", "import", "--file", "raw.jsonl"], installed.home);
    const delivery = run(installed.binary, cwd, [
      "plan", "contract", "--slug", "delivery-check", "--check-commit",
    ], installed.home);

    // Then: both stop safely without changing habit, HEAD, or index state.
    expect(raw.exitCode).toBe(5);
    expect(`${raw.stdout}${raw.stderr}`).not.toContain(rawPath);
    expect(delivery.exitCode).toBe(4);
    expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBefore);
    expect(run("git", cwd, ["symbolic-ref", "HEAD"]).stdout).toBe(headBefore.stdout);
    expect(run("git", cwd, ["write-tree"]).stdout).toBe(indexBefore.stdout);
  });

  test("workflow skills preserve contract retry review and delivery gates", () => {
    // Given: the installed workflow skill sources.
    const plan = skill("plan");
    const go = skill("go");
    const full = skill("full");
    const review = skill("review");
    const pr = skill("pr");
    const routing = readFileSync(join(ROOT, "skills", "_shared", "routing.md"), "utf8");

    // When: their explicit boundaries are inspected.
    // Then: each stage owns one observable gate in gdm's evidence loop.
    expect(plan).toContain("--require");
    expect(plan).toContain("--forbid");
    expect(go).toContain("gdm attempt fail");
    expect(go).toContain("gdm attempt retry");
    expect(go).toContain("--changed <종류> --evidence <파일>");
    expect(go).toContain("gdm habit harvest");
    expect(go).toMatch(/NEVER:[\s\S]*stage, commit, push, PR/u);
    expect(full).toMatch(/NEVER:[\s\S]*stage,\s+commit, push, PR/u);
    expect(full).toContain("실제 구현 모델과 다른 모델");
    expect(full).toContain("--audit --require <보존> --forbid <금지>");
    expect(full).toContain("INDEPENDENCE_BLOCKED");
    expect(review).toContain("confirmed");
    expect(review).toContain("duplicate");
    expect(review).toContain("rejected");
    expect(review).toContain("새 confirmed 유형이 나오지 않으면 탐색을 끝낸다");
    expect(pr).toContain("gdm plan contract --check-commit");
    expect(pr).toContain("Co-Authored-By");
    expect(pr).toContain("읽기 전용");
    expect(skill("reflect")).toContain("cleanup trap");
    expect(routing).toContain("제품 파일을 쓰는 실제 구현 주체는 한 명");
    expect(routing).toContain("실제 diff를 만든 구현 모델과 달라야 한다");
  });
});
