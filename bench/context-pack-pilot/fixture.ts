import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addCheck, initWork, passCheck } from "../../cli/src/state.ts";
import { saveWork, writeWorkOutput } from "../../cli/src/store.ts";
import type { WorkContract } from "../../cli/src/types.ts";

function write(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function contract(path: string): WorkContract {
  return {
    required: [],
    forbidden: [],
    activeHabits: [],
    commit: "forbidden",
    allowedPaths: [path],
  };
}

function provenWork(
  root: string,
  slug: string,
  sourcePath: string,
  description: string,
  evidenceName: string,
): void {
  let work = initWork(slug, `Fixture work ${slug}`, "2026-01-01T00:00:00.000Z", false, contract(sourcePath));
  work = addCheck(work, {
    desc: description,
    cmd: "true",
    expect: `${description} evidence exists`,
    kind: "behavior",
  }).work;
  saveWork(root, work);
  const body = `${slug} verified\n`;
  const observed = writeWorkOutput(root, slug, evidenceName, body);
  work = passCheck(work, "c1", {
    observed,
    sha256: createHash("sha256").update(body).digest("hex"),
    exitCode: 0,
    manual: false,
  }, "2026-01-01T00:01:00.000Z");
  saveWork(root, work);
}

export interface PilotFixture {
  readonly root: string;
  readonly expected: Readonly<Record<string, {
    readonly paths: readonly string[];
    readonly facts: Readonly<Record<string, string>>;
  }>>;
}

export function createPilotFixture(): PilotFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gdm-context-pack-pilot-")));
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (init.exitCode !== 0) throw new Error(new TextDecoder().decode(init.stderr));

  write(root, "src/boundary.ts", "import { appendRecord } from './journal.ts';\nexport const validationBoundary = appendRecord;\n");
  write(root, "src/journal.ts", "export const appendRecord = (value: string) => value;\n");
  write(root, "test/boundary.test.ts", "import { validationBoundary } from '../src/boundary.ts'; void validationBoundary;\n");
  write(root, "docs/architecture.md", "# Validation Ownership\n\nImplementation: [`boundary.ts`](../src/boundary.ts).\n");

  write(root, "src/router.ts", "import { buildPack } from './pack.ts';\nexport const routeContext = buildPack;\n");
  write(root, "src/pack.ts", "export const buildPack = { maxBytes: 4096 };\n");
  write(root, "test/router.test.ts", "import { routeContext } from '../src/router.ts'; void routeContext;\n");
  write(root, "docs/decisions.md", "# Token Budget Route\n\nEntry: [`router.ts`](../src/router.ts).\n");

  write(root, "package.json", `${JSON.stringify({
    name: "@fixture/context-core",
    private: true,
    scripts: { verify: "bun test" },
  }, null, 2)}\n`);
  write(root, ".github/CODEOWNERS", "/src/boundary.ts @platform-context\n/src/router.ts @token-runtime\n");

  for (let index = 0; index < 80; index++) {
    write(root, `src/decoy-${String(index).padStart(3, "0")}.ts`, `export const unrelated${index} = ${index};\n`);
    write(root, `docs/decoy-${String(index).padStart(3, "0")}.md`, `# Unrelated Component ${index}\n\nNo target relationship.\n`);
  }
  provenWork(root, "validation-ownership", "src/boundary.ts", "Validation ownership boundary", "c1.txt");
  provenWork(root, "token-budget", "src/router.ts", "Token budget route stays within 4096 bytes", "c1.txt");
  for (let index = 0; index < 20; index++) {
    saveWork(root, initWork(
      `unrelated-work-${String(index).padStart(2, "0")}`,
      `Unrelated fixture work ${index}`,
      "2026-01-01T00:00:00.000Z",
    ));
  }

  const add = Bun.spawnSync(["git", "add", "."], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (add.exitCode !== 0) throw new Error(new TextDecoder().decode(add.stderr));

  return {
    root,
    expected: {
      ownership: {
        paths: [
          ".gdm/validation-ownership/checks.json",
          ".github/CODEOWNERS",
          "docs/architecture.md",
          "package.json",
          "src/boundary.ts",
          "src/journal.ts",
          "test/boundary.test.ts",
        ],
        facts: {
          implementation: "src/boundary.ts",
          dependency: "src/journal.ts",
          test: "test/boundary.test.ts",
          package: "@fixture/context-core",
          owner: "@platform-context",
          work: "validation-ownership",
          check: "c1",
          evidence: ".gdm/validation-ownership/out/c1.txt",
        },
      },
      budget: {
        paths: [
          ".gdm/token-budget/checks.json",
          ".github/CODEOWNERS",
          "docs/decisions.md",
          "package.json",
          "src/pack.ts",
          "src/router.ts",
          "test/router.test.ts",
        ],
        facts: {
          implementation: "src/router.ts",
          dependency: "src/pack.ts",
          test: "test/router.test.ts",
          package: "@fixture/context-core",
          owner: "@token-runtime",
          work: "token-budget",
          check: "c1",
          evidence: ".gdm/token-budget/out/c1.txt",
          maxBytes: "4096",
        },
      },
    },
  };
}
