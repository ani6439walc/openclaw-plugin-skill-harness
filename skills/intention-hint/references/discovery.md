# Discovery — Capability Inventory

Goal: Build a complete inventory of all actionable capabilities.

## Actions

1. **Scan skills:**
   ```bash
   ls -1 ~/.openclaw/skills/ && for d in ~/.openclaw/skills/*/; do [ -f "$d/SKILL.md" ] && basename "$d"; done
   ```
   Read each `SKILL.md` frontmatter (`name`, `description`) to extract capability summaries.

2. **Scan tool schema:** Review currently available tool schemas to list built-in tools (exec, web_search, web_fetch, memory_search, etc.).

3. **Scan existing intents:**
   ```bash
   ls ~/.openclaw/extensions/intention-hint/intents/
   ```
   To see what intent coverage already exists.

4. **Read format rules:** Read `extensions/intention-hint/README.md` to refresh intent format rules.

## Output

Table with columns: `capability | type(skill/tool) | summary | source`.

## Validation

- Skill count matches the actual directory.
- Every tool schema is listed.
- Proceed to clustering only after inventory is complete and verified.
