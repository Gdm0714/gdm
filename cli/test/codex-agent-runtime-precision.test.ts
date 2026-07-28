import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_ENVELOPE_PREFIX,
  AGENT_PRE_ACK_TTL_MS,
  AGENT_RESERVATION_TTL_MS,
  agentLedgerPath,
  readAgentHookLedgerSummary,
  runCodexAgentHook,
  type AgentEnvelope,
  type AgentLedgerV1,
} from "../src/codex-agent-hook.ts";

type JsonObject = { [key: string]: unknown };

setDefaultTimeout(15_000);

function temporaryDirectory(prefix: string): string {
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

function spawnInput(
  event: "PreToolUse" | "PostToolUse",
  sessionId: string,
  toolUseId: string,
  task: AgentEnvelope,
  options: {
    readonly callerAgentId?: string;
    readonly response?: unknown;
    readonly message?: string;
    readonly taskName?: string;
  } = {},
): JsonObject {
  return {
    session_id: sessionId,
    hook_event_name: event,
    tool_name: "spawn_agent",
    tool_use_id: toolUseId,
    tool_input: {
      message:
        options.message ??
        `${AGENT_ENVELOPE_PREFIX}${JSON.stringify(task)}`,
      ...(options.taskName === undefined ? {} : { task_name: options.taskName }),
    },
    ...(options.callerAgentId === undefined
      ? {}
      : { agent_id: options.callerAgentId, agent_type: "worker" }),
    ...(event === "PostToolUse"
      ? { tool_response: options.response ?? JSON.stringify({ nickname: "worker" }) }
      : {}),
  };
}

function currentProcessStartDigest(): string | undefined {
  let identity: string | undefined;
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
    const startTicks = fields[19];
    let bootId = "unknown-boot";
    try {
      const candidate = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (candidate.length > 0) bootId = candidate;
    } catch {
      // Mirrors the production fallback.
    }
    if (startTicks !== undefined) identity = `linux:${bootId}:${startTicks}`;
  } else if (process.platform === "darwin") {
    const started = execFileSync(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(process.pid)],
      { encoding: "utf8" },
    ).trim();
    if (started.length > 0) identity = `darwin:${started}`;
  }
  return identity === undefined
    ? undefined
    : createHash("sha256").update(identity).digest("hex");
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
  return JSON.parse(
    readFileSync(agentLedgerPath(cwd, env, sessionId), "utf8"),
  ) as AgentLedgerV1;
}

