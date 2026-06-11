---
name: intention-hint
description: "Design, inventory, or evolve intent definitions for the intention-hint plugin. Use when creating/refining a single intent (design), bootstrapping or re-auditing the full catalog (inventory), or processing a self-evolution backlog finding (evolve)."
---

Manage intent definitions and Self-Evolution findings for the intention-hint
plugin.

### Mode routing

```
user request scope?
├── one intent (create/rename/split/merge/refine) → design
├── full catalog bootstrap or re-audit            → inventory
└── explicit "process backlog finding"            → evolve
```

Pick one mode, then follow its workflow.

## First-time setup (assets)

When bootstrapping from scratch, copy example intent templates from `assets/` as starting points:

- `assets/chat.md` / `assets/typo.md` — minimal behavior-only intents (no tools)
- `assets/memory-lookup.md` / `assets/memory-compare.md` / `assets/memory-timeline.md` — memory retrieval SOPs
- `assets/summarization.md` / `assets/research-general.md` — multi-source routing patterns

These are English example templates. Adapt to the project's language and intent scope.

## Mode: design

User wants to create, rename, split, merge, or refine **one** intent.

This mode handles all single-intent CRUD operations. The workflow is:
classify the action type → interview for requirements → ground against existing intents → draft the definition → deliver with validation.

Read order:

1. `references/interview.md`
2. `references/format-rules.md`
3. `references/closing.md`

**🔴 CHECKPOINT**: After interview, before drafting — confirm boundary summary with user.

## Mode: inventory

User wants to bootstrap or re-audit the entire intent system (first install or after many new skills/tools).

This mode performs a full capability inventory: scan all skills and tools → cluster by usage intent → identify gaps and overlaps → interview for missing intents → generate new intent definitions → review for collisions.

Read order:

1. `references/discovery.md`
2. `references/clustering.md`
3. `references/interview.md`
4. `references/format-rules.md`
5. `references/closing.md`

**🔴 CHECKPOINT**: After clustering, before interview — present cluster map to user for calibration.

## Mode: evolve

Use only when the user explicitly asks to process an Intent Self-Evolution
backlog finding. Process exactly one pending finding per invocation.

This mode handles automated improvement suggestions discovered by the self-evolution system. It reads the finding, applies the suggested change, validates, and commits.

Read order:

1. `references/evolve-workflow.md`
2. `references/format-rules.md`
3. Other design/inventory references only when the selected finding requires them

**🔴 CHECKPOINT**: After processing, before commit — show diff preview and confirm no conflicts.

Never enter this mode merely because `sessions/evolution.json` contains pending
items.

## Decision style

- Recommend defaults confidently; keep cognitive load low.
- Favor simple, maintainable intent boundaries over clever taxonomy.

## Concrete workflow examples

### Design mode — 5-step breakdown

**Step 1: Classify**
```bash
# Determine action type from user request
if user says "create" or "new" → action=create
if user says "rename" or "change name" → action=rename
if user says "split" or "separate" → action=split
if user says "merge" or "combine" → action=merge
if user says "refine" or "improve" → action=refine
```

**Step 2: Interview** (one question at a time)
```
Q1: "What should this intent detect?" → capture purpose
Q2: "What triggers this intent?" → capture 2-3 trigger phrases
Q3: "What tools or skills does it need?" → capture tool list
Q4: "Any existing intent this overlaps with?" → check collision
```

**Step 3: Ground**
```bash
# Read existing intents to check for collisions
ls extensions/intention-hint/intents/
# Read the most similar existing intent for reference
cat extensions/intention-hint/intents/<similar>.md
```

**Step 4: Draft**
```markdown
# Output format (must follow exactly)
---
name: <Intent Name>
id: <intent-id>
enabled: true
triggers:
  - "<trigger phrase 1>"
  - "<trigger phrase 2>"
examples:
  - "<example user message 1>"
  - "<example user message 2>"
---

## Guidelines
<2-3 sentences describing when to use this intent>

## Skills & Tools
- <skill or tool name>: <one-line description>

## Response Strategy
<bullet list of what the agent should do>
```

**Step 5: Deliver**
```bash
# Validate format
python3 -c "import yaml; yaml.safe_load(open('intent.md').read().split('---')[1])"
# Check for collisions
grep -l "<trigger>" extensions/intention-hint/intents/*.md
# If no collisions, write to target
mv intent.md extensions/intention-hint/intents/<intent-id>.md
```

### Inventory mode — 5-step breakdown

**Step 1: Discovery**
```bash
# Scan all skills
ls -1 ~/.openclaw/skills/ && for d in ~/.openclaw/skills/*/; do [ -f "$d/SKILL.md" ] && basename "$d"; done
# Scan existing intents
ls extensions/intention-hint/intents/
```
Output: capability table with columns `capability | type(skill/tool) | summary | source`

**Step 2: Clustering**
Group capabilities by **what the user is trying to achieve**, not by directory name.
Output: cluster map with `cluster name | capabilities | existing intent match | recommended intent ID`

**Step 3: Interview** — fill gaps identified in clustering

