import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

mock.module("@earendil-works/pi-ai", () => ({
  Type: {
    Object: (properties: unknown, options?: unknown) => ({ type: "object", properties, options }),
    Union: (items: unknown[]) => ({ anyOf: items }),
    Literal: (value: string) => ({ const: value }),
    Optional: (value: unknown) => ({ optional: value }),
    String: (options?: unknown) => ({ type: "string", options }),
  },
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
  withFileMutationQueue: async (_path: string, callback: () => unknown) => await callback(),
}));

const memoryExtensionUrl = pathToFileURL(
  join(import.meta.dir, "..", "..", "agents", "pi", "gdm-memory", "index.ts"),
).href;
const { default: installGdmMemory } = await import(memoryExtensionUrl);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(options: { trusted?: boolean; mode?: "tui" | "print"; hasUI?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gdm-memory-extension-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(project);
  process.env.GDM_PI_AGENT_DIR = agentDir;
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const notices: Array<{ message: string; level: string }> = [];
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  };
  installGdmMemory(pi as any);
  const ctx = {
    cwd: project,
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    isProjectTrusted: () => options.trusted ?? true,
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      confirm: async () => {
        throw new Error("automatic memory must not request confirmation");
      },
    },
  };
  return { root, agentDir, project, handlers, commands, tools, notices, ctx };
}

function toolText(value: any): string {
  return value.content?.[0]?.text ?? "";
}

describe("gdm-pi memory extension", () => {
  test("/remember stores project memory and before_agent_start injects it as untrusted data", async () => {
    const app = setup();
    await app.commands.get("remember").handler("Prefers Bun for TypeScript tests", app.ctx);
    expect(app.notices.at(-1)?.message).toContain("Remembered mem-");
    const injected = await app.handlers.get("before_agent_start")?.({
      prompt: "How should we test TypeScript?",
      systemPrompt: "base prompt",
    }, app.ctx);
    expect(injected.systemPrompt).toContain("base prompt");
    expect(injected.systemPrompt).toContain('trust="untrusted-data"');
    expect(injected.systemPrompt).toContain("Prefers Bun for TypeScript tests");
  });

  test("model remember and forget write automatically without confirmation", async () => {
    const app = setup({ mode: "print", hasUI: false });
    const rememberResult = await app.tools.get("gdm_memory").execute(
      "call-1",
      { action: "remember", scope: "global", text: "Uses Colima on this machine", reason: "User stated it" },
      undefined,
      undefined,
      app.ctx,
    );
    expect(toolText(rememberResult)).toContain("Remembered mem-");
    const id = toolText(rememberResult).match(/mem-[0-9a-f]{16}/u)?.[0];
    expect(id).toBeDefined();
    expect(readFileSync(join(app.agentDir, "memory", "global.jsonl"), "utf8")).toContain('"source":"tool-auto"');

    const recalled = await app.tools.get("gdm_memory").execute(
      "call-2",
      { action: "recall", query: "Colima" },
      undefined,
      undefined,
      app.ctx,
    );
    expect(toolText(recalled)).toContain("Uses Colima on this machine");
    const forgotten = await app.tools.get("gdm_memory").execute(
      "call-3",
      { action: "forget", scope: "global", id },
      undefined,
      undefined,
      app.ctx,
    );
    expect(toolText(forgotten)).toContain(`Forgot ${id}`);
    const afterForget = await app.tools.get("gdm_memory").execute(
      "call-4",
      { action: "recall", query: "Colima" },
      undefined,
      undefined,
      app.ctx,
    );
    expect(toolText(afterForget)).toContain("No matching");
  });

  test("automatic writes honor no-UI mode and untrusted project boundaries", async () => {
    const noUi = setup({ hasUI: false });
    const noUiResponse = await noUi.tools.get("gdm_memory").execute(
      "call-no-ui",
      { action: "remember", scope: "global", text: "Prefers terse reports" },
      undefined,
      undefined,
      noUi.ctx,
    );
    expect(toolText(noUiResponse)).toContain("Remembered mem-");

    const untrusted = setup({ trusted: false });
    await untrusted.commands.get("remember").handler("Prefers terse reports", untrusted.ctx);
    expect(untrusted.notices.at(-1)?.message).toContain("(global)");
    await untrusted.commands.get("remember").handler("--project Project decision", untrusted.ctx);
    expect(untrusted.notices.at(-1)?.message).toContain("trusted project");
    const projectTool = await untrusted.tools.get("gdm_memory").execute(
      "call-untrusted-project",
      { action: "remember", scope: "project", text: "Project decision" },
      undefined,
      undefined,
      untrusted.ctx,
    );
    expect(toolText(projectTool)).toContain("trusted project");
  });

  test("/memory lists, forgets, and diagnoses without automatic repair", async () => {
    const app = setup();
    await app.commands.get("remember").handler("Project uses Bun", app.ctx);
    const id = app.notices.at(-1)?.message.match(/mem-[0-9a-f]{16}/u)?.[0];
    expect(id).toBeDefined();
    await app.commands.get("memory").handler("", app.ctx);
    expect(app.notices.at(-1)?.message).toContain("Project uses Bun");
    await app.commands.get("memory").handler("list --project", app.ctx);
    expect(app.notices.at(-1)?.message).toContain("Project uses Bun");
    await app.commands.get("memory").handler("list --global --project", app.ctx);
    expect(app.notices.at(-1)?.message).toContain("Usage: /memory list");
    await app.commands.get("memory").handler(`forget ${id}`, app.ctx);
    expect(app.notices.at(-1)?.message).toContain(`Forgot ${id}`);
    await app.commands.get("memory").handler("doctor", app.ctx);
    expect(app.notices.at(-1)?.message).toContain("project: ok");
  });

  test("honors scoped recall and tab-separated remember flags", async () => {
    const app = setup();
    await app.commands.get("remember").handler("Project-specific Bun decision", app.ctx);
    await app.commands.get("remember").handler("--global\tGlobal Colima preference", app.ctx);
    const globalRecall = await app.tools.get("gdm_memory").execute(
      "call-scope",
      { action: "recall", scope: "global", query: "preference" },
      undefined,
      undefined,
      app.ctx,
    );
    expect(toolText(globalRecall)).toContain("Global Colima preference");
    expect(toolText(globalRecall)).not.toContain("Project-specific Bun decision");
  });

  test("pre-aborted automatic writes do not modify memory", async () => {
    const app = setup();
    const controller = new AbortController();
    controller.abort();
    const cancelledResult = await app.tools.get("gdm_memory").execute(
      "call-cancel",
      { action: "remember", scope: "global", text: "Cancelled durable preference" },
      controller.signal,
      undefined,
      app.ctx,
    );
    expect(toolText(cancelledResult)).toContain("cancelled");
    expect(await app.handlers.get("before_agent_start")?.({ prompt: "Cancelled", systemPrompt: "base" }, app.ctx))
      .toBeUndefined();
  });
});
