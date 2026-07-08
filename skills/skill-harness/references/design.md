# Design Workflow

Use this workflow when creating, renaming, splitting, merging, or refining one intent.

## Step 1 — Classify the action

Map the user's request to one action:

- `create` — new intent or missing coverage.
- `rename` — the boundary is correct but the filename-derived id is wrong.
- `split` — one intent contains multiple independent responsibilities.
- `merge` — two or more intents duplicate the same user goal.
- `refine` — the intent exists and needs clearer triggers, examples, or body guidance.

For rename, split, merge, deletion, or broad boundary changes, explain the planned file operations and wait for explicit confirmation before writing.

## Step 2 — Interview

Ask one question at a time. Use `references/interview.md` for the full interview order.

Minimum information before drafting:

1. Purpose and boundary.
2. Required `domain`.
3. Concrete triggers and examples.
4. Optional fastpath keywords and hint.
5. Skills worth listing in frontmatter and durable tool guidance worth moving into `## Experience`.
6. Concrete shell commands or stable CLI equivalents that should be preserved in `## Experience`, including mcporter-backed documentation calls.
7. Neighboring or colliding intents.

## Step 3 — Ground against existing intents

Use structured file/search tools when available:

- List runtime intent files under `~/.openclaw/plugins/skill-harness/intents/` or the user-provided runtime root.
- Read the most similar intent Markdown files.
- Search triggers/examples for overlap with the proposed boundary.
- Check the proposed domain and neighboring intents against the domain-intent consistency criteria in `references/clustering.md`.

Do not rely on shell-only listing/search examples when the host provides structured tools.

## Step 4 — Draft

Follow `references/format.md` exactly:

- Required frontmatter: `triggers[]`, `examples[]`, `domain`; optional `fastpath`.
- Optional frontmatter: `fastpath`, `skills[]`.
- Required body sections: `## Guidelines`, `## Response Strategy`; optional `## Concrete Workflow`, optional `## Experience`.
- Do not include `## Skills & Tools`; put skill names in frontmatter `skills[]`.
- Preserve concrete shell commands as bare commands in `## Experience`; for Context7, DeepWiki, or GoogleDeveloperKnowledge calls, add `mcporter` to `skills[]` and write the `mcporter call ...` command instead of MCP wrapper syntax.
- No body cross-references to other intent ids.

## Step 5 — Format check and delivery

Before writing or showing the final draft, perform simple format checks:

- Frontmatter exists and closes before body sections.
- Required fields exist with the right shape.
- Required body sections are present and ordered.
- Trigger/example text is concrete enough for routing.
- Skill dependencies use frontmatter `skills[]`; any tool guidance follows the `## Concrete Workflow` and `## Experience` rules in `references/format.md`.
- Concrete shell commands and mcporter-backed documentation lookups are written as bare commands in `## Experience`; no `exec({ command: ... })` or vague runtime-capability wording remains.
- No legacy `## Skills & Tools` section remains.
- No body cross-references to other intent ids.
- The target filename-derived id matches the declared boundary.
- The chosen domain passes the domain-intent consistency criteria from `references/clustering.md`.

If writing is approved, use the available file-editing tools to stage and apply the smallest safe change, then report what changed.