**Step 4: Generate** — draft new intent definitions for uncovered clusters

**Step 5: Review** — validate all new intents, check for collisions

### Evolve mode — transactional workflow

**Step 1: Select**
```bash
# Show all pending findings (picks highest frequency, oldest createdAt)
pnpm run backlog -- show
# Or show a specific finding
pnpm run backlog -- show --id <item-id>
```
Re-read the selected item — it must still be `pending`.

**Step 2: Ground**
Read the target intent markdown, the compact intent catalog, and relevant references.
For legacy items with `operation: unknown`, infer metadata:
```bash
pnpm run backlog -- set-target --id <item-id> --operation <operation> --target-intent <intent-id>
```

**Step 3: Backup + Apply**
```bash
# Create backup directory
mkdir -p /tmp/intention-hint-process-backlog/<item-id>-<timestamp>/
# Backup every file that may be modified or deleted
```
Then apply: `create` → new intent, `refine` → update target, `split`/`merge` → only after user confirmation.

**Step 4: Validate**
```bash
pnpm run backlog -- validate-intents --id <target-intent-id>
pnpm run test
pnpm run build
```

**Step 5: Commit or Rollback**
```bash
# All checks pass → mark processed
pnpm run backlog -- mark-processed --id <item-id> --expected-updated-at <timestamp>
# Validation fails → restore from backup, leave item pending
```

## Test prompts (dry_run)

| # | Prompt | Expected behavior | Mode |
|---|--------|-------------------|------|
| 1 | "Help me create a new intent for git operations" | Route to **design** → classify=create → interview Q1-Q4 → ground against existing intents → draft with correct frontmatter → validate | design |
| 2 | "Audit the entire intent system from scratch" | Route to **inventory** → discovery scan → clustering → 🔴 CHECKPOINT cluster map → interview gaps → generate → review collisions | inventory |
| 3 | "Process the next evolution backlog finding" | Route to **evolve** → `pnpm run backlog -- show` → ground → backup → apply → validate → mark processed or rollback | evolve |

## Failure modes

| Trigger | First fix | Fallback |
|---------|-----------|----------|
| **Interview stalls** — user does not reply or gives vague answers | Restate the question with recommended options ("A or B?") | Mark as `incomplete`, suggest resuming later |
| **Discovery scan fails** — skills directory missing or empty | Verify path, prompt user to confirm skills location | Accept manual capability list, tag as `manual_input` |
| **Clustering finds orphan capabilities** | Mark as `unclustered`, recommend creating a new intent | Keep orphan list for next audit cycle |
| **Closing collision warning** — new intent overlaps existing | Suggest split or merge, show collision details | Force-create but tag as `experimental`, flag for next review |
| **format-rules.md validation fails** | Read error message, fix format and retry | Display full format-rules.md for manual inspection |
| **Backlog finding already processed** | Skip, mark as `already_processed` | Re-check sessions/evolution.json state |
| **Evolve: target intent deleted or missing** | Skip finding, log warning with missing intent ID | Leave item `pending`, report to user for manual resolution |
| **Evolve: validation fails after apply** | Restore from `/tmp/intention-hint-process-backlog/` backup | Leave item `pending`, report validation errors to user |
| **Evolve: suggested change breaks existing intent format** | Reject the suggestion, keep original intent unchanged | Log rejection reason, leave item `pending` for next cycle |

## Validation commands

```bash
# Check YAML frontmatter syntax
python3 -c "import yaml; yaml.safe_load(open('<file>').read().split('---')[1])"

# Check for trigger collisions
grep -l "<trigger>" extensions/intention-hint/intents/*.md

# List all existing intent IDs
cat extensions/intention-hint/intents/*.md | grep "^id:" | cut -d' ' -f2

# Verify required sections exist
grep -E "^(## Guidelines|## Skills & Tools|## Response Strategy)" <file>
```

## Anti-patterns

| # | Anti-pattern | Why not | Do instead |
|---|-------------|---------|------------|
| 1 | **Ask multiple questions at once** | Confuses user, degrades response quality | interview.md mandates one question at a time |
| 2 | **Cross-reference other intents in body** | Classification sub-agent only sees triggers/examples; creates circular dependencies | Express boundaries via triggers and examples only; never mention other intent ids/names |
| 3 | **Skip format-rules.md before writing** | Inconsistent format breaks plugin parsing | Always read format-rules.md before writing any intent |
| 4 | **Run inventory without discovery/clustering** | Misses capabilities, produces orphan intents | Inventory mode must follow order: discovery → clustering → interview |
| 5 | **Process multiple backlog findings in one invocation** | Mixes context, impossible to track which finding was handled | Exactly one pending finding per invocation |
| 6 | **Skip validation before commit** | May introduce format errors or collisions | closing.md has safety checks — always execute them |
| 7 | **Create a new intent when one already exists** | Causes duplication and collision | Check existing intents during interview phase |
| 8 | **Use vague descriptions as triggers** | Classification cannot match accurately | Triggers must be concrete phrases or keywords |
