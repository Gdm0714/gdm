import { afterEach, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

mock.module("@earendil-works/pi-ai", () => ({ Type: {
  Object: (properties: unknown, options?: unknown) => ({ type: "object", properties, options }),
  Array: (items: unknown, options?: unknown) => ({ type: "array", items, options }),
  Union: (items: unknown[]) => ({ anyOf: items }), Literal: (value: unknown) => ({ const: value }),
  Optional: (value: unknown) => value, String: (options?: unknown) => ({ type: "string", options }),
  Number: () => ({ type: "number" }),
} }));
const url = pathToFileURL(join(import.meta.dir, "../../agents/pi/gdm-delegate.ts")).href;
const { default: install } = await import(url);
const saved = { ...process.env };
const roots: string[] = [];
afterEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GDM_PI_")) delete process.env[key];
  for (const [key, value] of Object.entries(saved)) if (key.startsWith("GDM_PI_")) process.env[key] = value;
  delete (globalThis as any).__gdmPiDelegateBudgetV1;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function harness() {
  delete (globalThis as any).__gdmPiDelegateBudgetV1;
  const events = new Map<string, any[]>(); let tool: any;
  install({ on(name: string, handler: any) { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerCommand() {}, registerTool(value: any) { tool = value; } });
  return { tool, patch: async (result: any) => {
    let event = { toolName: "gdm_delegate", details: result.details, isError: false };
    for (const fn of events.get("tool_result") ?? []) event = { ...event, ...await fn(event) };
    return event;
  } };
}
const task = { role: "scout", thinking: "medium", scope: "src", task: "Inspect contracts",
  deliverable: "Findings or reasoned no findings", verify: "Check cited source lines" };

test("delegate rejection records an attempted task and propagates the outer tool error", async () => {
  const { tool, patch } = harness();
  const result = await tool.execute("bad", { tasks: [{ ...task, thinking: "max" }] }, undefined, undefined, { cwd: process.cwd() });
  expect(result.details.delegation).toEqual({ status: "rejected", stage: "validation", attempted: 1,
    launched: 0, succeeded: 0, failed: 0, rejected: 1 });
  expect((await patch(result)).isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain('"thinking":"max"');
});

test("a missing executable is a failed spawn attempt, not a launched child", async () => {
  const root = mkdtempSync(join(tmpdir(), "gdm-delegate-missing-")); roots.push(root);
  process.env.GDM_PI_EXECUTABLE = join(root, "does-not-exist");
  const { tool, patch } = harness();
  const result = await tool.execute("missing", { tasks: [task] }, undefined, undefined, { cwd: root });
  expect(result.details.delegation).toMatchObject({ status: "failed", attempted: 1, launched: 0, failed: 1, succeeded: 0 });
  expect(result.details.results[0]).toMatchObject({ spawned: false, ok: false, usageComplete: false });
  expect((await patch(result)).isError).toBe(true);
});

test("explicit scout medium executes while empty specialist output is a failed participation", async () => {
  const root = mkdtempSync(join(tmpdir(), "gdm-delegate-events-")); roots.push(root);
  const executable = join(root, "pi");
  process.env.GDM_PI_EXECUTABLE = executable;
  const { tool, patch } = harness();
  const emit = (content: string) => {
    const message = { role: "assistant", provider: "openai-codex", model: "gpt-5.6-luna",
      content: [{ type: "text", text: content }], stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } } };
    const events = [{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/api.ts" } },
      { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false },
      { type: "message_end", message }, { type: "agent_end", messages: [message] }];
    writeFileSync(join(root, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(executable, `#!/bin/sh\nexec /bin/cat '${join(root, "events.jsonl")}'\n`); chmodSync(executable, 0o755);
    // macOS cold execution can take seconds; warm the synthetic transport before
    // testing delegation's completion/error contract, without altering its bounds.
    expect(Bun.spawnSync([executable], { stdout: "ignore", stderr: "pipe" }).exitCode).toBe(0);
  };
  emit("No findings: the inspected public contract is consistent.");
  const good = await tool.execute("ok", { tasks: [task] }, undefined, undefined, { cwd: root });
  expect(good.details.delegation).toMatchObject({ status: "completed", attempted: 1, launched: 1, succeeded: 1, rejected: 0 });
  expect(good.details.results[0]).toMatchObject({ role: "scout", model: "openai-codex/gpt-5.6-luna", thinking: "medium", spawned: true, ok: true });
  expect(good.details.results[0].toolCalls).toEqual([{ name: "read", path: "src/api.ts", isError: false }]);
  expect((await patch(good)).isError).toBe(false);
  emit("");
  const empty = await tool.execute("empty", { tasks: [task] }, undefined, undefined, { cwd: root });
  expect(empty.details.results[0]).toMatchObject({ transportOk: true, ok: false });
  expect(empty.details.delegation).toMatchObject({ status: "failed", attempted: 1, launched: 1, failed: 1 });
  expect((await patch(empty)).isError).toBe(true);
}, 30_000);
