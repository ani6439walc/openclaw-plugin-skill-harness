# Discovery — Capability Inventory

Goal: Build a complete inventory of all actionable capabilities.

## Actions

1. **Scan skills:** Inventory every active skill source exposed by the current environment: bundled extension skills, configured user/runtime skill directories, and the active OpenClaw skill catalog when available. Read each `SKILL.md` frontmatter (`name`, `description`) before deep-reading bodies.

2. **Scan tool schema:** List currently available tools from the runtime catalog, config, built-in help, or dashboard. Record user-visible capabilities such as exec, web search/fetch, memory search, browser, or image generation only when they are actually available.

3. **Scan existing intents:** Use structured file/search tools to list and inspect runtime intent Markdown in the active OpenClaw-resolved catalog. With the default local state directory, this is `~/.openclaw/plugins/skill-harness/intents/`. This shows what intent coverage already exists.

4. **Read format rules:** Read `references/format.md` (this directory) to refresh intent format rules.

## Output

Table with columns: `capability | type(skill/tool) | summary | source`.

## Validation

- Skill count matches the actual directory.
- Every tool schema is listed.
- Proceed to clustering only after inventory is complete and verified.
