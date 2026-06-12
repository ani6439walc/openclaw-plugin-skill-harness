---
name: intention-hint
description: "Design, inventory, or evolve intent definitions for the intention-hint plugin. Use when creating/refining a single intent (design), bootstrapping or re-auditing the full catalog (inventory), or processing a self-evolution backlog finding (evolve)."
---

# Intention Hint Skill

Manage the full lifecycle of intent definitions: from single-intent CRUD (design), to full-catalog bootstrap (inventory), to automated self-improvement (evolve).

## Quick routing

```
What does the user want?
├─ Create/rename/split/merge/refine ONE intent → design
├─ Bootstrap or re-audit the ENTIRE catalog → inventory
└─ Process a self-evolution backlog finding → evolve
```

If ambiguous, ask: "Are you working on a single intent, auditing the whole system, or processing a backlog finding?"

---

## Mode: design

### When to use

User wants to create, rename, split, merge, or refine **one** intent.

Keywords: "create intent", "new intent", "rename intent", "split intent", "merge intents", "refine intent", "improve intent"

### Workflow

**Step 1 — Classify action type**

```bash
if user says "create" or "new" → action=create
if user says "rename" or "change name" → action=rename
if user says "split" or "separate" → action=split
if user says "merge" or "combine" → action=merge
if user says "refine" or "improve" → action=refine
```

**Step 2 — Interview** (one question at a time, wait for reply)

```
Q1: "What should this intent detect?" → capture purpose
Q2: "What triggers this intent?" → capture 2-3 trigger phrases
Q3: "What tools or skills does it need?" → capture tool list
Q4: "Any existing intent this overlaps with?" → check collision
```

**🔴 CHECKPOINT**: Before drafting, confirm boundary summary with user:
- What this intent handles
- What it doesn't handle
- Neighboring intents it's close to

**Step 3 — Ground against existing intents**

```bash
# List all existing intents
ls extensions/intention-hint/intents/

# Read the most similar existing intent for reference
cat extensions/intention-hint/intents/<similar>.md

# Check for trigger collisions
grep -l "<trigger>" extensions/intention-hint/intents/*.md
```

**Step 4 — Draft with exact format**

```markdown
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

**Step 5 — Deliver with validation**

```bash
# Validate YAML frontmatter
python3 -c "import yaml; yaml.safe_load(open('intent.md').read().split('---')[1])"

# Verify required sections exist
grep -E "^(## Guidelines|## Skills & Tools|## Response Strategy)" intent.md

