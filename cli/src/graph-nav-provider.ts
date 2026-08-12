#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const QUERY_SCHEMA = "gdm-graph-query/v1" as const;
const RESULT_SCHEMA = "gdm-graph-result/v2" as const;
const PROVIDER_NAME = "gdm-ts-relative-imports" as const;
const PROVIDER_VERSION = 2 as const;

const MAX_DEPTH = 5;
const MAX_CANDIDATE_FILES = 512;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_READ_BYTES = 8 * 1024 * 1024;
const MAX_EDGES = 4_096;
const MAX_UNRESOLVED = 512;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;
const STATIC_LIMITATIONS = [
  "module-dependency-graph-only:no-symbol-or-call-analysis",
  "static-relative-imports-only:dynamic-import-require-bare-package-and-tsconfig-alias-unsupported",
  "bare-package-imports-outside-relative-graph",
  "lexical-scan-only:no-tsconfig-or-package-resolution",
] as const;
const REGEX_PREFIX_KEYWORDS = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "of", "return", "throw",
  "typeof", "void", "yield",
]);
const REGEX_PREFIX_PUNCTUATION = new Set([
  "(", "{", "[", ",", ";", "=", ":", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">",
]);
const TRANSPILERS = new Map<string, Bun.Transpiler>([
  [".ts", new Bun.Transpiler({ loader: "ts" })],
  [".tsx", new Bun.Transpiler({ loader: "tsx" })],
  [".js", new Bun.Transpiler({ loader: "js" })],
  [".jsx", new Bun.Transpiler({ loader: "jsx" })],
]);

type Direction = "dependencies" | "dependents";

interface QueryRequest {
  readonly schemaVersion: typeof QUERY_SCHEMA;
  readonly root: string;
  readonly entry: string;
  readonly direction: Direction;
  readonly maxDepth: number;
}

interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly via: "relative-import";
}

interface GraphNode {
  readonly path: string;
  readonly depth: number;
}

interface CandidateTest {
  readonly path: string;
  readonly reason: "direct-dependent" | "transitive-dependent";
}

interface UnresolvedReference {
  readonly from: string;
  readonly specifier?: string;
  readonly reason: string;
}

interface GraphResult {
  readonly schemaVersion: typeof RESULT_SCHEMA;
  readonly provider: { readonly name: typeof PROVIDER_NAME; readonly version: typeof PROVIDER_VERSION };
  readonly entry: string;
  readonly direction: Direction;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly candidateTests: readonly CandidateTest[];
  readonly unresolved: readonly UnresolvedReference[];
  readonly limitations: readonly string[];
  readonly freshness: {
    readonly algorithm: "sha256-visited-files";
    readonly consistent: boolean;
    readonly visitedFiles: number;
  };
  readonly coverage: {
    readonly scope: "requested-depth";
    readonly requestedMaxDepth: number;
    readonly completeWithinRequestedDepth: boolean;
    readonly frontier: readonly string[];
    readonly incompleteReasons: readonly string[];
  };
  readonly truncated: boolean;
  readonly limits: {
    readonly maxDepth: number;
    readonly maxCandidateFiles: number;
    readonly maxFileBytes: number;
    readonly maxTotalReadBytes: number;
    readonly maxEdges: number;
    readonly maxUnresolved: number;
  };
}

type Token = {
  readonly kind: "identifier" | "string" | "punctuation";
  readonly value: string;
  readonly curly: number;
  readonly paren: number;
  readonly bracket: number;
};

type TokenizedSource = {
  readonly tokens: readonly Token[];
  readonly errors: readonly string[];
};

type ParsedModule = {
  readonly staticSpecifiers: readonly string[];
  readonly dynamicImports: readonly (string | undefined)[];
  readonly requires: readonly (string | undefined)[];
  readonly errors: readonly string[];
};

class ProviderError extends Error {}

