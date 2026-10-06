import { spawn } from "node:child_process";
import {
  MAX_OUTPUT_BYTES,
  MAX_EVENT_STREAM_BYTES,
  MAX_EVENT_LINE_BYTES,
  MAX_STDERR_BYTES,
  buildChildArguments,
  credentialSignature,
} from "./delegate-policy.mjs";

function processGroupAlive(pid) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopOwnedProcess(child) {
  if (child.pid === undefined) return undefined;
  const pid = child.pid;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-pid, "SIGTERM");
  } catch {
    // The child may already have exited.
  }
  const killTimer = setTimeout(() => {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else if (processGroupAlive(pid)) process.kill(-pid, "SIGKILL");
    } catch {
      // The owned process group is already gone.
    }
  }, 1_000);
  killTimer.unref();
  return killTimer;
}

function appendBounded(current, size, chunk, limit) {
  const remaining = Math.max(0, limit - size);
  if (remaining > 0) current.push(chunk.subarray(0, remaining));
  return size + chunk.byteLength;
}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"];

// Count usage reported by completed assistant messages and compaction results.
// Deltas, turn_end and agent_end repeat data and must not be counted again.
function createEventReader() {
  let pending = Buffer.alloc(0);
  let output = "";
  let assistantTurns = 0;
  let usageTurns = 0;
  let reasoningTurns = 0;
  let compactionTurns = 0;
  let compactionUsageTurns = 0;
  let compacting = false;
  let ended = false;
  let settled = false;
  let stopReason = null;
  let providerError = "";
  const reportedModels = new Set();
  const toolStarts = new Map();
  const toolCalls = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    reasoning: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const nonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const addUsage = (observed) => {
    if (!observed || !TOKEN_FIELDS.every((field) => nonnegative(observed[field])) ||
        !observed.cost || !COST_FIELDS.every((field) => nonnegative(observed.cost[field]))) return false;
    for (const field of TOKEN_FIELDS) usage[field] += observed[field];
    for (const field of COST_FIELDS) usage.cost[field] += observed.cost[field];
    if (nonnegative(observed.reasoning)) {
      usage.reasoning += observed.reasoning;
      reasoningTurns += 1;
    }
    return true;
  };
  const readLine = (line) => {
    if (line.byteLength > MAX_EVENT_LINE_BYTES) throw new Error("child event line limit exceeded");
    if (line.toString("utf8").trim() === "") return;
    let event;
    try { event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
    catch { throw new Error("child emitted malformed JSON event"); }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
      throw new Error("child emitted malformed JSON event");
    }
    // A low-level agent_end can precede overflow compaction and a retry.
    // Keep legacy agent_end-only streams working, but honor explicit continuation
    // and the final agent_settled signal when the transport emits them.
    if (event.type === "agent_start" && !settled) ended = false;
    if (event.type === "agent_end" && event.willRetry !== true) ended = true;
    if (event.type === "agent_settled") { settled = true; ended = true; }
    if (event.type === "compaction_start") compacting = true;
    if (event.type === "compaction_end") {
      compacting = false;
      compactionTurns += 1;
      if (addUsage(event.result?.usage)) compactionUsageTurns += 1;
      if (event.willRetry === true && !settled) ended = false;
    }
    if (event.type === "tool_execution_start" && typeof event.toolCallId === "string" && toolStarts.size < 256) {
      const path = event.args?.path;
      toolStarts.set(event.toolCallId, {
        name: event.toolName,
        ...(typeof path === "string" && path.length <= 1024 && !credentialSignature(path) ? { path } : {}),
      });
    }
    if (event.type === "tool_execution_end" && toolStarts.has(event.toolCallId)) {
      const call = toolStarts.get(event.toolCallId);
      toolStarts.delete(event.toolCallId);
      if (toolCalls.length < 256) toolCalls.push({ ...call, isError: event.isError === true || event.result?.isError === true });
    }
    if (event.type !== "message_end") return;
    const message = event.message;
    if (!message || typeof message !== "object" || typeof message.role !== "string") {
      throw new Error("child emitted malformed message_end event");
    }
    if (message.role !== "assistant") return;
    if (ended || !Array.isArray(message.content)) throw new Error("child emitted malformed assistant event");
    assistantTurns += 1;
    stopReason = message.stopReason;
    providerError = typeof message.errorMessage === "string" ? message.errorMessage : "";
    // Preserve already received usage even if rendering this message fails.
    if (typeof message.provider === "string" && typeof message.model === "string") {
      reportedModels.add(`${message.provider}/${message.model}`);
    }
    if (addUsage(message.usage)) usageTurns += 1;
    output = message.content.filter((part) => part?.type === "text").map((part) => {
      if (typeof part.text !== "string") throw new Error("child emitted malformed assistant text");
      return part.text;
    }).join("\n");
    if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
      output = "";
      throw new Error("child output limit exceeded");
    }
  };
  return {
    append(chunk) {
      pending = Buffer.concat([pending, chunk]);
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        readLine(line);
      }
      if (pending.byteLength > MAX_EVENT_LINE_BYTES) throw new Error("child event line limit exceeded");
    },
    finish() {
      if (pending.byteLength > 0) readLine(pending);
      pending = Buffer.alloc(0);
      if (!ended || compacting || assistantTurns === 0) throw new Error("child JSON stream incomplete");
      if (stopReason !== "stop") {
        throw new Error(providerError || `child assistant stopped with ${String(stopReason)}`);
      }
    },
    result() {
      return { output, assistantTurns, reportedModels: [...reportedModels], stopReason, toolCalls,
        usage: usageTurns + compactionUsageTurns > 0 ? {
          ...usage, reasoning: reasoningTurns === assistantTurns + compactionTurns ? usage.reasoning : null,
        } : null,
        usageComplete: assistantTurns > 0 && usageTurns === assistantTurns &&
          compactionUsageTurns === compactionTurns && !compacting };
    },
  };
}

