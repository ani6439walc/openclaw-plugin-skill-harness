# Inventory Workflow

Use this workflow when bootstrapping or re-auditing the full intent catalog.

## Step 1 — Discovery scan

Build an inventory from the runtime-resolved catalogs instead of walking source directories yourself.

### Skills

Call `skill_list` once to obtain the invoking agent's resolved inventory across bundled, workspace, and configured extra skill roots. Do not reconstruct root precedence manually. Use `skill_search` only to narrow an uncertain capability and `skill_view` only when a description cannot establish the boundary.

### Tools

List currently available tools from the runtime catalog, config, built-in help, or dashboard. Record each tool's user-visible purpose, not implementation details.

### Existing intents

Use structured file/search tools to list and inspect runtime intent Markdown in the active OpenClaw-resolved catalog. With the default local state directory, this is `~/.openclaw/plugins/skill-harness/intents/`. Experience records live separately under `experiences/`; treat them as host-owned runtime evidence, not as intent content or inventory-maintenance input.

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
- Frontmatter contains classification metadata; the complete plain-text body contains one routing `guidance` sentence.
- Triggers/examples are concrete and non-duplicative.
- Optional `keywords` are durable short phrases appropriate for Step 1 QMD keyword BM25 retrieval.
- New intents do not collide with existing runtime intent boundaries.
- Domain-intent consistency criteria pass for every changed or newly proposed domain/intent relationship.
- Skill dependencies use direct frontmatter `skills[]`; the body remains only the one plain-text guidance sentence.
- Commands, workflows, and durable lessons remain in referenced skills, not intent definitions.

Report the inventory, proposed changes, and any unresolved ambiguities.
