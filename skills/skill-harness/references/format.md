# Format Rules

Rules for generating intent definition files. The canonical format spec lives in the plugin's `README.md` — this file is the agent-facing summary.

## Routing-only format

An intent has YAML frontmatter for classification metadata plus a plain-text Markdown body. Required frontmatter fields are `domain`, `triggers[]`, and `examples[]`; the complete body is one `guidance` sentence. Optional routing metadata is `keywords` and direct `skills[]`.

The body is the entire guidance value, not a Markdown document: do not create headings, lists, fences, commands, paths, a `## Skills & Tools` section, workflow text, or experience text. Durable workflows and lessons belong in referenced skills, not intent definitions.

Runtime experience records are host-owned, skill-scoped files under `experiences/`; do not create, edit, or reference them while drafting an intent.

## Frontmatter routing fields

```yaml
---
domain: "memory"
triggers:
  - "The user asks to compare two previously recorded trips."
examples:
  - "How did my recorded Japan trip compare with my Chiayi trip?"
keywords:
  - "optional exact keyword"
skills:
  - "optional-skill-name"
---
Route this request to the declared skills and follow the bounded routing context.
```

- `domain` is required and must be one string.
- `skills` is optional and must be a list of exact skill names. Use it only for skills the intent should load or strongly prefer.
- The complete plain-text body is required guidance, one durable routing-behavior sentence shared across keyword, QMD trigger, and classified routes.
- `keywords` is optional short phrases for Step 1 QMD keyword BM25 retrieval; never place a hint or workflow body here.

## Skills metadata rule

- Put skill dependencies in frontmatter `skills[]`.
- List only skills that directly help this routing outcome.
- Do not put a skill list, tool instructions, commands, workflow text, or experience text in the guidance body.

## No cross-references

Intent metadata must not mention other intents by name or id. The classifier sees frontmatter metadata; Step 1 routing uses `keywords`. See `references/interview.md` for the full rule context.