export async function runBoundedChild({
  executable,
  cwd,
  model,
  thinking,
  systemPrompt,
  taskText,
  timeoutMs,
  signal,
  metadata = {},
}) {
  const args = buildChildArguments({ model, thinking, systemPrompt, task: taskText });
  const startedAt = performance.now();
  const events = createEventReader();
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure = "";
  let spawned = false;
  let forceKillTimer;

  return await new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, GDM_PI_DELEGATED: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.once("spawn", () => { spawned = true; });
    const requestStop = (reason) => {
      if (failure.length > 0) return;
      failure = reason;
      forceKillTimer = stopOwnedProcess(child);
    };
    const timeout = setTimeout(() => requestStop("child timeout"), timeoutMs);
    timeout.unref();
    const abort = () => requestStop("child aborted");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    child.stdout?.on("data", (raw) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_EVENT_STREAM_BYTES) requestStop("child event stream limit exceeded");
      if (failure.length > 0) return;
      try { events.append(chunk); }
      catch (error) { requestStop(error.message); }
    });
    child.stderr?.on("data", (raw) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      stderrBytes = appendBounded(stderr, stderrBytes, chunk, MAX_STDERR_BYTES);
      if (stderrBytes > MAX_STDERR_BYTES) requestStop("child stderr limit exceeded");
    });
    child.on("error", (error) => {
      if (failure.length === 0) failure = `child spawn failed: ${error.message}`;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (forceKillTimer !== undefined &&
          (child.pid === undefined || process.platform === "win32" || !processGroupAlive(child.pid))) {
        clearTimeout(forceKillTimer);
      }
      const diagnostic = Buffer.concat(stderr).toString("utf8");
      if (failure.length === 0 && exitCode === 0) {
        try { events.finish(); }
        catch (error) { failure = error.message; }
      }
      const error = failure || (exitCode === 0 ? "" : diagnostic || `child exited ${String(exitCode)}`);
      const observed = events.result();
      resolve({
        ...metadata,
        ...observed,
        model,
        thinking,
        spawned,
        elapsedMs: Math.round(performance.now() - startedAt),
        usageComplete: exitCode === 0 && error.length === 0 && observed.usageComplete,
        ok: exitCode === 0 && error.length === 0,
        exitCode,
        error,
      });
    });
  });
}