class UnsafeFileError extends Error {}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function supported(path: string): boolean {
  return SUPPORTED_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalRepositoryPath(value: string, field: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("//")
  ) {
    throw new ProviderError(`${field} must be a canonical repository-relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ProviderError(`${field} must not contain empty, dot, or parent segments`);
  }
  if (posix.normalize(value) !== value) {
    throw new ProviderError(`${field} must be normalized`);
  }
  return value;
}

function parseRequest(raw: unknown): QueryRequest {
  if (!isRecord(raw)) throw new ProviderError("request must be a JSON object");
  const allowed = new Set(["schemaVersion", "root", "entry", "direction", "maxDepth"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ProviderError(`request has unknown field: ${unknown.sort()[0]}`);
  if (raw.schemaVersion !== QUERY_SCHEMA) throw new ProviderError(`schemaVersion must be ${QUERY_SCHEMA}`);
  if (typeof raw.root !== "string" || !isAbsolute(raw.root) || raw.root.includes("\0")) {
    throw new ProviderError("root must be an absolute path");
  }
  if (typeof raw.entry !== "string") throw new ProviderError("entry must be a string");
  const entry = canonicalRepositoryPath(raw.entry, "entry");
  if (raw.direction !== "dependencies" && raw.direction !== "dependents") {
    throw new ProviderError("direction must be dependencies or dependents");
  }
  if (!Number.isInteger(raw.maxDepth) || (raw.maxDepth as number) < 1 || (raw.maxDepth as number) > MAX_DEPTH) {
    throw new ProviderError(`maxDepth must be an integer from 1 to ${MAX_DEPTH}`);
  }
  return {
    schemaVersion: QUERY_SCHEMA,
    root: raw.root,
    entry,
    direction: raw.direction,
    maxDepth: raw.maxDepth as number,
  };
}

function assertSafeRegularFile(root: string, repositoryPath: string): Stats {
  let current = root;
  const segments = repositoryPath.split("/");
  for (let index = 0; index < segments.length; index++) {
    current = resolve(current, segments[index]!);
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch {
      throw new UnsafeFileError(`${repositoryPath} does not exist`);
    }
    if (stat.isSymbolicLink()) throw new UnsafeFileError(`${repositoryPath} crosses a symbolic link`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new UnsafeFileError(`${repositoryPath} crosses a non-directory component`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new UnsafeFileError(`${repositoryPath} is not a regular file`);
    }
  }
  return lstatSync(current);
}

function git(root: string, args: readonly string[], maxBuffer = MAX_GIT_OUTPUT_BYTES): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new ProviderError("unable to inspect Git repository");
  }
  return result.stdout;
}

function validateRoot(rootValue: string): string {
  const normalized = resolve(rootValue);
  let rootStat: Stats;
  let actual: string;
  try {
    rootStat = lstatSync(normalized);
    actual = realpathSync(normalized);
  } catch {
    throw new ProviderError("root does not exist");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || actual !== normalized) {
    throw new ProviderError("root must be a real, non-symlink directory");
  }
  const topLevelRaw = git(actual, ["rev-parse", "--show-toplevel"]).trim();
  let topLevel: string;
  try {
    topLevel = realpathSync(topLevelRaw);
  } catch {
    throw new ProviderError("Git top-level cannot be resolved");
  }
  if (topLevel !== actual) throw new ProviderError("root must equal the Git top-level directory");
  return actual;
}

function gitCandidatePaths(root: string): readonly string[] {
  return git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
}

function decodeEscape(source: string, index: number): { readonly value: string; readonly next: number } {
  const escaped = source[index + 1];
  if (escaped === undefined) return { value: "", next: source.length };
  const simple: Readonly<Record<string, string>> = {
    "n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "0": "\0",
    "\\": "\\", "\"": "\"", "'": "'",
  };
  if (Object.hasOwn(simple, escaped)) return { value: simple[escaped]!, next: index + 2 };
  if (escaped === "\n") return { value: "", next: index + 2 };
  if (escaped === "\r" && source[index + 2] === "\n") return { value: "", next: index + 3 };
  if (escaped === "x" && /^[0-9a-fA-F]{2}$/u.test(source.slice(index + 2, index + 4))) {
    return { value: String.fromCodePoint(Number.parseInt(source.slice(index + 2, index + 4), 16)), next: index + 4 };
  }
  if (escaped === "u") {
    const match = source.slice(index + 2).match(/^\{([0-9a-fA-F]{1,6})\}|^([0-9a-fA-F]{4})/u);
    if (match) {
      const code = match[1] ?? match[2]!;
      const point = Number.parseInt(code, 16);
      if (point <= 0x10ffff) return { value: String.fromCodePoint(point), next: index + 2 + match[0].length };
    }
  }
  return { value: escaped, next: index + 2 };
}

function canStartRegex(tokens: readonly Token[]): boolean {
  const previous = tokens.at(-1);
  if (previous === undefined) return true;
  if (previous.kind === "string") return false;
  if (previous.kind === "identifier") return REGEX_PREFIX_KEYWORDS.has(previous.value);
  return REGEX_PREFIX_PUNCTUATION.has(previous.value);
}

function tokenize(source: string): TokenizedSource {
  const tokens: Token[] = [];
  const errors: string[] = [];
  let curly = 0;
  let paren = 0;
  let bracket = 0;
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;
    if (index === 0 && char === "#" && source[index + 1] === "!") {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (/\s/u.test(char)) {
      index++;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) {
        errors.push("unterminated-block-comment");
        break;
      }
      index = end + 2;
      continue;
    }
    if (char === "/" && canStartRegex(tokens)) {
      let cursor = index + 1;
      let inCharacterClass = false;
      let closed = false;
      while (cursor < source.length) {
        const next = source[cursor]!;
        if (next === "\n" || next === "\r") break;
        if (next === "\\") {
          cursor += 2;
          continue;
        }
        if (next === "[") {
          inCharacterClass = true;
          cursor++;
          continue;
        }
        if (next === "]" && inCharacterClass) {
          inCharacterClass = false;
          cursor++;
          continue;
        }
        if (next === "/" && !inCharacterClass) {
          closed = true;
          cursor++;
          while (cursor < source.length && /[A-Za-z]/u.test(source[cursor]!)) cursor++;
          break;
        }
        cursor++;
      }
      if (!closed) {
        const line = source.slice(0, index).split("\n").length;
        errors.push(`unterminated-regex-literal-at-line-${line}`);
      }
      index = Math.max(cursor, index + 1);
      continue;
    }
    if (char === "\"" || char === "'") {
      const quote = char;
      let value = "";
      let cursor = index + 1;
      let closed = false;
      while (cursor < source.length) {
        const next = source[cursor]!;
        if (next === quote) {
          closed = true;
          cursor++;
          break;
        }
        if (next === "\n" || next === "\r") break;
        if (next === "\\") {
          const decoded = decodeEscape(source, cursor);
          value += decoded.value;
          cursor = decoded.next;
          continue;
        }
        value += next;
        cursor++;
      }
      if (!closed) {
        errors.push("unterminated-string-literal");
        index = Math.max(cursor, index + 1);
        continue;
      }
      tokens.push({ kind: "string", value, curly, paren, bracket });
      index = cursor;
      continue;
    }
    if (char === "`") {
      let cursor = index + 1;
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (source[cursor] === "`") {
          closed = true;
          cursor++;
          break;
        }
        cursor++;
      }
      if (!closed) errors.push("unterminated-template-literal");
      index = cursor;
      continue;
    }
    if (/[A-Za-z_$]/u.test(char)) {
      let cursor = index + 1;
      while (cursor < source.length && /[A-Za-z0-9_$]/u.test(source[cursor]!)) cursor++;
      tokens.push({ kind: "identifier", value: source.slice(index, cursor), curly, paren, bracket });
      index = cursor;
      continue;
    }

