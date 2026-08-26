import { isAbsolute } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DelegateBudget,
  childTimeout,
  validModel,
  validThinking,
  validateDelegationRequest,
} from "./delegate-policy.mjs";
import { runBoundedChild } from "./delegate-runner.mjs";
import { installGdmPresentation } from "./presentation.mjs";
import { installGdmCommands } from "./ax.mjs";

const childSystemPrompt = `You are a bounded read-only specialist delegated by a GDM Pi coordinator.
Use only read, grep, find, and ls. Never modify files, run shell commands, delegate, or claim that your
result is GDM evidence. Stay inside the supplied scope. Do not read or return credentials. Return a
concise result with paths and line numbers, distinguish evidence from inference, and state what the
coordinator must verify independently.`;

type DelegatedTask = {
  readonly role: "scout" | "reviewer";
  readonly scope: string;
  readonly task: string;
  readonly deliverable: string;
  readonly verify: string;
};

type ChildResult = {
  readonly role: string;
  readonly scope: string;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly output: string;
  readonly error: string;
};

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

async function runChild(
  executable: string,
  cwd: string,
  model: string,
  thinking: string,
  timeoutMs: number,
  task: DelegatedTask,
  signal: AbortSignal | undefined,
): Promise<ChildResult> {
  const taskText = [
    `Role: ${task.role}`,
    `Scope: ${task.scope}`,
    `Task: ${task.task}`,
    `Deliverable: ${task.deliverable}`,
    `Verification requested from coordinator: ${task.verify}`,
  ].join("\n");
  return await runBoundedChild({
    executable,
    cwd,
    model,
    thinking,
    systemPrompt: childSystemPrompt,
    taskText,
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    metadata: { role: task.role, scope: task.scope },
  });
}

function failure(text: string, details: unknown = {}): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    details,
    isError: true,
  };
}

export default function gdmDelegateExtension(pi: ExtensionAPI): void {
  installGdmPresentation(pi);
  installGdmCommands(pi);
  const globals = globalThis as typeof globalThis & { __gdmPiDelegateBudgetV1?: DelegateBudget };
  const budget = globals.__gdmPiDelegateBudgetV1 ?? new DelegateBudget();
  globals.__gdmPiDelegateBudgetV1 = budget;
  const pinnedModel = process.env.GDM_PI_CHILD_MODEL ?? "openai-codex/gpt-5.6-sol";
  const pinnedThinking = (process.env.GDM_PI_CHILD_THINKING ?? "xhigh") as ThinkingLevel;
  let restoringModel = false;
  let restoringThinking = false;

  pi.on("model_select", async (event, ctx) => {
    const selected = `${event.model.provider}/${event.model.id}`;
    if (selected === pinnedModel || restoringModel) return;
    const separator = pinnedModel.indexOf("/");
    const expected = ctx.modelRegistry.find(
      pinnedModel.slice(0, separator),
      pinnedModel.slice(separator + 1),
    );
    if (expected === undefined || expected === null) {
      ctx.ui.notify(`GDM Pi could not restore pinned model ${pinnedModel}`, "error");
      return;
    }
    restoringModel = true;
    try {
      const restored = await pi.setModel(expected);
      ctx.ui.notify(
        restored ? `GDM Pi restored pinned model ${pinnedModel}` : `GDM Pi could not restore pinned model ${pinnedModel}`,
        restored ? "warning" : "error",
      );
    } finally {
      restoringModel = false;
    }
  });
  pi.on("thinking_level_select", async (event, ctx) => {
    if (event.level === pinnedThinking || restoringThinking) return;
    restoringThinking = true;
    try {
      pi.setThinkingLevel(pinnedThinking);
      ctx.ui.notify(`GDM Pi restored pinned thinking level ${pinnedThinking}`, "warning");
    } finally {
      restoringThinking = false;
    }
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    const current = `${ctx.model.provider}/${ctx.model.id}`;
    if (current !== pinnedModel) {
      const separator = pinnedModel.indexOf("/");
      const expected = ctx.modelRegistry.find(
        pinnedModel.slice(0, separator),
        pinnedModel.slice(separator + 1),
      );
      if (expected === undefined || expected === null || !await pi.setModel(expected)) {
        throw new Error(`GDM_PI_MODEL_PIN_FAILED: ${pinnedModel}`);
      }
    }
    if (ctx.thinkingLevel !== pinnedThinking) pi.setThinkingLevel(pinnedThinking);
  });
  pi.registerCommand("gdm-delegate-status", {
    description: "Show the bounded GDM Pi delegation budget",
    handler: async (_args, ctx) => {
      const current = budget.snapshot();
      ctx.ui.notify(`GDM Pi delegates: ${current.active} active, ${current.total}/8 used`, "info");
    },
  });
  pi.registerTool({
    name: "gdm_delegate",
    label: "GDM Delegate",
    description: "Run 1-3 bounded read-only Pi specialists in parallel. The coordinator must verify every result.",
    promptSnippet: "Delegate bounded read-only repository investigation to up to three isolated Pi children",
    promptGuidelines: [
      "Use gdm_delegate only for independent read-only investigation that materially reduces coordinator context.",
      "Never treat gdm_delegate output as GDM evidence or let a delegated child modify files.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        role: Type.Union([Type.Literal("scout"), Type.Literal("reviewer")]),
        scope: Type.String(),
        task: Type.String(),
        deliverable: Type.String(),
        verify: Type.String(),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const validation = validateDelegationRequest(params);
      if (validation !== null) return failure(`GDM_PI_DELEGATION_REJECTED: ${validation}`);

      const tasks = params.tasks as DelegatedTask[];
      const reservation = budget.reserve(tasks.length);
      if (reservation !== null) return failure(`GDM_PI_DELEGATION_REJECTED: ${reservation}`, budget.snapshot());

      const executable = process.env.GDM_PI_EXECUTABLE ?? "";
      const model = process.env.GDM_PI_CHILD_MODEL ?? "openai-codex/gpt-5.6-sol";
      const thinking = process.env.GDM_PI_CHILD_THINKING ?? "xhigh";
      if (!isAbsolute(executable)) {
        budget.release(tasks.length);
        return failure("GDM_PI_DELEGATION_REJECTED: launch through gdm-pi so the Pi executable is identity-bound");
      }
      if (!validModel(model) || !validThinking(thinking)) {
        budget.release(tasks.length);
        return failure("GDM_PI_DELEGATION_REJECTED: invalid child model or thinking configuration");
      }

      onUpdate?.({
        content: [{ type: "text", text: `GDM Pi delegates: 0/${tasks.length} complete` }],
        details: budget.snapshot(),
      });
      try {
        const timeoutMs = childTimeout(process.env.GDM_PI_CHILD_TIMEOUT_MS);
        const results = await Promise.all(tasks.map((task) =>
          runChild(executable, ctx.cwd, model, thinking, timeoutMs, task, signal)
        ));
        const succeeded = results.filter((result) => result.ok).length;
        const text = results.map((result, index) => {
          const body = result.ok ? result.output.trim() || "(no output)" : result.error;
          return `### delegate ${index + 1}: ${result.role} [${result.ok ? "completed" : "failed"}]\nScope: ${result.scope}\n\n${body}`;
        }).join("\n\n---\n\n");
        return {
          content: [{ type: "text", text: `GDM Pi delegates: ${succeeded}/${results.length} succeeded\n\n${text}` }],
          details: { results, budget: budget.snapshot() },
          ...(succeeded === results.length ? {} : { isError: true }),
        };
      } finally {
        budget.release(tasks.length);
      }
    },
  });
}
