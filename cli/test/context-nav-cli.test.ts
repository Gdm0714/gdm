import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "dist", "gdm");
const decoder = new TextDecoder();
const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});

function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gdm-context-cli-")));
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(init.exitCode, decoder.decode(init.stderr)).toBe(0);
  writeFileSync(join(root, "entry.ts"), "export const validation = true;\n");
  return root;
}

function run(args: readonly string[], stdin = "", env: Record<string, string> = {}) {
  const result = Bun.spawnSync([CLI, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

describe("gdm context CLI", () => {
  test("executes a strict stdin query through the compiled binary", () => {
    const root = repository();
    const request = {
      schemaVersion: "gdm-context-query/v1",
      root,
      op: "pack",
      terms: ["validation"],
      seeds: ["entry.ts"],
      edgeTypes: ["imports"],
      maxDepth: 1,
      budget: { maxBytes: 4096, maxNodes: 24, maxEdges: 48, maxSnippets: 5 },
    };
    const result = run(["context", "query"], JSON.stringify(request), {
      GDM_CONTEXT_TRUSTED_ROOT: root,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    const pack = JSON.parse(result.stdout) as { s: string; st: string; n: unknown[] };
    expect(pack.s).toBe("gdm-context-pack/v1");
    expect(pack.st).toBe("ok");
    expect(pack.n.length).toBeGreaterThan(0);
  });

  test("maps malformed input and argv to usage errors", () => {
    const malformed = run(["context", "query"], "not-json");
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toContain("오류(usage):");

    for (const args of [
      ["context", "query", "extra"],
      ["context", "status", "extra"],
      ["context", "unknown"],
    ]) {
      const result = run(args);
      expect(result.exitCode, `${args.join(" ")}\n${result.stderr}`).toBe(2);
      expect(result.stdout).toBe("");
    }
  });

  test("reports one-shot status without waiting for stdin EOF", async () => {
    const child = Bun.spawn([CLI, "context", "status"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(1000).then(() => "timeout" as const),
    ]);
    expect(exitCode).not.toBe("timeout");
    expect(exitCode).toBe(0);
    const stdout = await new Response(child.stdout).text();
    const status = JSON.parse(stdout) as Record<string, unknown>;
    expect(status).toEqual({
      schemaVersion: "gdm-context-status/v1",
      provider: "gdm-local-context",
      version: 1,
      mode: "one-shot",
      cache: "disabled",
      querySchema: "gdm-context-query/v1",
      packSchema: "gdm-context-pack/v1",
      defaultMaxBytes: 4096,
      absoluteMaxBytes: 12288,
    });
  });
});
