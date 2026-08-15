import { validateRoutingIntentDirectory } from "./routing-validation.js";

export type IntentValidationResult = {
  valid: boolean;
  errors: string[];
  intents: Array<{ id: string; file: string }>;
};

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
