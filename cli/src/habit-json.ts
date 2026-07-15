import { assertNoSensitiveRaw, privacyError } from "./contract.ts";

export function scanJsonStringTokens(raw: string, field: string): void {
  let cursor = 0;
  while (cursor < raw.length) {
    if (raw[cursor] !== "\"") {
      cursor++;
      continue;
    }
    const start = cursor;
    cursor++;
    let escaped = false;
    while (cursor < raw.length) {
      const character = raw[cursor];
      if (character === "\"" && !escaped) break;
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
      cursor++;
    }
    if (cursor >= raw.length) throw privacyError(field);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw.slice(start, cursor + 1));
    } catch {
      throw privacyError(field);
    }
    if (typeof decoded !== "string") throw privacyError(field);
    assertNoSensitiveRaw(decoded, field);
    cursor++;
  }
}

export function parsePrivacyJson(raw: string, field: string): unknown {
  scanJsonStringTokens(raw, field);
  try {
    return JSON.parse(raw);
  } catch {
    throw privacyError(field);
  }
}

// gdm이 스스로 만든 진단 필드. 명령 출력·편집 patch가 담겨 개행·따옴표·`=`가
// 정상적으로 섞인다 — foreign secret이 아니므로 수확 스캔에서만 면제한다.
const HARVEST_DIAGNOSTIC_KEYS = new Set(["message", "patch"]);

function isJsonWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

// parsePrivacyJson과 같은 원문 토큰 스캔이되, 위 진단 키의 값(및 하위 트리)만
// 민감 스캔에서 제외한다. desc/reason/미지 필드와 중복 키 방어는 그대로 유지된다.
function scanHarvestTokens(raw: string, field: string): void {
  let cursor = 0;
  let depth = 0;
  let exemptDepth = -1;
  let pendingKey: string | null = null;
  while (cursor < raw.length) {
    const character = raw[cursor];
    if (character === "\"") {
      const start = cursor;
      cursor++;
      let escaped = false;
      while (cursor < raw.length) {
        const inner = raw[cursor];
        if (inner === "\"" && !escaped) break;
        escaped = inner === "\\" && !escaped;
        cursor++;
      }
      if (cursor >= raw.length) throw privacyError(field);
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw.slice(start, cursor + 1));
      } catch {
        throw privacyError(field);
      }
      if (typeof decoded !== "string") throw privacyError(field);
      cursor++;
      let look = cursor;
      while (look < raw.length && isJsonWhitespace(raw[look])) look++;
      if (raw[look] === ":") {
        assertNoSensitiveRaw(decoded, field);
        pendingKey = decoded;
      } else {
        const exempt = exemptDepth >= 0 || (pendingKey !== null && HARVEST_DIAGNOSTIC_KEYS.has(pendingKey));
        if (!exempt) assertNoSensitiveRaw(decoded, field);
        pendingKey = null;
      }
      continue;
    }
    if (character === "{" || character === "[") {
      depth++;
      if (exemptDepth < 0 && pendingKey !== null && HARVEST_DIAGNOSTIC_KEYS.has(pendingKey)) {
        exemptDepth = depth;
      }
      pendingKey = null;
    } else if (character === "}" || character === "]") {
      depth--;
      if (exemptDepth >= 0 && depth < exemptDepth) exemptDepth = -1;
      pendingKey = null;
    } else if (character === ",") {
      pendingKey = null;
    }
    cursor++;
  }
}

export function parseHarvestJson(raw: string, field: string): unknown {
  scanHarvestTokens(raw, field);
  try {
    return JSON.parse(raw);
  } catch {
    throw privacyError(field);
  }
}
