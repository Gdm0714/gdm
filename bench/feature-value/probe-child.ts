#!/usr/bin/env bun
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CHILD_SCHEMA,
  REGISTRATION_ARMS,
  type ChildProbe,
  type RegistrationArm,
} from "./protocol.ts";

const arm = process.argv[2] as RegistrationArm | undefined;
if (process.argv.length !== 3 || arm === undefined || !REGISTRATION_ARMS.includes(arm)) {
  console.error("usage: probe-child.ts <baseline|memory|computer-use|both|status|all>");
  process.exit(2);
}

const handlers = new Map<string, Array<(...args: any[]) => any>>();
const tools: any[] = [];
const statusValues: unknown[] = [];
const pi = {
  on(name: string, handler: (...args: any[]) => any) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  },
  registerCommand() {},
  registerTool(tool: unknown) { tools.push(tool); },
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function metadata() {
  const definitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    promptSnippet: tool.promptSnippet ?? "",
    promptGuidelines: tool.promptGuidelines ?? [],
    parameters: tool.parameters,
  }));
  return {
    toolCount: definitions.length,
    toolSchemaBytes: definitions.reduce((sum, tool) => sum + Buffer.byteLength(canonical(tool.parameters)), 0),
    promptMetadataBytes: definitions.reduce((sum, tool) => sum + Buffer.byteLength([
      tool.description, tool.promptSnippet, ...tool.promptGuidelines,
    ].join("\n")), 0),
    toolDefinitionBytes: Buffer.byteLength(canonical(definitions)),
  };
}

const started = performance.now();
const cpuStarted = process.cpuUsage();
let statusIntervalMs: number | null = null;
let statusFetchCalls = 0;
let statusFormattingValid: boolean | null = null;
let statusProviderHideValid: boolean | null = null;
let statusSetCalls = 0;

if (arm === "memory" || arm === "both" || arm === "all") {
  const agentDir = process.env.GDM_BENCH_AGENT_DIR;
  if (!agentDir?.startsWith("/")) throw new Error("GDM_BENCH_AGENT_DIR must be an isolated absolute path");
  process.env.GDM_PI_AGENT_DIR = agentDir;
  const extension = await import(pathToFileURL(resolve(import.meta.dir, "../../agents/pi/gdm-memory/index.ts")).href);
  extension.default(pi as any);
}

if (arm === "computer-use" || arm === "both" || arm === "all") {
  const extension = await import(pathToFileURL(resolve(import.meta.dir, "../../agents/pi/gdm-computer-use/index.ts")).href);
  extension.default(pi as any);
}

if (arm === "status" || arm === "all") {
  const statusPath = process.env.GDM_BENCH_STATUS_EXTENSION;
  if (!statusPath?.startsWith("/")) throw new Error("GDM_BENCH_STATUS_EXTENSION must be absolute");
  const canonicalPath = realpathSync(statusPath);
  const info = lstatSync(canonicalPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("status extension must be a regular non-symlink file");
  const beforeStart = handlers.get("session_start")?.length ?? 0;
  const beforeShutdown = handlers.get("session_shutdown")?.length ?? 0;
  const extension = await import(pathToFileURL(canonicalPath).href);
  extension.default(pi as any);

  const now = new Date("2026-09-04T00:00:00.000Z");
  const snapshot = {
    provider: "openai-codex",
    fiveHour: { usedPercent: 25, resetAt: (now.getTime() + 3_600_000) / 1000 },
    weekly: { usedPercent: 60, resetAt: (now.getTime() + 86_400_000) / 1000 },
    fetchedAt: now.getTime(),
  };
  const formatted = extension.formatCodexUsageStatus(snapshot, now);
  statusFormattingValid = formatted.includes("5h 75% 남음") && formatted.includes("주간 40% 남음");

  const ctx = {
    hasUI: true,
    model: { provider: "anthropic" },
    ui: {
      setStatus: (_key: string, value: unknown) => { statusValues.push(value); statusSetCalls++; },
      theme: { fg: (_color: string, value: string) => value },
    },
  };
  extension.syncCodexUsageStatus(ctx, now);
  statusProviderHideValid = statusValues.at(-1) === undefined;

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalFetch = globalThis.fetch;
  let intervalCallback: (() => void) | undefined;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    statusIntervalMs = typeof delay === "number" ? delay : null;
    intervalCallback = callback as () => void;
    return { synthetic: true } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  globalThis.fetch = (async () => {
    statusFetchCalls++;
    throw new Error("status display extension attempted a network request");
  }) as typeof fetch;
  (globalThis as typeof globalThis & { piCodexLimit?: unknown }).piCodexLimit = snapshot;
  ctx.model.provider = "openai-codex";
  try {
    const starts = (handlers.get("session_start") ?? []).slice(beforeStart);
    const shutdowns = (handlers.get("session_shutdown") ?? []).slice(beforeShutdown);
    for (const handler of starts) await handler({}, ctx);
    intervalCallback?.();
    for (const handler of shutdowns) await handler({}, ctx);
  } finally {
    delete (globalThis as typeof globalThis & { piCodexLimit?: unknown }).piCodexLimit;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    globalThis.fetch = originalFetch;
  }
}

const usage = process.cpuUsage(cpuStarted);
const registered = metadata();
const output: ChildProbe = {
  schemaVersion: CHILD_SCHEMA,
  arm,
  loadMs: performance.now() - started,
  cpuUserMicros: usage.user,
  cpuSystemMicros: usage.system,
  rssBytes: process.memoryUsage().rss,
  heapUsedBytes: process.memoryUsage().heapUsed,
  ...registered,
  statusIntervalMs,
  statusFetchCalls,
  statusSetCalls,
  statusFormattingValid,
  statusProviderHideValid,
};
process.stdout.write(`${JSON.stringify(output)}\n`);