describe("Codex agent runtime precision", () => {
  test("production JSON-text PostToolUse links only an unambiguous top-level agent_id", () => {
    const cwd = temporaryDirectory("gdm-runtime-wire-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-wire-home-"));
    const session = "wire-session";
    const task = envelope("wire-task");

    expect(
      preDecision(invoke(cwd, env, spawnInput("PreToolUse", session, "wire-use", task))),
    ).toBe("allow");
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", session, "wire-use", task, {
        response: JSON.stringify({ agent_id: "wire-agent", nickname: "Kuhn" }),
      }),
    );

    const afterPost = ledger(cwd, env, session);
    expect(afterPost.reservations["wire-use"]?.state).toBe("running");
    expect(afterPost.reservations["wire-use"]?.agentId).toBe("wire-agent");
    expect(afterPost.reservations["wire-use"]?.agentLinkAuthority).toBe("post");
    expect(afterPost.agents["wire-agent"]?.reservationToolUseId).toBe("wire-use");

    invoke(cwd, env, lifecycleInput("SubagentStop", session, "wire-agent"));
    expect(ledger(cwd, env, session).reservations["wire-use"]?.state).toBe("stopped");

    const ambiguousSession = "ambiguous-wire-session";
    const ambiguous = envelope("ambiguous-wire");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", ambiguousSession, "ambiguous-use", ambiguous),
    );
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", ambiguousSession, "ambiguous-use", ambiguous, {
        response: JSON.stringify({
          agent_id: "top-agent",
          nested: { agent_id: "nested-agent" },
        }),
      }),
    );
    const ambiguousState = ledger(cwd, env, ambiguousSession);
    expect(ambiguousState.reservations["ambiguous-use"]?.state).toBe("running");
    expect(ambiguousState.reservations["ambiguous-use"]?.agentId).toBeUndefined();
    expect(Object.keys(ambiguousState.agents)).toEqual([]);

    const conflictingSession = "conflicting-wire-session";
    const conflicting = envelope("conflicting-wire");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", conflictingSession, "conflicting-use", conflicting),
    );
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", conflictingSession, "conflicting-use", conflicting, {
        response: { agent_id: "snake-agent", agentId: "camel-agent" },
      }),
    );
    expect(
      ledger(cwd, env, conflictingSession).reservations["conflicting-use"]?.agentId,
    ).toBeUndefined();

    const directSession = "direct-object-session";
    const direct = envelope("direct-object");
    invoke(cwd, env, spawnInput("PreToolUse", directSession, "direct-use", direct));
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", directSession, "direct-use", direct, {
        response: { agent_id: "direct-agent", nickname: "compatibility" },
      }),
    );
    expect(ledger(cwd, env, directSession).reservations["direct-use"]?.agentId).toBe(
      "direct-agent",
    );

    const onceSession = "parse-exactly-once";
    const once = envelope("parse-exactly-once");
    invoke(cwd, env, spawnInput("PreToolUse", onceSession, "once-use", once));
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", onceSession, "once-use", once, {
        response: JSON.stringify(JSON.stringify({ agent_id: "double-encoded-agent" })),
      }),
    );
    expect(ledger(cwd, env, onceSession).reservations["once-use"]?.agentId).toBeUndefined();
  });

  test("reserved Responses and MCP namespaces pass through without agent ledger state", () => {
    const cwd = temporaryDirectory("gdm-runtime-reserved-namespace-cwd-");
    const env = environment(
      temporaryDirectory("gdm-runtime-reserved-namespace-home-"),
    );
    const session = "reserved-flat-namespaces";
    const reservedNamespaces = [
      "mcp",
      "mcp__server__",
      "api_tool",
      "browser",
      "computer",
      "container",
      "file_search",
      "functions",
      "image_gen",
      "multi_tool_use",
      "python",
      "python_user_visible",
      "submodel_delegator",
      "terminal",
      "tool_search",
      "web",
    ] as const;

    for (const [index, namespace] of reservedNamespaces.entries()) {
      const base = {
        session_id: session,
        tool_name: `${namespace}spawn_agent`,
        tool_use_id: `reserved-use-${index}`,
        tool_input: {
          task_name: `reserved_task_${index}`,
          message: `valid-looking reserved task ${index}`,
        },
      };
      expect(preDecision(invoke(cwd, env, {
        ...base,
        hook_event_name: "PreToolUse",
      }))).toBe("allow");
      const post = invoke(cwd, env, {
        ...base,
        hook_event_name: "PostToolUse",
        tool_response: { success: true },
      });
      expect(post.decision).toBeUndefined();
      expect(post.systemMessage).toBeUndefined();
    }
    expect(existsSync(agentLedgerPath(cwd, env, session))).toBe(false);

    const customSession = "non-reserved-flat-namespace";
    expect(
      preDecision(invoke(cwd, env, {
        session_id: customSession,
        hook_event_name: "PreToolUse",
        tool_name: "agentsspawn_agent",
        tool_use_id: "custom-use",
        tool_input: {
          task_name: "custom_task",
          message: "valid custom V2 task",
        },
      })),
    ).toBe("allow");
    expect(ledger(cwd, env, customSession).totalAcceptedAttempts).toBe(1);
  });

  test("exact Pre replay is denied even before Post or lifecycle evidence", () => {
    const cwd = temporaryDirectory("gdm-runtime-pre-replay-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-pre-replay-home-"));

    const postSession = "pre-after-post";
    const postTask = envelope("pre-after-post");
    const postPre = spawnInput("PreToolUse", postSession, "post-use", postTask);
    expect(preDecision(invoke(cwd, env, postPre))).toBe("allow");
    const afterFirstPre = readFileSync(agentLedgerPath(cwd, env, postSession));
    for (let replay = 0; replay < 20; replay += 1) {
      expect(preDecision(invoke(cwd, env, postPre))).toBe("deny");
    }
    expect(readFileSync(agentLedgerPath(cwd, env, postSession))).toEqual(
      afterFirstPre,
    );
    expect(ledger(cwd, env, postSession).totalAcceptedAttempts).toBe(1);
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", postSession, "post-use", postTask, {
        response: JSON.stringify({ agent_id: "post-agent" }),
      }),
    );
    expect(preDecision(invoke(cwd, env, postPre))).toBe("deny");

    const startSession = "pre-after-start";
    const startTask = envelope("pre-after-start");
    const startPre = spawnInput("PreToolUse", startSession, "start-use", startTask);
    expect(preDecision(invoke(cwd, env, startPre))).toBe("allow");
    invoke(cwd, env, lifecycleInput("SubagentStart", startSession, "start-agent"));
    expect(preDecision(invoke(cwd, env, startPre))).toBe("deny");
  });

  test("ledger event timestamps stay monotonic when lock acquisition reverses capture order", () => {
    const cwd = temporaryDirectory("gdm-runtime-monotonic-clock-cwd-");
    const env = environment(
      temporaryDirectory("gdm-runtime-monotonic-clock-home-"),
    );
    const earlier = 1_000;
    const later = 2_000;
    const laterIso = new Date(later).toISOString();
    const lifecycleExpiryIso = new Date(
      later + AGENT_RESERVATION_TTL_MS,
    ).toISOString();

    const startStopSession = "monotonic-start-stop";
    expect(
      invoke(
        cwd,
        env,
        lifecycleInput("SubagentStart", startStopSession, "start-stop-agent"),
        later,
      ).systemMessage,
    ).toBeUndefined();
    const reorderedStop = invoke(
      cwd,
      env,
      lifecycleInput("SubagentStop", startStopSession, "start-stop-agent"),
      earlier,
    );
    expect(reorderedStop.decision).toBeUndefined();
    expect(reorderedStop.systemMessage).toBeUndefined();
    let state = ledger(cwd, env, startStopSession);
    expect(state.createdAt).toBe(laterIso);
    expect(state.updatedAt).toBe(laterIso);
    expect(state.agents["start-stop-agent"]).toMatchObject({
      state: "stopped",
      firstObservedAt: laterIso,
      startedAt: laterIso,
      stoppedAt: laterIso,
    });

    const stopStartSession = "monotonic-stop-start";
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStop", stopStartSession, "stop-start-agent"),
      later,
    );
    expect(
      invoke(
        cwd,
        env,
        lifecycleInput("SubagentStart", stopStartSession, "stop-start-agent"),
        earlier,
      ).systemMessage,
    ).toBeUndefined();
    state = ledger(cwd, env, stopStartSession);
    expect(state.createdAt).toBe(laterIso);
    expect(state.updatedAt).toBe(laterIso);
    expect(state.agents["stop-start-agent"]).toMatchObject({
      state: "stopped",
      firstObservedAt: laterIso,
      stoppedAt: laterIso,
    });
    expect(state.agents["stop-start-agent"]?.startedAt).toBeUndefined();

    const preStartSession = "monotonic-pre-start";
    const preStartTask = envelope("monotonic-pre-start");
    invoke(
      cwd,
      env,
      spawnInput(
        "PreToolUse",
        preStartSession,
        "pre-start-use",
        preStartTask,
        { taskName: "monotonic_pre_start" },
      ),
      later,
    );
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", preStartSession, "pre-start-agent"),
      earlier,
    );
    state = ledger(cwd, env, preStartSession);
    expect(state.createdAt).toBe(laterIso);
    expect(state.updatedAt).toBe(laterIso);
    expect(state.reservations["pre-start-use"]).toMatchObject({
      reservedAt: laterIso,
      expiresAt: lifecycleExpiryIso,
      state: "running",
    });
    expect(state.agents["pre-start-agent"]).toMatchObject({
      firstObservedAt: laterIso,
      startedAt: laterIso,
      state: "running",
    });

    const startPostSession = "monotonic-start-post";
    const startPostTask = envelope("monotonic-start-post");
    invoke(
      cwd,
      env,
      spawnInput(
        "PreToolUse",
        startPostSession,
        "start-post-use",
        startPostTask,
        { taskName: "monotonic_start_post" },
      ),
      500,
    );
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", startPostSession, "start-post-agent"),
      later,
    );
    invoke(
      cwd,
      env,
      spawnInput(
        "PostToolUse",
        startPostSession,
        "start-post-use",
        startPostTask,
        {
          taskName: "monotonic_start_post",
          response: JSON.stringify({
            task_name: "/root/monotonic_start_post",
          }),
        },
      ),
      earlier,
    );
    state = ledger(cwd, env, startPostSession);
    expect(state.updatedAt).toBe(laterIso);
    expect(state.reservations["start-post-use"]).toMatchObject({
      postObservedAt: laterIso,
      expiresAt: lifecycleExpiryIso,
      state: "running",
    });
    expect(state.agents["start-post-agent"]).toMatchObject({
      firstObservedAt: laterIso,
      startedAt: laterIso,
      state: "running",
    });

    const postStartSession = "monotonic-post-start";
    const postStartTask = envelope("monotonic-post-start");
    invoke(
      cwd,
      env,
      spawnInput(
        "PreToolUse",
        postStartSession,
        "post-start-use",
        postStartTask,
        { taskName: "monotonic_post_start" },
      ),
      500,
    );
    invoke(
      cwd,
      env,
      spawnInput(
        "PostToolUse",
        postStartSession,
        "post-start-use",
        postStartTask,
        {
          taskName: "monotonic_post_start",
          response: JSON.stringify({
            task_name: "/root/monotonic_post_start",
          }),
        },
      ),
      later,
    );
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", postStartSession, "post-start-agent"),
      earlier,
    );
    state = ledger(cwd, env, postStartSession);
    expect(state.updatedAt).toBe(laterIso);
    expect(state.reservations["post-start-use"]).toMatchObject({
      postObservedAt: laterIso,
      expiresAt: lifecycleExpiryIso,
      state: "running",
    });
    expect(state.agents["post-start-agent"]).toMatchObject({
      firstObservedAt: laterIso,
      startedAt: laterIso,
      state: "running",
    });

    const prePostSession = "monotonic-pre-post";
    const prePostTask = envelope("monotonic-pre-post");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", prePostSession, "pre-post-use", prePostTask),
      later,
    );
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", prePostSession, "pre-post-use", prePostTask, {
        response: JSON.stringify({ agent_id: "pre-post-agent" }),
      }),
      earlier,
    );
    state = ledger(cwd, env, prePostSession);
    expect(state.createdAt).toBe(laterIso);
    expect(state.updatedAt).toBe(laterIso);
    expect(state.reservations["pre-post-use"]).toMatchObject({
      reservedAt: laterIso,
      postObservedAt: laterIso,
      expiresAt: lifecycleExpiryIso,
      state: "running",
    });
    expect(state.agents["pre-post-agent"]?.firstObservedAt).toBe(laterIso);

    const postPreSession = "monotonic-post-pre";
    const postPreTask = envelope("monotonic-post-pre");
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", postPreSession, "post-pre-use", postPreTask, {
        response: JSON.stringify({ agent_id: "post-pre-agent" }),
      }),
      later,
    );
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", postPreSession, "post-pre-use", postPreTask),
        earlier,
      )),
    ).toBe("allow");
    state = ledger(cwd, env, postPreSession);
    expect(state.createdAt).toBe(laterIso);
    expect(state.updatedAt).toBe(laterIso);
    expect(state.reservations["post-pre-use"]).toMatchObject({
      reservedAt: laterIso,
      postObservedAt: laterIso,
      expiresAt: lifecycleExpiryIso,
      state: "running",
    });
    expect(state.agents["post-pre-agent"]?.firstObservedAt).toBe(laterIso);
  });

  test("unstructured child reservations retain and enforce caller identity", () => {
    const cwd = temporaryDirectory("gdm-runtime-unstructured-caller-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-unstructured-caller-home-"));
    const session = "unstructured-caller";
    const base = {
      session_id: session,
      tool_name: "spawn_agent",
      tool_use_id: "unstructured-use",
      tool_input: { message: "ordinary child task without a GDM envelope" },
    };
    const pre = {
      ...base,
      hook_event_name: "PreToolUse",
      agent_id: "actual-parent-agent",
      agent_type: "worker",
    };
    expect(preDecision(invoke(cwd, env, pre))).toBe("allow");
    expect(preDecision(invoke(cwd, env, pre))).toBe("deny");
    expect(
      ledger(cwd, env, session).reservations["unstructured-use"]?.callerAgentId,
    ).toBe("actual-parent-agent");

    expect(
      preDecision(invoke(cwd, env, { ...pre, agent_id: "different-parent-agent" })),
    ).toBe("deny");
    const wrongPost = {
      ...base,
      hook_event_name: "PostToolUse",
      agent_id: "different-parent-agent",
      agent_type: "worker",
      tool_response: JSON.stringify({ agent_id: "child-agent" }),
    };
    expect(invoke(cwd, env, wrongPost).decision).toBe("block");
    expect(
      invoke(cwd, env, {
        ...wrongPost,
        agent_id: "actual-parent-agent",
      }).decision,
    ).toBeUndefined();
    expect(preDecision(invoke(cwd, env, pre))).toBe("deny");
    const state = ledger(cwd, env, session);
    expect(state.totalAcceptedAttempts).toBe(1);
    expect(state.reservations["unstructured-use"]?.agentId).toBe("child-agent");

    const stoppedSession = "unstructured-stopped-caller";
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStop", stoppedSession, "stopped-parent-agent"),
    );
    expect(
      preDecision(invoke(cwd, env, {
        ...pre,
        session_id: stoppedSession,
        tool_use_id: "stopped-caller-use",
        agent_id: "stopped-parent-agent",
      })),
    ).toBe("deny");
    expect(ledger(cwd, env, stoppedSession).totalAcceptedAttempts).toBe(0);
  });

  test("V2 lifecycle correlation converges for every Start/Post/Stop order", () => {
    const cwd = temporaryDirectory("gdm-runtime-v2-orders-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-v2-orders-home-"));
    const permutations = [
      ["start", "post", "stop"],
      ["start", "stop", "post"],
      ["post", "start", "stop"],
      ["post", "stop", "start"],
      ["stop", "start", "post"],
      ["stop", "post", "start"],
    ] as const;

    for (const [index, order] of permutations.entries()) {
      const session = `v2-order-${index}`;
      const task = envelope(`v2-order-${index}`);
      const taskName = `v2_task_${index}`;
      expect(
        preDecision(invoke(
          cwd,
          env,
          spawnInput("PreToolUse", session, "v2-use", task, { taskName }),
        )),
      ).toBe("allow");
      for (const event of order) {
        if (event === "start") {
          invoke(cwd, env, lifecycleInput("SubagentStart", session, "v2-agent"));
        } else if (event === "stop") {
          invoke(cwd, env, lifecycleInput("SubagentStop", session, "v2-agent"));
        } else {
          invoke(
            cwd,
            env,
            spawnInput("PostToolUse", session, "v2-use", task, {
              taskName,
              response: JSON.stringify({
                task_name: `/root/${taskName}`,
                nickname: "V2",
              }),
            }),
          );
        }
      }
      const state = ledger(cwd, env, session);
      expect(state.reservations["v2-use"]?.spawnProtocol).toBe("v2");
      expect(state.reservations["v2-use"]?.agentId).toBe("v2-agent");
      expect(state.reservations["v2-use"]?.agentLinkAuthority).toBe("serialized-v2");
      expect(state.reservations["v2-use"]?.postOutcome).toBe("succeeded");
      expect(state.reservations["v2-use"]?.state).toBe("stopped");
    }
  });

  test("V2 serializes identity-ambiguous windows but linked work stays parallel", () => {
    const cwd = temporaryDirectory("gdm-runtime-v2-window-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-v2-window-home-"));
    const session = "v2-window";
    const v1 = envelope("window-v1");
    const v2 = envelope("window-v2");

    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "v1-use", v1),
      )),
    ).toBe("allow");
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "v2-use", v2, {
          taskName: "window_v2",
        }),
      )),
    ).toBe("deny");

    invoke(cwd, env, lifecycleInput("SubagentStart", session, "v1-agent"));
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "v2-use", v2, {
          taskName: "window_v2",
        }),
      )),
    ).toBe("allow");
    const secondV1 = envelope("window-v1-second", {
      ownership: { mode: "read", resources: ["docs/window-v1-second.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "v1-second-use", secondV1),
      )),
    ).toBe("deny");

    invoke(cwd, env, lifecycleInput("SubagentStart", session, "v2-agent"));
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "v1-second-use", secondV1),
      )),
    ).toBe("allow");
    invoke(cwd, env, lifecycleInput("SubagentStart", session, "v1-second-agent"));
    const secondV2 = envelope("window-v2-second", {
      ownership: { mode: "read", resources: ["docs/window-v2-second.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "v2-second-use", secondV2, {
          taskName: "window_v2_second",
        }),
      )),
    ).toBe("allow");
    const state = ledger(cwd, env, session);
    expect(state.reservations["v1-use"]?.agentId).toBe("v1-agent");
    expect(state.reservations["v2-use"]?.agentId).toBe("v2-agent");
  });

  test("V2 canonical response paths are digest data while caller binding resolves identity", () => {
    const cwd = temporaryDirectory("gdm-runtime-v2-post-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-v2-post-home-"));
    const session = "v2-post-before-start";
    const task = envelope("v2-post-parent", {
      canDelegate: true,
      childQuota: 1,
      ownership: { mode: "read", resources: ["docs/v2-parent.md"] },
    });
    const taskName = "v2_post_parent";
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", session, "parent-use", task, { taskName }),
    );
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", session, "parent-use", task, {
        taskName,
        response: JSON.stringify({
          task_name: "/root/v2_post_parent",
          nickname: "parent",
        }),
      }),
    );
    const blocked = envelope("blocked-v2", {
      ownership: { mode: "read", resources: ["docs/blocked-v2.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "blocked-use", blocked, {
          taskName: "blocked_v2",
        }),
      )),
    ).toBe("deny");

    const unstructuredChild = {
      session_id: session,
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      tool_use_id: "actual-child-use",
      agent_id: "actual-parent-agent",
      agent_type: "worker",
      tool_input: { message: "actual unmarked child" },
    };
    expect(preDecision(invoke(cwd, env, unstructuredChild))).toBe("allow");
    const state = ledger(cwd, env, session);
    expect(state.reservations["parent-use"]?.agentId).toBe("actual-parent-agent");
    expect(state.reservations["parent-use"]?.agentLinkAuthority).toBe("caller");
    expect(state.reservations["actual-child-use"]?.callerAgentId).toBe(
      "actual-parent-agent",
    );

    const nestedSession = "v2-canonical-nested";
    const nested = envelope("canonical-grandchild", {
      ownership: { mode: "read", resources: ["docs/canonical-grandchild.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", nestedSession, "nested-use", nested, {
          taskName: "grandchild",
        }),
      )),
    ).toBe("allow");
    expect(
      invoke(
        cwd,
        env,
        spawnInput("PostToolUse", nestedSession, "nested-use", nested, {
          taskName: "grandchild",
          response: JSON.stringify({
            task_name: "/root/child/grandchild",
            nickname: "grandchild",
          }),
        }),
      ).decision,
    ).toBeUndefined();
    expect(
      ledger(cwd, env, nestedSession).reservations["nested-use"]?.postOutcome,
    ).toBe("succeeded");
  });

  test("structured nested spawns are bound to their actual caller and cumulative quota", () => {
    const cwd = temporaryDirectory("gdm-runtime-caller-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-caller-home-"));
    const session = "caller-session";
    const parent = envelope("parent-task", {
      canDelegate: true,
      childQuota: 1,
      ownership: { mode: "read", resources: ["src/parent.ts"] },
    });
    invoke(cwd, env, spawnInput("PreToolUse", session, "parent-use", parent));
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", session, "parent-use", parent, {
        response: JSON.stringify({ agent_id: "parent-agent" }),
      }),
    );

    const child = envelope("child-task", {
      parentId: "parent-task",
      depth: 2,
      ownership: { mode: "read", resources: ["src/child.ts"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "child-use", child, {
          callerAgentId: "parent-agent",
        }),
      )),
    ).toBe("allow");
    let state = ledger(cwd, env, session);
    expect(state.reservations["parent-use"]?.agentId).toBe("parent-agent");
    expect(state.reservations["parent-use"]?.agentLinkAuthority).toBe("caller");
    expect(state.reservations["child-use"]?.callerAgentId).toBe("parent-agent");

    const overQuota = envelope("over-quota", {
      parentId: "parent-task",
      depth: 2,
      ownership: { mode: "read", resources: ["src/over-quota.ts"] },
    });
    const beforeOverQuota = readFileSync(agentLedgerPath(cwd, env, session));
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "over-quota-use", overQuota, {
          callerAgentId: "parent-agent",
        }),
      )),
    ).toBe("deny");
    expect(readFileSync(agentLedgerPath(cwd, env, session))).toEqual(beforeOverQuota);

    const missingCaller = envelope("missing-caller", {
      parentId: "parent-task",
      depth: 2,
      ownership: { mode: "read", resources: ["src/missing-caller.ts"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "missing-caller-use", missingCaller),
      )),
    ).toBe("deny");

    const wrongCaller = envelope("wrong-caller", {
      parentId: "parent-task",
      depth: 2,
      ownership: { mode: "read", resources: ["src/wrong-caller.ts"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "wrong-caller-use", wrongCaller, {
          callerAgentId: "different-agent",
        }),
      )),
    ).toBe("deny");

    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", session, "child-use", child, {
        callerAgentId: "parent-agent",
        response: JSON.stringify({ agent_id: "child-agent" }),
      }),
    );
    state = ledger(cwd, env, session);
    expect(state.reservations["child-use"]?.agentId).toBe("child-agent");
    expect(state.reservations["child-use"]?.state).toBe("running");

    const fallbackSession = "caller-unavailable-fallback";
    const fallbackParent = envelope("fallback-parent", {
      canDelegate: true,
      childQuota: 1,
      ownership: { mode: "read", resources: ["src/fallback-parent.ts"] },
    });
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", fallbackSession, "fallback-parent-use", fallbackParent),
    );
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", fallbackSession, "fallback-parent-use", fallbackParent, {
        response: JSON.stringify({ nickname: "runtime-without-agent-id" }),
      }),
    );
    const fallbackChild = envelope("fallback-child", {
      parentId: "fallback-parent",
      depth: 2,
      ownership: { mode: "read", resources: ["src/fallback-child.ts"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput(
          "PreToolUse",
          fallbackSession,
          "fallback-child-use",
          fallbackChild,
        ),
      )),
    ).toBe("allow");
    expect(
      ledger(cwd, env, fallbackSession).reservations["fallback-child-use"]
        ?.callerAgentId,
    ).toBeUndefined();
    expect(readAgentHookLedgerSummary(cwd, env).parentDelegationEnforcement).toContain(
      "declaration-based compatibility fallback",
    );
  });

  test("a structured V2 child atomically resolves its unresolved V1 parent caller", () => {
    const cwd = temporaryDirectory("gdm-runtime-v1-parent-caller-cwd-");
    const env = environment(
      temporaryDirectory("gdm-runtime-v1-parent-caller-home-"),
    );
    const session = "v1-parent-v2-child";
    const parent = envelope("unresolved-v1-parent", {
      canDelegate: true,
      childQuota: 2,
      ownership: { mode: "read", resources: ["docs/unresolved-v1-parent.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "parent-use", parent),
      )),
    ).toBe("allow");
    expect(ledger(cwd, env, session).reservations["parent-use"]?.agentId).toBeUndefined();

    const child = envelope("v2-child", {
      parentId: parent.taskId,
      depth: 2,
      ownership: { mode: "read", resources: ["docs/v2-child.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "child-use", child, {
          callerAgentId: "actual-v1-parent-agent",
          taskName: "v2_child",
        }),
      )),
    ).toBe("allow");
    let state = ledger(cwd, env, session);
    expect(state.reservations["parent-use"]?.agentId).toBe(
      "actual-v1-parent-agent",
    );
    expect(state.reservations["parent-use"]?.agentLinkAuthority).toBe("caller");
    expect(state.reservations["parent-use"]?.state).toBe("running");
    expect(state.agents["actual-v1-parent-agent"]?.state).toBe("running");
    expect(state.reservations["child-use"]?.spawnProtocol).toBe("v2");
    expect(state.reservations["child-use"]?.callerAgentId).toBe(
      "actual-v1-parent-agent",
    );

    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", session, "actual-v2-child-agent"),
    );
    const wrongCallerChild = envelope("wrong-caller-v2-child", {
      parentId: parent.taskId,
      depth: 2,
      ownership: { mode: "read", resources: ["docs/wrong-caller-v2-child.md"] },
    });
    const beforeWrongCaller = readFileSync(agentLedgerPath(cwd, env, session));
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "wrong-caller-use", wrongCallerChild, {
          callerAgentId: "different-parent-agent",
          taskName: "wrong_caller_v2_child",
        }),
      )),
    ).toBe("deny");
    expect(readFileSync(agentLedgerPath(cwd, env, session))).toEqual(
      beforeWrongCaller,
    );
    state = ledger(cwd, env, session);
    expect(state.reservations["parent-use"]?.agentId).toBe(
      "actual-v1-parent-agent",
    );
    expect(state.agents["different-parent-agent"]).toBeUndefined();
    expect(state.totalAcceptedAttempts).toBe(2);
  });

  test("denied V1 parent resolution is transactional and unresolved V1 roots stay parallel", () => {
    const cwd = temporaryDirectory("gdm-runtime-v1-transaction-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-v1-transaction-home-"));
    const deniedSession = "denied-v1-parent-resolution";
    const parent = envelope("transaction-parent", {
      canDelegate: true,
      childQuota: 1,
      ownership: { mode: "read", resources: ["docs/transaction-parent.md"] },
    });
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", deniedSession, "parent-use", parent),
    );
    const beforeDenial = readFileSync(agentLedgerPath(cwd, env, deniedSession));
    const wrongDepthChild = envelope("wrong-depth-v2-child", {
      parentId: parent.taskId,
      depth: 3,
      ownership: { mode: "read", resources: ["docs/wrong-depth-v2-child.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", deniedSession, "wrong-depth-use", wrongDepthChild, {
          callerAgentId: "transaction-parent-agent",
          taskName: "wrong_depth_v2_child",
        }),
      )),
    ).toBe("deny");
    expect(readFileSync(agentLedgerPath(cwd, env, deniedSession))).toEqual(
      beforeDenial,
    );
    let state = ledger(cwd, env, deniedSession);
    expect(state.reservations["parent-use"]?.agentId).toBeUndefined();
    expect(state.agents["transaction-parent-agent"]).toBeUndefined();
    expect(state.totalAcceptedAttempts).toBe(1);

    const parallelSession = "parallel-unresolved-v1";
    const first = envelope("parallel-v1-first", {
      ownership: { mode: "read", resources: ["docs/parallel-v1-first.md"] },
    });
    const second = envelope("parallel-v1-second", {
      ownership: { mode: "read", resources: ["docs/parallel-v1-second.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", parallelSession, "first-use", first),
      )),
    ).toBe("allow");
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", parallelSession, "second-use", second),
      )),
    ).toBe("allow");
    state = ledger(cwd, env, parallelSession);
    expect(state.reservations["first-use"]?.agentId).toBeUndefined();
    expect(state.reservations["second-use"]?.agentId).toBeUndefined();
    expect(state.reservations["first-use"]?.spawnProtocol).toBe("v1");
    expect(state.reservations["second-use"]?.spawnProtocol).toBe("v1");
    expect(state.totalAcceptedAttempts).toBe(2);
  });

  test("caller-bound checks enforce canDelegate and exact depth", () => {
    const cwd = temporaryDirectory("gdm-runtime-parent-policy-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-parent-policy-home-"));

    for (const scenario of [
      { session: "no-delegate", canDelegate: false, depth: 2 },
      { session: "wrong-depth", canDelegate: true, depth: 3 },
    ]) {
      const parent = envelope(`${scenario.session}-parent`, {
        canDelegate: scenario.canDelegate,
        childQuota: 1,
        ownership: { mode: "read", resources: [`src/${scenario.session}-parent.ts`] },
      });
      invoke(
        cwd,
        env,
        spawnInput("PreToolUse", scenario.session, "parent-use", parent),
      );
      invoke(
        cwd,
        env,
        spawnInput("PostToolUse", scenario.session, "parent-use", parent, {
          response: JSON.stringify({ agent_id: `${scenario.session}-agent` }),
        }),
      );
      const child = envelope(`${scenario.session}-child`, {
        parentId: parent.taskId,
        depth: scenario.depth,
        ownership: { mode: "read", resources: [`src/${scenario.session}-child.ts`] },
      });
      const beforeDenial = readFileSync(
        agentLedgerPath(cwd, env, scenario.session),
      );
      expect(
        preDecision(invoke(
          cwd,
          env,
          spawnInput("PreToolUse", scenario.session, "child-use", child, {
            callerAgentId: `${scenario.session}-agent`,
          }),
        )),
      ).toBe("deny");
      expect(
        readFileSync(agentLedgerPath(cwd, env, scenario.session)),
      ).toEqual(beforeDenial);
    }
  });

  test("whitespace markers and identifiers fail closed while path aliases collide", () => {
    const cwd = temporaryDirectory("gdm-runtime-canonical-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-canonical-home-"));
    const malformed = envelope("indented-marker");
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", "canonical-session", "indented-use", malformed, {
          message: `  ${AGENT_ENVELOPE_PREFIX}${JSON.stringify(malformed)}`,
        }),
      )),
    ).toBe("deny");

    for (const [toolUseId, bad] of [
      ["space-task-use", envelope(" space-task")],
      [
        "space-resource-use",
        envelope("space-resource", {
          ownership: { mode: "read", resources: ["src/file.ts "] },
        }),
      ],
      [
        "space-scope-use",
        envelope("space-scope", { scope: " scope/value" }),
      ],
    ] as const) {
      expect(
        preDecision(invoke(
          cwd,
          env,
          spawnInput("PreToolUse", "canonical-session", toolUseId, bad),
        )),
      ).toBe("deny");
    }

    const writer = envelope("writer", {
      scope: "scope/writer",
      ownership: { mode: "write", resources: ["src/tmp/../shared.ts"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", "canonical-session", "writer-use", writer),
      )),
    ).toBe("allow");
    for (const [index, resource] of [
      "./src/shared.ts",
      "src\\shared.ts",
      "src/nested/../shared.ts",
    ].entries()) {
      const alias = envelope(`alias-${index}`, {
        scope: `scope/alias-${index}`,
        ownership: { mode: "write", resources: [resource] },
      });
      expect(
        preDecision(invoke(
          cwd,
          env,
          spawnInput("PreToolUse", "canonical-session", `alias-use-${index}`, alias),
        )),
      ).toBe("deny");
    }

    const scoped = envelope("scoped-a", {
      scope: "scope/tmp/../same",
      ownership: { mode: "read", resources: ["docs/a.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", "canonical-session", "scoped-a-use", scoped),
      )),
    ).toBe("allow");
    const scopeAlias = envelope("scoped-b", {
      scope: "./scope/same",
      ownership: { mode: "read", resources: ["docs/b.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", "canonical-session", "scoped-b-use", scopeAlias),
      )),
    ).toBe("deny");
    expect(ledger(cwd, env, "canonical-session").totalAcceptedAttempts).toBe(2);
  });

  test("short Pre acknowledgement expiry and provisional lifecycle links are conservative", () => {
    const cwd = temporaryDirectory("gdm-runtime-ttl-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-ttl-home-"));
    const startedAt = 1_800_000_000_000;

    const unacknowledged = envelope("unacknowledged");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", "pre-ttl", "pre-ttl-use", unacknowledged),
      startedAt,
    );
    expect(
      invoke(
        cwd,
        env,
        { session_id: "pre-ttl", hook_event_name: "Stop" },
        startedAt + AGENT_PRE_ACK_TTL_MS + 1,
      ).decision,
    ).toBeUndefined();
    const expired = ledger(cwd, env, "pre-ttl");
    expect(expired.reservations["pre-ttl-use"]?.state).toBe("expired");
    expect(expired.totalAcceptedAttempts).toBe(1);
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", "pre-ttl", "pre-ttl-use", unacknowledged),
        startedAt + AGENT_PRE_ACK_TTL_MS + 2,
      )),
    ).toBe("deny");
    expect(
      invoke(
        cwd,
        env,
        spawnInput("PostToolUse", "pre-ttl", "pre-ttl-use", unacknowledged, {
          response: JSON.stringify({ agent_id: "late-agent" }),
        }),
        startedAt + AGENT_PRE_ACK_TTL_MS + 3,
      ).decision,
    ).toBe("block");
    expect(ledger(cwd, env, "pre-ttl").agents["late-agent"]).toBeUndefined();

    const v2WithoutId = envelope("v2-without-id");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", "v2-session", "v2-use", v2WithoutId, {
        taskName: "v2_without_id",
      }),
      startedAt,
    );
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", "v2-session", "v2-use", v2WithoutId, {
        taskName: "v2_without_id",
        response: JSON.stringify({
          task_name: "v2_without_id",
          nickname: "no-id",
        }),
      }),
      startedAt + 1,
    );
    expect(
      invoke(
        cwd,
        env,
        { session_id: "v2-session", hook_event_name: "Stop" },
        startedAt + AGENT_RESERVATION_TTL_MS * 2,
      ).decision,
    ).toBeUndefined();
    expect(ledger(cwd, env, "v2-session").reservations["v2-use"]?.state).toBe(
      "expired",
    );

    const provisional = envelope("provisional");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", "provisional-session", "provisional-use", provisional),
      startedAt,
    );
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", "provisional-session", "provisional-agent"),
      startedAt + 1,
    );
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStop", "provisional-session", "provisional-agent"),
      startedAt + 2,
    );
    let provisionalState = ledger(cwd, env, "provisional-session");
    expect(provisionalState.reservations["provisional-use"]?.state).toBe("running");
    expect(provisionalState.reservations["provisional-use"]?.agentLinkAuthority).toBe(
      "provisional",
    );
    const dependent = envelope("dependent", {
      blockedBy: ["provisional"],
      ownership: { mode: "read", resources: ["docs/dependent.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", "provisional-session", "dependent-use", dependent),
        startedAt + 3,
      )),
    ).toBe("deny");

    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", "provisional-session", "provisional-use", provisional, {
        response: JSON.stringify({ agent_id: "provisional-agent" }),
      }),
      startedAt + 4,
    );
    provisionalState = ledger(cwd, env, "provisional-session");
    expect(provisionalState.reservations["provisional-use"]?.state).toBe("stopped");
    expect(provisionalState.reservations["provisional-use"]?.agentLinkAuthority).toBe(
      "post",
    );
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", "provisional-session", "dependent-use", dependent),
        startedAt + 5,
      )),
    ).toBe("allow");

    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", "old-agent-session", "old-agent"),
      startedAt,
    );
    const fresh = envelope("fresh-after-old");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", "old-agent-session", "fresh-use", fresh),
      startedAt + 1,
    );
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStop", "old-agent-session", "old-agent"),
      startedAt + 2,
    );
    const afterOldStop = ledger(cwd, env, "old-agent-session");
    expect(afterOldStop.reservations["fresh-use"]?.state).toBe("pending");
    expect(afterOldStop.reservations["fresh-use"]?.agentId).toBeUndefined();
  });

  test("session attempt history is never reset by the age of another ledger", () => {
    const cwd = temporaryDirectory("gdm-runtime-retention-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-retention-home-"));
    const originalSession = "long-lived-root-session";
    const startedAt = Date.now();
    for (let index = 0; index < 12; index += 1) {
      expect(
        preDecision(invoke(
          cwd,
          env,
          {
            session_id: originalSession,
            hook_event_name: "PreToolUse",
            tool_name: "spawn_agent",
            tool_use_id: `original-use-${index}`,
            tool_input: { message: `ordinary delegated task ${index}` },
          },
          startedAt + index,
        )),
      ).toBe("allow");
    }

    const afterThirtyOneDays = startedAt + 31 * 24 * 60 * 60 * 1_000;
    expect(
      preDecision(invoke(
        cwd,
        env,
        {
          session_id: "different-newer-session",
          hook_event_name: "PreToolUse",
          tool_name: "spawn_agent",
          tool_use_id: "newer-use",
          tool_input: { message: "trigger ordinary state maintenance" },
        },
        afterThirtyOneDays,
      )),
    ).toBe("allow");
    expect(
      preDecision(invoke(
        cwd,
        env,
        {
          session_id: originalSession,
          hook_event_name: "PreToolUse",
          tool_name: "spawn_agent",
          tool_use_id: "thirteenth-use",
          tool_input: { message: "must remain over the cumulative limit" },
        },
        afterThirtyOneDays + 1,
      )),
    ).toBe("deny");
    expect(ledger(cwd, env, originalSession).totalAcceptedAttempts).toBe(12);
  });

  test("PostToolUse digest checks are idempotent and never remap on conflict", () => {
    const cwd = temporaryDirectory("gdm-runtime-post-integrity-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-post-integrity-home-"));
    const session = "post-integrity";
    const task = envelope("post-integrity");
    invoke(cwd, env, spawnInput("PreToolUse", session, "post-use", task));

    const mismatched = spawnInput("PostToolUse", session, "post-use", task, {
      response: JSON.stringify({ agent_id: "agent-a" }),
      message: `${AGENT_ENVELOPE_PREFIX}${JSON.stringify(task)}\nchanged`,
    });
    expect(invoke(cwd, env, mismatched).decision).toBe("block");
    expect(ledger(cwd, env, session).reservations["post-use"]?.postOutcome).toBeUndefined();

    const accepted = spawnInput("PostToolUse", session, "post-use", task, {
      response: JSON.stringify({ agent_id: "agent-a", nickname: "A" }),
    });
    invoke(cwd, env, accepted);
    const stableBytes = readFileSync(agentLedgerPath(cwd, env, session));
    invoke(cwd, env, accepted, Date.now() + 10_000);
    expect(readFileSync(agentLedgerPath(cwd, env, session))).toEqual(stableBytes);

    const conflicting = spawnInput("PostToolUse", session, "post-use", task, {
      response: JSON.stringify({ agent_id: "agent-b", nickname: "B" }),
    });
    expect(invoke(cwd, env, conflicting).decision).toBe("block");
    expect(readFileSync(agentLedgerPath(cwd, env, session))).toEqual(stableBytes);
    const state = ledger(cwd, env, session);
    expect(state.reservations["post-use"]?.agentId).toBe("agent-a");
    expect(state.agents["agent-b"]).toBeUndefined();

    const wrongCaller = spawnInput("PostToolUse", session, "post-use", task, {
      callerAgentId: "unexpected-caller",
      response: JSON.stringify({ agent_id: "agent-a", nickname: "A" }),
    });
    expect(invoke(cwd, env, wrongCaller).decision).toBe("block");
    expect(readFileSync(agentLedgerPath(cwd, env, session))).toEqual(stableBytes);

    const failureSession = "failed-post";
    const failed = envelope("failed-post");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", failureSession, "failed-use", failed),
    );
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", failureSession, "failed-use", failed, {
        response: JSON.stringify({
          success: false,
          error: "spawn failed",
          agent_id: "failed-agent",
        }),
      }),
    );
    invoke(cwd, env, lifecycleInput("SubagentStop", failureSession, "failed-agent"));
    expect(ledger(cwd, env, failureSession).reservations["failed-use"]?.state).toBe(
      "failed",
    );
    const afterFailure = envelope("after-failure", {
      blockedBy: ["failed-post"],
      ownership: { mode: "read", resources: ["docs/after-failure.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", failureSession, "after-failure-use", afterFailure),
      )),
    ).toBe("deny");
  });

  test("prototype-shaped ids are ordinary keys and corrupt ledger invariants fail closed", () => {
    const cwd = temporaryDirectory("gdm-runtime-ledger-cwd-");
    const codexHome = temporaryDirectory("gdm-runtime-ledger-home-");
    const env = environment(codexHome);
    const session = "prototype-keys";
    const task = envelope("__proto__", {
      ownership: { mode: "read", resources: ["docs/prototype.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "__proto__", task),
      )),
    ).toBe("allow");
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", session, "__proto__", task, {
        response: JSON.stringify({ agent_id: "constructor" }),
      }),
    );
    invoke(cwd, env, lifecycleInput("SubagentStop", session, "constructor"));
    const safeState = ledger(cwd, env, session);
    expect(safeState.reservations["__proto__"]?.state).toBe("stopped");
    expect(safeState.agents["constructor"]?.reservationToolUseId).toBe("__proto__");
    expect(readAgentHookLedgerSummary(cwd, env).corruptLedgers).toBe(0);

    const corruptions: Array<{
      readonly name: string;
      readonly prepare: (state: JsonObject) => void;
    }> = [
      {
        name: "attempt-count",
        prepare: (state) => {
          state.totalAcceptedAttempts = 2;
        },
      },
      {
        name: "duplicate-task",
        prepare: (state) => {
          const reservations = state.reservations as JsonObject;
          const original = reservations["first-use"] as JsonObject;
          const duplicate = structuredClone(original);
          duplicate.toolUseId = "second-use";
          reservations["second-use"] = duplicate;
          state.totalAcceptedAttempts = 2;
        },
      },
      {
        name: "one-way-link",
        prepare: (state) => {
          const agents = state.agents as JsonObject;
          delete agents["linked-agent"];
        },
      },
      {
        name: "state-timestamp",
        prepare: (state) => {
          const reservations = state.reservations as JsonObject;
          const reservation = reservations["first-use"] as JsonObject;
          reservation.state = "stopped";
          delete reservation.stoppedAt;
        },
      },
    ];

    for (const corruption of corruptions) {
      const corruptHome = temporaryDirectory(`gdm-runtime-corrupt-${corruption.name}-`);
      const corruptEnv = environment(corruptHome);
      const corruptSession = `corrupt-${corruption.name}`;
      const first = envelope("first", {
        ownership: { mode: "read", resources: [`docs/${corruption.name}.md`] },
      });
      invoke(
        cwd,
        corruptEnv,
        spawnInput("PreToolUse", corruptSession, "first-use", first),
      );
      if (corruption.name === "one-way-link") {
        invoke(
          cwd,
          corruptEnv,
          spawnInput("PostToolUse", corruptSession, "first-use", first, {
            response: JSON.stringify({ agent_id: "linked-agent" }),
          }),
        );
      }
      const corruptPath = agentLedgerPath(cwd, corruptEnv, corruptSession);
      const raw = JSON.parse(readFileSync(corruptPath, "utf8")) as JsonObject;
      corruption.prepare(raw);
      writeFileSync(corruptPath, `${JSON.stringify(raw, null, 2)}\n`);

      const output = invoke(cwd, corruptEnv, {
        session_id: corruptSession,
        hook_event_name: "Stop",
        stop_hook_active: false,
      });
      expect(output.decision, corruption.name).toBe("block");
      expect(String(output.reason), corruption.name).toContain("corrupt");
      expect(readAgentHookLedgerSummary(cwd, corruptEnv).corruptLedgers).toBe(1);
    }
  });

  test("schema-v1 links without authority migrate to provisional and cannot satisfy blockedBy", () => {
    const cwd = temporaryDirectory("gdm-runtime-migrate-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-migrate-home-"));
    const session = "legacy-authority";
    const task = envelope("legacy-task");
    invoke(cwd, env, spawnInput("PreToolUse", session, "legacy-use", task));
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", session, "legacy-use", task, {
        response: JSON.stringify({ agent_id: "legacy-agent" }),
      }),
    );
    invoke(cwd, env, lifecycleInput("SubagentStop", session, "legacy-agent"));

    const path = agentLedgerPath(cwd, env, session);
    const raw = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    const reservations = raw.reservations as JsonObject;
    const reservation = reservations["legacy-use"] as JsonObject;
    delete reservation.agentLinkAuthority;
    delete reservation.postResponseDigest;
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);

    expect(
      invoke(cwd, env, {
        session_id: session,
        hook_event_name: "Stop",
        stop_hook_active: false,
      }).decision,
    ).toBe("block");
    const migrated = ledger(cwd, env, session);
    expect(migrated.reservations["legacy-use"]?.agentLinkAuthority).toBe("provisional");
    expect(migrated.reservations["legacy-use"]?.state).toBe("running");

    const dependent = envelope("legacy-dependent", {
      blockedBy: ["legacy-task"],
      ownership: { mode: "read", resources: ["docs/legacy-dependent.md"] },
    });
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "legacy-dependent-use", dependent),
      )),
    ).toBe("deny");

    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", session, "legacy-use", task, {
        response: JSON.stringify({ agent_id: "legacy-agent" }),
      }),
    );
    const checkpointed = ledger(cwd, env, session);
    expect(checkpointed.reservations["legacy-use"]?.agentLinkAuthority).toBe("post");
    expect(checkpointed.reservations["legacy-use"]?.state).toBe("stopped");
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "legacy-dependent-use", dependent),
      )),
    ).toBe("allow");
  });

  test("a reordered Post with different tool input cannot attach to a later Pre", () => {
    const cwd = temporaryDirectory("gdm-runtime-orphan-post-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-orphan-post-home-"));
    const session = "orphan-post";
    const task = envelope("orphan-post");
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", session, "orphan-use", task, {
        response: JSON.stringify({ agent_id: "orphan-agent" }),
        message: `${AGENT_ENVELOPE_PREFIX}${JSON.stringify(task)}\nold input`,
      }),
    );
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "orphan-use", task),
      )),
    ).toBe("deny");
    const state = ledger(cwd, env, session);
    expect(state.totalAcceptedAttempts).toBe(0);
    expect(Object.keys(state.reservations)).toEqual([]);
    expect(Object.keys(state.orphanPosts)).toEqual(["orphan-use"]);
  });

  test("mixed unresolved V1 and V2 recovery state never guesses a lifecycle link", () => {
    const cwd = temporaryDirectory("gdm-runtime-mixed-recovery-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-mixed-recovery-home-"));
    const session = "mixed-unresolved-recovery";
    const v1 = envelope("manual-v1", {
      ownership: { mode: "read", resources: ["docs/manual-v1.md"] },
    });
    invoke(cwd, env, spawnInput("PreToolUse", session, "v1-use", v1));

    const path = agentLedgerPath(cwd, env, session);
    const raw = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    const reservations = raw.reservations as JsonObject;
    const v2Reservation = structuredClone(reservations["v1-use"]) as JsonObject;
    v2Reservation.toolUseId = "v2-use";
    v2Reservation.toolInputDigest = "a".repeat(64);
    v2Reservation.spawnProtocol = "v2";
    v2Reservation.taskName = "manual_v2";
    v2Reservation.envelope = envelope("manual-v2", {
      ownership: { mode: "read", resources: ["docs/manual-v2.md"] },
    });
    reservations["v2-use"] = v2Reservation;
    raw.totalAcceptedAttempts = 2;
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);

    invoke(cwd, env, lifecycleInput("SubagentStart", session, "ambiguous-agent"));
    let state = ledger(cwd, env, session);
    expect(state.reservations["v1-use"]?.agentId).toBeUndefined();
    expect(state.reservations["v2-use"]?.agentId).toBeUndefined();
    expect(state.agents["ambiguous-agent"]?.reservationToolUseId).toBeUndefined();

    invoke(cwd, env, lifecycleInput("SubagentStop", session, "ambiguous-agent"));
    state = ledger(cwd, env, session);
    expect(state.reservations["v1-use"]?.agentId).toBeUndefined();
    expect(state.reservations["v2-use"]?.agentId).toBeUndefined();
    expect(state.agents["ambiguous-agent"]?.reservationToolUseId).toBeUndefined();
  });

  test("a failed Post cannot hide an agent that was actually observed running", () => {
    const cwd = temporaryDirectory("gdm-runtime-failed-running-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-failed-running-home-"));
    const startedAt = Date.now();
    const session = "failed-but-running";
    const task = envelope("failed-but-running");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", session, "running-use", task),
      startedAt,
    );
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", session, "running-agent"),
      startedAt + 1,
    );
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", session, "running-use", task, {
        response: JSON.stringify({
          success: false,
          error: "spawn call reported failure after Start",
          agent_id: "running-agent",
        }),
      }),
      startedAt + 2,
    );
    let state = ledger(cwd, env, session);
    expect(state.reservations["running-use"]?.postOutcome).toBe("failed");
    expect(state.reservations["running-use"]?.state).toBe("running");
    expect(
      invoke(
        cwd,
        env,
        { session_id: session, hook_event_name: "Stop" },
        startedAt + 3,
      ).decision,
    ).toBe("block");

    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStop", session, "running-agent"),
      startedAt + 4,
    );
    state = ledger(cwd, env, session);
    expect(state.reservations["running-use"]?.state).toBe("failed");
    expect(
      invoke(
        cwd,
        env,
        { session_id: session, hook_event_name: "Stop" },
        startedAt + 5,
      ).decision,
    ).toBeUndefined();

    const expirySession = "failed-running-expiry";
    const expiryTask = envelope("failed-running-expiry");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", expirySession, "expiry-use", expiryTask),
      startedAt,
    );
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", expirySession, "expiry-agent"),
      startedAt + 1,
    );
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", expirySession, "expiry-use", expiryTask, {
        response: JSON.stringify({
          success: false,
          agent_id: "expiry-agent",
        }),
      }),
      startedAt + 2,
    );
    expect(
      invoke(
        cwd,
        env,
        { session_id: expirySession, hook_event_name: "Stop" },
        startedAt + AGENT_RESERVATION_TTL_MS + 3,
      ).decision,
    ).toBeUndefined();
    expect(
      ledger(cwd, env, expirySession).reservations["expiry-use"]?.state,
    ).toBe("expired");
  });

  test("a later Start reactivates failed or expired linked reservations without erasing failure evidence", () => {
    const cwd = temporaryDirectory("gdm-runtime-reactivate-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-reactivate-home-"));
    const startedAt = Date.now();

    const failedSession = "failed-post-before-start";
    const failedTask = envelope("failed-post-before-start");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", failedSession, "failed-use", failedTask),
      startedAt,
    );
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", failedSession, "failed-use", failedTask, {
        response: JSON.stringify({
          success: false,
          error: "spawn reported failure before lifecycle Start",
          agent_id: "failed-late-agent",
        }),
      }),
      startedAt + 1,
    );
    let state = ledger(cwd, env, failedSession);
    expect(state.reservations["failed-use"]?.state).toBe("failed");
    const failureReason = state.reservations["failed-use"]?.failureReason;
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", failedSession, "failed-late-agent"),
      startedAt + 2,
    );
    state = ledger(cwd, env, failedSession);
    expect(state.reservations["failed-use"]?.state).toBe("running");
    expect(state.reservations["failed-use"]?.postOutcome).toBe("failed");
    expect(state.reservations["failed-use"]?.failureReason).toBe(failureReason);
    expect(
      invoke(
        cwd,
        env,
        { session_id: failedSession, hook_event_name: "Stop" },
        startedAt + 3,
      ).decision,
    ).toBe("block");
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStop", failedSession, "failed-late-agent"),
      startedAt + 4,
    );
    expect(ledger(cwd, env, failedSession).reservations["failed-use"]?.state).toBe(
      "failed",
    );
    expect(
      invoke(
        cwd,
        env,
        { session_id: failedSession, hook_event_name: "Stop" },
        startedAt + 5,
      ).decision,
    ).toBeUndefined();

    const expiredSession = "expired-linked-before-restart";
    const expiredTask = envelope("expired-linked-before-restart");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", expiredSession, "expired-use", expiredTask),
      startedAt,
    );
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", expiredSession, "expired-use", expiredTask, {
        response: JSON.stringify({
          agent_id: "expired-linked-agent",
          nickname: "linked",
        }),
      }),
      startedAt + 1,
    );
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", expiredSession, "expired-linked-agent"),
      startedAt + 2,
    );
    expect(
      invoke(
        cwd,
        env,
        { session_id: expiredSession, hook_event_name: "Stop" },
        startedAt + AGENT_RESERVATION_TTL_MS + 3,
      ).decision,
    ).toBeUndefined();
    state = ledger(cwd, env, expiredSession);
    expect(state.agents["expired-linked-agent"]?.state).toBe("running");
    expect(state.reservations["expired-use"]?.state).toBe("expired");
    expect(state.reservations["expired-use"]?.failureReason).toBe(
      "lifecycle_lease_expired",
    );

    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", expiredSession, "expired-linked-agent"),
      startedAt + AGENT_RESERVATION_TTL_MS + 4,
    );
    state = ledger(cwd, env, expiredSession);
    expect(state.reservations["expired-use"]?.state).toBe("running");
    expect(state.reservations["expired-use"]?.failureReason).toBeUndefined();
    expect(
      invoke(
        cwd,
        env,
        { session_id: expiredSession, hook_event_name: "Stop" },
        startedAt + AGENT_RESERVATION_TTL_MS + 5,
      ).decision,
    ).toBe("block");
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStop", expiredSession, "expired-linked-agent"),
      startedAt + AGENT_RESERVATION_TTL_MS + 6,
    );
    expect(
      ledger(cwd, env, expiredSession).reservations["expired-use"]?.state,
    ).toBe("stopped");
  });

  test("unlinked lifecycle observations are bounded and expire out of Stop", () => {
    const cwd = temporaryDirectory("gdm-runtime-unlinked-lease-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-unlinked-lease-home-"));
    const session = "unlinked-lifecycle-lease";
    const startedAt = Date.now();
    for (let index = 0; index < 12; index += 1) {
      expect(
        invoke(
          cwd,
          env,
          lifecycleInput("SubagentStart", session, `rogue-agent-${index}`),
          startedAt + index,
        ).systemMessage,
      ).toBeUndefined();
    }
    const overflow = invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", session, "rogue-agent-overflow"),
      startedAt + 12,
    );
    expect(String(overflow.systemMessage)).toContain(
      "unlinked lifecycle observation limit",
    );
    expect(Object.keys(ledger(cwd, env, session).agents)).toHaveLength(12);
    expect(
      invoke(
        cwd,
        env,
        { session_id: session, hook_event_name: "Stop" },
        startedAt + 13,
      ).decision,
    ).toBe("block");

    expect(
      invoke(
        cwd,
        env,
        { session_id: session, hook_event_name: "Stop" },
        startedAt + AGENT_RESERVATION_TTL_MS + 13,
      ).decision,
    ).toBeUndefined();
    expect(Object.keys(ledger(cwd, env, session).agents)).toEqual([]);
  });

  test("a full unlinked-observation cap never rejects a uniquely correlatable lifecycle event", () => {
    const cwd = temporaryDirectory("gdm-runtime-correlation-cap-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-correlation-cap-home-"));
    const startedAt = Date.now();

    const startSession = "correlation-cap-start";
    for (let index = 0; index < 12; index += 1) {
      invoke(
        cwd,
        env,
        lifecycleInput("SubagentStart", startSession, `start-rogue-${index}`),
        startedAt + index,
      );
    }
    const v1 = envelope("cap-v1", {
      ownership: { mode: "read", resources: ["docs/cap-v1.md"] },
    });
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", startSession, "v1-use", v1),
      startedAt + 13,
    );
    expect(
      invoke(
        cwd,
        env,
        lifecycleInput("SubagentStart", startSession, "correlated-v1-agent"),
        startedAt + 14,
      ).systemMessage,
    ).toBeUndefined();
    let state = ledger(cwd, env, startSession);
    expect(state.reservations["v1-use"]?.agentId).toBe("correlated-v1-agent");
    expect(
      Object.values(state.agents).filter(
        (agent) => agent.reservationToolUseId === undefined,
      ),
    ).toHaveLength(12);

    const stopSession = "correlation-cap-stop";
    for (let index = 0; index < 12; index += 1) {
      invoke(
        cwd,
        env,
        lifecycleInput("SubagentStart", stopSession, `stop-rogue-${index}`),
        startedAt + index,
      );
    }
    const v2 = envelope("cap-v2", {
      ownership: { mode: "read", resources: ["docs/cap-v2.md"] },
    });
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", stopSession, "v2-use", v2, {
        taskName: "cap_v2",
      }),
      startedAt + 13,
    );
    expect(
      invoke(
        cwd,
        env,
        lifecycleInput("SubagentStop", stopSession, "correlated-v2-agent"),
        startedAt + 14,
      ).systemMessage,
    ).toBeUndefined();
    state = ledger(cwd, env, stopSession);
    expect(state.reservations["v2-use"]?.agentId).toBe("correlated-v2-agent");
    expect(state.reservations["v2-use"]?.state).toBe("stopped");
    expect(
      Object.values(state.agents).filter(
        (agent) => agent.reservationToolUseId === undefined,
      ),
    ).toHaveLength(12);
  });

  test("schema-v1 auxiliary records above the new cap migrate without corruption", () => {
    const cwd = temporaryDirectory("gdm-runtime-cap-migration-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-cap-migration-home-"));
    const session = "legacy-over-cap";
    const task = envelope("legacy-orphan", {
      ownership: { mode: "read", resources: ["docs/legacy-orphan.md"] },
    });
    invoke(
      cwd,
      env,
      spawnInput("PostToolUse", session, "legacy-orphan-0", task, {
        response: JSON.stringify({ nickname: "legacy" }),
      }),
    );
    const path = agentLedgerPath(cwd, env, session);
    const raw = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    const orphanPosts = raw.orphanPosts as JsonObject;
    const original = orphanPosts["legacy-orphan-0"] as JsonObject;
    const observedAt = new Date().toISOString();
    for (let index = 1; index < 14; index += 1) {
      const orphan = structuredClone(original);
      orphan.toolUseId = `legacy-orphan-${index}`;
      orphan.observedAt = observedAt;
      orphanPosts[`legacy-orphan-${index}`] = orphan;
    }
    const agents = raw.agents as JsonObject;
    for (let index = 0; index < 14; index += 1) {
      agents[`legacy-agent-${index}`] = {
        agentId: `legacy-agent-${index}`,
        agentType: "worker",
        state: "stopped",
        firstObservedAt: observedAt,
        stoppedAt: observedAt,
      };
    }
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);

    expect(
      invoke(cwd, env, {
        session_id: session,
        hook_event_name: "Stop",
      }).decision,
    ).toBeUndefined();
    const migrated = ledger(cwd, env, session);
    expect(Object.keys(migrated.orphanPosts)).toHaveLength(12);
    expect(
      Object.values(migrated.agents).filter(
        (agent) => agent.reservationToolUseId === undefined,
      ),
    ).toHaveLength(12);
    expect(readAgentHookLedgerSummary(cwd, env).corruptLedgers).toBe(0);
  });

  test("summary reports expired leases without waiting for a mutating hook", () => {
    const cwd = temporaryDirectory("gdm-runtime-summary-lease-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-summary-lease-home-"));
    const startedAt = Date.now();
    const pending = envelope("summary-pending");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", "summary-pending-session", "pending-use", pending),
      startedAt,
    );
    let summary = readAgentHookLedgerSummary(cwd, env, startedAt + 1);
    expect(summary.pending).toBe(1);
    expect(summary.expired).toBe(0);
    summary = readAgentHookLedgerSummary(
      cwd,
      env,
      startedAt + AGENT_PRE_ACK_TTL_MS + 1,
    );
    expect(summary.pending).toBe(0);
    expect(summary.expired).toBe(1);

    const running = envelope("summary-running");
    invoke(
      cwd,
      env,
      spawnInput("PreToolUse", "summary-running-session", "running-use", running),
      startedAt,
    );
    invoke(
      cwd,
      env,
      lifecycleInput("SubagentStart", "summary-running-session", "summary-agent"),
      startedAt + 1,
    );
    summary = readAgentHookLedgerSummary(cwd, env, startedAt + 2);
    expect(summary.running).toBe(1);
    summary = readAgentHookLedgerSummary(
      cwd,
      env,
      startedAt + AGENT_RESERVATION_TTL_MS + 2,
    );
    expect(summary.running).toBe(0);
    expect(summary.expired).toBe(2);
    expect(
      ledger(cwd, env, "summary-running-session").reservations["running-use"]?.state,
    ).toBe("running");
  });

  test("unmatched Post records are bounded, replayable, and reconcile once", () => {
    const cwd = temporaryDirectory("gdm-runtime-orphan-bound-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-orphan-bound-home-"));
    const session = "orphan-bound";
    const posts: JsonObject[] = [];
    const tasks: AgentEnvelope[] = [];
    for (let index = 0; index < 12; index += 1) {
      const task = envelope(`orphan-${index}`, {
        ownership: { mode: "read", resources: [`docs/orphan-${index}.md`] },
      });
      const post = spawnInput(
        "PostToolUse",
        session,
        `orphan-use-${index}`,
        task,
        { response: JSON.stringify({ nickname: `orphan-${index}` }) },
      );
      tasks.push(task);
      posts.push(post);
      expect(invoke(cwd, env, post).decision).toBeUndefined();
    }
    let state = ledger(cwd, env, session);
    expect(Object.keys(state.orphanPosts)).toHaveLength(12);
    expect(state.totalAcceptedAttempts).toBe(0);
    const stable = readFileSync(agentLedgerPath(cwd, env, session));

    const overflowTask = envelope("orphan-overflow", {
      ownership: { mode: "read", resources: ["docs/orphan-overflow.md"] },
    });
    expect(
      invoke(
        cwd,
        env,
        spawnInput("PostToolUse", session, "orphan-overflow-use", overflowTask),
      ).decision,
    ).toBe("block");
    expect(readFileSync(agentLedgerPath(cwd, env, session))).toEqual(stable);
    expect(invoke(cwd, env, posts[0]!).decision).toBeUndefined();
    expect(readFileSync(agentLedgerPath(cwd, env, session))).toEqual(stable);

    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "orphan-use-0", tasks[0]!),
      )),
    ).toBe("allow");
    state = ledger(cwd, env, session);
    expect(state.totalAcceptedAttempts).toBe(1);
    expect(Object.keys(state.orphanPosts)).toHaveLength(11);
    expect(state.reservations["orphan-use-0"]?.postOutcome).toBe("succeeded");
    expect(
      preDecision(invoke(
        cwd,
        env,
        spawnInput("PreToolUse", session, "orphan-use-0", tasks[0]!),
      )),
    ).toBe("deny");
    expect(ledger(cwd, env, session).totalAcceptedAttempts).toBe(1);
  });

  test("stale ledger locks recover from PID reuse, unavailable identity, and legacy tokens", () => {
    const cwd = temporaryDirectory("gdm-runtime-stale-lock-cwd-");
    const startDigest = currentProcessStartDigest();
    expect(startDigest).toBeDefined();
    if (startDigest === undefined) return;
    const wrongDigest = startDigest === "0".repeat(64)
      ? "1".repeat(64)
      : "0".repeat(64);
    const cases = [
      ["pid-reuse", `v2:${process.pid}:${wrongDigest}:a1`],
      ["identity-unavailable", `v2:${process.pid}:unknown:a2`],
      ["legacy-pid-only", `${process.pid}-a3`],
    ] as const;

    for (const [name, token] of cases) {
      const env = environment(temporaryDirectory(`gdm-runtime-${name}-home-`));
      const session = `stale-lock-${name}`;
      const first = envelope(`first-${name}`, {
        ownership: { mode: "read", resources: [`docs/${name}-first.md`] },
      });
      invoke(cwd, env, spawnInput("PreToolUse", session, "first-use", first));
      const lockPath = `${agentLedgerPath(cwd, env, session)}.lock`;
      writeFileSync(lockPath, `${token}\n`);
      const stale = new Date(Date.now() - 31_000);
      utimesSync(lockPath, stale, stale);
      const second = envelope(`second-${name}`, {
        ownership: { mode: "read", resources: [`docs/${name}-second.md`] },
      });
      expect(
        preDecision(invoke(
          cwd,
          env,
          spawnInput("PreToolUse", session, "second-use", second),
        )),
      ).toBe("allow");
      expect(existsSync(lockPath)).toBe(false);
    }
  });

  test("a stale lock is preserved only for the exact live process incarnation", () => {
    const cwd = temporaryDirectory("gdm-runtime-live-lock-cwd-");
    const env = environment(temporaryDirectory("gdm-runtime-live-lock-home-"));
    const session = "live-lock-incarnation";
    const digest = currentProcessStartDigest();
    expect(digest).toBeDefined();
    if (digest === undefined) return;
    const first = envelope("live-lock-first", {
      ownership: { mode: "read", resources: ["docs/live-lock-first.md"] },
    });
    invoke(cwd, env, spawnInput("PreToolUse", session, "first-use", first));
    const lockPath = `${agentLedgerPath(cwd, env, session)}.lock`;
    const token = `v2:${process.pid}:${digest}:b1`;
    writeFileSync(lockPath, `${token}\n`);
    const stale = new Date(Date.now() - 31_000);
    utimesSync(lockPath, stale, stale);

    const second = envelope("live-lock-second", {
      ownership: { mode: "read", resources: ["docs/live-lock-second.md"] },
    });
    const output = invoke(
      cwd,
      env,
      spawnInput("PreToolUse", session, "second-use", second),
    );
    expect(preDecision(output)).toBe("deny");
    expect(String(
      (output.hookSpecificOutput as JsonObject).permissionDecisionReason,
    )).toContain("lock timed out");
    expect(readFileSync(lockPath, "utf8").trim()).toBe(token);
  });
});
