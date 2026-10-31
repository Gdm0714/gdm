// Explicit live probe; --verify only checks saved evidence and never calls a model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const [mode, directory] = process.argv.slice(2);
assert((mode === "--run" || mode === "--verify") && directory && isAbsolute(directory),
  "Usage: bun script/qa/claude-coordinator-smoke.ts --run|--verify /absolute/evidence-directory");
const project = join(directory, "project");
const probeSkills = join(project, ".claude/skills");
const projectSkills = Boolean(process.env.GDM_SMOKE_SKILLS_ROOT) || existsSync(probeSkills);
const skillsRoot = projectSkills ? probeSkills : join(homedir(), ".claude/skills");
const skillPath = join(skillsRoot, "gdm-go/SKILL.md");
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const testSource = 'import { strict as assert } from "node:assert";\nimport { sum } from "./sum.mjs";\nassert.equal(sum([]), 0);\nassert.equal(sum([2, 3]), 5);\nassert.equal(sum([-2, 2]), 0);\nconsole.log("3 sum cases passed");\n';

if (mode === "--run") {
  assert(!existsSync(directory), "Refusing to overwrite an earlier live run");
  mkdirSync(project, { recursive: true });
  if (process.env.GDM_SMOKE_SKILLS_ROOT) cpSync(process.env.GDM_SMOKE_SKILLS_ROOT, probeSkills, { recursive: true });
  const bin = join(directory, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "bun"));
  symlinkSync(process.env.GDM_SMOKE_GDM_BIN ?? join(homedir(), ".local/bin/gdm"), join(bin, "gdm"));
  for (const provider of ["codex", "gid"]) {
    const path = join(bin, provider);
    writeFileSync(path, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$GDM_SMOKE_TRIPWIRE"\nexit 97\n');
    chmodSync(path, 0o755);
  }
  writeFileSync(join(project, "sum.mjs"), 'export const sum = values => values.reduce((total, value) => total + value, 1);\n');
  writeFileSync(join(project, "sum.test.mjs"), testSource);
  writeFileSync(join(project, ".gitignore"), ".gdm/\n.claude/\n");
  // The scope gate needs a Git baseline. This commit contains only this synthetic fixture.
  for (const args of [["init", "-b", "main"], ["add", "sum.mjs", "sum.test.mjs", ".gitignore"],
    ["-c", "user.name=GDM smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "synthetic fixture baseline"]]) {
    const git = Bun.spawnSync(["git", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
    assert.equal(git.exitCode, 0, git.stderr.toString());
  }
  const prompt = "Use the installed gdm-go skill through the Skill tool to fix the sum.mjs off-by-one bug in this synthetic fixture. Read sum.test.mjs; it must stay unchanged. Work slug: claude-live. Use the normal GDM plan, regression red, edit, pass, done workflow. Only sum.mjs may be changed as product code. Record GDM state only through the CLI. Use bun sum.test.mjs as the regression command. No commit, push, PR, networking tools, external models, or delegation is needed. Finish the requested fix and verification in this Claude session. Report the result concisely.";
  writeFileSync(join(directory, "prompt.txt"), prompt);
  const claude = Bun.which("claude");
  assert(claude, "Claude Code must be installed and signed in");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GDM_SMOKE_TRIPWIRE: join(directory, "unexpected-provider-call") };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete env[key];
  const args = [claude, "-p", "--no-session-persistence", "--output-format", "stream-json", "--verbose",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-chrome",
    ...(projectSkills ? ["--setting-sources", "project"] : []),
    "--tools", "Read,Edit,Write,Bash,Glob,Grep,Skill", "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep,Skill",
    "--permission-mode", "dontAsk", "--max-budget-usd", "3", prompt];
  const startedAt = new Date().toISOString();
  const skillSha256 = hash(skillPath);
  const child = Bun.spawn(args, { cwd: project, env, stdin: "ignore",
    stdout: Bun.file(join(directory, "stdout.jsonl")), stderr: Bun.file(join(directory, "stderr.txt")) });
  const deadline = setTimeout(() => child.kill("SIGTERM"), 180_000);
  const exitCode = await child.exited;
  clearTimeout(deadline);
  writeFileSync(join(directory, "receipt.json"), JSON.stringify({ schemaVersion: "gdm-claude-coordinator-smoke/v1", startedAt,
    finishedAt: new Date().toISOString(), exitCode, skillSha256, transcriptSha256: hash(join(directory, "stdout.jsonl")),
    stderrSha256: hash(join(directory, "stderr.txt")) }, null, 2) + "\n");
}

const receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"));
assert.equal(receipt.schemaVersion, "gdm-claude-coordinator-smoke/v1");
assert.equal(receipt.exitCode, 0, "Claude process failed; inspect saved stderr and transcript");
assert.equal(hash(skillPath), receipt.skillSha256, "Installed skill changed since the live run");
const manifest = JSON.parse(readFileSync(join(skillsRoot, "gdm-target-manifest.json"), "utf8"));
assert.equal(manifest.target, "claude");
for (const skill of manifest.skills) assert.equal(hash(join(skillsRoot, skill.name, "SKILL.md")), skill.renderedSha256);
assert.equal(hash(join(directory, "stdout.jsonl")), receipt.transcriptSha256);
assert.equal(hash(join(directory, "stderr.txt")), receipt.stderrSha256);
assert.equal(readFileSync(join(project, "sum.test.mjs"), "utf8"), testSource);
assert(!existsSync(join(directory, "unexpected-provider-call")), "Another provider was invoked");
const messages = readFileSync(join(directory, "stdout.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const result = messages.findLast(message => message.type === "result");
assert(result && result.subtype === "success" && !result.is_error, "No successful Claude result");
const calls = messages.flatMap(message => message.message?.content ?? []).filter(block => block.type === "tool_use");
const results = messages.flatMap(message => message.message?.content ?? []).filter(block => block.type === "tool_result");
assert(calls.some(call => call.name === "Skill" && call.input?.skill === "gdm-go" &&
  results.some(result => result.tool_use_id === call.id && !result.is_error && JSON.stringify(result.content).includes("gdm-go"))), "Installed skill was never successfully invoked");
const texts = messages.flatMap(message => message.message?.content ?? []).filter(block => block.type === "text");
assert(texts.some(block => block.text.includes(`Base directory for this skill: ${realpathSync(join(skillsRoot, "gdm-go"))}`)),
  "Claude loaded a different installation of gdm-go");
const commands = calls.filter(call => call.name === "Bash").map(call => call.input.command).join("\n");
for (const command of ["gdm plan init", "gdm plan add", "--red", "gdm pass", "gdm done"]) assert(commands.includes(command), `Missing live command: ${command}`);
const state = JSON.parse(readFileSync(join(project, ".gdm/claude-live/checks.json"), "utf8"));
assert.equal(state.done, true);
assert.equal(state.contract.commit, "forbidden");
assert.deepEqual(state.contract.allowedPaths, ["sum.mjs"]);
assert(state.contract.forbiddenPaths.includes("sum.test.mjs"));
assert.equal(state.contract.scopeAmendments.length, 0, "Scope must not be relaxed to pass");
assert(state.checks.some(check => check.kind === "regression" && check.redEvidence?.exitCode > 0 && check.status === "proven"));
for (const check of state.checks) {
  assert.equal(check.status, "proven");
  for (const evidence of [check.redEvidence, check.evidence].filter(Boolean)) {
    assert.equal(hash(join(project, evidence.observed)), evidence.sha256);
  }
}
const verification = Bun.spawnSync([process.execPath, "sum.test.mjs"], { cwd: project, stdout: "pipe", stderr: "pipe" });
assert.equal(verification.exitCode, 0, verification.stderr.toString());
console.log(JSON.stringify({ status: "passed", directory, model: Object.keys(result.modelUsage ?? {}), turns: result.num_turns,
  durationMs: result.duration_ms, reportedCostUsd: result.total_cost_usd, toolCalls: calls.length, otherProviderCalls: 0,
  skillInvoked: "gdm-go", workDone: state.done }, null, 2));
