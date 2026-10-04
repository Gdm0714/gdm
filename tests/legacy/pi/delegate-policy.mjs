export const MAX_CONCURRENT_CHILDREN = 3;
export const MAX_TOTAL_CHILDREN = 8;
export const MAX_TASK_BYTES = 16 * 1024;
export const MAX_OUTPUT_BYTES = 128 * 1024;
export const MAX_EVENT_STREAM_BYTES = 8 * 1024 * 1024;
export const MAX_EVENT_LINE_BYTES = 2 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const DEFAULT_CHILD_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MODEL = "openai-codex/gpt-5.6-terra";
export const DEFAULT_THINKING = "high";

const ROLE_MODELS = {
  scout: { prefix: "SCOUT", model: "openai-codex/gpt-5.6-luna" },
  design: { prefix: "DESIGN", model: "openai-codex/gpt-6-astra" },
  reviewer: { prefix: "REVIEW", model: "openai-codex/gpt-6-astra" },
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ROLE_NAMES = new Set(Object.keys(ROLE_MODELS));
const CREDENTIAL_PATTERNS = [
  /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/iu,
  /\bghp_[A-Za-z0-9]{8,}\b/iu,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/iu,
  /\bAKIA[A-Z0-9]{12,}\b/u,
  /\bBearer\s+\S+/iu,
  /BEGIN [A-Z ]*PRIVATE KEY/iu,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];

function textBytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function validModel(value) {
  return typeof value === "string" && value.length <= 160 &&
    /^[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+$/u.test(value);
}

export function validThinking(value) {
  return typeof value === "string" && THINKING_LEVELS.has(value);
}

export function resolveChildConfiguration(role, env = process.env, thinkingOverride) {
  const defaults = ROLE_MODELS[role];
  if (!defaults) throw new Error("unsupported read-only role");
  const model = env[`GDM_PI_${defaults.prefix}_MODEL`] ?? env.GDM_PI_CHILD_MODEL ?? defaults.model;
  const configuredThinking = env[`GDM_PI_${defaults.prefix}_THINKING`] ?? env.GDM_PI_CHILD_THINKING ?? "medium";
  if (!validModel(model) || !validThinking(configuredThinking)) {
    throw new Error(`invalid ${role} model or thinking configuration`);
  }
  if (thinkingOverride !== undefined && !["medium", "high"].includes(thinkingOverride)) {
    throw new Error("task thinking override must be medium|high");
  }
  return { model, thinking: thinkingOverride ?? configuredThinking };
}

export function childTimeout(value) {
  if (value === undefined || value === "") return DEFAULT_CHILD_TIMEOUT_MS;
  if (!/^[0-9]+$/u.test(value)) return DEFAULT_CHILD_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 15 * 60 * 1000
    ? parsed
    : DEFAULT_CHILD_TIMEOUT_MS;
}

export function credentialSignature(value) {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

export function validateDelegationRequest(params) {
  if (typeof params !== "object" || params === null || !exactKeys(params, ["tasks"])) {
    return "delegate request must contain exactly one tasks field";
  }
  if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
    return "delegate request requires at least one task";
  }
  if (params.tasks.length > MAX_CONCURRENT_CHILDREN) {
    return `delegate request exceeds the ${MAX_CONCURRENT_CHILDREN}-child concurrency limit`;
  }
  for (const [index, task] of params.tasks.entries()) {
    if (typeof task !== "object" || task === null ||
      (!exactKeys(task, ["deliverable", "role", "scope", "task", "verify"]) &&
       !exactKeys(task, ["deliverable", "role", "scope", "task", "thinking", "verify"]))) {
      return `task ${index + 1} must contain exactly role, scope, task, deliverable, verify and optional thinking`;
    }
    if (!ROLE_NAMES.has(task.role)) return `task ${index + 1} has an unsupported read-only role`;
    if (Object.hasOwn(task, "thinking") && !["medium", "high"].includes(task.thinking)) {
      return `task ${index + 1} thinking must be medium|high`;
    }
    for (const field of ["scope", "task", "deliverable", "verify"]) {
      if (typeof task[field] !== "string" || task[field].trim().length === 0) {
        return `task ${index + 1} field ${field} must be nonempty text`;
      }
    }
    const serialized = JSON.stringify(task);
    if (textBytes(serialized) > MAX_TASK_BYTES) {
      return `task ${index + 1} exceeds the ${MAX_TASK_BYTES}-byte limit`;
    }
    if (credentialSignature(serialized)) {
      return `task ${index + 1} contains a credential-shaped value`;
    }
  }
  return null;
}

export class DelegateBudget {
  constructor() {
    this.active = 0;
    this.total = 0;
  }

  reserve(count) {
    if (!Number.isSafeInteger(count) || count < 1) return "delegate count must be a positive integer";
    if (this.active + count > MAX_CONCURRENT_CHILDREN) {
      return `delegate concurrency would exceed ${MAX_CONCURRENT_CHILDREN}`;
    }
    if (this.total + count > MAX_TOTAL_CHILDREN) {
      return `delegate session total would exceed ${MAX_TOTAL_CHILDREN}`;
    }
    this.active += count;
    this.total += count;
    return null;
  }

  release(count) {
    this.active = Math.max(0, this.active - count);
  }

  snapshot() {
    return { active: this.active, total: this.total };
  }
}

export function buildChildArguments({ model, thinking, systemPrompt, task }) {
  if (!validModel(model)) throw new Error("invalid child model");
  if (!validThinking(thinking)) throw new Error("invalid child thinking level");
  return [
    "--mode", "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--tools", "read,grep,find,ls",
    "--system-prompt", systemPrompt,
    "--model", model,
    "--thinking", thinking,
    `Task:\n${task}`,
  ];
}
