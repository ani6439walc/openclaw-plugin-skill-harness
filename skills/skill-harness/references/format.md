# Format Rules

Rules for generating intent definition files. The canonical format spec lives in the plugin's `README.md` — this file is the agent-facing summary.

## Routing-only format

An intent is YAML frontmatter only. Required fields are `domain`, `triggers[]`, `examples[]`, and one `guidance` sentence. Optional routing metadata is `fastpath.keywords`, `candidate`, and direct `skills[]`.

Do not create Markdown body sections, a `## Skills & Tools` section, workflow text, or experience text. Durable workflows and lessons belong in referenced skills, not intent definitions.

## Frontmatter routing fields

```yaml
---
domain: "memory"
triggers:
  - "The user asks to compare two previously recorded trips."
examples:
  - "How did my recorded Japan trip compare with my Chiayi trip?"
fastpath:
  keywords:
    - "optional exact keyword"
candidate:
  scope: "cross-flow"
  keywords:
    - "optional manual exact projection phrase"
skills:
  - "optional-skill-name"
guidance: "Route this request to the declared skills and follow the bounded routing context."
---
```

- `domain` is required and must be one string.
- `skills` is optional and must be a list of exact skill names. Use it only for skills the intent should load or strongly prefer.
- `guidance` is required, one durable routing-behavior sentence, and is shared by exact, inherited, and classified routes.
- `fastpath.keywords` is optional exact-match evidence. It does not contain a hint or workflow body.
- `candidate` is optional classifier-projection metadata. `candidate.scope`, when present, must be `cross-flow`; use it only when the intent must remain available across unrelated domains.
- `candidate.keywords` are manual exact projection evidence, not fastpaths and not body guidance. Normalize/deduplicate for matching with NFKC, locale-independent lowercasing, and collapsed whitespace without rewriting source text or treating hyphens and underscores as aliases. Require durable telemetry or labeled evidence plus positive-match and collision fixtures; never infer them from one session.

## Skills metadata rule

- Put skill dependencies in frontmatter `skills[]`.
- List only skills that directly help this routing outcome.
- Do not duplicate a skill list, tool instructions, commands, workflow text, or experience text in an intent body because bodies are unsupported.

## No cross-references

Intent metadata must not mention other intents by name or id. The classifier sees frontmatter metadata; fastpaths use `domain` and `fastpath`. See `references/interview.md` for the full rule context.
