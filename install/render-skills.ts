#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const MANIFEST_SCHEMA = "gdm-target-skill-manifest/v1";
const ADAPTER_VERSION = "gdm-target-adapter/v1";
const CAPABILITY_PROFILE = "gdm-read-only-specialist/v1";
const BODY_BEGIN = "<!-- GDM_RENDERED_SKILL_BODY_V1_BEGIN -->";
const BODY_END = "<!-- GDM_RENDERED_SKILL_BODY_V1_END -->";
const ADAPTER_BEGIN = "<!-- GDM_TARGET_ADAPTER_V1_BEGIN -->";
const ADAPTER_END = "<!-- GDM_TARGET_ADAPTER_V1_END -->";
const TARGET_FRAGMENT_RE = /<!-- GDM_TARGET_FRAGMENT_V1:([a-z0-9-]+) -->/gu;
const HASH_RE = /^[0-9a-f]{64}$/u;
const READ_ONLY_SKILLS = new Set(["analyze", "plan", "review"]);

type Target = "codex" | "claude" | "pi";

type Arguments = {
  readonly target: Target;
  readonly output: string;
  readonly sourceRoot: string;
  readonly agentsRoot: string;
};

function fail(message: string): never {
  throw new Error(`skill renderer: ${message}`);
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      fail("usage: render-skills.ts --target <codex|claude|pi> --output <dir> [--source-root <dir>] [--agents-root <dir>]");
    }
    values.set(flag, value);
  }
  const target = values.get("--target");
  const output = values.get("--output");
  if ((target !== "codex" && target !== "claude" && target !== "pi") || output === undefined) {
    fail("--target and --output are required");
  }
  const repositoryRoot = resolve(import.meta.dir, "..");
  return {
    target,
    output: resolve(output),
    sourceRoot: resolve(values.get("--source-root") ?? join(repositoryRoot, "skills")),
    agentsRoot: resolve(values.get("--agents-root") ?? join(repositoryRoot, "agents")),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function regularFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`regular file required: ${path}`);
}

function safeDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`directory without symlinks required: ${path}`);
}

function sortedFiles(root: string): string[] {
  safeDirectory(root);
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail(`source symlink is not supported: ${path}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) result.push(path);
      else fail(`unsupported source entry: ${path}`);
    }
  };
  visit(root);
  return result;
}

function hashTree(roots: readonly { readonly label: string; readonly path: string }[]): string {
  const digest = createHash("sha256");
  for (const root of roots) {
    for (const path of sortedFiles(root.path)) {
      const name = `${root.label}/${relative(root.path, path).split(sep).join("/")}`;
      const bytes = readFileSync(path);
      digest.update(`${name.length}:${name}:${bytes.length}:`);
      digest.update(bytes);
    }
  }
  return digest.digest("hex");
}

function splitFrontmatter(source: string, path: string): { readonly frontmatter: string; readonly body: string } {
  if (!source.startsWith("---\n")) fail(`SKILL.md frontmatter must start at byte zero: ${path}`);
  const finish = source.indexOf("\n---\n", 4);
  if (finish < 0) fail(`SKILL.md frontmatter is not closed: ${path}`);
  return {
    frontmatter: source.slice(0, finish + 5),
    body: source.slice(finish + 5).replace(/^\n/u, ""),
  };
}

function targetFragment(sourceRoot: string, target: Target, name: string): string {
  const fileName = `${target}-${name}.md`;
  const path = join(sourceRoot, "_shared", "targets", "fragments", fileName);
  regularFile(path);
  return readFileSync(path, "utf8").trimEnd();
}

function renderCore(sourceRoot: string, target: Target, skillName: string, body: string): string {
  if (target === "claude" && !READ_ONLY_SKILLS.has(skillName)) {
    return targetFragment(sourceRoot, target, "unsupported");
  }
  if (target === "claude") return targetFragment(sourceRoot, target, skillName);
  let markerCount = 0;
  const rendered = body.replace(TARGET_FRAGMENT_RE, (_marker, name: string) => {
    markerCount += 1;
    return targetFragment(sourceRoot, target, name);
  });
  if (READ_ONLY_SKILLS.has(skillName) && markerCount !== 1) {
    fail(`read-only skill requires exactly one target delegation fragment: ${skillName}`);
  }
  return rendered.trimEnd();
}

function renderFrontmatter(sourceRoot: string, target: Target, skillName: string, source: string): string {
  if (target !== "claude") return source;
  const descriptionName = READ_ONLY_SKILLS.has(skillName)
    ? "claude-read-only-description.txt"
    : "claude-unsupported-description.txt";
  const descriptionPath = join(sourceRoot, "_shared", "targets", "fragments", descriptionName);
  regularFile(descriptionPath);
  const description = readFileSync(descriptionPath, "utf8").trim();
  return `---\nname: gdm-${skillName}\ndescription: ${description}\n---\n`;
}

function copyTree(source: string, destination: string): void {
  safeDirectory(source);
  mkdirSync(destination, { recursive: false });
  for (const name of readdirSync(source).sort()) {
    const from = join(source, name);
    const to = join(destination, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) fail(`source symlink is not supported: ${from}`);
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, stat.mode & 0o111 ? 0o755 : 0o644);
    } else fail(`unsupported source entry: ${from}`);
  }
}

function assertContained(root: string, path: string): void {
  const canonicalRoot = realpathSync(root);
  const canonicalParent = realpathSync(dirname(path));
  if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}${sep}`)) {
    fail(`output escaped target root: ${path}`);
  }
}

