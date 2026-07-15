const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const QUOTED_OR_STRUCTURED_RE = /["'`{}<>]/u;
const SPEAKER_RE = /^(?:user|assistant|system|human|사용자|어시스턴트|시스템|사람)\s*:/iu;
const CODE_RE = /(?:=>|\(\);|function |class |const |let |var |import |export )/iu;
const DIFF_RE = /(?:diff --git|@@|--- |\+\+\+ )/iu;
const ABSOLUTE_PATH_RE = /(?:^|[\s(])(?:\/|~(?:\/|$)|[a-z]:[\\/]|\\\\)/iu;
const URI_RE = /(?:^|[^A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:/u;
const DOLLAR_OR_EQUALS_RE = /[$=]/u;
const SECRET_RE = /(?:sk-|ghp_|github_pat_|AKIA|Bearer |BEGIN [A-Z ]*PRIVATE KEY)/iu;
const JWT_RE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const FORBIDDEN_RULE_SEGMENTS = [".obsidian", "obsidian", "session", "sessions"] as const;

export function containsSensitiveRaw(value: string): boolean {
  return (
    CONTROL_RE.test(value) ||
    QUOTED_OR_STRUCTURED_RE.test(value) ||
    SPEAKER_RE.test(value) ||
    CODE_RE.test(value) ||
    DIFF_RE.test(value) ||
    ABSOLUTE_PATH_RE.test(value) ||
    URI_RE.test(value) ||
    DOLLAR_OR_EQUALS_RE.test(value) ||
    SECRET_RE.test(value) ||
    JWT_RE.test(value)
  );
}

export function isCanonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return RFC3339_RE.test(value) && !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function isSafeContainedRuleReference(value: string): boolean {
  if (value.length === 0 || value.length > 240 || value.trim() !== value || value.includes("\\")) return false;
  if (containsSensitiveRaw(value)) return false;
  const parts = value.split("/");
  return parts.every(
    (part) =>
      part.length > 0 &&
      part !== "." &&
      part !== ".." &&
      !FORBIDDEN_RULE_SEGMENTS.some((forbidden) => forbidden === part.toLowerCase()),
  );
}
