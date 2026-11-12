import type { OpenClawConfig } from "../api.js";
import { isRecord } from "./guards.js";

/** Read only this plugin's block from an injected host snapshot. */
export function readPluginConfig(
  snapshot: OpenClawConfig | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  const entries = snapshot?.plugins?.entries;
  if (!isRecord(entries)) return;

  let pluginConfig: unknown;
  for (const [key, entry] of Object.entries(entries)) {
    if (key.trim().toLowerCase() !== pluginId) continue;
    // Match host normalization: later aliases retain omitted config, but an
    // explicit config (including empty/invalid values) replaces the old value.
    if (!isRecord(entry)) pluginConfig = undefined;
    else if ("config" in entry) pluginConfig = entry.config;
  }
  return isRecord(pluginConfig) ? pluginConfig : undefined;
}
