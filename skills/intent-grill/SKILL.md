---
name: intent-grill
description: Interview the user to create or refine a new intention-hint-plugin intent definition that follows the project's README intent rules. Use when the user wants to add a new intent, rename an intent, split or merge intent boundaries, or design triggers/examples/body structure for an intent file.
---

Interview the user to define one new intent at a time for the intention-hint plugin.

Use the project's intent rules in `extensions/intention-hint/README.md` as the source of truth for:

- frontmatter vs body responsibilities
- trigger and example scope
- body structure
- memory-family escalation and boundary rules when relevant

Ask questions one at a time.

For each question:

- explain briefly why the decision matters
- give your recommended answer or default
- wait for the user's reply before moving on

Your job is to help the user converge on a clean intent definition, not to brainstorm endlessly.

## Opening decision tree

At the start of the interview, first classify the user's request into one of these paths:

1. create a brand-new intent
2. rename an existing intent
3. split an overloaded intent into smaller ones
4. merge two overlapping intents
5. refine an existing intent without renaming it

If the path is ambiguous, ask a single routing question first.
For that opening question:

- explain why the path matters
- recommend the most likely path
- then continue the interview using that path as the frame

## Interview goals

Reach a shared decision on these fields in order:

1. intent purpose and boundary
2. best name and `id`
3. filename
4. `triggers`
5. `examples`
6. body scope
7. skills or tools worth hinting
8. whether the intent overlaps with an existing one and should instead be split, merged, or renamed

## Interview rules

- Ask only one question at a time.
- If the answer can be grounded by reading the current `README.md` or existing `intents/*.md`, do that instead of asking a vague question.
- Prefer narrowing scope over making a broad catch-all intent.
- If the user is really describing an existing intent, say so directly.
- If two intents are colliding, recommend the smallest clean split.
- Do not write the final intent file until the user has answered enough to make the boundary clear.

## Closing mode

When enough information is collected, stop asking discovery questions and switch into closing mode.

In closing mode, produce these sections in order:

1. boundary summary
2. recommended `id`, `name`, and filename
3. collision warning, if the proposed intent still overlaps an existing one
4. final draft intent file

The boundary summary should explain:

- what this intent should handle
- what it should not handle
- which neighboring intents it is closest to

If the proposed design is still too broad or collides badly with an existing intent, do not force a final draft yet. Say what decision is still unresolved and ask the smallest next question.

When proposing skill or tool hints inside the final draft:

- use the README's required skill format
- use the README's required tool-call format
- do not invent ad-hoc labels or freeform tool prose when a concrete call shape is more appropriate

Examples:

```markdown
- Read a large Markdown document by section:
  skill: treemd
- Search recorded memory:
  memory_search({ query: "<subject_A_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })
```

## Output shape after the interview

When enough information is collected, produce a draft in this shape:

```markdown
---
id: <INTENT_ID>
name: <Human Readable Name>
triggers:
  - "..."
examples:
  - "..."
---

Detected "<intent>" intent. <One-sentence explanation.>

## Guidelines

- ...
- ...

## Response Strategy

- ...
- ...
```

## Grounding checklist

Before proposing the final draft:

- read `extensions/intention-hint/README.md`
- inspect neighboring intent files in `extensions/intention-hint/intents/`
- check whether the proposed name or scope overlaps an existing intent

## Decision style

- Recommend defaults confidently.
- Keep the user's cognitive load low.
- Favor simple, maintainable intent boundaries over clever taxonomy.
