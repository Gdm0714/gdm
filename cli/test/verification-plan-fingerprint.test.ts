import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checksHash, verificationPlanFingerprint } from "../src/state.ts";
import type { Work } from "../src/types.ts";

type Fixture = {
  readonly schemaVersion: number;
  readonly work: unknown;
  readonly sha256: string;
};

const fixturePath = join(import.meta.dir, "..", "..", "fixtures", "verification-plan-fingerprint-v1.json");

function fixture(): { readonly work: Work; readonly sha256: string } {
  const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
  expect(parsed.schemaVersion).toBe(1);
  return { work: parsed.work as Work, sha256: parsed.sha256 };
}

describe("verification plan fingerprint v1", () => {
  test("matches the shared Korean, slash, null, and legacy-default fixture", () => {
    const { work, sha256 } = fixture();

    expect(verificationPlanFingerprint(work)).toBe(sha256);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("omitted fields and their documented defaults have the same identity", () => {
    const { work, sha256 } = fixture();
    const explicitDefaults = {
      ...work,
      auditRequired: false,
      contract: {
        ...work.contract,
        commit: "forbidden" as const,
        assumptions: [],
        uncertainties: [],
        allowedPaths: ["."],
        forbiddenPaths: [],
        stopConditions: [],
        risk: "low" as const,
        verification: "deterministic" as const,
        simplificationRequired: false,
      },
      checks: work.checks.map((check) => ({
        ...check,
        kind: check.manual ? "manual" as const : "behavior" as const,
        expert: false,
      })),
    };

    expect(verificationPlanFingerprint(explicitDefaults)).toBe(sha256);
  });

  test("runtime proof state is excluded while plan order and nullable commands are bound", () => {
    const { work, sha256 } = fixture();
    const runtimeOnly = {
      ...work,
      slug: "different-runtime-slug",
      done: true,
      doneAt: "2026-08-12T01:00:00.000Z",
      checks: work.checks.map((check) => ({
        ...check,
        status: "proven" as const,
        evidence: {
          observed: "out.txt",
          sha256: "a".repeat(64),
          manual: check.manual,
          at: "2026-08-12T01:00:00.000Z",
        },
      })),
    };
    expect(verificationPlanFingerprint(runtimeOnly)).toBe(sha256);
    expect(checksHash(runtimeOnly)).not.toBe(checksHash(work));

    expect(verificationPlanFingerprint({ ...work, checks: [...work.checks].reverse() })).not.toBe(sha256);
    const emptyCommand = {
      ...work,
      checks: work.checks.map((check, index) => index === 0 ? { ...check, cmd: "" } : check),
    };
    expect(verificationPlanFingerprint(emptyCommand)).not.toBe(sha256);
  });
});
