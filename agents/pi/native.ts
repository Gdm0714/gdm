/** Pi host transport only. Validation, storage and process policy live in Rust. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
export function nativeExecutable(): string {
  return process.env.GDM_NATIVE_EXECUTABLE ?? process.env.GDM_EXECUTABLE ?? "gdm";
}
export async function nativeRpc(command: string, input: unknown, cwd: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<any> {
  if (signal?.aborted) throw new Error("Request cancelled");
  return await new Promise((resolve, reject) => {
    const child = spawn(nativeExecutable(), [command, "rpc"], { cwd, stdio: "pipe" });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    let stdout = "", stderr = "", finished = false;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 15_000);
    };
    const timer = setTimeout(() => { failure = new Error(`Native ${command} timed out`); abort(); }, timeoutMs);
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", finish);
    child.stdout.on("data", data => {
      if (failure) return;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(data) > 4 * 1024 * 1024) { failure = new Error(`Native ${command} output exceeded limit`); abort(); return; }
      stdout += data.toString();
    });
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-8192); });
    child.on("close", code => {
      if (signal?.aborted) return finish(new Error("Request cancelled"));
      if (failure) return finish(failure);
      if (code !== 0) return finish(new Error(stderr.trim() || `Native ${command} exited ${code}`));
      try { finish(undefined, JSON.parse(stdout)); } catch { finish(new Error("Invalid native response")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
    if (signal?.aborted) abort();
  });
}

/** One scoped VM owner per extension. Closing the host closes its native server. */
export class ComputerTransport {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { id: number; resolve: (v: any) => void; reject: (e: Error) => void };
  private serial = 0;
  private buffer = "";
  private async ensure(): Promise<void> {
    if (this.child) return;
    const args = ["computer-use", "serve"];
    if (process.env.GDM_TYPESAFE_ENV_FILE) args.push("--env-file", process.env.GDM_TYPESAFE_ENV_FILE);
    const child = spawn(nativeExecutable(), args, { stdio: "pipe" });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    this.child = child; this.buffer = "";
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    child.on("error", error => this.fail(error));
    child.on("close", () => { if (this.child === child) { this.child = undefined; this.fail(new Error("Computer Use native server closed")); } });
    child.stdout.on("data", data => {
      this.buffer += data.toString();
      if (Buffer.byteLength(this.buffer) > 24 * 1024 * 1024) { this.fail(new Error("Computer Use response too large")); void this.stop(); return; }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const response = JSON.parse(line);
          if (this.pending?.id !== response.id) continue;
          const request = this.pending; this.pending = undefined;
          response.error ? request.reject(new Error(response.error.message)) : request.resolve(response.result);
        } catch { this.fail(new Error("Invalid Computer Use response")); void this.stop(); }
      }
    });
  }
  private fail(error: Error): void { const pending = this.pending; this.pending = undefined; pending?.reject(error); }
  async request(method: "execute" | "choose" | "step", params: unknown, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) throw new Error("Computer Use request cancelled");
    if (this.pending) throw new Error("Computer Use is busy");
    await this.ensure();
    if (this.pending) throw new Error("Computer Use is busy");
    const abort = () => { this.fail(new Error("Computer Use request cancelled")); void this.stop(); };
    const timer = setTimeout(abort, 180_000);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        const id = ++this.serial; this.pending = { id, resolve, reject };
        if (signal?.aborted) return abort();
        this.child!.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  async stop(): Promise<void> {
    const child = this.child; this.child = undefined;
    this.fail(new Error("Computer Use stopped"));
    if (!child) return;
    child.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 15_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolve(); }
    });
  }
}
