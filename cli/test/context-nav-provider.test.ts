import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runContextQuery } from "../src/context-nav/index.ts";
import { addCheck, initWork, passCheck } from "../src/state.ts";
import { saveWork, writeWorkOutput } from "../src/store.ts";
import type { ContextPack, ContextQuery } from "../src/context-nav/schema.ts";
import type { WorkContract } from "../src/types.ts";

const decoder = new TextDecoder();

function git(cwd: string, args: readonly string[]): void {
  const outcome = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(outcome.exitCode, decoder.decode(outcome.stderr)).toBe(0);
}

function repository(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(root, ["init", "-q"]);
  return root;
}

function write(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function sha8(contents: string): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 8);
}

function query(root: string, overrides: Partial<ContextQuery> = {}): ContextQuery {
  return {
    schemaVersion: "gdm-context-query/v1",
    root,
    op: "pack",
    terms: ["validation", "boundary", "backend", "core"],
    seeds: ["src/state.ts"],
    edgeTypes: ["imports", "mentions", "contains", "owns", "touches", "verifies", "evidenced_by", "tests"],
    maxDepth: 2,
    budget: { maxBytes: 4096, maxNodes: 24, maxEdges: 48, maxSnippets: 5 },
    ...overrides,
  };
}

function nodeIndex(pack: ContextPack, key: string): number {
  return pack.n.findIndex((node) => node[0] === key);
}

function edgeKeys(pack: ContextPack): string[] {
  return pack.e.map(([from, to, type]) => `${pack.n[from]?.[0]}->${pack.n[to]?.[0]}:${type}`);
}

function fixture(): { readonly root: string; readonly stateSource: string; readonly docsSource: string } {
  const root = repository("gdm-context-provider-");
  const stateSource = "import { appendJournal } from './journal.ts';\nexport const validationBoundary = appendJournal;\n";
  const docsSource = "# Validation Boundary\n\nThe implementation is [`state.ts`](../src/state.ts).\n";
  write(root, "src/state.ts", stateSource);
  write(root, "src/journal.ts", "export const appendJournal = true;\n");
  write(root, "src/nested/component.ts", "export const nestedComponent = true;\n");
  write(root, "test/state.test.ts", "import { validationBoundary } from '../src/state.ts'; void validationBoundary;\n");
  write(root, "docs/architecture.md", docsSource);
  write(root, "package.json", `${JSON.stringify({ name: "@acme/core", scripts: { verify: "bun test" } }, null, 2)}\n`);
  write(root, ".github/CODEOWNERS", "/src/state.ts @backend\ncomponent.ts @nested-owner\n");
  write(root, "CODEOWNERS", "component.ts @root-owner\n");
  write(root, "docs/CODEOWNERS", "component.ts @docs-owner\n");

  const contract: WorkContract = {
    required: [],
    forbidden: [],
    activeHabits: [],
    commit: "forbidden",
    allowedPaths: ["src/state.ts"],
  };
  let work = initWork("validation-boundary", "Cobalt compass decision", "2026-01-01T00:00:00.000Z", false, contract);
  work = addCheck(work, {
    desc: "Validation boundary has journal evidence",
    cmd: "true",
    expect: "journal evidence exists",
    kind: "behavior",
  }).work;
  saveWork(root, work);
  const observed = writeWorkOutput(root, work.slug, "c1.txt", "EVIDENCE_BODY_MUST_NOT_BE_INDEXED\n");
  work = passCheck(work, "c1", {
    observed,
    sha256: createHash("sha256").update("EVIDENCE_BODY_MUST_NOT_BE_INDEXED\n").digest("hex"),
    exitCode: 0,
    manual: false,
  }, "2026-01-01T00:01:00.000Z");
  saveWork(root, work);
  return { root, stateSource, docsSource };
}

