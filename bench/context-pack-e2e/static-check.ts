#!/usr/bin/env bun
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

const HERE = import.meta.dir;
const RESULTS = join(HERE, "results");
const SOURCE_FILES = [
  "protocol.ts",
  "bench-io.ts",
  "run-e2e.ts",
  "verify-e2e.ts",
  "assess-e2e.ts",
  "install-gdm.ts",
  "verify-installed.ts",
  "static-check.ts",
];
const FORBIDDEN_RESULT_KEYS = new Set([
  "prompt",
  "assistantResponse",
  "toolArguments",
  "toolResults",
  "commandText",
  "outputText",
  "answerText",
  "evidenceBody",
  "rawEvents",
  "eventStream",
  "providerOutput",
]);

function inspectKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectKeys(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RESULT_KEYS.has(key)) throw new Error(`forbidden retained key ${path}.${key}`);
    inspectKeys(child, `${path}.${key}`);
  }
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`result symlink ${relative(RESULTS, path)}`);
    if (stat.isDirectory()) files.push(...walk(path));
    else if (stat.isFile()) files.push(path);
  }
  return files;
}

for (const file of SOURCE_FILES) {
  const text = readFileSync(join(HERE, file), "utf8");
  if (file !== "static-check.ts" && /explicitFileOperandHashes|\b(?:sqlite|embedding|daemon)\b|sh\s+-c|zsh\s+-c|\beval\s*\(/iu.test(text)) {
    throw new Error(`forbidden implementation pattern ${file}`);
  }
}
const benchIo = readFileSync(join(HERE, "bench-io.ts"), "utf8");
if (benchIo.includes("fixtureManifest(") || !benchIo.includes('if (!/^\\.gdm\\/[^/]+\\/out$/u.test(repositoryPath)) walk(path)')) {
  throw new Error("evidence body traversal exclusion missing");
}
const runner = readFileSync(join(HERE, "run-e2e.ts"), "utf8");
if (!runner.includes("directoryManifest(PILOT_RESULTS)") ||
    /(?:writeFileSync|appendFileSync|unlinkSync|renameSync)\s*\(\s*PILOT_RESULTS/u.test(runner) ||
    !runner.includes("promotionEligible: false") || !runner.includes('defaultActivation: "blocked"')) {
  throw new Error("runner confinement or promotion invariant missing");
}
const assessor = readFileSync(join(HERE, "assess-e2e.ts"), "utf8");
if (!assessor.includes("promotionEligible: false") || !assessor.includes('defaultActivation: "blocked"')) {
  throw new Error("assessor promotion invariant missing");
}
if (existsSync(RESULTS) && lstatSync(RESULTS).isDirectory()) {
  for (const path of walk(RESULTS)) {
    const text = readFileSync(path, "utf8");
    if (/\b(?:password|passwd|secret|api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret)\b\s*[:=]\s*["']?[^\s"'}]+/iu.test(text)) {
      throw new Error(`credential-shaped retained value ${basename(path)}`);
    }
    if (path.endsWith(".json")) inspectKeys(JSON.parse(text), basename(path));
    else if (path.endsWith(".jsonl")) text.trimEnd().split("\n").filter(Boolean).forEach((line, index) => inspectKeys(JSON.parse(line), `${basename(path)}:${index + 1}`));
    else throw new Error(`unsupported result artifact ${basename(path)}`);
  }
}
console.log(JSON.stringify({ staticCheck: true, sourceFiles: SOURCE_FILES.length, rawBodiesRetained: false, promotionEligible: false, defaultActivation: "blocked" }));
