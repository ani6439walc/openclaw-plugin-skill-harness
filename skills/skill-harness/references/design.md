# Design Workflow

Use this workflow when creating, renaming, splitting, merging, or refining one intent.

## Step 1 — Classify the action

Map the user's request to one action:

- `create` — new intent or missing coverage.
- `rename` — the boundary is correct but the filename-derived id is wrong.
- `split` — one intent contains multiple independent responsibilities.
- `merge` — two or more intents duplicate the same user goal.
- `refine` — the intent exists and needs clearer routing metadata or guidance.

For rename, split, merge, deletion, or broad boundary changes, explain the planned file operations and wait for explicit confirmation before writing.

## Step 2 — Interview

Ask one question at a time. Use `references/interview.md` for the full interview order.

Minimum information before drafting:

1. Purpose and boundary.
2. Required `domain`.
3. Concrete triggers and examples.
4. Optional exact fastpath keywords.
5. One durable plain-text body guidance sentence and direct skills worth listing in frontmatter.
6. Neighboring or colliding intents.

## Step 3 — Ground against existing intents

Use structured file/search tools when available:

- List runtime intent files in the active OpenClaw-resolved catalog. With the default local state directory, this is `~/.openclaw/plugins/skill-harness/intents/`.
- Read the most similar intent Markdown files.
- Search triggers/examples for overlap with the proposed boundary.
- Check the proposed domain and neighboring intents against the domain-intent consistency criteria in `references/clustering.md`.

Do not rely on shell-only listing/search examples when the host provides structured tools.

## Step 4 — Draft

Follow `references/format.md` exactly:

- Required frontmatter: `triggers[]`, `examples[]`, and `domain`; the complete body is one `guidance` sentence.
- Optional frontmatter: `fastpath.keywords`, `candidate`, and direct `skills[]`.
- Do not include Markdown body sections, tool instructions, workflows, or experiences; the body is only the plain-text guidance sentence.
- No intent-metadata cross-references to other intent ids.

## Step 5 — Format check and delivery

Before writing or showing the final draft, perform simple format checks:

- Frontmatter exists and is the complete intent file.
- Required fields exist with the right shape.
- Trigger/example text is concrete enough for routing.
- The complete plain-text body is one durable routing sentence.
- Skill dependencies use direct frontmatter `skills[]`; no tool guidance, workflow, or experience text belongs in the body.
- No intent-metadata cross-references to other intent ids.
- The target filename-derived id matches the declared boundary.
- The chosen domain passes the domain-intent consistency criteria from `references/clustering.md`.

If writing is approved, use the available file-editing tools to stage and apply the smallest safe change, then report what changed.
