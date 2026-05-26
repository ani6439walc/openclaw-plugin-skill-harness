import {
  definePluginEntry,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "../api.js";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveConfig } from "./config.js";
import { defaultCatalog } from "./intent-loader.js";
import { createHookHandlers, type HookDeps } from "./hooks.js";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export function createPlugin(api: OpenClawPluginApi) {
  let config = resolveConfig(api.pluginConfig);

  const refreshLiveConfigFromRuntime = () => {
    const livePluginConfig = resolveLivePluginConfigObject(
      api.runtime.config?.current
        ? () => api.runtime.config.current() as OpenClawConfig
        : undefined,
      "intention-hint",
      api.pluginConfig as Record<string, unknown>,
    );
    config = resolveConfig(livePluginConfig ?? {});
  };

  const refreshIntents = () => {
    const dir = config.intentsDir;
    if (dir) {
      defaultCatalog.load(dir);
    } else {
      defaultCatalog.reset();
    }
  };

  const deps: HookDeps = {
    api,
    config: () => config,
    refreshLiveConfigFromRuntime,
    refreshIntents,
  };

  const handlers = createHookHandlers(deps);

  return definePluginEntry({
    id: "intention-hint",
    name: "Intention Hint",
    description:
      "Pre-scans user intent before replies and injects routing hints via before_prompt_build hook.",
    register() {
      // Calculate plugin root from current file location (dist/src/)
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const pluginRoot = join(currentDir, "..", "..");

      // Create sessions folder if it doesn't exist
      const sessionsDir = join(pluginRoot, "sessions");
      if (!existsSync(sessionsDir)) {
        mkdirSync(sessionsDir, { recursive: true });
      }

      refreshLiveConfigFromRuntime();
      refreshIntents();

      api.on("before_prompt_build", handlers.onBeforePromptBuild, {
        timeoutMs: config.timeoutMs * 1.1 + 500,
      });
      api.on("agent_end", handlers.onAgentEnd);
      api.on("after_tool_call", handlers.onAfterToolCall);
    },
  });
}