describe("one-shot context navigation provider", () => {
  test("connects source, docs, package, ownership, and GDM metadata", () => {
    const { root, stateSource, docsSource } = fixture();
    const pack = runContextQuery(query(root), { GDM_CONTEXT_TRUSTED_ROOT: root });

    expect(pack.s).toBe("gdm-context-pack/v1");
    expect(pack.st).toBe("ok");
    expect(pack.fr).toBe("fresh");
    expect(Buffer.byteLength(JSON.stringify(pack))).toBeLessThanOrEqual(4096);

    const expectedKeys = [
      "src/state.ts",
      "src/journal.ts",
      "test/state.test.ts",
      "docs/architecture.md#validation-boundary",
      "pkg:@acme/core",
      "owner:@backend",
      "w:validation-boundary",
      "c:validation-boundary:c1",
      "ev:.gdm/validation-boundary/out/c1.txt",
    ];
    for (const key of expectedKeys) {
      expect(nodeIndex(pack, key), `${key}\n${JSON.stringify(pack)}`).toBeGreaterThanOrEqual(0);
    }

    expect(pack.n[nodeIndex(pack, "src/state.ts")]).toEqual(["src/state.ts", "file", sha8(stateSource), 1]);
    expect(pack.n[nodeIndex(pack, "docs/architecture.md#validation-boundary")]).toEqual([
      "docs/architecture.md#validation-boundary",
      "heading",
      sha8(docsSource),
      1,
    ]);

    const edges = edgeKeys(pack);
    expect(edges).toContain("src/state.ts->src/journal.ts:imports");
    expect(edges).toContain("test/state.test.ts->src/state.ts:tests");
    expect(edges).toContain("docs/architecture.md#validation-boundary->src/state.ts:mentions");
    expect(edges).toContain("owner:@backend->src/state.ts:owns");
    expect(edges).toContain("w:validation-boundary->src/state.ts:touches");
    expect(edges).toContain("w:validation-boundary->c:validation-boundary:c1:contains");
    expect(edges).toContain("c:validation-boundary:c1->ev:.gdm/validation-boundary/out/c1.txt:evidenced_by");
    expect(JSON.stringify(pack)).not.toContain("EVIDENCE_BODY_MUST_NOT_BE_INDEXED");

    const basenameOwners = runContextQuery(query(root, {
      terms: ["nested", "owner"],
      seeds: [],
      edgeTypes: ["owns"],
      maxDepth: 1,
    }), { GDM_CONTEXT_TRUSTED_ROOT: root });
    expect(nodeIndex(basenameOwners, "owner:@nested-owner")).toBeGreaterThanOrEqual(0);
    expect(nodeIndex(basenameOwners, "src/nested/component.ts")).toBeGreaterThanOrEqual(0);
    expect(edgeKeys(basenameOwners)).toContain("owner:@nested-owner->src/nested/component.ts:owns");
    expect(JSON.stringify(basenameOwners)).not.toContain("@root-owner");
    expect(JSON.stringify(basenameOwners)).not.toContain("@docs-owner");

    const lowerPriorityOwners = runContextQuery(query(root, {
      terms: ["root", "owner"],
      seeds: [],
      edgeTypes: ["owns"],
      maxDepth: 1,
    }), { GDM_CONTEXT_TRUSTED_ROOT: root });
    expect(JSON.stringify(lowerPriorityOwners)).not.toContain("@root-owner");
    expect(JSON.stringify(lowerPriorityOwners)).not.toContain("@docs-owner");
  });

  test("indexes Work brief terms without returning the original brief", () => {
    const { root } = fixture();
    const pack = runContextQuery(query(root, {
      op: "route",
      seeds: [],
      terms: ["cobalt"],
      edgeTypes: [],
      maxDepth: 0,
      budget: { maxBytes: 1024, maxNodes: 12, maxEdges: 0, maxSnippets: 0 },
    }), { GDM_CONTEXT_TRUSTED_ROOT: root });

    expect(pack.n.some((node) => node[0] === "w:validation-boundary")).toBe(true);
    expect(JSON.stringify(pack)).not.toContain("Cobalt compass decision");
  });

  test("caps the combined lexical terms of each node at 96", () => {
    const { root } = fixture();
    const contract: WorkContract = {
      required: [],
      forbidden: [],
      activeHabits: [],
      commit: "forbidden",
      allowedPaths: ["src/state.ts"],
    };
    const longBrief = `${Array.from({ length: 120 }, (_, index) => `key${index.toString().padStart(3, "0")}`).join(" ")} latebeacon`;
    saveWork(root, initWork("term-cap", longBrief, "2026-01-01T00:00:00.000Z", false, contract));

    const early = runContextQuery(query(root, {
      op: "route",
      seeds: [],
      terms: ["key000"],
      edgeTypes: [],
      maxDepth: 0,
      budget: { maxBytes: 1024, maxNodes: 12, maxEdges: 0, maxSnippets: 0 },
    }), { GDM_CONTEXT_TRUSTED_ROOT: root });
    const beyondCap = runContextQuery(query(root, {
      op: "route",
      seeds: [],
      terms: ["latebeacon"],
      edgeTypes: [],
      maxDepth: 0,
      budget: { maxBytes: 1024, maxNodes: 12, maxEdges: 0, maxSnippets: 0 },
    }), { GDM_CONTEXT_TRUSTED_ROOT: root });

    expect(early.n.some((node) => node[0] === "w:term-cap")).toBe(true);
    expect(beyondCap.n.some((node) => node[0] === "w:term-cap")).toBe(false);
  });

  test("returns a smaller route response when no seed is known", () => {
    const { root } = fixture();
    const pack = runContextQuery(query(root, {
      op: "route",
      seeds: [],
      terms: ["validation", "boundary"],
      budget: { maxBytes: 1024, maxNodes: 12, maxEdges: 0, maxSnippets: 0 },
    }), { GDM_CONTEXT_TRUSTED_ROOT: root });

    expect(pack.st).toBe("ok");
    expect(pack.e).toEqual([]);
    expect(pack.sn).toEqual([]);
    expect(pack.n.some((node) => node[0] === "docs/architecture.md#validation-boundary")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(pack))).toBeLessThanOrEqual(1024);
  });
});
