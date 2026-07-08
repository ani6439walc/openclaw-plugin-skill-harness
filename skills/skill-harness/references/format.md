# Format Rules

Rules for generating intent definition files. The canonical format spec lives in the plugin's `README.md` — this file is the agent-facing summary.

## Required section order

1. YAML frontmatter (`triggers[]`, `examples[]`, required `domain`, optional `fastpath`, optional `skills[]`)
2. `## Guidelines`
3. `## Response Strategy`
4. `## Concrete Workflow` (optional)
5. `## Experience` (optional)

Do not create a `## Skills & Tools` section. That section is legacy-only; migrate any skill names into frontmatter `skills[]` and move durable operational guidance into `## Experience`.

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
skills:
  - "optional-skill-name"
---
```

- `domain` is required and must be one string.
- `skills` is optional and must be a list of exact skill names. Use it only for skills the intent should load or strongly prefer.
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

## Skills metadata rule

- Put skill dependencies in frontmatter `skills[]`.
- Do not duplicate the same skill list in the body.
- When mentioning skills in `## Experience`, use this phrasing:

  ```markdown
  - Use `treemd` skill when a large Markdown document needs section-level navigation.
  ```

- Do not write `Use \`treemd\` when ...`; include the word `skill` after the skill name.
- If a previous `## Skills & Tools` section said what a skill should do, rewrite that guidance as durable experience instead of preserving the section.

## Tool guidance rule

- Concrete tool call examples belong in `## Concrete Workflow` when the execution sequence requires them.
- `## Experience` should usually describe the capability rather than the tool name:
  - Prefer: `Use semantic memory search as the primary retrieval path...`
  - Avoid: `Use \`memory_search\` as the primary retrieval path...`
- Keep concrete tool names in `## Experience` only when the name itself is the durable lesson and abstraction would make the guidance less useful.

## Command guidance rule

- If legacy guidance contains a concrete shell command or a concrete MCP call with a stable CLI equivalent, preserve the executable command in `## Experience` as a bare shell command.
- Do not wrap commands in `exec({ command: ... })` or describe them as generic "local validation or command execution" guidance.
- For mcporter-backed documentation calls such as Context7, DeepWiki, or GoogleDeveloperKnowledge, add `mcporter` to frontmatter `skills[]` and write the CLI command directly:

  ```markdown
  - Resolve a library name to a Context7 id before querying docs:
    `mcporter call bifrost.Context7-resolve-library-id libraryName="<library>" query="<question>" --output json`
  - Query Google developer documentation for product-specific claims:
    `mcporter call bifrost.GoogleDeveloperKnowledge-answer_query query="<question>" --output json`
  ```

## Experience inclusion rule

- Include only durable lessons that help future turns with the same intent.
- Good entries: reusable tips, parameters, pitfalls, recovery notes, skill usage rules, and stable tool-agnostic operational lessons.
- Skip one-off transcripts, user-specific secrets, and general knowledge that belongs in active-memory.

## No cross-references

Body must never mention other intents by name or id. The classifier sees frontmatter metadata; fastpaths use `domain` and `fastpath`. See `references/interview.md` for the full rule context.
