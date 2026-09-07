import { posix } from "node:path";

export const SUPPORTED_MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;

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

export type ParsedModule = {
  readonly staticSpecifiers: readonly string[];
  readonly dynamicImports: readonly (string | undefined)[];
  readonly requires: readonly (string | undefined)[];
  readonly errors: readonly string[];
};

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

export function parseModule(source: string, repositoryPath: string): ParsedModule {
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
