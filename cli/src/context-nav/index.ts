import {
  ABSOLUTE_MAX_BYTES,
  CONTEXT_PACK_SCHEMA,
  CONTEXT_QUERY_SCHEMA,
  CONTEXT_STATUS_SCHEMA,
  ContextError,
  DEFAULT_MAX_BYTES,
  parseContextQuery,
  type ContextPack,
  type ContextStatus,
} from "./schema.ts";
import { buildContextPack, trustedGitRoot, untrustedPack } from "./query.ts";

export { ContextError } from "./schema.ts";

export function contextStatus(): ContextStatus {
  return {
    schemaVersion: CONTEXT_STATUS_SCHEMA,
    provider: "gdm-local-context",
    version: 1,
    mode: "one-shot",
    cache: "disabled",
    querySchema: CONTEXT_QUERY_SCHEMA,
    packSchema: CONTEXT_PACK_SCHEMA,
    defaultMaxBytes: DEFAULT_MAX_BYTES,
    absoluteMaxBytes: ABSOLUTE_MAX_BYTES,
  };
}

export function runContextQuery(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ContextPack {
  const query = parseContextQuery(raw);
  const root = trustedGitRoot(query.root, env.GDM_CONTEXT_TRUSTED_ROOT);
  if (root === null) return untrustedPack(query);
  try {
    return buildContextPack(query, root);
  } catch (error) {
    if (error instanceof ContextError) throw error;
    throw error;
  }
}
