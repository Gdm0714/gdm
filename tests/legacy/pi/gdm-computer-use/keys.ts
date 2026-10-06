export type Modifier = "cmd" | "shift" | "alt" | "ctrl";

const namedKeys: Readonly<Record<string, number>> = {
  backspace: 0xff08,
  tab: 0xff09,
  return: 0xff0d,
  enter: 0xff0d,
  escape: 0xff1b,
  esc: 0xff1b,
  delete: 0xffff,
  home: 0xff50,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  pageup: 0xff55,
  pagedown: 0xff56,
  end: 0xff57,
  space: 0x20,
  f1: 0xffbe,
  f2: 0xffbf,
  f3: 0xffc0,
  f4: 0xffc1,
  f5: 0xffc2,
  f6: 0xffc3,
  f7: 0xffc4,
  f8: 0xffc5,
  f9: 0xffc6,
  f10: 0xffc7,
  f11: 0xffc8,
  f12: 0xffc9,
};

const modifierKeys: Readonly<Record<Modifier, number>> = {
  shift: 0xffe1,
  ctrl: 0xffe3,
  alt: 0xffe9,
  cmd: 0xffeb,
};

export function keysymForNamedKey(name: string): number {
  const normalized = name.toLowerCase();
  if (normalized.length === 1 && normalized.charCodeAt(0) >= 0x20 && normalized.charCodeAt(0) <= 0x7e) {
    return normalized.charCodeAt(0);
  }
  const keysym = namedKeys[normalized];
  if (keysym === undefined) throw new Error(`Unsupported guest key: ${name}`);
  return keysym;
}

export function keysymForModifier(modifier: Modifier): number {
  return modifierKeys[modifier];
}

export function keysymsForText(text: string): readonly number[] {
  if (text.length === 0 || text.length > 2000) throw new Error("Guest text must contain 1 to 2000 characters");
  const output: number[] = [];
  for (const character of text) {
    const codepoint = character.codePointAt(0)!;
    if (character === "\n") output.push(namedKeys.return!);
    else if (character === "\t") output.push(namedKeys.tab!);
    else if (codepoint >= 0x20 && codepoint <= 0x7e) output.push(codepoint);
    else throw new Error("Stage 1 guest typing supports printable ASCII, newline, and tab only");
  }
  return output;
}

export function normalizeModifiers(input: readonly string[] | undefined): readonly Modifier[] {
  if (!input) return [];
  const seen = new Set<Modifier>();
  for (const item of input) {
    if (item !== "cmd" && item !== "shift" && item !== "alt" && item !== "ctrl") {
      throw new Error(`Unsupported guest modifier: ${item}`);
    }
    seen.add(item);
  }
  return [...seen];
}
