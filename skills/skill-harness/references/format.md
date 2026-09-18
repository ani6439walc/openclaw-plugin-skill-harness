# Format Rules

Rules for generating intent definition files. The canonical format spec lives in the plugin's `README.md` — this file is the agent-facing summary.

## Routing-only format

An intent has YAML frontmatter for classification metadata plus a plain-text Markdown body. Required frontmatter fields are `triggers[]` and `examples[]`; the complete body is one `guidance` sentence. Optional routing metadata is `keywords` and direct `skills[]`.

The body is the entire guidance value, not a Markdown document: do not create headings, lists, fences, commands, paths, a `## Skills & Tools` section, workflow text, or experience text. Durable workflows and lessons belong in referenced skills, not intent definitions.

Runtime experience records are host-owned, skill-scoped files under `experiences/`; do not create, edit, or reference them while drafting an intent.

## Frontmatter routing fields

```yaml
---
triggers:
  - "The user asks to compare two previously recorded trips."
examples:
  - "How did my recorded Japan trip compare with my Chiayi trip?"
keywords:
  - "optional short phrase"
skills:
  - "optional-skill-name"
---
Route this request to the declared skills and follow the bounded routing context.
```

Frontmatter keys must follow this fixed canonical order:

1. `triggers` (required, array of full descriptive sentences)
2. `examples` (required, array of realistic user message sentences)
3. `keywords` (optional, array of exact/short phrases for Step 1 BM25)
4. `skills` (optional, array of exact skill names in lowercase)

- `skills` is optional and must be a list of exact skill names written strictly in lowercase. Use it only for skills the intent should load or strongly prefer.
- The complete plain-text body is required guidance, one durable routing-behavior sentence shared across QMD keyword, QMD hybrid, and classifier routes.
- `keywords` is optional short phrases for Step 1 QMD keyword BM25 retrieval; never place a hint or workflow body here.

## Skills metadata rule

- Put skill dependencies in frontmatter `skills[]` written strictly in lowercase.
- List only skills that directly help this routing outcome.
- Do not put a skill list, tool instructions, commands, workflow text, or experience text in the guidance body.

## No cross-references

Intent metadata must not mention other intents by name or id. The classifier sees frontmatter metadata; Step 1 routing uses `keywords`. See `references/interview.md` for the full rule context.

## Runtime prompt format

At prompt construction time, the plugin compiles the matched intent and relevant skills into a compact structure:

```text
Inferred intent and relevant skills (advisory, non-user input; load with `skill_view` if relevant):
<skill_harness_plugin>
  <intent name="intent-id">
    One durable plain-text routing guidance sentence.
  </intent>
  <matched_skills>
    <skill name="skill-name">
      Skill description
      <skill_experience>
        <identity>experience-id</identity>
        <keywords>["tag1", "tag2"]</keywords>
      </skill_experience>
    </skill>
  </matched_skills>
</skill_harness_plugin>
```

Key rules of the runtime format:

- Dynamic context is introduced by a concise single-line advisory header (`Inferred intent and relevant skills (advisory, non-user input; load with \`skill_view\` if relevant):`when intent and skills exist,`Inferred relevant skills from conversation (advisory, non-user input; load with \`skill_view\` if relevant):`when skills-only, or`Inferred user intent from conversation (advisory, non-user input):`when intent-only) directly preceding`<skill_harness_plugin>`.
- `<intent name="${intent}">` combines intent identity and guidance in one tag.
- `<matched_skills>` contains the skills selected for the turn. `<skill name="${name}">` encapsulates skill identity and description. File paths are omitted from both matched skills and static `<working_set_skills>` to save prompt tokens; agents inspect `path` dynamically via `skill_list` or `skill_view`.
- `<context_policy>` is omitted.

The current renderer emits no candidate-skills header or `<skill_candidates>` wrapper. Those retired forms are historical sanitizer-only input: conversation sanitization strips them from retained assembled text, but no new prompt may emit them.
