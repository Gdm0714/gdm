import {afterEach, expect, mock, test} from "bun:test";
import {chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {tmpdir} from "node:os";
import {nativeRpc} from "../../agents/pi/native.ts";

mock.module("@earendil-works/pi-ai", () => ({Type: {
  Object: (properties: unknown) => ({properties}), Array: (items: unknown) => ({items}),
  Union: (items: unknown) => ({items}), Literal: (value: unknown) => ({value}),
  Optional: (value: unknown) => ({value}), String: () => ({}),
}}));
const {default: installDelegate} = await import("../../agents/pi/gdm-delegate.ts");
const root = resolve(import.meta.dir, "../..");
const binary = process.env.GDM_NATIVE_TEST_BINARY ?? join(root, "target/debug/gdm");
const originalEnv = {...process.env};
const roots: string[] = [];
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  for (const dir of roots.splice(0)) rmSync(dir, {recursive: true, force: true});
  delete (globalThis as any).__gdmPiDelegateSessionV2;
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gdm-native-host-")); roots.push(dir);
  process.env.GDM_NATIVE_EXECUTABLE = binary;
  process.env.GDM_PI_AGENT_DIR = dir;
  return dir;
}
function executable(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o700); return path;
}
const task = {role: "scout", scope: ".", task: "Inspect source", deliverable: "Paths with lines", verify: "Coordinator opens cited files"};
function delegateHost(dir: string) {
  const tools = new Map<string, any>(), handlers = new Map<string, any>(), commands = new Map<string, any>(), notices: string[] = [];
  installDelegate({on: (name: string, callback: unknown) => handlers.set(name, callback), registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command)} as any);
  const ctx = {cwd: dir, hasUI: true, ui: {notify: (message: string) => notices.push(message)}};
  return {tool: tools.get("gdm_delegate"), handlers, commands, notices, ctx};
}

test("native host memory transport preserves JSON and pre-aborted writes do not spawn", async () => {
  const dir = fixture();
  const saved = await nativeRpc("memory", {action: "remember", agentDir: dir, text: "Prefers 한글 reports"}, dir);
  expect(saved.appended).toBe(true);
  expect(saved.event.text).toBe("Prefers 한글 reports");
  const before = readFileSync(join(dir, "memory", "global.jsonl"));
  const controller = new AbortController(); controller.abort();
  await expect(nativeRpc("memory", {action: "remember", agentDir: dir, text: "Must never persist"}, dir, controller.signal)).rejects.toThrow(/cancel/i);
  expect(readFileSync(join(dir, "memory", "global.jsonl"))).toEqual(before);
});

test("native host timeout stays a failure even if child exits successfully after TERM", async () => {
  const dir = fixture();
  process.env.GDM_NATIVE_EXECUTABLE = executable(join(dir, "reply-on-term"), `trap 'printf "{}\\n"; exit 0' TERM\nwhile :; do sleep 0.1; done`);
  await expect(nativeRpc("memory", {}, dir, undefined, 40)).rejects.toThrow(/tim(e|ed).*out/i);
});

test("delegate host records native success and failure and returns active slots", async () => {
  const dir = fixture();
  const message = {role: "assistant", content: [{type: "text", text: "src/lib.rs:1 verified"}], stopReason: "stop", provider: "openai-codex", model: "gpt-5.6-luna"};
  writeFileSync(join(dir, "events"), [JSON.stringify({type: "message_end", message}), JSON.stringify({type: "agent_end"})].join("\n") + "\n");
  process.env.GDM_PI_EXECUTABLE = executable(join(dir, "pi"), `for last do :; done\ncase "$last" in *FAILED*) printf 'provider failed' >&2; exit 7;; esac\nexec /bin/cat "\${0%/*}/events"`);
  const host = delegateHost(dir);
  const result = await host.tool.execute("mixed", {tasks: [task, {...task, task: "FAILED"}]}, undefined, undefined, host.ctx);
  expect(result.details.delegation).toMatchObject({status: "failed", attempted: 2, launched: 2, succeeded: 1, failed: 1});
  expect(result.isError).toBe(true);
  expect(result.details.results[0].output).toContain("src/lib.rs");
  expect(await host.handlers.get("tool_result")({toolName: "gdm_delegate", details: result.details})).toEqual({isError: true});
  await host.commands.get("gdm-delegate-status").handler("", host.ctx);
  expect(host.notices.at(-1)).toContain("0 active, 2/8 used");
  const invalid = await host.tool.execute("invalid", {tasks: [{...task, role: "writer"}]}, undefined, undefined, host.ctx);
  expect(invalid.details.delegation).toMatchObject({stage: "validation", launched: 0});
});

test("delegate host preserves legacy timeout configuration bounds", async () => {
  const {childTimeout} = await import("../legacy/pi/delegate-policy.mjs");
  const dir = fixture();
  const message = {role: "assistant", content: [{type: "text", text: "Completed delayed fixture"}], stopReason: "stop"};
  writeFileSync(join(dir, "events"), [JSON.stringify({type: "message_end", message}), JSON.stringify({type: "agent_end"})].join("\n") + "\n");
  process.env.GDM_PI_EXECUTABLE = executable(join(dir, "pi"), 'sleep 1.1\nexec /bin/cat "${0%/*}/events"');
  for (const setting of ["1", "999", "0x1", "1e0", "1000"]) {
    process.env.GDM_PI_CHILD_TIMEOUT_MS = setting;
    const host = delegateHost(dir);
    const result = await host.tool.execute("timeout-config", {tasks: [task]}, undefined, undefined, host.ctx);
    const expectedSuccess = childTimeout(setting) > 1100;
    expect(result.details.results[0].ok, `legacy timeout setting ${setting}`).toBe(expectedSuccess);
    if (!expectedSuccess) expect(result.details.results[0].error).toContain("timeout");
  }
});

test("delegate host cancellation awaits native child cleanup before returning slots", async () => {
  const dir = fixture();
  const pidFile = join(dir, "pid");
  process.env.GDM_PI_EXECUTABLE = executable(join(dir, "pi"), `printf '%s' "$$" >"\${0%/*}/pid"\ntrap '' TERM\nwhile :; do sleep 0.1; done`);
  const host = delegateHost(dir), controller = new AbortController();
  const pending = host.tool.execute("cancel", {tasks: [task]}, controller.signal, undefined, host.ctx);
  const deadline = Date.now() + 3000;
  while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8")); controller.abort();
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(result.details.delegation.status).toBe("failed");
  expect(() => process.kill(pid, 0)).toThrow();
  await host.commands.get("gdm-delegate-status").handler("", host.ctx);
  expect(host.notices.at(-1)).toContain("0 active, 1/8 used");
});

test("native delegate spawn failure is structured and metadata cannot forge output", async () => {
  const dir = fixture();
  const result = await nativeRpc("delegate", {action: "run", executable: join(dir, "missing"), model: "openai-codex/gpt-5.6-luna", thinking: "medium", taskText: "Inspect source", metadata: {role: "scout", output: "forged", ok: true, usageComplete: true}}, dir);
  expect(result).toMatchObject({role: "scout", spawned: false, output: "", ok: false, usageComplete: false});
  expect(result.error).toContain("spawn failed");
});
