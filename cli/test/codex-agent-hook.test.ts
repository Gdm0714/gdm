import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AGENT_ENVELOPE_PREFIX,
  AGENT_RESERVATION_TTL_MS,
  agentLedgerPath,
  readAgentHookLedgerSummary,
  runCodexAgentHook,
  type AgentEnvelope,
  type AgentLedgerV1,
} from "../src/codex-agent-hook.ts";
import {
  AGENT_HOOK_EVENTS,
  AGENT_HOOK_HANDLER_ID,
  AGENT_HOOK_SPAWN_MATCHER,
  agentHookCommand,
  agentHooksBackupPath,
  agentHooksConfigPath,
  codexAgentHookDoctorLines,
  installAgentHooks,
  readAgentHooksStatus,
} from "../src/codex-agent-hooks-config.ts";

setDefaultTimeout(20_000);

const CLI_ROOT = join(import.meta.dir, "..");
const HOOK_MODULE_URL = pathToFileURL(
  join(CLI_ROOT, "src", "codex-agent-hook.ts"),
).href;

type JsonObject = { [key: string]: unknown };

function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function environment(codexHome: string): Record<string, string> {
  return { ...process.env, CODEX_HOME: codexHome } as Record<string, string>;
}

function envelope(
  taskId: string,
  overrides: Partial<Omit<AgentEnvelope, "ownership">> & {
    readonly ownership?: AgentEnvelope["ownership"];
  } = {},
): AgentEnvelope {
  return {
    taskId,
    parentId: "root",
    role: "worker",
    scope: `scope/${taskId}`,
    ownership: { mode: "write", resources: [`src/${taskId}.ts`] },
    deliverable: `deliver ${taskId}`,
    verify: "bun test",
    stopWhen: "tests pass",
    canDelegate: false,
    childQuota: 0,
    depth: 1,
    blockedBy: [],
    ...overrides,
  };
}

function hookInput(
  event: "PreToolUse" | "PostToolUse",
  sessionId: string,
  toolUseId: string,
  agentEnvelope: AgentEnvelope,
  response?: unknown,
): JsonObject {
  return {
    session_id: sessionId,
    hook_event_name: event,
    tool_name: "Agent",
    tool_use_id: toolUseId,
    tool_input: {
      message: `${AGENT_ENVELOPE_PREFIX}${JSON.stringify(agentEnvelope)}`,
    },
    ...(event === "PostToolUse" ? { tool_response: response ?? { success: true } } : {}),
  };
}

function lifecycleInput(
  event: "SubagentStart" | "SubagentStop",
  sessionId: string,
  agentId: string,
): JsonObject {
  return {
    session_id: sessionId,
    hook_event_name: event,
    agent_id: agentId,
    agent_type: "worker",
  };
}

function invoke(
  cwd: string,
  env: Record<string, string>,
  input: JsonObject,
  timestamp?: number,
): JsonObject {
  return runCodexAgentHook(cwd, JSON.stringify(input), env, timestamp);
}

function preDecision(output: JsonObject): string | undefined {
  const specific = output.hookSpecificOutput;
  return typeof specific === "object" && specific !== null && !Array.isArray(specific)
    ? (specific as JsonObject).permissionDecision as string | undefined
    : undefined;
}

function ledger(
  cwd: string,
  env: Record<string, string>,
  sessionId: string,
): AgentLedgerV1 {
  return JSON.parse(readFileSync(agentLedgerPath(cwd, env, sessionId), "utf8")) as AgentLedgerV1;
}

function hookHandlers(config: JsonObject, event: string): JsonObject[] {
  const hooks = config.hooks as JsonObject;
  const groups = hooks[event] as JsonObject[];
  return groups.flatMap((group) => group.hooks as JsonObject[]);
}

