import type { OpenClawPluginApi } from "./api.js";
import { createPlugin } from "./src/plugin.js";

export default {
  id: "skill-harness",
  name: "Skill Harness",
  description:
    "Pre-scans user intent before replies and injects routing hints via before_prompt_build hook.",
  register(api: OpenClawPluginApi) {
    const plugin = createPlugin(api);
    plugin.register(api);
  },
};