    if (char === "}") curly = Math.max(0, curly - 1);
    if (char === ")") paren = Math.max(0, paren - 1);
    if (char === "]") bracket = Math.max(0, bracket - 1);
    tokens.push({ kind: "punctuation", value: char, curly, paren, bracket });
    if (char === "{") curly++;
    if (char === "(") paren++;
    if (char === "[") bracket++;
    index++;
  }
  return { tokens, errors };
}

function topLevel(token: Token): boolean {
  return token.curly === 0 && token.paren === 0 && token.bracket === 0;
}

function literalArgument(tokens: readonly Token[], start: number): string | undefined {
  const open = tokens[start + 1];
  const argument = tokens[start + 2];
  return open?.kind === "punctuation" && open.value === "(" && argument?.kind === "string"
    ? argument.value
    : undefined;
}

function parseModule(source: string, repositoryPath: string): ParsedModule {
  const tokenized = tokenize(source);
  const fallbackStaticSpecifiers: string[] = [];
  const fallbackDynamicImports: (string | undefined)[] = [];
  const fallbackRequires: (string | undefined)[] = [];
  const typeOnlySpecifiers: string[] = [];
  const tokens = tokenized.tokens;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "identifier") continue;
    const next = tokens[index + 1];
    if (token.value === "import" && next?.kind === "punctuation" && next.value === "(") {
      fallbackDynamicImports.push(literalArgument(tokens, index));
      continue;
    }
    if (token.value === "require" && next?.kind === "punctuation" && next.value === "(") {
      fallbackRequires.push(literalArgument(tokens, index));
      continue;
    }
    if (!topLevel(token) || (token.value !== "import" && token.value !== "export")) continue;
    if (token.value === "import" && next?.kind === "string") {
      fallbackStaticSpecifiers.push(next.value);
      continue;
    }
    if (token.value === "import" && next?.kind === "punctuation" && (next.value === "." || next.value === "(")) {
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const candidate = tokens[cursor]!;
      if (candidate.kind === "punctuation" && candidate.value === ";" && topLevel(candidate)) break;
      if (
        cursor > index + 1 && candidate.kind === "identifier" && topLevel(candidate) &&
        (candidate.value === "import" || candidate.value === "export")
      ) break;
      if (candidate.kind === "identifier" && candidate.value === "from" && topLevel(candidate)) {
        const specifier = tokens[cursor + 1];
        if (specifier?.kind === "string") {
          fallbackStaticSpecifiers.push(specifier.value);
          const hasTypeMarker = tokens
            .slice(index + 1, cursor)
            .some((part) => part.kind === "identifier" && part.value === "type");
          if (hasTypeMarker) typeOnlySpecifiers.push(specifier.value);
        }
        break;
      }
    }
  }

  const transpiler = TRANSPILERS.get(posix.extname(repositoryPath));
  if (transpiler === undefined) {
    return {
      staticSpecifiers: fallbackStaticSpecifiers,
      dynamicImports: fallbackDynamicImports,
      requires: fallbackRequires,
      errors: tokenized.errors,
    };
  }
  const parserSource = source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
  let imports: Bun.Import[];
  try {
    imports = transpiler.scanImports(parserSource);
  } catch {
    return {
      staticSpecifiers: fallbackStaticSpecifiers,
      dynamicImports: fallbackDynamicImports,
      requires: fallbackRequires,
      errors: tokenized.errors.length > 0 ? tokenized.errors : ["syntax-error"],
    };
  }
  return {
    staticSpecifiers: [...new Set([
      ...imports.filter((item) => item.kind === "import-statement").map((item) => item.path),
      ...typeOnlySpecifiers,
    ])],
    dynamicImports: imports
      .filter((item) => item.kind === "dynamic-import")
      .map((item) => item.path || undefined),
    requires: imports
      .filter((item) => item.kind === "require-call" || item.kind === "require-resolve")
      .map((item) => item.path || undefined),
    errors: [],
  };
}

