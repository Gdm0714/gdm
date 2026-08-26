import { patchVerificationPlanSourceFingerprint } from "./store.ts";

/**
 * Persist one source-approval field without serializing the normalized Work
 * returned by loadWork. That keeps omitted legacy plan defaults omitted and
 * avoids turning this narrow metadata write into a plan rewrite.
 */
export function saveVerificationPlanSourceFingerprint(
  cwd: string,
  slug: string,
  fingerprint: string,
): void {
  patchVerificationPlanSourceFingerprint(cwd, slug, fingerprint);
}
