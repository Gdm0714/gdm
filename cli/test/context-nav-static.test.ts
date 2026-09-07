import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function filesUnder(path: string): string[] {
  const root = join(ROOT, path);
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  }).sort();
}

describe("P1 context navigation scope and simplicity", () => {
  test("keeps the provider read-only, local, one-shot, and schema-free in Pi", () => {
    const contextFiles = filesUnder("cli/src/context-nav");
    const source = [...contextFiles.map(read), read("cli/src/context-nav-command.ts")].join("\n");

    expect(contextFiles.some((path) => /(?:store|sync|sqlite)/u.test(path))).toBe(false);
    for (const forbidden of [
      "bun:sqlite",
      "registerTool",
      "createServer",
      "WebSocket",
      "node:net",
      "node:http",
      "node:https",
      "fetch(",
      "writeFileSync",
      "appendFileSync",
      "mkdirSync",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(read("agents/pi/gdm-pi")).not.toContain("gdm-context");
    expect(read("agents/pi/gdm-pi")).not.toContain("gdm_context");
    for (const path of filesUnder("skills")) {
      expect(read(path), path).not.toContain("gdm-context-query/v1");
    }
  });

  test("has one shared module parser instead of a duplicated scanner", () => {
    const sourceFiles = filesUnder("cli/src").filter((path) => path.endsWith(".ts"));
    const definitions = sourceFiles.flatMap((path) => {
      const matches = read(path).match(/\bfunction parseModule\s*\(/gu) ?? [];
      return matches.map(() => path);
    });

    expect(definitions).toEqual(["cli/src/graph-nav-scan.ts"]);
    expect(read("cli/src/graph-nav-provider.ts")).toContain('from "./graph-nav-scan.ts"');
  });
});
