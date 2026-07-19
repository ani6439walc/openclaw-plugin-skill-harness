# Inventory Workflow

Use this workflow when bootstrapping or re-auditing the full intent catalog.

## Step 1 — Discovery scan

Build an inventory from the active sources instead of assuming a single skill directory.

### Skills

Include every available skill source the current environment exposes:

- Bundled extension skills, including this package's `skills/` tree.
- User/runtime skill directories configured for OpenClaw.
- The active OpenClaw skill catalog if the runtime exposes one.

For each skill, read only the frontmatter and short description first. Deep-read the body only when needed to distinguish capability boundaries.

### Tools

List currently available tools from the runtime catalog, config, built-in help, or dashboard. Record each tool's user-visible purpose, not implementation details.

### Existing intents

Use structured file/search tools to list and inspect runtime intent Markdown in the active OpenClaw-resolved catalog. With the default local state directory, this is `~/.openclaw/plugins/skill-harness/intents/`.

## Step 2 — Capability table

Produce a table with:

`capability | type(skill/tool/intent) | summary | source`

Completion criterion: every available skill/tool is represented once, and every existing runtime intent has been considered as current coverage.

## Step 3 — Cluster by user goal

Use `references/clustering.md`:

- Group by what the user is trying to accomplish, not by directory name.
- Assign each capability to exactly one primary cluster.
- Compare each cluster to current runtime intents.
- Mark clusters as covered, gap, overlap, or unclear.
- Apply the domain-intent consistency criteria from `references/clustering.md` before presenting the cluster map.

## Step 4 — Calibration checkpoint

Present the cluster map before generating or changing intents. Ask the user to correct cluster names, missing capabilities, or boundaries.

## Step 5 — Draft gaps

For each confirmed gap, use the design workflow and `references/format.md` to draft a candidate intent.

## Step 6 — Format check

Use simple format checks instead of command-specific validation steps:

- Frontmatter exists and required fields have the right shape.
- Body sections follow the required order.
- Triggers/examples are concrete and non-duplicative.
- Optional `candidate.scope` and `candidate.keywords` are justified by durable cross-domain evidence and collision checks rather than inferred from one session.
- New intents do not collide with existing runtime intent boundaries.
- Domain-intent consistency criteria pass for every changed or newly proposed domain/intent relationship.
- Skill dependencies use frontmatter `skills[]`.
- `## Experience` contains durable skill/tool guidance only; skill entries follow `references/format.md`, and tool entries usually describe capabilities instead of concrete tool names.
- Concrete shell commands and mcporter-backed documentation calls are preserved as bare commands in `## Experience`; `mcporter` appears in `skills[]` when those commands are required.
- No legacy `## Skills & Tools` section remains.

Report the inventory, proposed changes, and any unresolved ambiguities.
