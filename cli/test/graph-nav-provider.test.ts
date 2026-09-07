import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PROVIDER = join(import.meta.dir, "..", "src", "graph-nav-provider.ts");
const decoder = new TextDecoder();

type Direction = "dependencies" | "dependents";

type Query = {
  readonly schemaVersion: "gdm-graph-query/v1";
  readonly root: string;
  readonly entry: string;
  readonly direction: Direction;
  readonly maxDepth: number;
};

type Edge = {
  readonly from: string;
  readonly to: string;
  readonly via: "relative-import";
};

type Node = {
  readonly path: string;
  readonly depth: number;
};

type Coverage = {
  readonly scope: "requested-depth";
  readonly requestedMaxDepth: number;
  readonly completeWithinRequestedDepth: boolean;
  readonly frontier: readonly string[];
  readonly incompleteReasons: readonly string[];
};

type Result = {
  readonly schemaVersion: "gdm-graph-result/v2";
  readonly provider: { readonly name: string; readonly version: number };
  readonly entry: string;
  readonly direction: Direction;
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly candidateTests: readonly { readonly path: string; readonly reason: string }[];
  readonly unresolved: readonly { readonly from: string; readonly specifier?: string; readonly reason: string }[];
  readonly limitations: readonly string[];
  readonly freshness: { readonly algorithm: string; readonly consistent: boolean; readonly visitedFiles: number };
  readonly coverage: Coverage;
  readonly truncated: boolean;
  readonly limits: {
    readonly maxDepth: number;
    readonly maxCandidateFiles: number;
    readonly maxFileBytes: number;
    readonly maxTotalReadBytes: number;
    readonly maxEdges: number;
    readonly maxUnresolved: number;
  };
};

type Invocation = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly result?: Result;
};

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

function request(root: string, overrides: Partial<Query> = {}): Query {
  return {
    schemaVersion: "gdm-graph-query/v1",
    root,
    entry: "src/entry.ts",
    direction: "dependencies",
    maxDepth: 2,
    ...overrides,
  };
}

