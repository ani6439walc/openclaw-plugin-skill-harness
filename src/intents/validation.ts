import { validateRoutingIntentDirectory } from "./routing-validation.js";

export type IntentValidationResult = {
  valid: boolean;
  errors: string[];
  intents: Array<{ id: string; file: string }>;
};

// Preserve the pre-routing-validation public contract for downstream callers.
export function validateIntentDirectory(
  intentDirectory: string,
  targetIntentIds: readonly string[] = [],
): IntentValidationResult {
  const result = validateRoutingIntentDirectory(
    intentDirectory,
    targetIntentIds,
  );
  return {
    valid: result.valid,
    errors: result.errors,
    intents: result.intents.map(({ id, file }) => ({ id, file })),
  };
}
