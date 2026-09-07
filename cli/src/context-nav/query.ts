import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseModule, SUPPORTED_MODULE_EXTENSIONS } from "../graph-nav-scan.ts";
import { loadWork } from "../store.ts";
import { validateSlug } from "../state.ts";
import {
  CONTEXT_PACK_SCHEMA,
  looksAssignmentLike,
  looksSecret,
  ROUTE_MAX_BYTES,
  type ContextEdgeTuple,
  type ContextEdgeType,
  type ContextNodeKind,
  type ContextNodeTuple,
  type ContextPack,
  type ContextQuery,
  type ContextSnippetTuple,
} from "./schema.ts";

const MAX_CANDIDATE_FILES = 2_048;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_READ_BYTES = 8 * 1024 * 1024;
const MAX_INTERNAL_EDGES = 8_192;
const RESERVED_GDM_DIRECTORIES = new Set(["habits", "native", "plans"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

interface SourceSnippet {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

interface InternalNode {
  readonly key: string;
  readonly kind: ContextNodeKind;
  readonly hash8: string;
  readonly line: number;
  readonly terms: ReadonlySet<string>;
  readonly snippet?: SourceSnippet;
}

interface InternalEdge {
  readonly from: string;
  readonly to: string;
  readonly type: ContextEdgeType;
  readonly line: number;
}

interface SourceFile {
  readonly path: string;
  readonly source: string;
  readonly lines: readonly string[];
  readonly sha256: string;
  readonly hash8: string;
  readonly kind: "file" | "test";
}

class GraphBuilder {
  readonly nodes = new Map<string, InternalNode>();
  readonly edges = new Map<string, InternalEdge>();
  readonly limitations = new Set<string>();
  readonly files = new Map<string, SourceFile>();
  workFingerprint = "";
  totalReadBytes = 0;

  constructor(
    readonly root: string,
    readonly candidates: ReadonlySet<string>,
    private readonly fileDigest: (value: Uint8Array) => string = sha256,
  ) {}

  addNode(node: InternalNode): void {
    if (looksSecret(node.key)) {
      this.limitations.add("secret-shaped-node-skipped");
      return;
    }
    const current = this.nodes.get(node.key);
    if (current === undefined) {
      this.nodes.set(node.key, node);
      return;
    }
    this.nodes.set(node.key, {
      ...current,
      terms: new Set([...current.terms, ...node.terms]),
      ...(current.snippet === undefined && node.snippet !== undefined ? { snippet: node.snippet } : {}),
    });
  }

  addEdge(edge: InternalEdge): void {
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) return;
    const key = `${edge.from}\0${edge.to}\0${edge.type}\0${edge.line}`;
    if (this.edges.has(key)) return;
    if (this.edges.size >= MAX_INTERNAL_EDGES) {
      this.limitations.add(`internal-edge-cap-reached:${MAX_INTERNAL_EDGES}`);
      return;
    }
    this.edges.set(key, edge);
  }

  verifyFreshness(): boolean {
    const currentCandidates = candidatePaths(this.root);
    const initialCandidates = [...this.candidates];
    if (currentCandidates.length !== initialCandidates.length ||
        currentCandidates.some((path, index) => path !== initialCandidates[index])) return false;
    let verifiedBytes = 0;
    for (const file of [...this.files.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      try {
        const stat = assertSafeRegularFile(this.root, file.path);
        if (stat.size > MAX_FILE_BYTES || verifiedBytes + stat.size > MAX_TOTAL_READ_BYTES) return false;
        const bytes = readFileSync(resolve(this.root, file.path));
        verifiedBytes += bytes.byteLength;
        if (this.fileDigest(bytes) !== file.sha256) return false;
      } catch {
        return false;
      }
    }
    try {
      return this.workFingerprint === workFingerprint(this.root);
    } catch {
      return false;
    }
  }

  read(path: string): SourceFile | null {
    const cached = this.files.get(path);
    if (cached !== undefined) return cached;
    let stat: Stats;
    try {
      stat = assertSafeRegularFile(this.root, path);
    } catch {
      this.limitations.add("unsafe-or-nonregular-candidate-skipped");
      return null;
    }
    if (stat.size > MAX_FILE_BYTES || this.totalReadBytes + stat.size > MAX_TOTAL_READ_BYTES) {
      this.limitations.add(stat.size > MAX_FILE_BYTES ? "file-size-cap-reached" : "total-read-byte-cap-reached");
      return null;
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(resolve(this.root, path));
    } catch {
      this.limitations.add("candidate-read-failed");
      return null;
    }
    this.totalReadBytes += bytes.byteLength;
    let source: string;
    try {
      source = UTF8.decode(bytes);
    } catch {
      this.limitations.add("invalid-utf8-candidate-skipped");
      return null;
    }
    const digest = this.fileDigest(bytes);
    const file: SourceFile = {
      path,
      source,
      lines: source.split(/\r?\n/u),
      sha256: digest,
      hash8: digest.slice(0, 8),
      kind: isTestPath(path) ? "test" : "file",
    };
    this.files.set(path, file);
    return file;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hash8(value: string | Uint8Array): string {
  return sha256(value).slice(0, 8);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeRegularFile(root: string, repositoryPath: string): Stats {
  let current = root;
  const segments = repositoryPath.split("/");
  for (let index = 0; index < segments.length; index++) {
    current = resolve(current, segments[index]!);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("symbolic link");
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error("non-directory component");
    if (index === segments.length - 1 && !stat.isFile()) throw new Error("non-regular file");
  }
  return lstatSync(current);
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("unable to inspect Git repository");
  }
  return result.stdout;
}

export function trustedGitRoot(requested: string, trusted: string | undefined): string | null {
  if (trusted === undefined || requested !== trusted || resolve(requested) !== requested) return null;
  try {
    const rootStat = lstatSync(requested);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(requested) !== requested) return null;
    const top = git(requested, ["rev-parse", "--show-toplevel"]).trim();
    if (realpathSync(top) !== requested) return null;
    return requested;
  } catch {
    return null;
  }
}

function ignoredPath(path: string): boolean {
  return path === ".gdm" || path.startsWith(".gdm/") || path === ".gdm.lock" ||
    path.split("/").some((part) => part.startsWith(".env")) || looksSecret(path);
}

function candidatePaths(root: string): readonly string[] {
  return git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((path) => path.length > 0 && !ignoredPath(path))
    .filter((path) => {
      if (path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) return false;
      return posix.normalize(path) === path;
    })
    .sort()
    .slice(0, MAX_CANDIDATE_FILES);
}

function splitTerms(value: string): readonly string[] {
  const separated = value.normalize("NFC")
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .replace(/[_./:@#-]+/gu, " ")
    .toLowerCase();
  return [...new Set((separated.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => term.length <= 64 && !looksSecret(term))
    .slice(0, 96))];
}

function terms(...values: readonly string[]): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const value of values) {
    for (const term of splitTerms(value)) {
      selected.add(term);
      if (selected.size >= 96) return selected;
    }
  }
  return selected;
}

function isModule(path: string): boolean {
  return SUPPORTED_MODULE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function isMarkdown(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/u.test(path);
}

function lineOf(lines: readonly string[], value: string): number {
  const index = lines.findIndex((line) => line.includes(value));
  return index < 0 ? 1 : index + 1;
}

function safeSnippet(lines: readonly string[], line: number, radius = 0): SourceSnippet | undefined {
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  let text = lines.slice(start - 1, end).join("\n").trimEnd();
  if (!text || looksSecret(text) || looksAssignmentLike(text)) return undefined;
  while (Buffer.byteLength(text) > 480 && text.length > 0) text = text.slice(0, -1);
  if (!text || looksSecret(text) || looksAssignmentLike(text)) return undefined;
  return { startLine: start, endLine: end, text };
}

function fileNode(builder: GraphBuilder, file: SourceFile): void {
  builder.addNode({
    key: file.path,
    kind: file.kind,
    hash8: file.hash8,
    line: 1,
    terms: terms(file.path),
  });
}

function resolveRelative(from: string, specifier: string, candidates: ReadonlySet<string>): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  if (specifier.includes("\\") || specifier.includes("\0")) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (base === ".." || base.startsWith("../") || base.startsWith("/")) return null;
  const extension = posix.extname(base);
  const options = extension.length === 0
    ? [
      ...SUPPORTED_MODULE_EXTENSIONS.map((candidate) => `${base}${candidate}`),
      ...SUPPORTED_MODULE_EXTENSIONS.map((candidate) => `${base}/index${candidate}`),
    ]
    : extension === ".js"
      ? [base, `${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`, `${base.slice(0, -3)}.jsx`]
      : extension === ".jsx"
        ? [base, `${base.slice(0, -4)}.tsx`]
        : [base];
  return options.find((candidate) => candidates.has(candidate)) ?? null;
}

function ingestModules(builder: GraphBuilder): void {
  for (const path of [...builder.candidates].filter(isModule).sort()) {
    const file = builder.read(path);
    if (file === null) continue;
    fileNode(builder, file);
    const parsed = parseModule(file.source, file.path);
    if (parsed.errors.length > 0) builder.limitations.add("module-parse-error-present");
    if (parsed.dynamicImports.length > 0) builder.limitations.add("dynamic-import-unsupported");
    if (parsed.requires.length > 0) builder.limitations.add("require-unsupported");
    for (const specifier of parsed.staticSpecifiers) {
      const target = resolveRelative(file.path, specifier, builder.candidates);
      if (target === null) {
        if (specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("#")) {
          builder.limitations.add("path-alias-unsupported");
        }
        continue;
      }
      const targetFile = builder.read(target);
      if (targetFile === null) continue;
      fileNode(builder, targetFile);
      builder.addEdge({
        from: file.path,
        to: target,
        type: file.kind === "test" ? "tests" : "imports",
        line: lineOf(file.lines, specifier),
      });
    }
  }
}

function headingSlug(value: string): string {
  return splitTerms(value).join("-").slice(0, 96) || "heading";
}

function docTarget(path: string, raw: string, candidates: ReadonlySet<string>): string | null {
  const target = raw.trim().replace(/^<|>$/gu, "").split("#", 1)[0]!;
  if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("/")) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) return null;
  return candidates.has(resolved) ? resolved : null;
}

function ingestMarkdown(builder: GraphBuilder): void {
  for (const path of [...builder.candidates].filter(isMarkdown).sort()) {
    const file = builder.read(path);
    if (file === null) continue;
    fileNode(builder, file);
    let current = file.path;
    const headingKeys = new Set<string>();
    for (let index = 0; index < file.lines.length; index++) {
      const line = file.lines[index]!;
      const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/u)?.[1]?.trim();
      if (heading !== undefined) {
        if (looksSecret(heading) || looksAssignmentLike(heading)) {
          builder.limitations.add("secret-shaped-heading-skipped");
          current = file.path;
        } else {
          const base = `${file.path}#${headingSlug(heading)}`;
          const key = headingKeys.has(base) ? `${base}-${index + 1}` : base;
          headingKeys.add(key);
          builder.addNode({
            key,
            kind: "heading",
            hash8: file.hash8,
            line: index + 1,
            terms: terms(file.path, heading),
            snippet: safeSnippet(file.lines, index + 1),
          });
          builder.addEdge({ from: file.path, to: key, type: "contains", line: index + 1 });
          current = key;
        }
      }
      const destinations = [
        ...line.matchAll(/\]\(([^)\s]+)\)/gu),
        ...line.matchAll(/`([^`\s]+\.[A-Za-z0-9]+)`/gu),
      ].map((match) => match[1]!).filter(Boolean);
      for (const destination of destinations) {
        const target = docTarget(file.path, destination, builder.candidates);
        if (target === null) continue;
        const targetFile = builder.read(target);
        if (targetFile === null) continue;
        fileNode(builder, targetFile);
        builder.addEdge({ from: current, to: target, type: "mentions", line: index + 1 });
      }
    }
  }
}

function ingestPackages(builder: GraphBuilder): void {
  for (const path of [...builder.candidates].filter((candidate) => posix.basename(candidate) === "package.json").sort()) {
    const file = builder.read(path);
    if (file === null) continue;
    fileNode(builder, file);
    let raw: unknown;
    try {
      raw = JSON.parse(file.source);
    } catch {
      builder.limitations.add("package-json-invalid");
      continue;
    }
    if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.length === 0 || looksSecret(raw.name)) continue;
    const metadata = [raw.name];
    for (const field of [raw.scripts, raw.dependencies, raw.devDependencies]) {
      if (isRecord(field)) metadata.push(...Object.keys(field));
    }
    const key = `pkg:${raw.name}`;
    const line = lineOf(file.lines, `"name"`);
    builder.addNode({
      key,
      kind: "package",
      hash8: file.hash8,
      line,
      terms: terms(path, ...metadata),
      snippet: safeSnippet(file.lines, line),
    });
    builder.addEdge({ from: path, to: key, type: "contains", line });
  }
}

function codeownersRegex(raw: string): RegExp | null {
  const anchored = raw.startsWith("/");
  let pattern = anchored ? raw.slice(1) : raw;
  if (!pattern || pattern.startsWith("!") || pattern.includes("\\") || pattern.includes("[")) return null;
  const rootRelative = anchored || pattern.includes("/");
  const directory = pattern.endsWith("/");
  if (directory) pattern = pattern.slice(0, -1);
  const escaped = pattern.replace(/[.+^${}()|]/gu, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll("\u0000", ".*");
  const prefix = rootRelative ? "^" : "(?:^|.*/)";
  return new RegExp(`${prefix}${escaped}${directory ? "(?:/.*)?" : ""}$`, "u");
}

function ingestOwners(builder: GraphBuilder): void {
  const path = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
    .find((candidate) => builder.candidates.has(candidate));
  if (path === undefined) return;
  const ownership = new Map<string, { readonly owners: readonly string[]; readonly line: number }>();
  const file = builder.read(path);
  if (file === null) return;
  fileNode(builder, file);
  for (let index = 0; index < file.lines.length; index++) {
    const line = file.lines[index]!.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/u);
    const matcher = pattern === undefined ? null : codeownersRegex(pattern);
    const safeOwners = owners.filter((owner) => owner.startsWith("@") && !looksSecret(owner));
    if (matcher === null || safeOwners.length === 0) {
      builder.limitations.add("codeowners-rule-unsupported");
      continue;
    }
    for (const candidate of builder.candidates) {
      if (candidate !== path && matcher.test(candidate)) ownership.set(candidate, { owners: safeOwners, line: index + 1 });
    }
  }
  for (const [path, owned] of [...ownership.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const file = builder.read(path);
    if (file === null) continue;
    fileNode(builder, file);
    for (const owner of owned.owners) {
      const key = `owner:${owner}`;
      builder.addNode({ key, kind: "owner", hash8: hash8(owner), line: owned.line, terms: terms(owner) });
      builder.addEdge({ from: key, to: path, type: "owns", line: owned.line });
    }
  }
}

function pathMatchesScope(path: string, scope: string): boolean {
  if (scope === ".") return false;
  if (scope === path) return true;
  if (scope.endsWith("/")) return path.startsWith(scope);
  if (!scope.includes("*")) return path.startsWith(`${scope}/`);
  const matcher = codeownersRegex(scope);
  return matcher?.test(path) ?? false;
}

function strictWorks(root: string) {
  const directory = resolve(root, ".gdm");
  let rootStat: Stats;
  try {
    rootStat = lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("unsafe GDM metadata root");
  const works: ReturnType<typeof loadWork>[] = [];
  for (const name of readdirSync(directory).sort()) {
    const child = resolve(directory, name);
    const childStat = lstatSync(child);
    if (childStat.isSymbolicLink()) throw new Error("symbolic link in GDM metadata");
    if (!childStat.isDirectory()) continue;
    const statePath = resolve(child, "checks.json");
    let stateStat: Stats;
    try {
      stateStat = lstatSync(statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (name.startsWith(".") || RESERVED_GDM_DIRECTORIES.has(name)) continue;
      try {
        validateSlug(name);
      } catch {
        continue;
      }
      throw new Error("incomplete GDM Work state");
    }
    if (stateStat.isSymbolicLink() || !stateStat.isFile()) throw new Error("unsafe GDM Work state");
    works.push(loadWork(root, name));
  }
  return works;
}

function projectedWorks(root: string) {
  return strictWorks(root).sort((left, right) => left.slug.localeCompare(right.slug)).map((work) => ({
    slug: work.slug,
    brief: work.brief,
    createdAt: work.createdAt,
    done: work.done,
    allowedPaths: work.contract.allowedPaths ?? ["."],
    checks: work.checks.map((check) => ({
      id: check.id,
      desc: check.desc,
      expect: check.expect,
      kind: check.kind ?? "behavior",
      manual: check.manual,
      status: check.status,
      evidence: check.evidence === undefined ? null : {
        observed: check.evidence.observed,
        sha256: check.evidence.sha256,
        exitCode: check.evidence.exitCode ?? null,
        manual: check.evidence.manual,
        at: check.evidence.at,
      },
    })),
  }));
}

function workFingerprint(root: string): string {
  return sha256(JSON.stringify(projectedWorks(root)));
}

function ingestWorks(builder: GraphBuilder): void {
  const works = projectedWorks(builder.root);
  builder.workFingerprint = sha256(JSON.stringify(works));
  for (const work of works) {
    const workKey = `w:${work.slug}`;
    builder.addNode({
      key: workKey,
      kind: "work",
      hash8: hash8(`${work.slug}\0${work.createdAt}\0${work.done}`),
      line: 0,
      terms: looksSecret(work.brief)
        ? terms(work.slug, work.done ? "done" : "open")
        : terms(work.slug, work.brief, work.done ? "done" : "open"),
    });
    if (looksSecret(work.brief)) builder.limitations.add("secret-shaped-work-text-skipped");
    const scopes = work.allowedPaths;
    for (const path of builder.candidates) {
      if (!scopes.some((scope) => pathMatchesScope(path, scope))) continue;
      const file = builder.read(path);
      if (file === null) continue;
      fileNode(builder, file);
      builder.addEdge({ from: workKey, to: path, type: "touches", line: 0 });
    }
    for (const check of work.checks) {
      const checkKey = `c:${work.slug}:${check.id}`;
      builder.addNode({
        key: checkKey,
        kind: "check",
        hash8: hash8(`${check.id}\0${check.status}\0${check.kind ?? "behavior"}\0${check.manual}`),
        line: 0,
        terms: looksSecret(`${check.desc}\n${check.expect}`)
          ? terms(check.id, check.status, check.kind ?? "behavior")
          : terms(check.id, check.desc, check.expect, check.status, check.kind ?? "behavior"),
      });
      if (looksSecret(`${check.desc}\n${check.expect}`)) builder.limitations.add("secret-shaped-check-text-skipped");
      builder.addEdge({ from: workKey, to: checkKey, type: "contains", line: 0 });
      for (const path of builder.candidates) {
        if (scopes.some((scope) => pathMatchesScope(path, scope)) && builder.nodes.has(path)) {
          builder.addEdge({ from: checkKey, to: path, type: "verifies", line: 0 });
        }
      }
      if (check.evidence === null || looksSecret(check.evidence.observed)) continue;
      const evidenceKey = `ev:${check.evidence.observed}`;
      builder.addNode({
        key: evidenceKey,
        kind: "evidence_ref",
        hash8: check.evidence.sha256.slice(0, 8),
        line: 0,
        terms: terms(check.evidence.observed, check.evidence.manual ? "manual" : "automatic"),
      });
      builder.addEdge({ from: checkKey, to: evidenceKey, type: "evidenced_by", line: 0 });
    }
  }
}

function scoreNode(node: InternalNode, queryTerms: readonly string[], seeds: readonly string[]): number {
  let score = 0;
  for (const seed of seeds) {
    if (node.key === seed) score += 200;
    else if (node.key.startsWith(`${seed}#`)) score += 120;
  }
  for (const query of queryTerms) {
    for (const term of node.terms) {
      if (term === query) score += 24;
      else if (term.startsWith(query) || query.startsWith(term)) score += 10;
      else if (term.includes(query) || query.includes(term)) score += 4;
    }
  }
  return score;
}

