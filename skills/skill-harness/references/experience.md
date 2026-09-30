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

Background QMD indexers (`SkillExperienceQmdIndex`) will automatically re-index experiences upon detection of filesystem changes or scheduled refreshes.
