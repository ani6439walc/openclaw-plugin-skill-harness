import { canonicalIdentity } from "../normalize.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return no authority when the complete runtime agent registry is unavailable. */
export function activeAgentIdsFromConfig(
  config: unknown,
  workingSetAgentIds: readonly string[],
): string[] | undefined {
  if (!isRecord(config) || !isRecord(config.agents)) return undefined;
  const entries = config.agents.entries;
  if (!isRecord(entries)) return undefined;
  const ids = new Set(["main"]);
  for (const [id, entry] of Object.entries(entries)) {
    const normalized = canonicalIdentity(id);
    if (!normalized || !isRecord(entry)) return undefined;
    ids.add(normalized);
  }
  for (const id of workingSetAgentIds) {
    const normalized = canonicalIdentity(id);
    if (normalized) ids.add(normalized);
  }
  return [...ids];
}
