import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexAgentLimitDoctorLines,
  readCodexAgentLimitConfig,
  RECOMMENDED_CONCURRENT_LIMIT,
} from "../src/codex-agent-limit.ts";

type Fixture = {
  readonly cwd: string;
  readonly codexHome: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

function fixture(source?: string): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), "gdm-agent-limit-test-"));
  const codexHome = join(cwd, ".codex");
  if (source !== undefined) {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), source);
  }
  return { cwd, codexHome, env: { HOME: cwd } };
}

describe("Codex agent concurrency limit", () => {
  test("missing and unset configs remain distinct", () => {
    const missing = fixture();
    expect(readCodexAgentLimitConfig(missing.cwd, missing.env)).toEqual({
      exists: false,
      invalid: false,
    });
    expect(codexAgentLimitDoctorLines(missing.cwd, missing.env)).toEqual([
      "  Codex 서브에이전트 사용자 설정: config.toml 없음 (현재 세션 유효값 미확인)",
      expect.stringContaining("/debug-config"),
    ]);

    const unset = fixture('model = "gpt-5"\n');
    expect(readCodexAgentLimitConfig(unset.cwd, unset.env)).toEqual({
      exists: true,
      official: undefined,
      legacyAgents: undefined,
      legacyFeature: undefined,
      invalid: false,
      invalidKind: undefined,
      invalidMessage: undefined,
    });
    expect(codexAgentLimitDoctorLines(unset.cwd, unset.env)).toEqual([
      "  Codex 서브에이전트 사용자 설정: 명시 상한 없음 (현재 세션 유효값 미확인)",
      "  → 16GB급 장비 권장: [agents] max_concurrent_threads_per_session = 4",
      expect.stringContaining("/debug-config"),
    ]);
  });

  test("official limits classify the recommended, high, and risky boundaries", () => {
    expect(RECOMMENDED_CONCURRENT_LIMIT).toBe(4);
    for (const scenario of [
      { limit: 4, classification: "권장 범위", lower: false },
      { limit: 5, classification: "고병렬 설정 — 메모리 압력 확인", lower: false },
      { limit: 8, classification: "고병렬 설정 — 메모리 압력 확인", lower: false },
      { limit: 9, classification: "위험 — 8개 초과", lower: true },
    ]) {
      const current = fixture(
        `[agents]\nmax_concurrent_threads_per_session = ${scenario.limit}\n`,
      );
      expect(readCodexAgentLimitConfig(current.cwd, current.env)).toMatchObject({
        exists: true,
        official: scenario.limit,
        invalid: false,
      });

      const lines = codexAgentLimitDoctorLines(current.cwd, current.env);
      expect(lines[0]).toBe(
        `  Codex 서브에이전트 사용자 설정: 동시 활성 ${scenario.limit}개 (${scenario.classification})`,
      );
      expect(lines.some((line) => line.includes("= 4로 낮추세요"))).toBe(
        scenario.lower,
      );
      expect(lines.at(-1)).toContain("/debug-config");
    }
  });

  test("invalid paths, TOML, tables, and scalar limits report precise invalid kinds", () => {
    const invalidPath = fixture();
    mkdirSync(invalidPath.codexHome, { recursive: true });
    mkdirSync(join(invalidPath.codexHome, "config.toml"));
    expect(readCodexAgentLimitConfig(invalidPath.cwd, invalidPath.env)).toMatchObject({
      exists: true,
      invalid: true,
      invalidKind: "path",
    });
    expect(codexAgentLimitDoctorLines(invalidPath.cwd, invalidPath.env)[0]).toContain(
      "config.toml 경로 오류",
    );

    const malformed = fixture("[agents\nmax_concurrent_threads_per_session = 4\n");
    expect(readCodexAgentLimitConfig(malformed.cwd, malformed.env)).toMatchObject({
      exists: true,
      invalid: true,
      invalidKind: "parse",
    });
    expect(codexAgentLimitDoctorLines(malformed.cwd, malformed.env)[0]).toContain(
      "TOML 문법 오류",
    );

    for (const source of [
      "agents = 4\n",
      "features = true\n",
      '[agents]\nmax_concurrent_threads_per_session = "4"\n',
      "[agents]\nmax_threads = 0\n",
      "[features.multi_agent_v2]\nmax_concurrent_threads_per_session = 1.5\n",
    ]) {
      const invalid = fixture(source);
      expect(readCodexAgentLimitConfig(invalid.cwd, invalid.env)).toMatchObject({
        exists: true,
        invalid: true,
        invalidKind: "shape",
        invalidMessage: "동시성 상한 또는 관련 TOML 테이블의 형식이 올바르지 않습니다",
      });
      expect(codexAgentLimitDoctorLines(invalid.cwd, invalid.env)[0]).toContain(
        "상한 설정 오류",
      );
    }
  });

  test("legacy agents.max_threads remains readable but emits migration guidance", () => {
    const legacy = fixture("[agents]\nmax_threads = 5\n");
    expect(readCodexAgentLimitConfig(legacy.cwd, legacy.env)).toMatchObject({
      official: undefined,
      legacyAgents: 5,
      legacyFeature: undefined,
      invalid: false,
    });
    expect(codexAgentLimitDoctorLines(legacy.cwd, legacy.env)).toEqual([
      "  Codex 서브에이전트 사용자 설정: legacy 동시 활성 5개 (고병렬 설정 — 메모리 압력 확인)",
      "  → 구형 상한 설정을 제거하고 [agents] max_concurrent_threads_per_session = 4만 유지하세요",
      expect.stringContaining("/debug-config"),
    ]);
  });

  test("deprecated multi_agent_v2 remains readable but emits migration guidance", () => {
    const deprecated = fixture(
      "[features.multi_agent_v2]\nmax_concurrent_threads_per_session = 9\n",
    );
    expect(readCodexAgentLimitConfig(deprecated.cwd, deprecated.env)).toMatchObject({
      official: undefined,
      legacyAgents: undefined,
      legacyFeature: 9,
      invalid: false,
    });
    expect(codexAgentLimitDoctorLines(deprecated.cwd, deprecated.env)).toEqual([
      "  Codex 서브에이전트 사용자 설정: legacy 동시 활성 9개 (위험 — 8개 초과)",
      "  → 구형 상한 설정을 제거하고 [agents] max_concurrent_threads_per_session = 4만 유지하세요",
      expect.stringContaining("/debug-config"),
    ]);
  });

  test("official value wins conflicts while every legacy value is exposed", () => {
    const conflict = fixture(
      [
        "[agents]",
        "max_concurrent_threads_per_session = 4",
        "max_threads = 6",
        "",
        "[features.multi_agent_v2]",
        "max_concurrent_threads_per_session = 7",
        "",
      ].join("\n"),
    );
    expect(readCodexAgentLimitConfig(conflict.cwd, conflict.env)).toEqual({
      exists: true,
      official: 4,
      legacyAgents: 6,
      legacyFeature: 7,
      invalid: false,
      invalidKind: undefined,
      invalidMessage: undefined,
    });
    expect(codexAgentLimitDoctorLines(conflict.cwd, conflict.env)).toEqual([
      "  Codex 서브에이전트 사용자 설정: 동시 활성 4개 (권장 범위)",
      "  → 구형 상한 설정을 제거하고 [agents] max_concurrent_threads_per_session = 4만 유지하세요",
      expect.stringContaining("/debug-config"),
    ]);
  });
});