function rankedNodes(builder: GraphBuilder, query: ContextQuery): readonly InternalNode[] {
  const queryTerms = [...new Set(query.terms.flatMap(splitTerms))];
  const scores = new Map<string, number>();
  const queue: Array<{ readonly key: string; readonly depth: number; readonly score: number }> = [];
  for (const node of builder.nodes.values()) {
    const score = scoreNode(node, queryTerms, query.seeds);
    if (score <= 0) continue;
    scores.set(node.key, score);
    queue.push({ key: node.key, depth: 0, score });
  }
  const allowedEdges = new Set(query.edgeTypes);
  const adjacency = new Map<string, string[]>();
  for (const edge of builder.edges.values()) {
    if (!allowedEdges.has(edge.type)) continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from]);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    if (current.depth >= query.maxDepth) continue;
    for (const next of (adjacency.get(current.key) ?? []).sort()) {
      const propagated = Math.max(1, current.score - ((current.depth + 1) * 8));
      if ((scores.get(next) ?? 0) >= propagated) continue;
      scores.set(next, propagated);
      queue.push({ key: next, depth: current.depth + 1, score: propagated });
    }
  }
  return [...scores.entries()]
    .sort(([leftKey, leftScore], [rightKey, rightScore]) => rightScore - leftScore || leftKey.localeCompare(rightKey))
    .map(([key]) => builder.nodes.get(key)!)
    .filter(Boolean);
}