class QueryContext {
  readonly limitations = new Set<string>(STATIC_LIMITATIONS);
  readonly incompleteReasons = new Set<string>();
  readonly unresolved = new Map<string, UnresolvedReference>();
  readonly sources = new Map<string, string>();
  readonly initialHashes = new Map<string, string>();
  totalReadBytes = 0;
  reservedFreshnessBytes = 0;
  truncated = false;
  budgetExhausted = false;

  constructor(
    readonly root: string,
    readonly candidates: ReadonlySet<string>,
  ) {}

  addLimitation(value: string): void {
    this.limitations.add(value);
  }

  addIncomplete(value: string): void {
    this.incompleteReasons.add(value);
  }

  addUnresolved(value: UnresolvedReference): void {
    const key = `${value.from}\0${value.specifier ?? ""}\0${value.reason}`;
    if (this.unresolved.has(key)) return;
    if (this.unresolved.size >= MAX_UNRESOLVED) {
      this.markTruncated(`unresolved-cap-reached:${MAX_UNRESOLVED}`);
      return;
    }
    this.unresolved.set(key, value);
  }

  markTruncated(limitation: string): void {
    this.truncated = true;
    this.limitations.add(limitation);
    this.incompleteReasons.add(limitation);
  }

  readSource(repositoryPath: string): string | null {
    const cached = this.sources.get(repositoryPath);
    if (cached !== undefined) return cached;
    let stat: Stats;
    try {
      stat = assertSafeRegularFile(this.root, repositoryPath);
    } catch {
      this.addUnresolved({ from: repositoryPath, reason: "unsafe-or-missing-file" });
      this.addLimitation("unsafe-or-missing-candidate-skipped");
      this.addIncomplete("unsafe-or-missing-file");
      return null;
    }
    if (stat.size > MAX_FILE_BYTES) {
      this.markTruncated(`file-size-cap-reached:${MAX_FILE_BYTES}`);
      this.addUnresolved({ from: repositoryPath, reason: "file-too-large" });
      return null;
    }
    // Reserve the second read required by the freshness check.
    if (this.totalReadBytes + this.reservedFreshnessBytes + (stat.size * 2) > MAX_TOTAL_READ_BYTES) {
      this.budgetExhausted = true;
      this.markTruncated(`total-read-byte-cap-reached:${MAX_TOTAL_READ_BYTES}`);
      this.addUnresolved({ from: repositoryPath, reason: "total-read-budget-exhausted" });
      return null;
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(resolve(this.root, repositoryPath));
    } catch {
      this.addUnresolved({ from: repositoryPath, reason: "file-disappeared-during-read" });
      this.addLimitation("file-disappeared-during-query");
      this.addIncomplete("file-disappeared-during-read");
      return null;
    }
    if (
      bytes.byteLength > MAX_FILE_BYTES ||
      this.totalReadBytes + this.reservedFreshnessBytes + (bytes.byteLength * 2) > MAX_TOTAL_READ_BYTES
    ) {
      this.budgetExhausted = true;
      this.markTruncated(`total-read-byte-cap-reached:${MAX_TOTAL_READ_BYTES}`);
      this.addUnresolved({ from: repositoryPath, reason: "read-budget-race" });
      return null;
    }
    this.totalReadBytes += bytes.byteLength;
    this.reservedFreshnessBytes += bytes.byteLength;
    this.initialHashes.set(repositoryPath, sha256(bytes));
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      this.addUnresolved({ from: repositoryPath, reason: "invalid-utf8" });
      this.addLimitation("invalid-utf8-source-skipped");
      this.addIncomplete("invalid-utf8");
      return null;
    }
    this.sources.set(repositoryPath, source);
    return source;
  }

  finishFreshness(): GraphResult["freshness"] {
    let consistent = true;
    for (const [repositoryPath, initialHash] of [...this.initialHashes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const stat = assertSafeRegularFile(this.root, repositoryPath);
        if (stat.size > MAX_FILE_BYTES || this.totalReadBytes + stat.size > MAX_TOTAL_READ_BYTES) {
          consistent = false;
          this.markTruncated(`freshness-read-cap-reached:${MAX_TOTAL_READ_BYTES}`);
          continue;
        }
        const bytes = readFileSync(resolve(this.root, repositoryPath));
        this.totalReadBytes += bytes.byteLength;
        if (sha256(bytes) !== initialHash) consistent = false;
      } catch {
        consistent = false;
      }
    }
    if (!consistent) {
      this.addLimitation("visited-file-changed-or-disappeared-during-query");
      this.addIncomplete("freshness-inconsistent");
    }
    return {
      algorithm: "sha256-visited-files",
      consistent,
      visitedFiles: this.initialHashes.size,
    };
  }
}

