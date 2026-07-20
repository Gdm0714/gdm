import { GdmError } from "./state.ts";

export function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index >= 0) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new GdmError(`--${name} 값이 필요합니다`, "usage");
    }
    return value;
  }
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

export function requiredFlag(args: string[], name: string): string {
  const value = readFlag(args, name);
  if (value === undefined) throw new GdmError(`--${name} 값이 필요합니다`, "usage");
  return value;
}

export function readFlags(args: string[], name: string): readonly string[] {
  const values: string[] = [];
  const token = `--${name}`;
  const prefix = `${token}=`;
  for (let index = 0; index < args.length; index++) {
    const current = args[index];
    if (current === token) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new GdmError(`${token} 값이 필요합니다`, "usage");
      }
      values.push(value);
      index++;
    } else if (current?.startsWith(prefix)) {
      values.push(current.slice(prefix.length));
    }
  }
  return values;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

export function ensureFlags(args: string[], value: string[], bool: string[] = []): void {
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(2, equals) : token.slice(2);
    if (value.includes(name)) {
      if (equals < 0) index++;
      continue;
    }
    if (bool.includes(name)) {
      if (equals >= 0) throw new GdmError(`--${name}는 값을 받지 않습니다`, "usage");
      continue;
    }
    const known = [...value, ...bool].map((flag) => `--${flag}`).join(", ") || "없음";
    throw new GdmError(`알 수 없는 플래그: --${name} (가능: ${known})`, "usage");
  }
}
