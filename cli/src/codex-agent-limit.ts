import { join } from "node:path";
import {
  resolveCodexHome,
  type AgentHookEnvironment,
} from "./codex-agent-hooks-config.ts";
import {
  objectValue,
  readCodexConfig,
  type CodexConfigObject,
} from "./codex-config.ts";

// Codex applies this to concurrently open spawned-agent threads, excluding the primary.
// It is a resource safety fuse, not a delegation-depth or total-spawn limit.
export const RECOMMENDED_CONCURRENT_LIMIT = 4;
const HIGH_CONCURRENT_LIMIT = 8;
const EFFECTIVE_VALUE_NOTE =
  "  → 현재 세션 유효값은 CLI·프로필·프로젝트 설정이 덮을 수 있으므로 /debug-config에서 확인하세요";

export type CodexAgentLimitConfig = {
  readonly exists: boolean;
  readonly official?: number;
  readonly legacyAgents?: number;
  readonly legacyFeature?: number;
  readonly invalid: boolean;
  readonly invalidKind?: "path" | "read" | "parse" | "shape";
  readonly invalidMessage?: string;
};

function positiveInteger(
  table: CodexConfigObject | undefined,
  key: string,
): number | "invalid" | undefined {
  if (table === undefined || !Object.prototype.hasOwnProperty.call(table, key)) {
    return undefined;
  }
  const value = table[key];
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1
    ? value
    : "invalid";
}

function readCodexAgentLimitConfigAt(codexHomePath: string): CodexAgentLimitConfig {
  const source = readCodexConfig(codexHomePath);
  if (source.state === "missing") {
    return { exists: false, invalid: false };
  }
  if (source.state === "invalid") {
    return {
      exists: true,
      invalid: true,
      invalidKind: source.kind,
      invalidMessage: source.message,
    };
  }

  const agentsRaw = source.value.agents;
  const featuresRaw = source.value.features;
  const agents = objectValue(agentsRaw);
  const features = objectValue(featuresRaw);
  const legacyFeatureRaw = features?.multi_agent_v2;
  const legacyFeatureTable = objectValue(legacyFeatureRaw);
  let invalid = false;
  if (agentsRaw !== undefined && agents === undefined) invalid = true;
  if (featuresRaw !== undefined && features === undefined) invalid = true;

  const officialValue = positiveInteger(
    agents,
    "max_concurrent_threads_per_session",
  );
  const legacyAgentsValue = positiveInteger(agents, "max_threads");
  const legacyFeatureValue = positiveInteger(
    legacyFeatureTable,
    "max_concurrent_threads_per_session",
  );
  if (
    officialValue === "invalid" ||
    legacyAgentsValue === "invalid" ||
    legacyFeatureValue === "invalid"
  ) {
    invalid = true;
  }

  return {
    exists: true,
    official: officialValue === "invalid" ? undefined : officialValue,
    legacyAgents:
      legacyAgentsValue === "invalid" ? undefined : legacyAgentsValue,
    legacyFeature:
      legacyFeatureValue === "invalid" ? undefined : legacyFeatureValue,
    invalid,
    invalidKind: invalid ? "shape" : undefined,
    invalidMessage: invalid
      ? "동시성 상한 또는 관련 TOML 테이블의 형식이 올바르지 않습니다"
      : undefined,
  };
}

export function readCodexAgentLimitConfig(
  cwd: string,
  env: AgentHookEnvironment = { HOME: cwd },
): CodexAgentLimitConfig {
  return readCodexAgentLimitConfigAt(resolveCodexHome(cwd, env));
}

function classification(limit: number): string {
  if (limit <= RECOMMENDED_CONCURRENT_LIMIT) return "권장 범위";
  if (limit <= HIGH_CONCURRENT_LIMIT) return "고병렬 설정 — 메모리 압력 확인";
  return "위험 — 8개 초과";
}

export function codexAgentLimitDoctorLines(
  cwd: string,
  env: AgentHookEnvironment = { HOME: cwd },
): readonly string[] {
  const codexHomePath = resolveCodexHome(cwd, env);
  const configPath = join(codexHomePath, "config.toml");
  const config = readCodexAgentLimitConfigAt(codexHomePath);
  if (!config.exists) {
    return [
      "  Codex 서브에이전트 사용자 설정: config.toml 없음 (현재 세션 유효값 미확인)",
      EFFECTIVE_VALUE_NOTE,
    ];
  }
  if (config.invalid) {
    const label =
      config.invalidKind === "parse"
        ? "TOML 문법 오류"
        : config.invalidKind === "path"
          ? "config.toml 경로 오류"
          : config.invalidKind === "read"
            ? "config.toml 읽기 오류"
            : "상한 설정 오류";
    return [
      `  Codex 서브에이전트 사용자 설정: ${label}`,
      ...(config.invalidMessage === undefined
        ? []
        : [`  → ${config.invalidMessage}`]),
      `  → ${configPath}의 [agents] max_concurrent_threads_per_session = 4를 확인하세요`,
      EFFECTIVE_VALUE_NOTE,
    ];
  }

  const legacy = config.legacyFeature ?? config.legacyAgents;
  if (config.official === undefined && legacy === undefined) {
    return [
      "  Codex 서브에이전트 사용자 설정: 명시 상한 없음 (현재 세션 유효값 미확인)",
      "  → 16GB급 장비 권장: [agents] max_concurrent_threads_per_session = 4",
      EFFECTIVE_VALUE_NOTE,
    ];
  }

  const effective = config.official ?? legacy!;
  const prefix = config.official === undefined ? "legacy 동시 활성" : "동시 활성";
  const lines = [
    `  Codex 서브에이전트 사용자 설정: ${prefix} ${effective}개 (${classification(effective)})`,
  ];
  if (legacy !== undefined) {
    lines.push(
      "  → 구형 상한 설정을 제거하고 [agents] max_concurrent_threads_per_session = 4만 유지하세요",
    );
  } else if (effective > HIGH_CONCURRENT_LIMIT) {
    lines.push(
      `  → ${configPath}의 [agents] max_concurrent_threads_per_session = 4로 낮추세요`,
    );
  }
  lines.push(EFFECTIVE_VALUE_NOTE);
  return lines;
}