function main(): void {
  const args = parseArguments(Bun.argv.slice(2));
  safeDirectory(args.sourceRoot);
  safeDirectory(args.agentsRoot);
  for (const path of [
    join(args.agentsRoot, "run-role.sh"),
    join(args.agentsRoot, "providers", "codex.sh"),
    join(args.agentsRoot, "providers", "claude.sh"),
    join(args.agentsRoot, "providers", "pi.sh"),
  ]) {
    regularFile(path);
    if ((lstatSync(path).mode & 0o111) === 0) fail(`executable role runner file required: ${path}`);
  }
  const existing = existsSync(args.output);
  if (existing) {
    safeDirectory(args.output);
    if (readdirSync(args.output).length !== 0) fail(`output directory must be empty: ${args.output}`);
  } else mkdirSync(args.output, { recursive: true });

  const adapterPath = join(args.sourceRoot, "_shared", "targets", `${args.target}.md`);
  regularFile(adapterPath);
  const adapter = readFileSync(adapterPath, "utf8").trimEnd();
  const sourceSha256 = hashTree([
    { label: "skills", path: args.sourceRoot },
    { label: "agents", path: args.agentsRoot },
  ]);

  const skills: Array<{
    name: string;
    sourcePath: string;
    sourceSha256: string;
    renderedSha256: string;
  }> = [];
  const aggregate = createHash("sha256");
  const directories = readdirSync(args.sourceRoot).sort();
  for (const directoryName of directories) {
    if (directoryName === "_shared") continue;
    const sourceDirectory = join(args.sourceRoot, directoryName);
    const stat = lstatSync(sourceDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`skill directory required: ${sourceDirectory}`);
    const skillPath = join(sourceDirectory, "SKILL.md");
    regularFile(skillPath);
    const canonicalSource = readFileSync(skillPath, "utf8");
    const { frontmatter: sourceFrontmatter, body } = splitFrontmatter(canonicalSource, skillPath);
    const frontmatter = renderFrontmatter(args.sourceRoot, args.target, directoryName, sourceFrontmatter);
    const skillSourceSha256 = sha256(canonicalSource);
    const renderedBody = renderCore(args.sourceRoot, args.target, directoryName, body);
    const rendered = `${frontmatter}\n${ADAPTER_BEGIN}\n${adapter}\n${ADAPTER_END}\n\n${BODY_BEGIN}\n${renderedBody}\n${BODY_END}\n`;
    if (/\{\{|\}\}|__GDM_[A-Z0-9_]+__/u.test(rendered)) fail(`unresolved marker in ${skillPath}`);
    const withoutAdapter = rendered.slice(0, rendered.indexOf(ADAPTER_BEGIN)) + rendered.slice(rendered.indexOf(ADAPTER_END) + ADAPTER_END.length);
    if (/\b(?:claude\s+-p|codex\s+exec)\b/iu.test(withoutAdapter)) {
      fail(`direct provider invocation escaped target adapter: ${skillPath}`);
    }
    if (args.target !== "codex" && /GDM_AGENT_ENVELOPE_V1|multi_agent_v2|hook caller|native (?:Codex )?root session/iu.test(withoutAdapter)) {
      fail(`Codex native delegation guarantee escaped ${args.target} adapter: ${skillPath}`);
    }

    const destination = join(args.output, `gdm-${directoryName}`);
    mkdirSync(destination);
    for (const name of readdirSync(sourceDirectory).sort()) {
      if (name === "SKILL.md") continue;
      const from = join(sourceDirectory, name);
      const to = join(destination, name);
      const child = lstatSync(from);
      if (child.isDirectory()) copyTree(from, to);
      else if (child.isFile()) {
        copyFileSync(from, to);
        chmodSync(to, child.mode & 0o111 ? 0o755 : 0o644);
      } else fail(`unsupported skill asset: ${from}`);
    }
    const renderedPath = join(destination, "SKILL.md");
    assertContained(args.output, renderedPath);
    writeFileSync(renderedPath, rendered, { encoding: "utf8", mode: 0o644, flag: "wx" });
    aggregate.update(`${directoryName}:${canonicalSource.length}:${canonicalSource}`);
    skills.push({
      name: `gdm-${directoryName}`,
      sourcePath: `skills/${directoryName}`,
      sourceSha256: skillSourceSha256,
      renderedSha256: sha256(rendered),
    });
  }

  copyTree(args.agentsRoot, join(args.output, "gdm-agents"));
  const canonicalSourceSha256 = aggregate.digest("hex");
  const runnerPath = join(args.output, "gdm-agents", "run-role.sh");
  const codexAdapterPath = join(args.output, "gdm-agents", "providers", "codex.sh");
  const claudeAdapterPath = join(args.output, "gdm-agents", "providers", "claude.sh");
  const piAdapterPath = join(args.output, "gdm-agents", "providers", "pi.sh");
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    target: args.target,
    adapterVersion: ADAPTER_VERSION,
    canonicalSourceSha256,
    sourceSha256,
    capabilityProfile: {
      id: CAPABILITY_PROFILE,
      filesystem: "read-only",
      delegation: "disabled",
      mcp: "disabled",
      shell: "unsupported",
      browser: "unsupported",
      network: "unsupported",
    },
    hook: args.target === "codex"
      ? { id: "gdm-agent-gate-v1", status: "supported", requiredForTarget: true }
      : { id: null, status: "not-required", requiredForTarget: false },
    runner: {
      contract: "gdm-role-runner/v1",
      path: "gdm-agents/run-role.sh",
      sha256: sha256(readFileSync(runnerPath)),
      adapters: {
        codex: {
          path: "gdm-agents/providers/codex.sh",
          sha256: sha256(readFileSync(codexAdapterPath)),
        },
        claude: {
          path: "gdm-agents/providers/claude.sh",
          sha256: sha256(readFileSync(claudeAdapterPath)),
        },
        pi: {
          path: "gdm-agents/providers/pi.sh",
          sha256: sha256(readFileSync(piAdapterPath)),
        },
      },
    },
    skills,
  } as const;
  if (!HASH_RE.test(manifest.canonicalSourceSha256) || !HASH_RE.test(manifest.sourceSha256) ||
      !HASH_RE.test(manifest.runner.sha256) ||
      !HASH_RE.test(manifest.runner.adapters.codex.sha256) ||
      !HASH_RE.test(manifest.runner.adapters.claude.sha256) ||
      !HASH_RE.test(manifest.runner.adapters.pi.sha256)) {
    fail("manifest hash invariant failed");
  }
  writeFileSync(
    join(args.output, "gdm-target-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644, flag: "wx" },
  );
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

main();