function invoke(raw: unknown, args: readonly string[] = ["query"]): Invocation {
  const outcome = Bun.spawnSync([PROVIDER, ...args], {
    stdin: new TextEncoder().encode(JSON.stringify(raw)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = decoder.decode(outcome.stdout);
  const stderr = decoder.decode(outcome.stderr);
  return {
    exitCode: outcome.exitCode,
    stdout,
    stderr,
    ...(outcome.exitCode === 0 ? { result: JSON.parse(stdout) as Result } : {}),
  };
}

function edgePairs(result: Result): readonly string[] {
  return result.edges.map((edge) => `${edge.from}->${edge.to}`);
}

describe("graph navigation provider", () => {
  test("keeps the v2 stdout contract byte-stable", () => {
    const root = repository("gdm-graph-golden-");
    write(root, "src/entry.ts", "import './dependency.ts';\n");
    write(root, "src/dependency.ts", "export const dependency = true;\n");

    const outcome = invoke(request(root, { maxDepth: 1 }));
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    expect(outcome.stdout).toBe(`${JSON.stringify({
      schemaVersion: "gdm-graph-result/v2",
      provider: { name: "gdm-ts-relative-imports", version: 2 },
      entry: "src/entry.ts",
      direction: "dependencies",
      nodes: [
        { path: "src/dependency.ts", depth: 1 },
        { path: "src/entry.ts", depth: 0 },
      ],
      edges: [
        { from: "src/entry.ts", to: "src/dependency.ts", via: "relative-import" },
      ],
      candidateTests: [],
      unresolved: [],
      limitations: [
        "bare-package-imports-outside-relative-graph",
        "lexical-scan-only:no-tsconfig-or-package-resolution",
        "module-dependency-graph-only:no-symbol-or-call-analysis",
        "static-relative-imports-only:dynamic-import-require-bare-package-and-tsconfig-alias-unsupported",
      ],
      freshness: {
        algorithm: "sha256-visited-files",
        consistent: true,
        visitedFiles: 2,
      },
      coverage: {
        scope: "requested-depth",
        requestedMaxDepth: 1,
        completeWithinRequestedDepth: true,
        frontier: [],
        incompleteReasons: [],
      },
      truncated: false,
      limits: {
        maxDepth: 5,
        maxCandidateFiles: 512,
        maxFileBytes: 512 * 1024,
        maxTotalReadBytes: 8 * 1024 * 1024,
        maxEdges: 4_096,
        maxUnresolved: 512,
      },
    })}\n`);
  });

  test("returns relative import dependencies and dependents", () => {
    const root = repository("gdm-graph-links-");
    write(root, "src/entry.ts", `
      import {
        dependency,
      } from "./dependency";
      import type { TypeOnly } from "./type-only";
      import { View } from "./view";
      import "./side-effect.js";
      export { helper } from "./re-export";
      const stringNoise = 'import fake from "./fake-string"';
      const regexNoise = /import fake from ["']fake-regex["']/u;
      // import "./fake-line-comment";
      /* export * from "./fake-block-comment"; */
      export const entry: TypeOnly = { value: dependency + Number(regexNoise.test(stringNoise)) + Number(Boolean(View)) };
    `);
    write(root, "src/dependency.ts", "export const dependency = 1;\n");
    write(root, "src/type-only.ts", "export interface TypeOnly { readonly value: number }\n");
    write(root, "src/view.tsx", `
      import type { TypeOnly } from "./type-only";
      export const View = (_value: TypeOnly) => <p>import fake from "./fake-jsx"</p>;
    `);
    write(root, "src/fake-jsx.ts", "export const fake = true;\n");
    write(root, "src/side-effect.js", "globalThis.sideEffect = true;\n");
    write(root, "src/re-export.tsx", "export const helper = 2;\n");
    write(root, "src/consumer.ts", "import { entry } from './entry.ts'; export { entry };\n");
    write(root, "test/entry.test.ts", "import { entry } from '../src/consumer.ts'; void entry;\n");

    const dependencies = invoke(request(root, { direction: "dependencies", maxDepth: 2 }));
    expect(dependencies.exitCode, dependencies.stderr).toBe(0);
    expect(dependencies.result?.schemaVersion).toBe("gdm-graph-result/v2");
    expect(dependencies.result?.provider).toEqual({ name: "gdm-ts-relative-imports", version: 2 });
    expect(dependencies.result?.nodes).toEqual([
      { path: "src/dependency.ts", depth: 1 },
      { path: "src/entry.ts", depth: 0 },
      { path: "src/re-export.tsx", depth: 1 },
      { path: "src/side-effect.js", depth: 1 },
      { path: "src/type-only.ts", depth: 1 },
      { path: "src/view.tsx", depth: 1 },
    ]);
    expect(edgePairs(dependencies.result!)).toEqual([
      "src/entry.ts->src/dependency.ts",
      "src/entry.ts->src/re-export.tsx",
      "src/entry.ts->src/side-effect.js",
      "src/entry.ts->src/type-only.ts",
      "src/entry.ts->src/view.tsx",
      "src/view.tsx->src/type-only.ts",
    ]);
    expect(dependencies.result?.edges.every((edge) => edge.via === "relative-import")).toBe(true);
    expect(dependencies.result?.freshness).toEqual({
      algorithm: "sha256-visited-files",
      consistent: true,
      visitedFiles: 6,
    });
    expect(dependencies.result?.coverage).toEqual({
      scope: "requested-depth",
      requestedMaxDepth: 2,
      completeWithinRequestedDepth: true,
      frontier: [],
      incompleteReasons: [],
    });
    expect(dependencies.result?.nodes.some((node) => node.path.includes("fake"))).toBe(false);
    expect(
      dependencies.result?.unresolved.some((item) => item.reason.startsWith("parse-error:")),
      JSON.stringify(dependencies.result?.unresolved),
    ).toBe(false);

    const dependents = invoke(request(root, { direction: "dependents", maxDepth: 2 }));
    expect(dependents.exitCode, dependents.stderr).toBe(0);
    expect(dependents.result?.nodes).toEqual([
      { path: "src/consumer.ts", depth: 1 },
      { path: "src/entry.ts", depth: 0 },
      { path: "test/entry.test.ts", depth: 2 },
    ]);
    expect(edgePairs(dependents.result!)).toEqual([
      "src/consumer.ts->src/entry.ts",
      "test/entry.test.ts->src/consumer.ts",
    ]);
    expect(dependents.result?.candidateTests).toEqual([
      { path: "test/entry.test.ts", reason: "transitive-dependent" },
    ]);
    expect(dependents.result?.freshness.consistent).toBe(true);
    expect(dependents.result?.coverage.frontier).toEqual([]);
    expect(dependents.result?.coverage.completeWithinRequestedDepth).toBe(true);
  });

  test("discloses partial coverage and consistency", async () => {
    const partialRoot = repository("gdm-graph-partial-");
    write(partialRoot, "src/entry.ts", `
      import("./dynamic.ts");
      const required = require("./required.ts");
      import alias from "@/alias";
      import packageValue from "some-package";
      import filesystem from "node:fs";
      import { test as bunTest } from "bun:test";
      void required; void alias; void packageValue; void filesystem; void bunTest;
      /* intentionally unterminated
    `);
    write(partialRoot, "src/dynamic.ts", "export default 1;\n");
    write(partialRoot, "src/required.ts", "export default 1;\n");
    const partial = invoke(request(partialRoot));

    expect(partial.exitCode, partial.stderr).toBe(0);
    expect(partial.result?.edges).toEqual([]);
    expect(partial.result?.limitations.length).toBeGreaterThan(0);
    const reasons = partial.result?.unresolved.map((item) => item.reason) ?? [];
    expect(reasons).toContain("dynamic-import-unsupported");
    expect(reasons).toContain("require-unsupported");
    expect(reasons).toContain("path-alias-unsupported");
    expect(reasons).toContain("parse-error:unterminated-block-comment");
    expect(reasons.some((reason) => reason.includes("bare-package"))).toBe(false);
    expect(
      partial.result?.unresolved.filter((item) =>
        item.specifier === "some-package" || item.specifier === "node:fs" || item.specifier === "bun:test"
      ),
    ).toEqual([]);
    expect(partial.result?.limitations.filter((item) => item === "bare-package-imports-outside-relative-graph")).toHaveLength(1);
    expect(partial.result?.freshness.consistent).toBe(true);
    expect(partial.result?.coverage.completeWithinRequestedDepth).toBe(false);
    expect(partial.result?.coverage.incompleteReasons).toContain("parse-error:unterminated-block-comment");

    const changingRoot = repository("gdm-graph-changing-");
    const padding = "x".repeat(8 * 1024);
    for (let index = 0; index < 400; index++) {
      write(changingRoot, `src/candidate-${String(index).padStart(3, "0")}.ts`, `export const value${index} = "${padding}";\n`);
    }
    write(changingRoot, "src/entry.ts", "export const entry = 0;\n");
    write(changingRoot, "src/volatile.ts", "export const volatile = 0;\n");
    const child = Bun.spawn([PROVIDER, "query"], {
      stdin: new TextEncoder().encode(JSON.stringify(request(changingRoot, { direction: "dependents" }))),
      stdout: "pipe",
      stderr: "pipe",
    });
    let active = true;
    let revision = 0;
    const mutator = (async () => {
      while (active) {
        writeFileSync(join(changingRoot, "src", "volatile.ts"), `export const volatile = ${revision++};\n`);
        await Bun.sleep(1);
      }
    })();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    active = false;
    await mutator;

    expect(exitCode, stderr).toBe(0);
    const changing = JSON.parse(stdout) as Result;
    expect(revision).toBeGreaterThan(1);
    expect(changing.freshness.visitedFiles).toBeGreaterThan(1);
    expect(changing.freshness.consistent).toBe(false);
    expect(changing.limitations).toContain("visited-file-changed-or-disappeared-during-query");
    expect(changing.coverage.completeWithinRequestedDepth).toBe(false);
    expect(changing.coverage.incompleteReasons).toContain("freshness-inconsistent");
  });

  test("rejects unsafe paths and bounds traversal", () => {
    const root = repository("gdm-graph-bounds-");
    write(root, "src/entry.ts", "import './level-one.ts';\n");
    write(root, "src/level-one.ts", "import './level-two.ts';\n");
    write(root, "src/level-two.ts", "export const end = true;\n");
    write(root, "src/link-target.ts", "export const linked = true;\n");
    symlinkSync("link-target.ts", join(root, "src", "link.ts"));
    mkdirSync(join(root, "src", "directory.ts"));

    const nestedRoot = join(root, "src");
    const invalidRequests: readonly unknown[] = [
      request(root, { entry: join(root, "src", "entry.ts") }),
      request(root, { entry: "../entry.ts" }),
      request(root, { entry: "src/link.ts" }),
      request(root, { entry: "src/directory.ts" }),
      request(nestedRoot),
      request(root, { maxDepth: 6 }),
      { ...request(root), extra: true },
    ];
    for (const invalid of invalidRequests) {
      const outcome = invoke(invalid);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.stdout).toBe("");
      expect(outcome.stderr).toContain("graph-nav-provider:");
    }
    const invalidInvocation = invoke(request(root), ["not-query"]);
    expect(invalidInvocation.exitCode).not.toBe(0);
    expect(invalidInvocation.stdout).toBe("");

    const depthBound = invoke(request(root, { maxDepth: 1 }));
    expect(depthBound.exitCode, depthBound.stderr).toBe(0);
    expect(depthBound.result?.nodes).toEqual([
      { path: "src/entry.ts", depth: 0 },
      { path: "src/level-one.ts", depth: 1 },
    ]);
    expect(depthBound.result?.truncated).toBe(false);
    expect(depthBound.result?.limitations).not.toContain("max-depth-reached:1");
    expect(depthBound.result?.coverage).toEqual({
      scope: "requested-depth",
      requestedMaxDepth: 1,
      completeWithinRequestedDepth: true,
      frontier: ["src/level-one.ts"],
      incompleteReasons: [],
    });

    const fullyExplored = invoke(request(root, { maxDepth: 2 }));
    expect(fullyExplored.exitCode, fullyExplored.stderr).toBe(0);
    expect(fullyExplored.result?.coverage.requestedMaxDepth).toBe(2);
    expect(fullyExplored.result?.limits.maxDepth).toBe(5);
    expect(fullyExplored.result?.coverage.frontier).toEqual([]);
    expect(fullyExplored.result?.coverage.completeWithinRequestedDepth).toBe(true);

    const candidateRoot = repository("gdm-graph-candidate-cap-");
    write(candidateRoot, "src/entry.ts", "export const entry = true;\n");
    for (let index = 0; index < 520; index++) {
      write(candidateRoot, `src/module-${String(index).padStart(3, "0")}.ts`, `export const value${index} = ${index};\n`);
    }
    const candidateBound = invoke(request(candidateRoot, { direction: "dependents" }));
    expect(candidateBound.exitCode, candidateBound.stderr).toBe(0);
    expect(candidateBound.result?.limits.maxCandidateFiles).toBe(512);
    expect(candidateBound.result?.truncated).toBe(true);
    expect(candidateBound.result?.limitations).toContain("candidate-file-cap-reached:512");
    expect(candidateBound.result?.coverage.completeWithinRequestedDepth).toBe(false);
    expect(candidateBound.result?.coverage.incompleteReasons).toContain("candidate-file-cap-reached:512");

    const fileRoot = repository("gdm-graph-file-cap-");
    write(fileRoot, "src/entry.ts", "import './huge.ts';\n");
    write(fileRoot, "src/huge.ts", `export const huge = "${"h".repeat((512 * 1024) + 1)}";\n`);
    const fileBound = invoke(request(fileRoot, { maxDepth: 1 }));
    expect(fileBound.exitCode, fileBound.stderr).toBe(0);
    expect(fileBound.result?.limits.maxFileBytes).toBe(512 * 1024);
    expect(fileBound.result?.truncated).toBe(true);
    expect(fileBound.result?.unresolved.some((item) => item.reason === "file-too-large")).toBe(true);
    expect(fileBound.result?.coverage.completeWithinRequestedDepth).toBe(false);
    expect(fileBound.result?.coverage.incompleteReasons).toContain(`file-size-cap-reached:${512 * 1024}`);

    const byteRoot = repository("gdm-graph-byte-cap-");
    const imports: string[] = [];
    for (let index = 0; index < 18; index++) {
      imports.push(`import './large-${index}.ts';`);
      write(byteRoot, `src/large-${index}.ts`, `export const large${index} = "${"b".repeat(250 * 1024)}";\n`);
    }
    write(byteRoot, "src/entry.ts", `${imports.join("\n")}\n`);
    const byteBound = invoke(request(byteRoot, { maxDepth: 1 }));
    expect(byteBound.exitCode, byteBound.stderr).toBe(0);
    expect(byteBound.result?.limits.maxTotalReadBytes).toBe(8 * 1024 * 1024);
    expect(byteBound.result?.truncated).toBe(true);
    expect(byteBound.result?.limitations.some((item) => item.startsWith("total-read-byte-cap-reached:"))).toBe(true);
    expect(byteBound.result?.coverage.completeWithinRequestedDepth).toBe(false);
    expect(
      byteBound.result?.coverage.incompleteReasons.some((item) => item.startsWith("total-read-byte-cap-reached:")),
    ).toBe(true);
  });
});
