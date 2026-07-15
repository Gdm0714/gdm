import { assertNoSensitiveRaw } from "./contract.ts";
import { GdmError } from "./state.ts";

export type FlagGrammar = {
  readonly valued: readonly string[];
  readonly boolean?: readonly string[];
  readonly repeatable?: readonly string[];
};

export function scanHabitArgs(args: readonly string[]): void {
  for (const argument of args) {
    if (!argument.startsWith("--")) {
      assertNoSensitiveRaw(argument, "habit-argument");
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    assertNoSensitiveRaw(name, "habit-flag");
    if (equals >= 0) assertNoSensitiveRaw(argument.slice(equals + 1), "habit-argument");
  }
}

export function readFlag(args: readonly string[], name: string): string | undefined {
  const token = `--${name}`;
  const found = args.indexOf(token);
  if (found >= 0) {
    const value = args[found + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new GdmError("habit 플래그 값이 필요합니다", "usage");
    }
    return value;
  }
  const prefix = `${token}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

export function readFlags(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  const token = `--${name}`;
  const prefix = `${token}=`;
  for (let index = 0; index < args.length; index++) {
    const current = args[index];
    if (current === token) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new GdmError("habit 플래그 값이 필요합니다", "usage");
      }
      values.push(value);
      index++;
    } else if (current?.startsWith(prefix)) {
      values.push(current.slice(prefix.length));
    }
  }
  return values;
}

export function ensureFlags(args: readonly string[], grammar: FlagGrammar): void {
  const booleans = grammar.boolean ?? [];
  const repeatable = grammar.repeatable ?? [];
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === undefined || !token.startsWith("--")) {
      throw new GdmError("habit 명령에 예상하지 않은 위치 인자가 있습니다", "usage");
    }
    const equals = token.indexOf("=");
    const name = token.slice(2, equals < 0 ? undefined : equals);
    const valued = grammar.valued.includes(name);
    if (!valued && !(booleans.includes(name) && equals < 0)) {
      throw new GdmError("알 수 없는 habit 플래그가 있습니다", "usage");
    }
    if (!repeatable.includes(name) && seen.has(name)) {
      throw new GdmError("단일 habit 플래그가 중복됐습니다", "usage");
    }
    seen.add(name);
    if (valued && equals < 0) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new GdmError("habit 플래그 값이 필요합니다", "usage");
      }
      index++;
    }
  }
}

export function requiredFlag(args: readonly string[], name: string): string {
  const value = readFlag(args, name);
  if (value === undefined) throw new GdmError("필수 habit 플래그가 없습니다", "usage");
  return value;
}

export function leadingReference(
  args: readonly string[],
): { readonly reference: string; readonly flags: readonly string[] } {
  const [reference, ...flags] = args;
  if (reference === undefined || reference.startsWith("--")) {
    throw new GdmError("habit reference가 필요합니다", "usage");
  }
  return { reference, flags };
}
