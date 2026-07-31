import { TOML } from "bun";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CodexConfigObject = { readonly [key: string]: unknown };

export type CodexConfigReadResult =
  | {
      readonly state: "missing";
      readonly path: string;
    }
  | {
      readonly state: "valid";
      readonly path: string;
      readonly value: CodexConfigObject;
    }
  | {
      readonly state: "invalid";
      readonly path: string;
      readonly kind: "path" | "read" | "parse";
      readonly message: string;
    };

function isObject(value: unknown): value is CodexConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isObject(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function objectValue(value: unknown): CodexConfigObject | undefined {
  return isObject(value) ? value : undefined;
}

export function readCodexConfig(codexHomePath: string): CodexConfigReadResult {
  const path = join(codexHomePath, "config.toml");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "missing", path };
    return {
      state: "invalid",
      path,
      kind: "read",
      message: `config.toml 상태를 읽을 수 없습니다: ${errorMessage(error)}`,
    };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return {
      state: "invalid",
      path,
      kind: "path",
      message: "config.toml 경로가 일반 파일이 아닙니다",
    };
  }

  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    return {
      state: "invalid",
      path,
      kind: "read",
      message: `config.toml을 읽을 수 없습니다: ${errorMessage(error)}`,
    };
  }

  try {
    const value = TOML.parse(source);
    if (!isObject(value)) {
      return {
        state: "invalid",
        path,
        kind: "parse",
        message: "config.toml 최상위 값이 테이블이 아닙니다",
      };
    }
    return { state: "valid", path, value };
  } catch (error) {
    return {
      state: "invalid",
      path,
      kind: "parse",
      message: `config.toml TOML 문법이 올바르지 않습니다: ${errorMessage(error)}`,
    };
  }
}
