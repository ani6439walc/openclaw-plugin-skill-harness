# Format Rules

Rules for generating intent definition files. Source of truth: `extensions/intention-hint/README.md`.

## Required section order

1. YAML frontmatter (`id`, `name`, `enabled: true`, `triggers[]`, `examples[]`)
2. Detected intent detection line
3. `## Guidelines`
4. `## Skills & Tools`
5. `## Response Strategy`
6. `## Concrete Workflow` (optional)

## Skill hint format

```markdown
- Read a large Markdown document by section:
  skill: treemd
```

- Description and skill on the same list item, separated by colon.
- Skill line indented two spaces under the list item.

## Tool call format

```markdown
- Search recorded memory:
  memory_search({ query: "<keywords>", corpus: "memory", maxResults: 5 })
```

## Concrete Workflow inclusion rule

- **Always include** for multi-step intents (memory-*, system-diagnostics, browser-automation, research-*)
- **Include** when the intent requires a specific sequence
- **Skip** for simple rule-following intents (chat, typo, etc.)
- **Rule of thumb**: if you can describe execution as "Step 1 → Step 2 → ...", add it

## Workflow content rules

- Numbered steps with actionable bullet points
- Include tool call examples inside relevant steps
- Keep steps short — not explanatory prose
- Structure: `### Step N — <name>`

## No cross-references

Body must never mention other intents by name or id. Classification sub-agent only sees frontmatter (triggers + examples).
