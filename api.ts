export {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";

import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
export const logger = createSubsystemLogger("plugins/intention-hint");
export type { OpenClawConfig } from "openclaw/plugin-sdk";
export { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
