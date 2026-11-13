export {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";

import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export interface PluginSubsystemLogger {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

// Muted cyan/teal blue (38;5;74 from 256-color palette)
export const LOG_PREFIX = "\x1b[38;5;74mskill-harness:\x1b[0m";

let backendLogger: PluginSubsystemLogger = createSubsystemLogger("plugins");

function formatPrefixed(message: string): string {
  return message.startsWith(LOG_PREFIX) ? message : `${LOG_PREFIX} ${message}`;
}

export const logger: PluginSubsystemLogger = {
  trace(message: string): void {
    backendLogger.trace(formatPrefixed(message));
  },
  debug(message: string): void {
    backendLogger.debug(formatPrefixed(message));
  },
  info(message: string): void {
    backendLogger.info(formatPrefixed(message));
  },
  warn(message: string): void {
    backendLogger.warn(formatPrefixed(message));
  },
};

export interface ExternalApiLogger extends Partial<
  OpenClawPluginApi["logger"]
> {
  trace?: (message: string) => void;
}

export function setApiLogger(apiLogger: ExternalApiLogger): void {
  const defaultLogger = createSubsystemLogger("plugins");
  backendLogger = {
    trace: (msg) =>
      apiLogger.trace ? apiLogger.trace(msg) : defaultLogger.trace(msg),
    debug: (msg) =>
      apiLogger.debug ? apiLogger.debug(msg) : defaultLogger.debug(msg),
    info: (msg) =>
      apiLogger.info ? apiLogger.info(msg) : defaultLogger.info(msg),
    warn: (msg) =>
      apiLogger.warn ? apiLogger.warn(msg) : defaultLogger.warn(msg),
  };
}

export function resetApiLogger(): void {
  backendLogger = createSubsystemLogger("plugins");
}

export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