function graphFingerprint(builder: GraphBuilder): string {
  const hash = createHash("sha256");
  for (const node of [...builder.nodes.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    hash.update(`${node.key}\0${node.hash8}\0${node.line}\n`);
  }
  for (const edge of [...builder.edges.values()].sort(compareEdge)) {
    hash.update(`${edge.from}\0${edge.to}\0${edge.type}\0${edge.line}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

function compareEdge(left: InternalEdge, right: InternalEdge): number {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to) ||
    left.type.localeCompare(right.type) || left.line - right.line;
}

function renderBounded(
  builder: GraphBuilder,
  query: ContextQuery,
  ranked: readonly InternalNode[],
  fresh: boolean,
): ContextPack {
  const maxBytes = query.op === "route" ? Math.min(query.budget.maxBytes, ROUTE_MAX_BYTES) : query.budget.maxBytes;
  const eligibleEdges = [...builder.edges.values()]
    .filter((edge) => query.edgeTypes.includes(edge.type))
    .sort(compareEdge);
  let nodeLimit = Math.min(ranked.length, query.budget.maxNodes);
  let edgeLimit = query.op === "route" ? 0 : query.budget.maxEdges;
  let snippetLimit = query.op === "route" || !fresh ? 0 : query.budget.maxSnippets;
  let whyLimit = Math.min(builder.limitations.size, 8);
  const initiallyDropped = Math.max(0, ranked.length - query.budget.maxNodes);
  let budgetTrimmed = false;

  const render = (): ContextPack => {
    const chosen = ranked.slice(0, nodeLimit);
    const indices = new Map(chosen.map((node, index) => [node.key, index]));
    const nodes: ContextNodeTuple[] = chosen.map((node) => [node.key, node.kind, node.hash8, node.line]);
    const allEdges: ContextEdgeTuple[] = eligibleEdges.flatMap((edge) => {
      const from = indices.get(edge.from);
      const to = indices.get(edge.to);
      return from === undefined || to === undefined ? [] : [[from, to, edge.type, edge.line] as const];
    });
    const snippets: ContextSnippetTuple[] = chosen.flatMap((node, index) => node.snippet === undefined
      ? []
      : [[index, node.snippet.startLine, node.snippet.endLine, node.snippet.text] as const]);
    const dropped = initiallyDropped + Math.max(0, allEdges.length - edgeLimit) + Math.max(0, snippets.length - snippetLimit) +
      Math.max(0, Math.min(ranked.length, query.budget.maxNodes) - nodeLimit);
    const limited = dropped > 0 || budgetTrimmed;
    const why: ContextPack["tr"] = limited
      ? {
        why: budgetTrimmed ? "byte-budget" : initiallyDropped > 0 ? "node-budget" : allEdges.length > edgeLimit ? "edge-budget" : "snippet-budget",
        dropped,
        hint: "narrow-terms-seeds-or-depth",
      }
      : null;
    return {
      s: CONTEXT_PACK_SCHEMA,
      st: !fresh ? "stale" : ranked.length === 0 ? "unsupported" : "ok",
      fr: fresh ? "fresh" : "stale",
      fp: graphFingerprint(builder),
      n: nodes,
      e: allEdges.slice(0, edgeLimit),
      sn: snippets.slice(0, snippetLimit),
      u: { count: builder.limitations.size, why: [...builder.limitations].sort().slice(0, whyLimit) },
      tr: why,
      lim: { b: maxBytes, n: query.budget.maxNodes, e: query.budget.maxEdges, sn: query.budget.maxSnippets, d: query.maxDepth },
    };
  };

  let pack = render();
  while (Buffer.byteLength(JSON.stringify(pack)) > maxBytes) {
    budgetTrimmed = true;
    if (snippetLimit > 0) snippetLimit--;
    else if (edgeLimit > 0) edgeLimit--;
    else if (nodeLimit > 0) nodeLimit--;
    else if (whyLimit > 0) whyLimit--;
    else throw new Error("context pack minimum response exceeds byte budget");
    pack = render();
  }
  return pack;
}

function emptyFailurePack(
  query: ContextQuery,
  status: "untrusted" | "error",
  reason: string,
): ContextPack {
  const maxBytes = query.op === "route" ? Math.min(query.budget.maxBytes, ROUTE_MAX_BYTES) : query.budget.maxBytes;
  return {
    s: CONTEXT_PACK_SCHEMA,
    st: status,
    fr: "stale",
    fp: "",
    n: [],
    e: [],
    sn: [],
    u: { count: 1, why: [reason] },
    tr: null,
    lim: { b: maxBytes, n: query.budget.maxNodes, e: query.budget.maxEdges, sn: query.budget.maxSnippets, d: query.maxDepth },
  };
}

export function untrustedPack(query: ContextQuery): ContextPack {
  return emptyFailurePack(query, "untrusted", "trusted-root-mismatch");
}

export function buildContextPack(
  query: ContextQuery,
  root: string,
  hooks: {
    readonly beforeFreshness?: () => void;
    readonly fileDigestForTest?: (value: Uint8Array) => string;
  } = {},
): ContextPack {
  const candidates = new Set(candidatePaths(root));
  const builder = new GraphBuilder(root, candidates, hooks.fileDigestForTest);
  if (candidates.size >= MAX_CANDIDATE_FILES) builder.limitations.add(`candidate-file-cap-reached:${MAX_CANDIDATE_FILES}`);
  ingestModules(builder);
  ingestMarkdown(builder);
  ingestPackages(builder);
  ingestOwners(builder);
  try {
    ingestWorks(builder);
  } catch {
    return emptyFailurePack(query, "error", "gdm-metadata-invalid");
  }
  hooks.beforeFreshness?.();
  const fresh = builder.verifyFreshness();
  if (!fresh) builder.limitations.add("source-or-work-changed-during-query");
  return renderBounded(builder, query, rankedNodes(builder, query), fresh);
}
