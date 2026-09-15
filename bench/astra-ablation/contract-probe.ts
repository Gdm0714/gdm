import { safeText } from "../../cli/src/contract.ts";
import { containsSensitiveRaw } from "../../cli/src/validation-boundary.ts";

// Synthetic natural-language text only; no actual credentials or user memory.
const samples = [
  { id: "ordinary_export_description", text: "A zero export limit returns an empty array", expectedAccepted: true },
  { id: "ordinary_function_description", text: "Use local function contracts", expectedAccepted: true },
  { id: "ordinary_slash_description", text: "Preserve CSV/percentile behavior", expectedAccepted: true },
  { id: "ordinary_requirement", text: "Zero limit returns no rows", expectedAccepted: true },
  { id: "synthetic_credential_control", text: "Bearer SYNTHETIC_NOT_A_REAL_TOKEN", expectedAccepted: false },
];
const result = samples.map(({ id, text, expectedAccepted }) => {
  try {
    safeText(text, "require");
    return { id, expectedAccepted, accepted: true, sensitiveRaw: containsSensitiveRaw(text), error: null };
  } catch (error) {
    return { id, expectedAccepted, accepted: false, sensitiveRaw: containsSensitiveRaw(text), error: error instanceof Error ? error.message : String(error) };
  }
});
console.log(JSON.stringify({
  purpose: "Reproduction of observed benign contract-description rejection; expectedAccepted is the proposed behavior, not the current contract.",
  results: result,
  benignRejections: result.filter(r => r.expectedAccepted && !r.accepted).length,
  credentialControlRejected: !result.find(r => r.id === "synthetic_credential_control")!.accepted,
}, null, 2));
