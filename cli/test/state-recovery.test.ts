import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWork } from "../src/state.ts";
import { loadWork, readJournal, saveWork } from "../src/store.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const NOW = "2026-07-15T00:00:00.000Z";
const decoder = new TextDecoder();

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "gdm-state-recovery-"));
}

function runCli(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function statePath(cwd: string, slug: string): string {
  return join(cwd, ".gdm", slug, "checks.json");
}

describe("state recovery", () => {
  test("explicit CLI repair removes only trailing NUL bytes and journals the recovery", () => {
    const cwd = tempRepo();
    const slug = "recover-state";
    const work = initWork(slug, "trailing NUL 복구", NOW);
    saveWork(cwd, work);
    const clean = readFileSync(statePath(cwd, slug));
    appendFileSync(statePath(cwd, slug), Buffer.from([0, 0]));

    expect(() => loadWork(cwd, slug)).toThrow(/JSON 파싱 실패/);
    const result = runCli(cwd, ["repair", "state", "--slug", slug, "--trailing-nul"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("trailing NUL 2바이트 제거");
    expect(loadWork(cwd, slug)).toEqual(work);
    expect(readFileSync(statePath(cwd, slug))).toEqual(clean);
    expect(runCli(cwd, ["plan", "list", "--slug", slug, "--json"]).exitCode).toBe(0);
    expect(readJournal(cwd, slug).at(-1)).toMatchObject({
      event: "state.repair",
      kind: "trailing-nul",
      removedBytes: 2,
    });
  });

  test("repair refuses clean, truncated, and non-NUL-suffix corruption without changing bytes", () => {
    const cases: Array<{ name: string; mutate: (valid: Buffer) => Buffer }> = [
      { name: "clean", mutate: (valid) => valid },
      {
        name: "truncated",
        mutate: (valid) => Buffer.concat([valid.subarray(0, valid.length - 8), Buffer.from([0])]),
      },
      {
        name: "foreign-suffix",
        mutate: (valid) => Buffer.concat([valid, Buffer.from("X"), Buffer.from([0])]),
      },
      {
        name: "nul-not-at-eof",
        mutate: (valid) => Buffer.concat([valid, Buffer.from([0]), Buffer.from("\n")]),
      },
      {
        name: "invalid-utf8",
        mutate: (valid) => Buffer.concat([valid.subarray(0, -2), Buffer.from([0xff, 0])]),
      },
      {
        name: "invalid-schema",
        mutate: () => Buffer.from('{"slug":"repair-invalid-schema"}\0'),
      },
      {
        name: "slug-mismatch",
        mutate: (valid) => Buffer.concat([
          Buffer.from(valid.toString("utf8").replace('"slug": "repair-slug-mismatch"', '"slug": "different-slug"')),
          Buffer.from([0]),
        ]),
      },
    ];

    for (const scenario of cases) {
      const cwd = tempRepo();
      const slug = `repair-${scenario.name}`;
      saveWork(cwd, initWork(slug, "거부 검증", NOW));
      const path = statePath(cwd, slug);
      const damaged = scenario.mutate(readFileSync(path));
      writeFileSync(path, damaged);

      const result = runCli(cwd, ["repair", "state", "--slug", slug, "--trailing-nul"]);

      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(path)).toEqual(damaged);
      expect(readJournal(cwd, slug)).toHaveLength(0);
    }
  });

  test("concurrent CLI saves use independent temporary files and leave valid state", async () => {
    const cwd = tempRepo();
    const slug = "concurrent-state";
    expect(runCli(cwd, [
      "plan", "init", "--slug", slug,
      "--brief", "동시 저장",
      "--require", "상태 유효",
      "--forbid", "자동 커밋",
    ]).exitCode).toBe(0);
    expect(runCli(cwd, [
      "plan", "add", "--slug", slug,
      "--desc", "초기 항목",
      "--cmd", "true",
      "--expect", "exit 0",
    ]).exitCode).toBe(0);

    const count = 32;
    const processes = Array.from({ length: count }, (_, index) => Bun.spawn([
      "bun", CLI, "plan", "edit",
      "--slug", slug,
      "--check", "c1",
      "--desc", `동시 수정 ${index}`,
      "--reason", `임시 파일 충돌 검증 ${index}`,
    ], { cwd, stdout: "ignore", stderr: "ignore" }));
    const exits = await Promise.all(processes.map((process) => process.exited));

    expect(exits).toEqual(Array.from({ length: count }, () => 0));
    expect(loadWork(cwd, slug).checks[0]?.desc).toMatch(/^동시 수정 \d+$/);
    const files = readdirSync(join(cwd, ".gdm", slug));
    expect(files.some((name) => name.includes(".tmp"))).toBe(false);
  });

  test("repair requires its explicit mode flag", () => {
    const cwd = tempRepo();
    const slug = "repair-flags";
    mkdirSync(join(cwd, ".gdm", slug), { recursive: true });
    writeFileSync(statePath(cwd, slug), "{}\0");

    const result = runCli(cwd, ["repair", "state", "--slug", slug]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--trailing-nul");
  });
});