describe("Codex delegated-agent hook runtime", () => {
  test("invalid envelopes deny before creating or changing state", () => {
    const cwd = tempDirectory("gdm-agent-invalid-cwd-");
    const codexHome = tempDirectory("gdm-agent-invalid-home-");
    const env = environment(codexHome);
    const valid = envelope("valid");
    const invalidMessages = [
      `${AGENT_ENVELOPE_PREFIX}${JSON.stringify({ ...valid, taskId: "" })}`,
      `${AGENT_ENVELOPE_PREFIX}${JSON.stringify({
        ...valid,
        ownership: { mode: "write", resources: [] },
      })}`,
      `${AGENT_ENVELOPE_PREFIX}${JSON.stringify({ ...valid, unknown: true })}`,
      `${AGENT_ENVELOPE_PREFIX}${JSON.stringify({ ...valid, childQuota: "1" })}`,
    ];

    for (const [index, message] of invalidMessages.entries()) {
      const input = hookInput("PreToolUse", "invalid-session", `bad-${index}`, valid);
      (input.tool_input as JsonObject).message = message;
      expect(preDecision(invoke(cwd, env, input))).toBe("deny");
    }

    expect(existsSync(join(codexHome, "gdm"))).toBe(false);
  });

  test("an envelope example below the first line stays an ordinary unmarked spawn", () => {
    const cwd = tempDirectory("gdm-agent-marker-example-cwd-");
    const codexHome = tempDirectory("gdm-agent-marker-example-home-");
    const env = environment(codexHome);
    const input = hookInput(
      "PreToolUse",
      "marker-example-session",
      "marker-example-use",
      envelope("marker-example"),
    );
    (input.tool_input as JsonObject).message =
      "Review this documentation example:\n" +
      `${AGENT_ENVELOPE_PREFIX}<single-line JSON>\n` +
      "Explain the fields without opting into the gdm contract.";

    expect(preDecision(invoke(cwd, env, input))).toBe("allow");
    const state = ledger(cwd, env, "marker-example-session");
    expect(state.reservations["marker-example-use"]?.contractMode).toBe("unstructured");
  });

  test("a valid first-line envelope may discuss the marker in its task body", () => {
    const cwd = tempDirectory("gdm-agent-marker-body-cwd-");
    const codexHome = tempDirectory("gdm-agent-marker-body-home-");
    const env = environment(codexHome);
    const task = envelope("marker-body");
    const input = hookInput("PreToolUse", "marker-body-session", "marker-body-use", task);
    (input.tool_input as JsonObject).message =
      `${AGENT_ENVELOPE_PREFIX}${JSON.stringify(task)}\n` +
      `Review code that emits the literal text ${AGENT_ENVELOPE_PREFIX} in documentation.`;

    expect(preDecision(invoke(cwd, env, input))).toBe("allow");
    expect(ledger(cwd, env, "marker-body-session").totalAcceptedAttempts).toBe(1);
  });

  test("a repeated tool_use_id is denied without consuming another attempt", () => {
    const cwd = tempDirectory("gdm-agent-idempotent-cwd-");
    const codexHome = tempDirectory("gdm-agent-idempotent-home-");
    const env = environment(codexHome);
    const input = hookInput("PreToolUse", "session-a", "tool-a", envelope("task-a"));

    expect(preDecision(invoke(cwd, env, input))).toBe("allow");
    expect(preDecision(invoke(cwd, env, input))).toBe("deny");
    const changedInstruction = hookInput(
      "PreToolUse",
      "session-a",
      "tool-a",
      envelope("task-a"),
    );
    (changedInstruction.tool_input as JsonObject).message += "\nDifferent instruction";
    expect(preDecision(invoke(cwd, env, changedInstruction))).toBe("deny");

    const state = ledger(cwd, env, "session-a");
    expect(state.schemaVersion).toBe(1);
    expect(state.totalAcceptedAttempts).toBe(1);
    expect(Object.keys(state.reservations)).toEqual(["tool-a"]);
    const statePath = agentLedgerPath(cwd, env, "session-a");
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(codexHome, "gdm")).mode & 0o777).toBe(0o700);
    expect(statSync(join(codexHome, "gdm", "agent-ledgers")).mode & 0o777).toBe(0o700);
  });

  test("ordinary unmarked Codex spawns remain usable but share the hard limit of 12", () => {
    const cwd = tempDirectory("gdm-agent-unmarked-cwd-");
    const codexHome = tempDirectory("gdm-agent-unmarked-home-");
    const env = environment(codexHome);
    const decisions: Array<string | undefined> = [];

    for (let index = 0; index < 13; index += 1) {
      decisions.push(preDecision(invoke(cwd, env, {
        session_id: "unmarked-session",
        hook_event_name: "PreToolUse",
        tool_name: "spawn_agent",
        tool_use_id: `unmarked-use-${index}`,
        tool_input: { message: `Handle ordinary delegated task ${index}` },
      })));
    }

    expect(decisions.slice(0, 12)).toEqual(Array(12).fill("allow"));
    expect(decisions[12]).toBe("deny");
    const state = ledger(cwd, env, "unmarked-session");
    expect(state.totalAcceptedAttempts).toBe(12);
    expect(
      Object.values(state.reservations).every(
        (reservation) => reservation.contractMode === "unstructured",
      ),
    ).toBe(true);
    const summary = readAgentHookLedgerSummary(cwd, env);
    expect(summary.unstructuredAttempts).toBe(12);
    expect(summary.structuredAttempts).toBe(0);
  });

  test("flat custom V2 namespaces share the 12-attempt gate while unrelated suffix tools pass through", () => {
    const cwd = tempDirectory("gdm-agent-custom-v2-cwd-");
    const codexHome = tempDirectory("gdm-agent-custom-v2-home-");
    const env = environment(codexHome);
    const session = "custom-v2-session";
    for (let index = 0; index < 12; index += 1) {
      const base = {
        session_id: session,
        tool_name: "agentsspawn_agent",
        tool_use_id: `custom-v2-use-${index}`,
        tool_input: {
          task_name: `custom_v2_${index}`,
          message: `custom V2 task ${index}`,
        },
      };
      expect(preDecision(invoke(cwd, env, {
        ...base,
        hook_event_name: "PreToolUse",
      }))).toBe("allow");
      expect(invoke(cwd, env, {
        ...base,
        hook_event_name: "PostToolUse",
        tool_response: { success: false, error: "synthetic spawn failure" },
      }).decision).toBeUndefined();
    }
    expect(
      preDecision(invoke(cwd, env, {
        session_id: session,
        hook_event_name: "PreToolUse",
        tool_name: "agentsspawn_agent",
        tool_use_id: "custom-v2-use-12",
        tool_input: {
          task_name: "custom_v2_12",
          message: "thirteenth custom V2 task",
        },
      })),
    ).toBe("deny");
    expect(ledger(cwd, env, session).totalAcceptedAttempts).toBe(12);

    const unrelatedSession = "custom-v2-unrelated";
    for (const [index, toolName, toolInput] of [
      [0, "agentsspawn_agent", { message: "missing task name" }],
      [1, "agentsspawn_agent", { task_name: "missing_message" }],
      [2, `${"a".repeat(65)}spawn_agent`, {
        task_name: "namespace_too_long",
        message: "not an official flat namespace",
      }],
      [3, "custom.namespawn_agent", {
        task_name: "invalid_namespace_character",
        message: "dot is not part of the flat namespace grammar",
      }],
    ] as const) {
      expect(
        preDecision(invoke(cwd, env, {
          session_id: unrelatedSession,
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_use_id: `unrelated-${index}`,
          tool_input: toolInput,
        })),
      ).toBe("allow");
    }
    expect(existsSync(agentLedgerPath(cwd, env, unrelatedSession))).toBe(false);
  });

  test("unmarked tool_use_id retries are denied even with canonical-equivalent input", () => {
    const cwd = tempDirectory("gdm-agent-unmarked-id-cwd-");
    const codexHome = tempDirectory("gdm-agent-unmarked-id-home-");
    const env = environment(codexHome);
    const base = {
      session_id: "unmarked-id-session",
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      tool_use_id: "same-unmarked-use",
      tool_input: { message: "Handle task A", fork_turns: "none" },
    };

    expect(preDecision(invoke(cwd, env, base))).toBe("allow");
    expect(preDecision(invoke(cwd, env, {
      ...base,
      tool_input: { fork_turns: "none", message: "Handle task A" },
    }))).toBe("deny");
    expect(preDecision(invoke(cwd, env, {
      ...base,
      tool_input: { message: "Handle task B", fork_turns: "none" },
    }))).toBe("deny");
    expect(ledger(cwd, env, "unmarked-id-session").totalAcceptedAttempts).toBe(1);
  });

  test("13 parallel PreToolUse processes atomically allow exactly 12 attempts", async () => {
    const cwd = tempDirectory("gdm-agent-parallel-cwd-");
    const codexHome = tempDirectory("gdm-agent-parallel-home-");
    const script = `
      import { AGENT_ENVELOPE_PREFIX, runCodexAgentHook } from ${JSON.stringify(HOOK_MODULE_URL)};
      const index = Number(process.argv[1]);
      const envelope = {
        taskId: "parallel-" + index,
        parentId: "root",
        role: "worker",
        scope: "scope/parallel-" + index,
        ownership: { mode: "write", resources: ["src/parallel-" + index + ".ts"] },
        deliverable: "deliver",
        verify: "verify",
        stopWhen: "stop",
        canDelegate: false,
        childQuota: 0,
        depth: 1,
        blockedBy: [],
      };
      const input = {
        session_id: "parallel-session",
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: "parallel-tool-" + index,
        tool_input: { message: AGENT_ENVELOPE_PREFIX + JSON.stringify(envelope) },
      };
      process.stdout.write(JSON.stringify(runCodexAgentHook(process.cwd(), JSON.stringify(input), process.env)));
    `;
    const children = Array.from({ length: 13 }, (_, index) =>
      Bun.spawn(["bun", "-e", script, String(index)], {
        cwd,
        env: environment(codexHome),
        stdout: "pipe",
        stderr: "pipe",
      })
    );
    const results = await Promise.all(children.map(async (child) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    }));

    expect(results.every((result) => result.exitCode === 0), JSON.stringify(results)).toBe(true);
    const decisions = results.map((result) => preDecision(JSON.parse(result.stdout) as JsonObject));
    expect(decisions.filter((decision) => decision === "allow")).toHaveLength(12);
    expect(decisions.filter((decision) => decision === "deny")).toHaveLength(1);
    expect(ledger(cwd, environment(codexHome), "parallel-session").totalAcceptedAttempts).toBe(12);
  });

  test("attempt counters and duplicate ids are isolated by session", () => {
    const cwd = tempDirectory("gdm-agent-isolation-cwd-");
    const codexHome = tempDirectory("gdm-agent-isolation-home-");
    const env = environment(codexHome);
    const same = envelope("same-task");

    expect(preDecision(invoke(cwd, env, hookInput("PreToolUse", "s1", "u1", same)))).toBe("allow");
    expect(preDecision(invoke(cwd, env, hookInput("PreToolUse", "s2", "u1", same)))).toBe("allow");

    expect(agentLedgerPath(cwd, env, "s1")).not.toBe(agentLedgerPath(cwd, env, "s2"));
    expect(ledger(cwd, env, "s1").totalAcceptedAttempts).toBe(1);
    expect(ledger(cwd, env, "s2").totalAcceptedAttempts).toBe(1);
  });

  test("PostToolUse failure releases active ownership but keeps the attempt consumed", () => {
    const cwd = tempDirectory("gdm-agent-post-cwd-");
    const codexHome = tempDirectory("gdm-agent-post-home-");
    const env = environment(codexHome);
    const session = "post-session";
    const first = envelope("first", {
      ownership: { mode: "write", resources: ["src/shared.ts"] },
    });
    expect(preDecision(invoke(cwd, env, hookInput("PreToolUse", session, "u1", first)))).toBe("allow");
    invoke(
      cwd,
      env,
      hookInput("PostToolUse", session, "u1", first, { success: false, error: "spawn failed" }),
    );

    const afterFailure = ledger(cwd, env, session);
    expect(afterFailure.totalAcceptedAttempts).toBe(1);
    expect(afterFailure.reservations.u1?.state).toBe("failed");
    expect(
      preDecision(invoke(
        cwd,
        env,
        hookInput(
          "PreToolUse",
          session,
          "u2",
          envelope("second", {
            ownership: { mode: "write", resources: ["src/shared.ts"] },
          }),
        ),
      )),
    ).toBe("allow");
    expect(ledger(cwd, env, session).totalAcceptedAttempts).toBe(2);
  });

  test("PostToolUse observed before PreToolUse is reconciled without refunding the attempt", () => {
    const cwd = tempDirectory("gdm-agent-post-reorder-cwd-");
    const codexHome = tempDirectory("gdm-agent-post-reorder-home-");
    const env = environment(codexHome);
    const session = "post-reorder-session";
    const task = envelope("post-reordered");

    invoke(
      cwd,
      env,
      hookInput(
        "PostToolUse",
        session,
        "post-before-pre",
        task,
        { success: false, error: "spawn failed before reservation observation" },
      ),
    );
    expect(
      preDecision(invoke(
        cwd,
        env,
        hookInput("PreToolUse", session, "post-before-pre", task),
      )),
    ).toBe("allow");

    const state = ledger(cwd, env, session);
    expect(state.totalAcceptedAttempts).toBe(1);
    expect(state.reservations["post-before-pre"]?.state).toBe("failed");
    expect(state.orphanPosts).toEqual({});
  });

  test("duplicate task, same-scope child, overlapping writes, and unmet blockedBy deny", () => {
    const cwd = tempDirectory("gdm-agent-policy-cwd-");
    const codexHome = tempDirectory("gdm-agent-policy-home-");
    const env = environment(codexHome);
    const session = "policy-session";
    const parent = envelope("parent", {
      scope: "parent-scope",
      canDelegate: true,
      childQuota: 2,
      ownership: { mode: "write", resources: ["src/parent.ts"] },
    });
    expect(preDecision(invoke(cwd, env, hookInput("PreToolUse", session, "parent-use", parent)))).toBe("allow");

    const denied = [
      envelope("parent", { scope: "other", ownership: { mode: "read", resources: ["README.md"] } }),
      envelope("same-scope", {
        parentId: "parent",
        scope: "parent-scope",
        depth: 2,
        ownership: { mode: "read", resources: ["README.md"] },
      }),
      envelope("overlap", {
        ownership: { mode: "write", resources: ["src/parent.ts"] },
      }),
      envelope("blocked", {
        blockedBy: ["missing-task"],
        ownership: { mode: "read", resources: ["README.md"] },
      }),
    ];
    for (const [index, value] of denied.entries()) {
      expect(
        preDecision(invoke(cwd, env, hookInput("PreToolUse", session, `denied-${index}`, value))),
      ).toBe("deny");
    }

    const noDelegateParent = envelope("no-delegate-parent", {
      canDelegate: false,
      childQuota: 2,
      ownership: { mode: "read", resources: ["docs/no-delegate.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        hookInput("PreToolUse", session, "no-delegate-parent-use", noDelegateParent),
      )),
    ).toBe("allow");
    expect(
      preDecision(invoke(
        cwd,
        env,
        hookInput(
          "PreToolUse",
          session,
          "no-delegate-child-use",
          envelope("no-delegate-child", {
            parentId: "no-delegate-parent",
            depth: 2,
            ownership: { mode: "read", resources: ["docs/no-delegate-child.md"] },
          }),
        ),
      )),
    ).toBe("deny");

    const quotaParent = envelope("quota-parent", {
      canDelegate: true,
      childQuota: 1,
      ownership: { mode: "read", resources: ["docs/quota.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        hookInput("PreToolUse", session, "quota-parent-use", quotaParent),
      )),
    ).toBe("allow");
    expect(
      preDecision(invoke(
        cwd,
        env,
        hookInput(
          "PreToolUse",
          session,
          "quota-child-1-use",
          envelope("quota-child-1", {
            parentId: "quota-parent",
            depth: 2,
            ownership: { mode: "read", resources: ["docs/quota-child-1.md"] },
          }),
        ),
      )),
    ).toBe("allow");
    expect(
      preDecision(invoke(
        cwd,
        env,
        hookInput(
          "PreToolUse",
          session,
          "quota-child-2-use",
          envelope("quota-child-2", {
            parentId: "quota-parent",
            depth: 2,
            ownership: { mode: "read", resources: ["docs/quota-child-2.md"] },
          }),
        ),
      )),
    ).toBe("deny");

    const depthParent = envelope("depth-parent", {
      canDelegate: true,
      childQuota: 2,
      ownership: { mode: "read", resources: ["docs/depth.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        hookInput("PreToolUse", session, "depth-parent-use", depthParent),
      )),
    ).toBe("allow");
    expect(
      preDecision(invoke(
        cwd,
        env,
        hookInput(
          "PreToolUse",
          session,
          "depth-child-use",
          envelope("depth-child", {
            parentId: "depth-parent",
            depth: 3,
            ownership: { mode: "read", resources: ["docs/depth-child.md"] },
          }),
        ),
      )),
    ).toBe("deny");

    expect(ledger(cwd, env, session).totalAcceptedAttempts).toBe(5);
  });

  test("lifecycle reorder and duplicates converge on stopped, not verified success", () => {
    const cwd = tempDirectory("gdm-agent-reorder-cwd-");
    const codexHome = tempDirectory("gdm-agent-reorder-home-");
    const env = environment(codexHome);
    const session = "reorder-session";
    const task = envelope("dependency");

    invoke(cwd, env, lifecycleInput("SubagentStop", session, "agent-1"));
    invoke(cwd, env, lifecycleInput("SubagentStart", session, "agent-1"));
    expect(preDecision(invoke(cwd, env, hookInput("PreToolUse", session, "u1", task)))).toBe("allow");
    invoke(
      cwd,
      env,
      hookInput("PostToolUse", session, "u1", task, { success: true, agent_id: "agent-1" }),
    );
    const stableBytes = readFileSync(agentLedgerPath(cwd, env, session));
    invoke(cwd, env, lifecycleInput("SubagentStop", session, "agent-1"));
    invoke(
      cwd,
      env,
      hookInput("PostToolUse", session, "u1", task, { success: true, agent_id: "agent-1" }),
    );

    const state = ledger(cwd, env, session);
    expect(state.agents["agent-1"]?.state).toBe("stopped");
    expect(state.reservations.u1?.state).toBe("stopped");
    expect(readFileSync(agentLedgerPath(cwd, env, session))).toEqual(stableBytes);
    const summary = readAgentHookLedgerSummary(cwd, env);
    expect(summary.stopped).toBe(1);
    expect(summary.subagentStopSemantics).toContain("sequencing hint");
    expect(summary.subagentStopSemantics).toContain("not thread termination");
    expect(
      preDecision(invoke(
        cwd,
        env,
        hookInput(
          "PreToolUse",
          session,
          "u2",
          envelope("after-dependency", {
            blockedBy: ["dependency"],
            ownership: { mode: "read", resources: ["README.md"] },
          }),
        ),
      )),
    ).toBe("allow");
  });

  test("reversed concurrent lifecycle order never swaps task ownership", () => {
    const cwd = tempDirectory("gdm-agent-correlation-cwd-");
    const codexHome = tempDirectory("gdm-agent-correlation-home-");
    const env = environment(codexHome);
    const session = "correlation-session";
    const taskA = envelope("task-a", {
      ownership: { mode: "write", resources: ["src/a.ts"] },
    });
    const taskB = envelope("task-b", {
      ownership: { mode: "write", resources: ["src/b.ts"] },
    });

    expect(preDecision(invoke(cwd, env, hookInput("PreToolUse", session, "use-a", taskA)))).toBe("allow");
    expect(preDecision(invoke(cwd, env, hookInput("PreToolUse", session, "use-b", taskB)))).toBe("allow");
    invoke(cwd, env, lifecycleInput("SubagentStart", session, "agent-b"));
    invoke(cwd, env, lifecycleInput("SubagentStart", session, "agent-a"));
    invoke(
      cwd,
      env,
      hookInput("PostToolUse", session, "use-b", taskB, {
        success: true,
        agent_id: "agent-b",
      }),
    );
    invoke(
      cwd,
      env,
      hookInput("PostToolUse", session, "use-a", taskA, {
        success: true,
        agent_id: "agent-a",
      }),
    );
    invoke(cwd, env, lifecycleInput("SubagentStop", session, "agent-b"));

    const state = ledger(cwd, env, session);
    expect(state.reservations["use-a"]?.agentId).toBe("agent-a");
    expect(state.reservations["use-a"]?.state).toBe("running");
    expect(state.reservations["use-b"]?.agentId).toBe("agent-b");
    expect(state.reservations["use-b"]?.state).toBe("stopped");
    expect(
      preDecision(invoke(
        cwd,
        env,
        hookInput(
          "PreToolUse",
          session,
          "blocked-by-a-use",
          envelope("blocked-by-a", {
            blockedBy: ["task-a"],
            ownership: { mode: "read", resources: ["README.md"] },
          }),
        ),
      )),
    ).toBe("deny");
    expect(
      preDecision(invoke(
        cwd,
        env,
        hookInput(
          "PreToolUse",
          session,
          "overlap-a-use",
          envelope("overlap-a", {
            ownership: { mode: "write", resources: ["src/a.ts"] },
          }),
        ),
      )),
    ).toBe("deny");
  });

  test("authoritative PostToolUse agent ids repair provisional one-candidate links", () => {
    const cwd = tempDirectory("gdm-agent-remap-cwd-");
    const codexHome = tempDirectory("gdm-agent-remap-home-");
    const env = environment(codexHome);
    const session = "remap-session";
    const taskA = envelope("remap-a");
    const taskB = envelope("remap-b");

    invoke(cwd, env, hookInput("PreToolUse", session, "remap-use-a", taskA));
    invoke(cwd, env, lifecycleInput("SubagentStart", session, "remap-agent-b"));
    invoke(cwd, env, hookInput("PreToolUse", session, "remap-use-b", taskB));
    invoke(cwd, env, lifecycleInput("SubagentStart", session, "remap-agent-a"));
    invoke(
      cwd,
      env,
      hookInput("PostToolUse", session, "remap-use-b", taskB, {
        success: true,
        agent_id: "remap-agent-b",
      }),
    );
    invoke(
      cwd,
      env,
      hookInput("PostToolUse", session, "remap-use-a", taskA, {
        success: true,
        agent_id: "remap-agent-a",
      }),
    );

    const state = ledger(cwd, env, session);
    expect(state.reservations["remap-use-a"]?.agentId).toBe("remap-agent-a");
    expect(state.reservations["remap-use-b"]?.agentId).toBe("remap-agent-b");
    expect(state.agents["remap-agent-a"]?.reservationToolUseId).toBe("remap-use-a");
    expect(state.agents["remap-agent-b"]?.reservationToolUseId).toBe("remap-use-b");
  });

  test("Stop continues within pending/running leases and releases them after expiry", () => {
    const cwd = tempDirectory("gdm-agent-stop-cwd-");
    const codexHome = tempDirectory("gdm-agent-stop-home-");
    const env = environment(codexHome);
    const start = Date.now();
    const pendingSession = "pending-stop";
    const pending = envelope("pending");
    invoke(cwd, env, hookInput("PreToolUse", pendingSession, "u1", pending), start);
    expect(invoke(cwd, env, {
      session_id: pendingSession,
      hook_event_name: "Stop",
      stop_hook_active: false,
    }, start).decision).toBe("block");
    const pendingReentry = invoke(cwd, env, {
      session_id: pendingSession,
      hook_event_name: "Stop",
      stop_hook_active: true,
    }, start + 1);
    expect(pendingReentry.decision).toBeUndefined();
    expect(pendingReentry.systemMessage).toContain("will not create an infinite continuation loop");
    expect(
      invoke(
        cwd,
        env,
        { session_id: pendingSession, hook_event_name: "Stop" },
        start + AGENT_RESERVATION_TTL_MS + 1,
      ).decision,
    ).toBeUndefined();
    expect(ledger(cwd, env, pendingSession).reservations.u1?.state).toBe("expired");

    const runningSession = "running-stop";
    const running = envelope("running");
    invoke(cwd, env, hookInput("PreToolUse", runningSession, "u2", running), start);
    invoke(cwd, env, lifecycleInput("SubagentStart", runningSession, "agent-running"), start + 1);
    invoke(
      cwd,
      env,
      hookInput("PostToolUse", runningSession, "u2", running, {
        agent_id: "agent-running",
      }),
      start + 2,
    );
    expect(
      invoke(
        cwd,
        env,
        {
          session_id: runningSession,
          hook_event_name: "Stop",
          stop_hook_active: false,
        },
        start + 3,
      ).decision,
    ).toBe("block");
    expect(
      invoke(
        cwd,
        env,
        {
          session_id: runningSession,
          hook_event_name: "Stop",
          stop_hook_active: true,
        },
        start + 4,
      ).decision,
    ).toBeUndefined();
    expect(
      invoke(
        cwd,
        env,
        { session_id: runningSession, hook_event_name: "Stop" },
        start + AGENT_RESERVATION_TTL_MS + 3,
      ).decision,
    ).toBeUndefined();
    expect(ledger(cwd, env, runningSession).reservations.u2?.state).toBe("expired");
    expect(
      ledger(cwd, env, runningSession).reservations.u2?.failureReason,
    ).toBe("lifecycle_lease_expired");

    const reorderedSession = "start-before-reservation";
    invoke(cwd, env, lifecycleInput("SubagentStart", reorderedSession, "orphan-running"), start);
    expect(
      invoke(cwd, env, {
        session_id: reorderedSession,
        hook_event_name: "Stop",
        stop_hook_active: false,
      }, start + 1).decision,
    ).toBe("block");
    expect(
      invoke(cwd, env, {
        session_id: reorderedSession,
        hook_event_name: "Stop",
        stop_hook_active: true,
      }, start + 2).decision,
    ).toBeUndefined();
    invoke(cwd, env, lifecycleInput("SubagentStop", reorderedSession, "orphan-running"), start + 2);
    expect(
      invoke(cwd, env, { session_id: reorderedSession, hook_event_name: "Stop" }, start + 3).decision,
    ).toBeUndefined();
  });

  test("released reservations and corrupt-ledger reentry cannot trap Stop forever", () => {
    const cwd = tempDirectory("gdm-agent-stop-liveness-cwd-");
    const codexHome = tempDirectory("gdm-agent-stop-liveness-home-");
    const env = environment(codexHome);
    const start = Date.now();

    const failedSession = "failed-with-pending-agent";
    const failed = envelope("failed-with-agent");
    invoke(cwd, env, hookInput("PreToolUse", failedSession, "failed-use", failed), start);
    invoke(
      cwd,
      env,
      hookInput("PostToolUse", failedSession, "failed-use", failed, {
        success: false,
        agent_id: "failed-agent",
      }),
      start + 1,
    );
    expect(ledger(cwd, env, failedSession).reservations["failed-use"]?.state).toBe("failed");
    expect(ledger(cwd, env, failedSession).agents["failed-agent"]?.state).toBe("pending");
    expect(invoke(cwd, env, {
      session_id: failedSession,
      hook_event_name: "Stop",
      stop_hook_active: false,
    }, start + 2).decision).toBeUndefined();

    const acknowledgedSession = "acknowledged-with-pending-agent";
    const acknowledged = envelope("acknowledged-with-agent");
    invoke(
      cwd,
      env,
      hookInput("PreToolUse", acknowledgedSession, "acknowledged-use", acknowledged),
      start,
    );
    invoke(
      cwd,
      env,
      hookInput("PostToolUse", acknowledgedSession, "acknowledged-use", acknowledged, {
        success: true,
        agent_id: "pending-agent",
      }),
      start + 1,
    );
    expect(invoke(cwd, env, {
      session_id: acknowledgedSession,
      hook_event_name: "Stop",
      stop_hook_active: false,
    }, start + AGENT_RESERVATION_TTL_MS + 2).decision).toBeUndefined();
    expect(
      ledger(cwd, env, acknowledgedSession).reservations["acknowledged-use"]?.state,
    ).toBe("expired");

    const corruptSession = "corrupt-stop";
    invoke(
      cwd,
      env,
      hookInput("PreToolUse", corruptSession, "corrupt-use", envelope("corrupt")),
      start,
    );
    writeFileSync(agentLedgerPath(cwd, env, corruptSession), "{not-json\n");
    expect(invoke(cwd, env, {
      session_id: corruptSession,
      hook_event_name: "Stop",
      stop_hook_active: false,
    }, start + 1).decision).toBe("block");
    const corruptReentry = invoke(cwd, env, {
      session_id: corruptSession,
      hook_event_name: "Stop",
      stop_hook_active: true,
    }, start + 2);
    expect(corruptReentry.decision).toBeUndefined();
    expect(corruptReentry.systemMessage).toContain("will not loop again");
  });
});

describe("Codex delegated-agent hook installation", () => {
  test("merge preserves unrelated handlers, creates one exact backup, and is byte-idempotent", () => {
    const cwd = tempDirectory("gdm-agent-config-cwd-");
    const codexHome = tempDirectory("gdm-agent-config-home-");
    const env = environment(codexHome);
    const path = agentHooksConfigPath(cwd, env);
    const original = `${JSON.stringify({
      description: "user-owned",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/opt/user-stop", timeout: 7 }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "/opt/user-start" }] }],
      },
    }, null, 2)}\n`;
    writeFileSync(path, original);

    const first = installAgentHooks(cwd, env, process.execPath);
    const afterFirst = readFileSync(path);
    const second = installAgentHooks(cwd, env, process.execPath);

    expect(first.changed).toBe(true);
    expect(first.backupCreated).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.backupCreated).toBe(false);
    expect(readFileSync(path)).toEqual(afterFirst);
    expect(readFileSync(agentHooksBackupPath(cwd, env), "utf8")).toBe(original);
    expect(statSync(agentHooksBackupPath(cwd, env)).mode & 0o777).toBe(0o600);
    const config = JSON.parse(afterFirst.toString("utf8")) as JsonObject;
    expect(JSON.stringify(config)).toContain("/opt/user-stop");
    expect(JSON.stringify(config)).toContain("/opt/user-start");
    for (const event of AGENT_HOOK_EVENTS) {
      expect(
        hookHandlers(config, event).filter((handler) =>
          String(handler.command).includes(AGENT_HOOK_HANDLER_ID)
        ),
      ).toHaveLength(1);
    }
    expect(readAgentHooksStatus(cwd, env).installed).toBe(true);
  });

  test("spawn matcher covers official flat namespaces and status rejects the legacy narrow matcher", () => {
    const cwd = tempDirectory("gdm-agent-matcher-cwd-");
    const codexHome = tempDirectory("gdm-agent-matcher-home-");
    const env = environment(codexHome);
    const path = agentHooksConfigPath(cwd, env);
    installAgentHooks(cwd, env, process.execPath);
    const config = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    const hooks = config.hooks as JsonObject;
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const group = (hooks[event] as JsonObject[]).find((candidate) =>
        (candidate.hooks as JsonObject[]).some((handler) =>
          String(handler.command).includes(AGENT_HOOK_HANDLER_ID)
        )
      );
      expect(group?.matcher).toBe(AGENT_HOOK_SPAWN_MATCHER);
    }

    const matcher = new RegExp(AGENT_HOOK_SPAWN_MATCHER, "u");
    for (const toolName of [
      "Agent",
      "spawn_agent",
      "collaborationspawn_agent",
      "collaboration.spawn_agent",
      "agentsspawn_agent",
      `${"a".repeat(64)}spawn_agent`,
      "mcp__custom_1_spawn_agent",
    ]) {
      expect(matcher.test(toolName), toolName).toBe(true);
    }
    for (const toolName of [
      `${"a".repeat(65)}spawn_agent`,
      "custom.namespawn_agent",
      "spawn_agent_extra",
      "prefixspawn-agent",
    ]) {
      expect(matcher.test(toolName), toolName).toBe(false);
    }

    const preGroup = (hooks.PreToolUse as JsonObject[]).find((candidate) =>
      (candidate.hooks as JsonObject[]).some((handler) =>
        String(handler.command).includes(AGENT_HOOK_HANDLER_ID)
      )
    )!;
    preGroup.matcher =
      "^(Agent|spawn_agent|collaborationspawn_agent|collaboration\\.spawn_agent)$";
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    const legacy = readAgentHooksStatus(cwd, env);
    expect(legacy.configured).toBe(false);
    expect(legacy.invalidEvents).toContain("PreToolUse");
  });

  test("malformed, symlink, and non-regular hooks.json paths fail closed", () => {
    const cwd = tempDirectory("gdm-agent-config-reject-cwd-");

    const malformedHome = tempDirectory("gdm-agent-malformed-home-");
    const malformedEnv = environment(malformedHome);
    const malformedPath = agentHooksConfigPath(cwd, malformedEnv);
    const malformed = '{"hooks":[\n';
    writeFileSync(malformedPath, malformed);
    expect(() => installAgentHooks(cwd, malformedEnv, "/opt/gdm")).toThrow("JSON이 손상");
    expect(readFileSync(malformedPath, "utf8")).toBe(malformed);
    expect(existsSync(agentHooksBackupPath(cwd, malformedEnv))).toBe(false);

    const symlinkHome = tempDirectory("gdm-agent-symlink-home-");
    const symlinkEnv = environment(symlinkHome);
    const symlinkPath = agentHooksConfigPath(cwd, symlinkEnv);
    const target = join(symlinkHome, "target.json");
    writeFileSync(target, '{"description":"user"}\n');
    symlinkSync(target, symlinkPath);
    expect(() => installAgentHooks(cwd, symlinkEnv, "/opt/gdm")).toThrow("일반 파일이 아닙니다");
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe('{"description":"user"}\n');

    const directoryHome = tempDirectory("gdm-agent-directory-home-");
    const directoryEnv = environment(directoryHome);
    const directoryPath = agentHooksConfigPath(cwd, directoryEnv);
    mkdirSync(directoryPath);
    writeFileSync(join(directoryPath, "sentinel"), "owned\n");
    expect(() => installAgentHooks(cwd, directoryEnv, "/opt/gdm")).toThrow("일반 파일이 아닙니다");
    expect(readFileSync(join(directoryPath, "sentinel"), "utf8")).toBe("owned\n");
  });

  test("custom absolute binary is shell-quoted into all five identified handlers", () => {
    const cwd = tempDirectory("gdm-agent-binary-cwd-");
    const codexHome = tempDirectory("gdm-agent-binary-home-");
    const env = environment(codexHome);
    const binary = join(codexHome, "bin with space", "gdm's binary");

    installAgentHooks(cwd, env, binary);

    const config = JSON.parse(readFileSync(agentHooksConfigPath(cwd, env), "utf8")) as JsonObject;
    const expected = agentHookCommand(binary);
    for (const event of AGENT_HOOK_EVENTS) {
      expect(hookHandlers(config, event).filter((handler) => handler.command === expected)).toHaveLength(1);
    }
    expect(expected).toContain("--handler-id gdm-agent-gate-v1");
    const status = readAgentHooksStatus(cwd, env);
    expect(status.configured).toBe(true);
    expect(status.executable).toBe(false);
  });

  test("doctor separates installed files, disabled feature, and unverified hook trust", () => {
    const home = tempDirectory("gdm-agent-doctor-home-");
    const cwd = tempDirectory("gdm-agent-doctor-cwd-");
    installAgentHooks(cwd, { HOME: home }, process.execPath);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = false\n");
    expect(codexAgentHookDoctorLines(home).join("\n")).toContain("비활성화");

    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    const enabled = codexAgentHookDoctorLines(home).join("\n");
    expect(enabled).toContain("설치됨");
    expect(enabled).toContain("현재 세션 유효값 미확인");
    expect(enabled).toContain("/debug-config");
    expect(enabled).toContain("/hooks");
    expect(enabled).toContain("신뢰");

    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
    const defaulted = codexAgentHookDoctorLines(home).join("\n");
    expect(defaulted).toContain("명시 설정 없음 · 기본값 활성");
    expect(defaulted).toContain("현재 세션 유효값 미확인");
  });

  test("an existing hostile backup path is never overwritten", () => {
    const cwd = tempDirectory("gdm-agent-backup-cwd-");
    const codexHome = tempDirectory("gdm-agent-backup-home-");
    const env = environment(codexHome);
    const path = agentHooksConfigPath(cwd, env);
    writeFileSync(path, '{"description":"user"}\n');
    const backup = agentHooksBackupPath(cwd, env);
    writeFileSync(backup, "do-not-overwrite\n");
    chmodSync(backup, 0o600);

    installAgentHooks(cwd, env, "/opt/gdm");

    expect(readFileSync(backup, "utf8")).toBe("do-not-overwrite\n");
  });

  test("dry-run validates the complete merge without creating config or backup files", () => {
    const cwd = tempDirectory("gdm-agent-dry-run-cwd-");
    const codexHome = tempDirectory("gdm-agent-dry-run-home-");
    const env = environment(codexHome);
    const path = agentHooksConfigPath(cwd, env);

    const result = installAgentHooks(cwd, env, process.execPath, {
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.executable).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(agentHooksBackupPath(cwd, env))).toBe(false);
  });

  test("an external byte change is detected before backup or config replacement", () => {
    const cwd = tempDirectory("gdm-agent-drift-cwd-");
    const codexHome = tempDirectory("gdm-agent-drift-home-");
    const env = environment(codexHome);
    const path = agentHooksConfigPath(cwd, env);
    const external = '{"description":"external edit"}\n';
    writeFileSync(path, '{"description":"original"}\n');

    expect(() =>
      installAgentHooks(cwd, env, process.execPath, {
        beforeWrite: () => writeFileSync(path, external),
      })
    ).toThrow("외부에서 변경");

    expect(readFileSync(path, "utf8")).toBe(external);
    expect(existsSync(agentHooksBackupPath(cwd, env))).toBe(false);
  });

  test("a backup is published only after its complete private inode is ready", () => {
    const cwd = tempDirectory("gdm-agent-backup-publish-cwd-");
    const codexHome = tempDirectory("gdm-agent-backup-publish-home-");
    const env = environment(codexHome);
    const path = agentHooksConfigPath(cwd, env);
    const original = '{"description":"original"}\n';
    writeFileSync(path, original);

    expect(() =>
      installAgentHooks(cwd, env, process.execPath, {
        beforeBackupPublish: () => {
          throw new Error("injected backup publication failure");
        },
      })
    ).toThrow("injected backup publication failure");

    expect(readFileSync(path, "utf8")).toBe(original);
    expect(existsSync(agentHooksBackupPath(cwd, env))).toBe(false);
    expect(
      readdirSync(codexHome).some((name) =>
        name.includes(`${AGENT_HOOK_HANDLER_ID}.backup`) && name.endsWith(".tmp")
      ),
    ).toBe(false);
  });

  test("a byte change after temp fsync is revalidated immediately before rename", () => {
    const cwd = tempDirectory("gdm-agent-before-rename-cwd-");
    const codexHome = tempDirectory("gdm-agent-before-rename-home-");
    const env = environment(codexHome);
    const path = agentHooksConfigPath(cwd, env);
    const external = '{"description":"late external edit"}\n';
    writeFileSync(path, '{"description":"original"}\n');

    expect(() =>
      installAgentHooks(cwd, env, process.execPath, {
        beforeRename: () => writeFileSync(path, external),
      })
    ).toThrow("외부에서 변경");

    expect(readFileSync(path, "utf8")).toBe(external);
    expect(
      readdirSync(codexHome).some((name) =>
        name.includes(AGENT_HOOK_HANDLER_ID) && name.endsWith(".tmp")
      ),
    ).toBe(false);
  });

  test("a non-regular backup path is rejected during dry-run without mutation", () => {
    const cwd = tempDirectory("gdm-agent-backup-preflight-cwd-");
    const codexHome = tempDirectory("gdm-agent-backup-preflight-home-");
    const env = environment(codexHome);
    const path = agentHooksConfigPath(cwd, env);
    const original = '{"description":"user"}\n';
    const backupTarget = join(codexHome, "backup-target");
    writeFileSync(path, original);
    writeFileSync(backupTarget, "target\n");
    symlinkSync(backupTarget, agentHooksBackupPath(cwd, env));

    expect(() =>
      installAgentHooks(cwd, env, process.execPath, { dryRun: true })
    ).toThrow("일반 파일이 아닙니다");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readFileSync(backupTarget, "utf8")).toBe("target\n");
  });

  test("dry-run rejects malformed config.toml before creating hooks state", () => {
    const cwd = tempDirectory("gdm-agent-toml-preflight-cwd-");
    const codexHome = tempDirectory("gdm-agent-toml-preflight-home-");
    const env = environment(codexHome);
    const path = agentHooksConfigPath(cwd, env);
    writeFileSync(join(codexHome, "config.toml"), "[features\nhooks = true\n");

    expect(() =>
      installAgentHooks(cwd, env, process.execPath, { dryRun: true })
    ).toThrow("TOML 문법");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(agentHooksBackupPath(cwd, env))).toBe(false);
  });

  test("status requires an exact generated command, exact 10-second timeout, and executable binary", () => {
    const cwd = tempDirectory("gdm-agent-static-status-cwd-");
    const codexHome = tempDirectory("gdm-agent-static-status-home-");
    const env = environment(codexHome);
    const path = agentHooksConfigPath(cwd, env);
    installAgentHooks(cwd, env, process.execPath);
    const config = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    const hooks = config.hooks as JsonObject;
    const pre = (hooks.PreToolUse as JsonObject[])[0]!;
    const handler = (pre.hooks as JsonObject[])[0]!;
    for (const timeout of [0, 0.001, 600]) {
      handler.timeout = timeout;
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

      const driftedTimeout = readAgentHooksStatus(cwd, env);
      expect(driftedTimeout.configured).toBe(false);
      expect(driftedTimeout.invalidEvents).toContain("PreToolUse");
    }

    handler.timeout = 10;
    handler.statusMessage = "user-customized progress text";
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    expect(readAgentHooksStatus(cwd, env).configured).toBe(true);

    handler.command =
      `${agentHookCommand(process.execPath)} --unexpected`;
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    expect(readAgentHooksStatus(cwd, env).configured).toBe(false);
  });

  test("status treats a configured symlink and its current realpath as the same executable", () => {
    const cwd = tempDirectory("gdm-agent-realpath-status-cwd-");
    const codexHome = tempDirectory("gdm-agent-realpath-status-home-");
    const env = environment(codexHome);
    const binaryLink = join(codexHome, "gdm-link");
    symlinkSync(process.execPath, binaryLink);
    installAgentHooks(cwd, env, binaryLink);

    const status = readAgentHooksStatus(cwd, env, process.execPath);

    expect(status.executable).toBe(true);
    expect(status.matchesCurrentExecutable).toBe(true);
    expect(status.installed).toBe(true);
  });

  test("status and doctor never execute an untrusted configured command", () => {
    const cwd = tempDirectory("gdm-agent-status-no-exec-cwd-");
    const codexHome = tempDirectory("gdm-agent-status-no-exec-home-");
    const env = environment(codexHome);
    const sentinel = join(codexHome, "executed");
    const candidate = join(codexHome, "untrusted-gdm");
    writeFileSync(
      candidate,
      `#!/bin/sh\nprintf executed > '${sentinel}'\n`,
    );
    chmodSync(candidate, 0o755);
    installAgentHooks(cwd, env, candidate);

    readAgentHooksStatus(cwd, env, candidate);
    codexAgentHookDoctorLines(cwd, env, candidate);

    expect(existsSync(sentinel)).toBe(false);
  });

  test("a lock older than 30 seconds is not stolen while its owner pid is alive", () => {
    const cwd = tempDirectory("gdm-agent-live-lock-cwd-");
    const codexHome = tempDirectory("gdm-agent-live-lock-home-");
    const env = environment(codexHome);
    const path = agentHooksConfigPath(cwd, env);
    const lock = `${path}.gdm-lock`;
    const token = `${process.pid}-${"a".repeat(24)}`;
    writeFileSync(lock, `${token}\n`);
    const old = new Date(Date.now() - 31_000);
    utimesSync(lock, old, old);

    expect(() => installAgentHooks(cwd, env, process.execPath)).toThrow(
      "잠금을 기다리다 시간 초과",
    );
    expect(readFileSync(lock, "utf8").trim()).toBe(token);
    expect(existsSync(path)).toBe(false);
  });

  test("stale empty and malformed lock publications are reclaimed", () => {
    for (const [name, contents] of [
      ["empty", ""],
      ["malformed", "not-a-lock-token\n"],
    ] as const) {
      const cwd = tempDirectory(`gdm-agent-${name}-lock-cwd-`);
      const codexHome = tempDirectory(`gdm-agent-${name}-lock-home-`);
      const env = environment(codexHome);
      const path = agentHooksConfigPath(cwd, env);
      const lock = `${path}.gdm-lock`;
      writeFileSync(lock, contents);
      const old = new Date(Date.now() - 31_000);
      utimesSync(lock, old, old);

      const result = installAgentHooks(cwd, env, process.execPath);

      expect(result.installed).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(lock)).toBe(false);
    }
  });

  test("a fresh empty lock publication is not mistaken for stale ownership", () => {
    const cwd = tempDirectory("gdm-agent-fresh-empty-lock-cwd-");
    const codexHome = tempDirectory("gdm-agent-fresh-empty-lock-home-");
    const env = environment(codexHome);
    const path = agentHooksConfigPath(cwd, env);
    const lock = `${path}.gdm-lock`;
    writeFileSync(lock, "");

    expect(() => installAgentHooks(cwd, env, process.execPath)).toThrow(
      "잠금을 기다리다 시간 초과",
    );
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe("");
    expect(existsSync(path)).toBe(false);
  });
});
