# Format Rules

Rules for generating intent definition files. The canonical format spec lives in the plugin's `README.md` — this file is the agent-facing summary.

## Routing-only format

An intent has YAML frontmatter for classification metadata plus a plain-text Markdown body. Required frontmatter fields are `domain`, `triggers[]`, and `examples[]`; the complete body is one `guidance` sentence. Optional routing metadata is `fastpath.keywords`, `candidate`, and direct `skills[]`.

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
fastpath:
  keywords:
    - "optional exact keyword"
candidate:
  scope: "cross-flow"
skills:
  - "optional-skill-name"
---
Route this request to the declared skills and follow the bounded routing context.
```

- `domain` is required and must be one string.
- `skills` is optional and must be a list of exact skill names. Use it only for skills the intent should load or strongly prefer.
- The complete plain-text body is required guidance, one durable routing-behavior sentence shared by exact, inherited, and classified routes.
- `fastpath.keywords` is optional whole-message exact-match evidence. The same values also populate the domain-scoped lexical QMD topic-keyword collection, so use only durable short phrases appropriate for both routes; never place a hint or workflow body here.
- `candidate` is optional classifier-projection metadata. `candidate.scope`, when present, must be `cross-flow`; use it only when the intent must remain available across unrelated domains.
- The schema still accepts `candidate.keywords` for catalog compatibility, but current QMD candidate projection does not consume it. Do not add new `candidate.keywords` entries.

## Skills metadata rule

- Put skill dependencies in frontmatter `skills[]`.
- List only skills that directly help this routing outcome.
- Do not put a skill list, tool instructions, commands, workflow text, or experience text in the guidance body.

## No cross-references

Intent metadata must not mention other intents by name or id. The classifier sees frontmatter metadata; fastpaths use `domain` and `fastpath`. See `references/interview.md` for the full rule context.
