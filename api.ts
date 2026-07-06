export {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";

import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
export const logger = createSubsystemLogger("plugins/skill-harness");
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