# If no collisions, write to target
mv intent.md extensions/intention-hint/intents/<intent-id>.md
```

### Failure modes

| Trigger | First fix | Fallback |
|---------|-----------|----------|
| **Interview stalls** — user does not reply or gives vague answers | Restate with recommended options ("A or B?") | Mark as `incomplete`, suggest resuming later |
| **Collision detected** — new intent overlaps existing | Suggest split or merge, show collision details | Force-create but tag as `experimental`, flag for next review |
| **format-rules.md validation fails** | Read error message, fix format and retry | Display full format-rules.md for manual inspection |

### Anti-patterns

| # | Anti-pattern | Why not | Do instead |
|---|-------------|---------|------------|
| 1 | **Ask multiple questions at once** | Confuses user, degrades response quality | Interview one question at a time |
| 2 | **Cross-reference other intents in body** | Classification sub-agent only sees triggers/examples | Express boundaries via triggers and examples only |
| 3 | **Skip format-rules.md before writing** | Inconsistent format breaks plugin parsing | Always read format-rules.md first |
| 4 | **Create a new intent when one already exists** | Causes duplication and collision | Check existing intents during interview |
| 5 | **Use vague descriptions as triggers** | Classification cannot match accurately | Triggers must be concrete phrases or keywords |

---

## Mode: inventory

### When to use

User wants to bootstrap or re-audit the **entire** intent system.

Keywords: "audit intents", "bootstrap intents", "re-audit", "check intent coverage", "find missing intents"

### Workflow

**Step 1 — Discovery scan**

```bash
# Scan all skills
ls -1 ~/.openclaw/skills/ && for d in ~/.openclaw/skills/*/; do [ -f "$d/SKILL.md" ] && basename "$d"; done

# Scan existing intents
ls extensions/intention-hint/intents/
```

Output: capability table with columns `capability | type(skill/tool) | summary | source`

**Step 2 — Clustering**

Group capabilities by **what the user is trying to achieve**, not by directory name.

Output: cluster map with `cluster name | capabilities | existing intent match | recommended intent ID`

**🔴 CHECKPOINT**: Present cluster map to user for calibration before proceeding.

**Step 3 — Interview gaps**

Fill gaps identified in clustering. For each uncovered cluster, interview the user to confirm intent boundaries.

**Step 4 — Generate new intents**

Draft new intent definitions for uncovered clusters using the design mode workflow (Step 4 format).

**Step 5 — Review for collisions**

Validate all new intents, check for collisions, and deliver.

### Failure modes

| Trigger | First fix | Fallback |
|---------|-----------|----------|
| **Discovery scan fails** — skills directory missing or empty | Verify path, prompt user to confirm skills location | Accept manual capability list, tag as `manual_input` |
| **Clustering finds orphan capabilities** | Mark as `unclustered`, recommend creating a new intent | Keep orphan list for next audit cycle |

### Anti-patterns

| # | Anti-pattern | Why not | Do instead |
|---|-------------|---------|------------|
| 1 | **Run inventory without discovery/clustering** | Misses capabilities, produces orphan intents | Must follow order: discovery → clustering → interview |
| 2 | **Skip cluster map checkpoint** | User cannot calibrate, may miss gaps | Always present cluster map before interview |

---

## Mode: evolve

### When to use

User explicitly asks to process a self-evolution backlog finding.

Keywords: "process backlog", "evolve intent", "handle evolution finding", "process the next finding"

**Never enter this mode merely because `sessions/evolution.json` contains pending items.**

Read and follow `references/evolve-workflow.md` before processing a finding.

### Workflow

**Step 1 — Select finding**

```bash
# Show all pending findings (picks highest frequency, oldest createdAt)
pnpm run backlog -- show

# Or show a specific finding
pnpm run backlog -- show --id <item-id>
```

Re-read the selected item — it must still be `pending`.

**Step 2 — Ground against current state**

Read the target intent markdown, the compact intent catalog, and relevant references.

For legacy items with `operation: unknown`, infer metadata:

```bash
pnpm run backlog -- set-target --id <item-id> --operation <operation> --target-intent <intent-id>
```

**Step 3 — Backup + Apply**

```bash
# Create backup directory
mkdir -p /tmp/intention-hint-process-backlog/<item-id>-<timestamp>/

# Backup every file that may be modified or deleted
```

Then apply:
- `create` → new intent
- `refine` → update target intent
- `split`/`merge` → only after user confirmation

**Step 4 — Validate**

```bash
pnpm run backlog -- validate-intents --id <target-intent-id>
pnpm run test
pnpm run build
```

**Step 5 — Commit or Rollback**

```bash
# All checks pass → mark processed
pnpm run backlog -- mark-processed --id <item-id> --expected-updated-at <timestamp>

# Validation fails → restore from backup, leave item pending
```

**🔴 CHECKPOINT**: After processing, before commit — show diff preview and confirm no conflicts.

### Failure modes

| Trigger | First fix | Fallback |
|---------|-----------|----------|
| **Backlog finding already processed** | Skip, mark as `already_processed` | Re-check sessions/evolution.json state |
| **Target intent deleted or missing** | Skip finding, log warning with missing intent ID | Leave item `pending`, report to user for manual resolution |
| **Validation fails after apply** | Restore from `/tmp/intention-hint-process-backlog/` backup | Leave item `pending`, report validation errors to user |
| **Suggested change breaks existing intent format** | Reject the suggestion, keep original intent unchanged | Log rejection reason, leave item `pending` for next cycle |

### Anti-patterns

| # | Anti-pattern | Why not | Do instead |
|---|-------------|---------|------------|
| 1 | **Process multiple backlog findings in one invocation** | Mixes context, impossible to track which finding was handled | Exactly one pending finding per invocation |
| 2 | **Skip validation before commit** | May introduce format errors or collisions | Always run validate-intents, test, build |
| 3 | **Enter evolve mode without explicit user request** | Backlog items may be stale or irrelevant | Only enter when user says "process backlog" |

---

## Shared resources

### First-time setup (assets)

When bootstrapping from scratch, copy example intent templates from `assets/`:

- `assets/chat.md` / `assets/typo.md` — minimal behavior-only intents (no tools)
- `assets/memory-lookup.md` / `assets/memory-compare.md` / `assets/memory-timeline.md` — memory retrieval SOPs
- `assets/summarization.md` / `assets/research-general.md` — multi-source routing patterns

### Validation commands

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

### Decision style

- Recommend defaults confidently; keep cognitive load low.
- Favor simple, maintainable intent boundaries over clever taxonomy.

### Test prompts (dry_run)

| # | Prompt | Expected behavior | Mode |
|---|--------|-------------------|------|
| 1 | "Help me create a new intent for git operations" | Route to **design** → classify=create → interview Q1-Q4 → ground → draft → validate | design |
| 2 | "Audit the entire intent system from scratch" | Route to **inventory** → discovery → clustering → 🔴 CHECKPOINT → interview → generate → review | inventory |
| 3 | "Process the next evolution backlog finding" | Route to **evolve** → `pnpm run backlog -- show` → ground → backup → apply → validate → mark/rollback | evolve |
