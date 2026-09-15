// Benchmark-only observation. No phase is auto-approved or retried by this extension.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export default function trace(pi: any) {
  const root = process.cwd();
  const destination = process.env.GDM_QUALITY_TRACE_DIR!;
  mkdirSync(destination, { recursive: true });
  let index = 0;
  function capture(kind: string, event: any = {}) {
    const files: Record<string, Buffer> = {};
    const unsafe: string[] = [];
    function walk(path: string) {
      if (!existsSync(path)) return;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) { unsafe.push(relative(root, path)); return; }
      if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
      else if (stat.isFile()) {
        if (stat.size > 1024 * 1024) { unsafe.push(relative(root, path)); return; }
        files[relative(root, path)] = readFileSync(path);
      }
    }
    for (const name of ["src", "test", "package.json", "TASK.md", "DECISIONS.json"]) walk(join(root, name));
    const hashes = Object.fromEntries(Object.keys(files).sort().map(name => [name, hash(files[name]!)]));
    const sourceHashes = Object.fromEntries(Object.entries(hashes).filter(([name]) => name.startsWith("src/")));
    const snapshot = String(index++).padStart(4, "0");
    const dir = join(destination, "snapshots", snapshot);
    for (const [name, data] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true }); writeFileSync(join(dir, name), data);
    }
    const record = { index: index - 1, kind, toolName: event.toolName, toolCallId: event.toolCallId,
      roles: event.toolName === "gdm_delegate" && Array.isArray(event.input?.tasks)
        ? event.input.tasks.map((t: any) => t?.role) : [],
      sourceHash: hash(JSON.stringify(sourceHashes)), hashes, unsafe, snapshot,
      timestamp: Date.now(), isError: event.isError ?? false };
    appendFileSync(join(destination, "trace.jsonl"), JSON.stringify(record) + "\n");
  }
  pi.on("session_start", () => capture("start"));
  pi.on("tool_call", (event: any) => { capture("before", event); });
  pi.on("tool_result", (event: any) => { capture("after", event); });
  pi.on("agent_settled", () => capture("settled"));
}
