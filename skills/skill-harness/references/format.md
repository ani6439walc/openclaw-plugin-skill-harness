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

Frontmatter keys must follow this fixed canonical order:

1. `domain` (required, single string)
2. `triggers` (required, array of full descriptive sentences)
3. `examples` (required, array of realistic user message sentences)
4. `keywords` (optional, array of exact/short phrases for Step 1 BM25)
5. `skills` (optional, array of exact skill names in lowercase)

- `domain` is required and must be one string.
- `skills` is optional and must be a list of exact skill names written strictly in lowercase. Use it only for skills the intent should load or strongly prefer.
- The complete plain-text body is required guidance, one durable routing-behavior sentence shared across keyword, QMD trigger, and classified routes.
- `keywords` is optional short phrases for Step 1 QMD keyword BM25 retrieval; never place a hint or workflow body here.

## Skills metadata rule

- Put skill dependencies in frontmatter `skills[]` written strictly in lowercase.
- List only skills that directly help this routing outcome.
- Do not put a skill list, tool instructions, commands, workflow text, or experience text in the guidance body.

## No cross-references

Intent metadata must not mention other intents by name or id. The classifier sees frontmatter metadata; Step 1 routing uses `keywords`. See `references/interview.md` for the full rule context.

## Runtime prompt format

At prompt construction time, the plugin compiles the matched intent and candidate skills into a compact structure:

```text
<<<BEGIN_SKILL_HARNESS_CONTEXT>>>
Skill Harness context (advisory, non-user input):
When relevant, load candidate skills with `skill_view` before proceeding:
<skill_harness_plugin>
  <intent name="intent-id">
    One durable plain-text routing guidance sentence.
  </intent>
  <skill_candidates>
    <skill name="skill-name">
      Skill description
      <skill_experience>
        <identity>experience-id</identity>
        <keywords>tag1, tag2</keywords>
      </skill_experience>
    </skill>
  </skill_candidates>
</skill_harness_plugin>
<<<END_SKILL_HARNESS_CONTEXT>>>
```

Key rules of the runtime format:

- Dynamic context is enclosed in `<<<BEGIN_SKILL_HARNESS_CONTEXT>>>` and `<<<END_SKILL_HARNESS_CONTEXT>>>` with the `Skill Harness context (advisory, non-user input):` header and conditional `When relevant, load candidate skills with \`skill_view\` before proceeding:` guidance.
- `<intent name="${intent}">` combines intent identity and guidance in one tag.
- `<skill name="${name}">` encapsulates skill identity and description. File paths are omitted from both candidate skills and static `<configured_skills>` to save prompt tokens; agents inspect `path` dynamically via `skill_list` or `skill_view`.
- `<context_policy>` is omitted.
