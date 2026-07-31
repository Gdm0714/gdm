import {
  AGENT_HOOK_HANDLER_ID,
  assertAgentHookExecutable,
  inspectCodexHooksFeature,
  installAgentHooks,
  readAgentHooksStatus,
  resolveCodexHome,
  type AgentHookEnvironment,
} from "./codex-agent-hooks-config.ts";
import {
  AGENT_SESSION_ATTEMPT_EXTENSION_SIZE,
  AGENT_SESSION_HARD_ATTEMPT_LIMIT,
  AGENT_SESSION_INITIAL_ATTEMPT_LIMIT,
  readAgentHookLedgerSummary,
  runCodexAgentHook,
} from "./codex-agent-hook.ts";
import { isAbsolute } from "node:path";

export class AgentCliError extends Error {
  readonly code = "agent_usage";

  constructor(message: string) {
    super(message);
    this.name = "AgentCliError";
  }
}

function onlyJsonFlag(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--json") return true;
  throw new AgentCliError("지원하지 않는 agent 옵션입니다");
}

function installFlags(args: readonly string[]): {
  readonly binary: string;
  readonly json: boolean;
  readonly dryRun: boolean;
} {
  let binary: string | undefined;
  let json = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      if (json) throw new AgentCliError("--json을 중복 지정할 수 없습니다");
      json = true;
      continue;
    }
    if (argument === "--dry-run") {
      if (dryRun) throw new AgentCliError("--dry-run을 중복 지정할 수 없습니다");
      dryRun = true;
      continue;
    }
    if (argument === "--binary") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || binary !== undefined) {
        throw new AgentCliError("--binary에는 하나의 절대 경로가 필요합니다");
      }
      binary = value;
      index += 1;
      continue;
    }
    throw new AgentCliError(`지원하지 않는 hook-install 옵션입니다: ${argument}`);
  }
  if (binary === undefined || !isAbsolute(binary)) {
    throw new AgentCliError(
      "사용법: gdm agent hook-install --binary <gdm 절대경로> [--dry-run] [--json]",
    );
  }
  return { binary, json, dryRun };
}

function validateHookArgs(args: readonly string[]): void {
  if (args.length === 0) return;
  if (
    args.length === 2 &&
    args[0] === "--handler-id" &&
    args[1] === AGENT_HOOK_HANDLER_ID
  ) {
    return;
  }
  throw new AgentCliError(
    `사용법: gdm agent hook [--handler-id ${AGENT_HOOK_HANDLER_ID}]`,
  );
}

export function cmdAgent(
  cwd: string,
  args: readonly string[],
  stdinText: string,
  env: AgentHookEnvironment,
  executable: string,
): void {
  const [subcommand, ...rest] = args;
  if (subcommand === "hook") {
    validateHookArgs(rest);
    console.log(JSON.stringify(runCodexAgentHook(cwd, stdinText, env)));
    return;
  }
  if (subcommand === "hook-install") {
    const flags = installFlags(rest);
    assertAgentHookExecutable(flags.binary);
    const result = installAgentHooks(cwd, env, flags.binary, {
      dryRun: flags.dryRun,
    });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        flags.dryRun
          ? `Codex agent hooks 사전검증 완료: ${result.configPath}`
          : result.changed
            ? `Codex agent hooks 설치 완료: ${result.configPath}`
            : `Codex agent hooks 변경 없음: ${result.configPath}`,
      );
      if (result.backupCreated) console.log(`기존 설정 백업: ${result.backupPath}`);
    }
    return;
  }
  if (subcommand === "hook-status") {
    const json = onlyJsonFlag(rest);
    const hooks = readAgentHooksStatus(cwd, env, executable);
    const feature = inspectCodexHooksFeature(resolveCodexHome(cwd, env));
    const effective =
      !hooks.configured
        ? "not-configured"
        : !hooks.executable
          ? "not-executable"
          : hooks.matchesCurrentExecutable === false
            ? "executable-drift"
            : feature.state === "disabled"
              ? "disabled"
              : feature.state === "invalid"
                ? "invalid-feature"
                : "unverified";
    const status = {
      schemaVersion: 1 as const,
      installed: hooks.installed,
      configured: hooks.configured,
      executable: hooks.executable,
      feature,
      trust: "unknown" as const,
      effective,
      hooks,
      ledgers: readAgentHookLedgerSummary(cwd, env),
    };
    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(
        `Codex agent hooks: configured=${status.configured} executable=${status.executable} ` +
          `feature=${status.feature.state} trust=${status.trust} effective=${status.effective}`,
      );
      console.log(
        `Agent ledgers: ${status.ledgers.sessions} sessions, ` +
          `${status.ledgers.pending} pending, ${status.ledgers.running} running; ` +
          `${status.ledgers.structuredAttempts} structured / ` +
          `${status.ledgers.unstructuredAttempts} unstructured attempts`,
      );
      console.log(
        `Agent attempt budget starts at ${AGENT_SESSION_INITIAL_ATTEMPT_LIMIT}, ` +
          `opens ${AGENT_SESSION_ATTEMPT_EXTENSION_SIZE} more only after active work settles, ` +
          `and stops at ${AGENT_SESSION_HARD_ATTEMPT_LIMIT}. ` +
          `Parent delegation enforcement: ${status.ledgers.parentDelegationEnforcement}.`,
      );
      console.log(
        `Lifecycle association: ${status.ledgers.lifecycleAssociation}.`,
      );
    }
    return;
  }
  throw new AgentCliError(
    "사용법: gdm agent hook | hook-install --binary <절대경로> [--dry-run] | hook-status [--json]",
  );
}
