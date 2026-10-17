import { definePluginEntry } from "./api.js";
import { createPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "skill-harness",
  name: "Skill Harness",
  description:
    "Discovers relevant skills and experiences before replies and injects routing context via before_prompt_build hook.",
  register(api) {
    const plugin = createPlugin(api);
    plugin.register(api);
  },
});
