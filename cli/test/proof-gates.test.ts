import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultContract } from "../src/contract.ts";
import {
  addCheck,
  closeWork,
  editCheck,
  initWork,
  passCheck,
  recordAudit,
  recordRedEvidence,
} from "../src/state.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();
const NOW = "2026-08-04T00:00:00.000Z";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "gdm-proof-"));
}

function run(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

describe("proof gates", () => {
  test("regression check records a failing red run before the green pass", () => {
    const cwd = tempDir();
    expect(run(cwd, [
      "plan", "init", "--slug", "red-green", "--brief", "fix regression", "--require", "회귀 재현",
    ]).exitCode).toBe(0);
    expect(run(cwd, [
      "plan", "add", "--slug", "red-green", "--desc", "fixed marker",
      "--cmd", "test -f fixed.txt", "--expect", "marker exists", "--kind", "regression",
    ]).exitCode).toBe(0);

    const premature = run(cwd, ["pass", "c1", "--slug", "red-green"]);
    expect(premature.exitCode).toBe(4);
    expect(premature.stderr).toContain("--red");

    const red = run(cwd, ["pass", "c1", "--red", "--slug", "red-green"]);
    expect(red.exitCode).toBe(0);
    writeFileSync(join(cwd, "fixed.txt"), "fixed\n");
    const green = run(cwd, ["pass", "c1", "--slug", "red-green"]);
    expect(green.exitCode).toBe(0);

    const work = JSON.parse(readFileSync(join(cwd, ".gdm", "red-green", "checks.json"), "utf8"));
    expect(work.checks[0].redEvidence.exitCode).not.toBe(0);
    expect(work.checks[0].evidence.exitCode).toBe(0);
    expect(Date.parse(work.checks[0].redEvidence.at)).toBeLessThanOrEqual(Date.parse(work.checks[0].evidence.at));
  });

  test("editing a regression definition invalidates both red and green proof", () => {
    let work = initWork("regression-edit", "edit", NOW);
    ({ work } = addCheck(work, {
      desc: "bug", cmd: "false", expect: "fixed", kind: "regression",
    }));
    work = recordRedEvidence(
      work,
      "c1",
      { observed: "red.txt", sha256: "red", exitCode: 1, manual: false },
      NOW,
    );
    work = passCheck(work, "c1", { observed: "green.txt", sha256: "green", exitCode: 0, manual: false }, NOW);
    const edited = editCheck(work, "c1", { cmd: "test true" }, "명령 강화").work.checks[0]!;
    expect(edited.status).toBe("open");
    expect(edited.redEvidence).toBeUndefined();
    expect(edited.evidence).toBeUndefined();
  });

  test("high and opaque work requires attributed expert evidence and an independent audit", () => {
    const contract = { ...defaultContract(), risk: "high" as const, verification: "opaque" as const };
    let missing = initWork("opaque-missing", "opaque", NOW, true, contract);
    ({ work: missing } = addCheck(missing, { desc: "regular", cmd: "true", expect: "ok" }));
    missing = passCheck(missing, "c1", { observed: "out.txt", sha256: "green", manual: false }, NOW);
    expect(() => closeWork(missing, NOW)).toThrow(/전문가 확인/);

    let work = initWork("opaque-expert", "opaque", NOW, true, contract);
    ({ work } = addCheck(work, { desc: "expert review", expect: "safe", manual: true, expert: true }));
    expect(() => passCheck(work, "c1", { observed: "review.md", sha256: "review", manual: true }, NOW)).toThrow(
      /reviewer.*판단 근거/,
    );
    work = passCheck(
      work,
      "c1",
      { observed: "review.md", sha256: "review", manual: true, reviewer: "domain-owner", note: "위험 허용" },
      NOW,
    );
    work = recordAudit(work, "pass", "audit.md", "a".repeat(64), "Codex", "Claude", null, NOW);
    expect(closeWork(work, NOW).done).toBe(true);
  });
});
