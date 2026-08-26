import { spawn } from "node:child_process";
import {
  MAX_OUTPUT_BYTES,
  MAX_STDERR_BYTES,
  buildChildArguments,
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
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure = "";
  let forceKillTimer;

  return await new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, GDM_PI_DELEGATED: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      stdoutBytes = appendBounded(stdout, stdoutBytes, chunk, MAX_OUTPUT_BYTES);
      if (stdoutBytes > MAX_OUTPUT_BYTES) requestStop("child output limit exceeded");
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
      const output = Buffer.concat(stdout).toString("utf8");
      const diagnostic = Buffer.concat(stderr).toString("utf8");
      const error = failure || (exitCode === 0 ? "" : diagnostic || `child exited ${String(exitCode)}`);
      resolve({
        ...metadata,
        ok: exitCode === 0 && error.length === 0,
        exitCode,
        output,
        error,
      });
    });
  });
}
