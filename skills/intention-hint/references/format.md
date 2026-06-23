# Format Rules

Rules for generating intent definition files. The canonical format spec lives in the plugin's `README.md` — this file is the agent-facing summary.

## Required section order

1. YAML frontmatter (`triggers[]`, `examples[]`, required `domain`, optional `fastpath`)
2. `## Guidelines`
3. `## Skills & Tools` (optional)
4. `## Response Strategy`
5. `## Concrete Workflow` (optional)
6. `## Experience` (optional)

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

## Frontmatter routing fields

```yaml
---
triggers:
  - "Concrete user-goal boundary phrase"
examples:
  - "Realistic user message"
domain: "one-domain"
fastpath:
  hint: "Optional short A1 injected hint."
  keywords:
    - "optional exact or fuzzy keyword"
---
```

- `domain` is required and must be one string.
- `fastpath.keywords` is optional. A1 uses it for exact-match only when `fastpath.hint` is present; A2 uses it for domain-scoped keyword similarity even without a hint.
- `fastpath.hint` should be short. It is injected directly on A1 hits instead of the full intent body.

## Concrete Workflow inclusion rule

- **Always include** for multi-step intents (memory-_, system-diagnostics, browser-automation, research-_)
- **Include** when the intent requires a specific sequence
- **Skip** for simple rule-following intents (chat, typo, etc.)
- **Rule of thumb**: if you can describe execution as "Step 1 → Step 2 → ...", add it

## Workflow content rules

- Numbered steps with actionable bullet points
- Include tool call examples inside relevant steps
- Keep steps short — not explanatory prose
- Structure: `### Step N — <name>`

## Experience inclusion rule

- Include only durable lessons that help future turns with the same intent.
- Good entries: reusable tips, parameters, pitfalls, recovery notes, and stable skill/tool lessons.
- Skip one-off transcripts, user-specific secrets, and general knowledge that belongs in active-memory.

## No cross-references

Body must never mention other intents by name or id. The classifier sees frontmatter metadata; fastpaths use `domain` and `fastpath`. See `references/interview.md` for the full rule context.