function resolutionCandidates(from: string, specifier: string): readonly string[] {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (base === ".." || base.startsWith("../") || base.startsWith("/")) return [];
  const extension = posix.extname(base);
  if (extension.length === 0) {
    return [
      ...SUPPORTED_EXTENSIONS.map((candidate) => `${base}${candidate}`),
      ...SUPPORTED_EXTENSIONS.map((candidate) => `${base}/index${candidate}`),
    ];
  }
  if (extension === ".js") {
    const stem = base.slice(0, -extension.length);
    return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.jsx`];
  }
  if (extension === ".jsx") {
    const stem = base.slice(0, -extension.length);
    return [base, `${stem}.tsx`];
  }
  return [base];
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isClearPathAlias(specifier: string): boolean {
  return specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("#");
}

function resolveStaticSpecifier(
  context: QueryContext,
  from: string,
  specifier: string,
): string | null {
  if (!isRelativeSpecifier(specifier)) {
    if (isClearPathAlias(specifier)) {
      context.addUnresolved({ from, specifier, reason: "path-alias-unsupported" });
      context.addLimitation("path-alias-unsupported");
    } else {
      // Bare packages cannot point to a repository-relative module in this provider. They are
      // a capability boundary, disclosed once in limitations rather than as per-file noise.
      context.addLimitation("bare-package-imports-outside-relative-graph");
    }
    return null;
  }
  if (specifier.includes("\\") || specifier.includes("\0")) {
    context.addUnresolved({ from, specifier, reason: "unsafe-relative-specifier" });
    return null;
  }
  const candidates = resolutionCandidates(from, specifier);
  if (candidates.length === 0) {
    context.addUnresolved({ from, specifier, reason: "relative-specifier-outside-root" });
    return null;
  }
  for (const candidate of candidates) {
    if (!context.candidates.has(candidate)) continue;
    try {
      assertSafeRegularFile(context.root, candidate);
      return candidate;
    } catch {
      context.addUnresolved({ from, specifier, reason: "relative-target-unsafe" });
      context.addLimitation("symlink-or-nonregular-import-target-skipped");
      context.addIncomplete("relative-target-unsafe");
      return null;
    }
  }
  const extension = posix.extname(posix.normalize(posix.join(posix.dirname(from), specifier)));
  const reason = extension.length > 0 && !SUPPORTED_EXTENSIONS.includes(extension as typeof SUPPORTED_EXTENSIONS[number])
    ? "relative-target-extension-unsupported"
    : "relative-target-unresolved-or-outside-candidate-cap";
  context.addUnresolved({ from, specifier, reason });
  context.addLimitation(reason);
  if (reason === "relative-target-unresolved-or-outside-candidate-cap") {
    context.addIncomplete(reason);
  }
  return null;
}

function scanModule(context: QueryContext, repositoryPath: string): readonly GraphEdge[] {
  if (!supported(repositoryPath)) {
    context.addUnresolved({ from: repositoryPath, reason: "entry-or-candidate-extension-unsupported" });
    context.addLimitation("supported-extensions-only:ts-tsx-js-jsx");
    return [];
  }
  const source = context.readSource(repositoryPath);
  if (source === null) return [];
  const parsed = parseModule(source, repositoryPath);
  for (const error of parsed.errors) {
    const reason = `parse-error:${error}`;
    context.addUnresolved({ from: repositoryPath, reason });
    context.addLimitation("lexical-parse-error-present");
    context.addIncomplete(reason);
  }
  for (const specifier of parsed.dynamicImports) {
    discloseRuntimeSpecifier(context, repositoryPath, specifier, "dynamic-import-unsupported");
  }
  for (const specifier of parsed.requires) {
    discloseRuntimeSpecifier(context, repositoryPath, specifier, "require-unsupported");
  }
  const edges = new Map<string, GraphEdge>();
  for (const specifier of parsed.staticSpecifiers) {
    const target = resolveStaticSpecifier(context, repositoryPath, specifier);
    if (target === null) continue;
    const edge: GraphEdge = { from: repositoryPath, to: target, via: "relative-import" };
    edges.set(`${edge.from}\0${edge.to}`, edge);
  }
  return [...edges.values()].sort(compareEdges);
}

function discloseRuntimeSpecifier(
  context: QueryContext,
  repositoryPath: string,
  specifier: string | undefined,
  reason: "dynamic-import-unsupported" | "require-unsupported",
): void {
  context.addLimitation(reason);
  if (specifier === undefined || isRelativeSpecifier(specifier)) {
    context.addUnresolved({
      from: repositoryPath,
      ...(specifier === undefined ? {} : { specifier }),
      reason,
    });
  } else if (isClearPathAlias(specifier)) {
    context.addUnresolved({ from: repositoryPath, specifier, reason: "path-alias-unsupported" });
    context.addLimitation("path-alias-unsupported");
  } else {
    context.addLimitation("bare-package-imports-outside-relative-graph");
  }
}

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to);
}

function insertEdge(edges: Map<string, GraphEdge>, edge: GraphEdge, context: QueryContext): boolean {
  const key = `${edge.from}\0${edge.to}`;
  if (edges.has(key)) return true;
  if (edges.size >= MAX_EDGES) {
    context.markTruncated(`edge-cap-reached:${MAX_EDGES}`);
    return false;
  }
  edges.set(key, edge);
  return true;
}

interface TraversalResult {
  readonly nodes: ReadonlyMap<string, number>;
  readonly edges: readonly GraphEdge[];
  readonly frontier: readonly string[];
}

function dependencyTraversal(
  context: QueryContext,
  entry: string,
  maxDepth: number,
): TraversalResult {
  const depths = new Map<string, number>([[entry, 0]]);
  const queue = [entry];
  const edges = new Map<string, GraphEdge>();
  const boundaryEdges: GraphEdge[] = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    const depth = depths.get(current)!;
    const outgoing = scanModule(context, current);
    for (const edge of outgoing) {
      if (depth >= maxDepth) {
        boundaryEdges.push(edge);
        continue;
      }
      if (!insertEdge(edges, edge, context)) continue;
      if (!depths.has(edge.to)) {
        depths.set(edge.to, depth + 1);
        queue.push(edge.to);
      }
    }
    if (context.budgetExhausted) break;
  }
  const frontier = new Set<string>();
  for (const edge of boundaryEdges) {
    if (depths.has(edge.to)) {
      insertEdge(edges, edge, context);
    } else {
      frontier.add(edge.from);
    }
  }
  return {
    nodes: depths,
    edges: [...edges.values()].sort(compareEdges),
    frontier: [...frontier].sort(),
  };
}

function dependentTraversal(
  context: QueryContext,
  candidates: readonly string[],
  entry: string,
  maxDepth: number,
): TraversalResult {
  const allEdges = new Map<string, GraphEdge>();
  for (const candidate of candidates) {
    for (const edge of scanModule(context, candidate)) insertEdge(allEdges, edge, context);
    if (context.budgetExhausted) break;
  }
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of allEdges.values()) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge);
    incoming.set(edge.to, list);
  }
  for (const list of incoming.values()) list.sort(compareEdges);

  const depths = new Map<string, number>([[entry, 0]]);
  const queue = [entry];
  const selectedEdges = new Map<string, GraphEdge>();
  const boundaryEdges: GraphEdge[] = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    const depth = depths.get(current)!;
    const dependents = incoming.get(current) ?? [];
    for (const edge of dependents) {
      if (depth >= maxDepth) {
        boundaryEdges.push(edge);
        continue;
      }
      insertEdge(selectedEdges, edge, context);
      if (!depths.has(edge.from)) {
        depths.set(edge.from, depth + 1);
        queue.push(edge.from);
      }
    }
  }
  const frontier = new Set<string>();
  for (const edge of boundaryEdges) {
    if (depths.has(edge.from)) {
      insertEdge(selectedEdges, edge, context);
    } else {
      frontier.add(edge.to);
    }
  }
  return {
    nodes: depths,
    edges: [...selectedEdges.values()].sort(compareEdges),
    frontier: [...frontier].sort(),
  };
}

function isCandidateTest(path: string): boolean {
  return /(?:^|\/)test\//u.test(path) || /\.test\.(?:ts|tsx|js|jsx)$/u.test(path);
}

function candidateTests(direction: Direction, nodes: ReadonlyMap<string, number>): readonly CandidateTest[] {
  if (direction !== "dependents") return [];
  return [...nodes.entries()]
    .filter(([path, depth]) => depth > 0 && isCandidateTest(path))
    .map(([path, depth]) => ({
      path,
      reason: depth === 1 ? "direct-dependent" as const : "transitive-dependent" as const,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function buildCandidateSet(
  root: string,
  entry: string,
  contextLimitations: Set<string>,
): { readonly paths: readonly string[]; readonly truncated: boolean } {
  const valid: string[] = [];
  for (const raw of gitCandidatePaths(root)) {
    if (!supported(raw)) continue;
    try {
      valid.push(canonicalRepositoryPath(raw, "Git candidate"));
    } catch {
      contextLimitations.add("noncanonical-git-candidate-skipped");
    }
  }
  const unique = [...new Set(valid)].sort();
  const truncated = unique.length > MAX_CANDIDATE_FILES;
  let selected = unique.slice(0, MAX_CANDIDATE_FILES);
  if (supported(entry) && !selected.includes(entry)) {
    selected = selected.length < MAX_CANDIDATE_FILES
      ? [...selected, entry]
      : [...selected.slice(0, -1), entry];
    selected.sort();
  }
  return { paths: selected, truncated };
}

function runQuery(request: QueryRequest): GraphResult {
  const root = validateRoot(request.root);
  try {
    assertSafeRegularFile(root, request.entry);
  } catch (error) {
    throw new ProviderError(error instanceof Error ? error.message : "entry is not a safe regular file");
  }

  const initialLimitations = new Set<string>();
  const candidates = buildCandidateSet(root, request.entry, initialLimitations);
  const candidateSet = new Set(candidates.paths);
  if (supported(request.entry)) candidateSet.add(request.entry);
  const context = new QueryContext(root, candidateSet);
  for (const limitation of initialLimitations) {
    context.addLimitation(limitation);
    context.addIncomplete(limitation);
  }
  if (candidates.truncated) context.markTruncated(`candidate-file-cap-reached:${MAX_CANDIDATE_FILES}`);

  const traversal = request.direction === "dependencies"
    ? dependencyTraversal(context, request.entry, request.maxDepth)
    : dependentTraversal(context, [...candidateSet].sort(), request.entry, request.maxDepth);
  const freshness = context.finishFreshness();
  return {
    schemaVersion: RESULT_SCHEMA,
    provider: { name: PROVIDER_NAME, version: PROVIDER_VERSION },
    entry: request.entry,
    direction: request.direction,
    nodes: [...traversal.nodes.entries()]
      .map(([path, depth]) => ({ path, depth }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    edges: traversal.edges,
    candidateTests: candidateTests(request.direction, traversal.nodes),
    unresolved: [...context.unresolved.values()].sort((left, right) =>
      left.from.localeCompare(right.from) ||
      (left.specifier ?? "").localeCompare(right.specifier ?? "") ||
      left.reason.localeCompare(right.reason)
    ),
    limitations: [...context.limitations].sort(),
    freshness,
    coverage: {
      scope: "requested-depth",
      requestedMaxDepth: request.maxDepth,
      completeWithinRequestedDepth: context.incompleteReasons.size === 0,
      frontier: traversal.frontier,
      incompleteReasons: [...context.incompleteReasons].sort(),
    },
    truncated: context.truncated,
    limits: {
      maxDepth: MAX_DEPTH,
      maxCandidateFiles: MAX_CANDIDATE_FILES,
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalReadBytes: MAX_TOTAL_READ_BYTES,
      maxEdges: MAX_EDGES,
      maxUnresolved: MAX_UNRESOLVED,
    },
  };
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== "query") {
    throw new ProviderError("usage: graph-nav-provider.ts query");
  }
  const input = await Bun.stdin.text();
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new ProviderError("stdin must contain exactly one JSON request");
  }
  const result = runQuery(parseRequest(raw));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof ProviderError ? error.message : "internal provider error";
  process.stderr.write(`graph-nav-provider: ${message}\n`);
  process.exitCode = error instanceof ProviderError ? 2 : 1;
}
