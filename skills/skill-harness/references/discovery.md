# Discovery — Capability Inventory

Goal: Build a complete inventory of all actionable capabilities.

## Actions

1. **Scan skills:**

   ```bash
   ls -1 ~/.openclaw/skills/ && for d in ~/.openclaw/skills/*/; do [ -f "$d/SKILL.md" ] && basename "$d"; done
   ```

   Read each `SKILL.md` frontmatter (`name`, `description`) to extract capability summaries.

2. **Scan tool schema:** List currently available tools by running:

   ```bash
   # List tool schemas from OpenClaw config
   cat ~/.openclaw/config.yaml | grep -A 50 "tools:" || echo "Check OpenClaw dashboard for tool list"
   ```

   Alternatively, review the tool documentation in OpenClaw's built-in help or dashboard to enumerate: exec, web_search, web_fetch, memory_search, browser, image_generate, etc.

3. **Scan existing intents:**

   ```bash
   ls ~/.openclaw/plugins/skill-harness/intents/
   ```

   To see what intent coverage already exists.

4. **Read format rules:** Read `references/format.md` (this directory) to refresh intent format rules.

## Output

Table with columns: `capability | type(skill/tool) | summary | source`.

## Validation

- Skill count matches the actual directory.
- Every tool schema is listed.
- Proceed to clustering only after inventory is complete and verified.
