# Skill Experience Maintenance Workflow

Use this reference to inspect, draft, refine, or prune Skill Harness experiences on demand.

## Experience Structure

Each skill experience lives in a separate subdirectory under `<dataRoot>/experiences/<id>/` (default: `~/.openclaw/plugins/skill-harness/experiences/<id>/`).

An experience directory consists of plain markdown files:

- **`summary.md`** (Required): Plain-text summary of the problem and solution pattern (max 240 code points).
- **`keywords.md`** (Required): Relevant keywords for fast keyword/lexical discovery, one per line (max 12 keywords, max 64 code points each).
- **`body.md`** (Required): Concrete reusable workflow, durable steps, pitfalls, and guidelines (max 12,000 code points).
- **`skills.md`** (Optional): Associated skill names (exactly one per line; no comma-separated lists) that this experience activates or depends upon.

### Segment and ID Rules

- Experience IDs must match `^[a-z0-9][a-z0-9._-]*$` and cannot exceed 64 code points.
- No other files or symlinks are permitted inside an experience directory.

## Quality Criteria

1. **Reusability**: Must capture a generic, repeatable problem-solving pattern rather than a one-off prompt or transient user conversation.
2. **Privacy**: Never include private user data, absolute local machine paths, secrets, API keys, or raw turn transcripts.
3. **Decoupled Skills**: Link only real, relevant skills in `skills.md` that directly assist with executing the pattern.
4. **Focused Guidance**: Keep `summary.md` concise for high-precision retrieval ranking, and provide actionable, self-contained steps in `body.md`.

## Lifecycle Operations

- **Inspect**: Query `<dataRoot>/experiences/` to examine active patterns.
- **Draft**: Create a new folder `<dataRoot>/experiences/<id>/` with valid `summary.md`, `keywords.md`, `body.md`, and optional `skills.md`.
- **Refine**: Edit existing `.md` files to clarify steps, adjust keywords, or update linked skills based on observed tool usage.
- **Prune / Delete**: Remove obsolete or duplicate experience directories.

Managed QMD refreshes can re-index changed experience files when subsequent source checks are enabled.

## Validate manual changes

Use the production validator through the read-only bundled CLI. In a source checkout, first run `pnpm run build` from the package root; installed packages already contain `dist/`. The CLI reports `{ valid, entryCount, errors }` without experience bodies and exits 0 only when valid. Missing directories, unsupported arguments, malformed inputs, symlinks, invalid content, and invisible linked skills exit 1. It never creates or edits runtime files.

Prepare a private JSON object mapping **every configured agent ID** to that agent’s complete visible skill names. In each agent’s own context, use `skill_list` with `limit: 100`, then follow `next_offset` until `has_more` is false; extract `skills[].name`. Preserve empty arrays for agents with no visible skills. Do not infer all-agent visibility from one agent or from an incomplete page. If you cannot obtain the complete visibility map, stop before declaring linked skills valid.

For example, a visibility file has this shape (replace the example with observed IDs and names):

```json
{ "main": ["git"], "worker": [] }
```

Keep it outside the repository with private permissions. From the package root:

```bash
node skills/skill-harness/scripts/validate-experiences.mjs \
  --experiences-dir /path/to/staged/experiences \
  --visible-skills-file /path/to/private/visible-skills.json
```

Validate the staged experience tree before applying a manual maintenance batch, then validate the runtime tree after authorized edits. Resolve every reported error; the validator checks limits, allowed files, symlinks, canonical ID collisions, and whether each linked skill is visible to at least one supplied agent. It validates the supplied map’s shape but cannot prove the map is complete or current.

Filesystem refresh is conditional: automatic checks follow the configured QMD refresh interval; setting it to zero disables subsequent automatic checks. Validation alone does not prove an index refreshed or a Gateway loaded the plugin.
