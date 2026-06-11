---
name: intention-hint
description: "Manage the intention-hint plugin's intent system. Use when designing or refining intent definitions, auditing the catalog, or explicitly processing a Self-Evolution backlog finding."
---

Manage intent definitions and Self-Evolution findings for the intention-hint
plugin.
Three modes — pick based on user request scope.

## Mode: single

User wants to create, rename, split, merge, or refine **one** intent.

Read order:

1. `references/interview.md`
2. `references/format-rules.md`
3. `references/closing.md`

Then follow the 5-step workflow: classify → interview → ground → draft → deliver.

**🔴 CHECKPOINT**: After interview, before drafting — confirm boundary summary with user.

## Mode: audit

User wants to bootstrap or re-audit the entire intent system (first install or after many new skills/tools).

Read order:

1. `references/discovery.md`
2. `references/clustering.md`
3. `references/interview.md`
4. `references/format-rules.md`
5. `references/closing.md`

Then follow: discovery → clustering → interview → generate → review.

**🔴 CHECKPOINT**: After clustering, before interview — present cluster map to user for calibration.

## Mode: backlog

Use only when the user explicitly asks to process an Intent Self-Evolution
backlog finding. Process exactly one pending finding per invocation.

Read order:

1. `references/process-backlog.md`
2. `references/format-rules.md`
3. Other single/audit references only when the selected finding requires them

Then follow the transactional workflow in `references/process-backlog.md`.
Never enter this mode merely because `sessions/evolution.json` contains pending
items.

**🔴 CHECKPOINT**: After processing, before commit — show diff preview and confirm no conflicts.

## First-time setup (assets)

When bootstrapping from scratch, copy example intent templates from `assets/` as starting points:

- `assets/chat.md` / `assets/typo.md` — minimal behavior-only intents (no tools)
- `assets/memory-lookup.md` / `assets/memory-compare.md` / `assets/memory-timeline.md` — memory retrieval SOPs
- `assets/summarization.md` / `assets/research-general.md` — multi-source routing patterns

These are English example templates. Adapt to the project's language and intent scope.

## Decision style

- Recommend defaults confidently; keep cognitive load low.
- Favor simple, maintainable intent boundaries over clever taxonomy.

## Concrete workflow examples

### Single mode — 5-step breakdown

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

## Failure modes

| Trigger | First fix | Fallback |
|---------|-----------|----------|
| **Interview stalls** — user does not reply or gives vague answers | Restate the question with recommended options ("A or B?") | Mark as `incomplete`, suggest resuming later |
| **Discovery scan fails** — skills directory missing or empty | Verify path, prompt user to confirm skills location | Accept manual capability list, tag as `manual_input` |
| **Clustering finds orphan capabilities** | Mark as `unclustered`, recommend creating a new intent | Keep orphan list for next audit cycle |
| **Closing collision warning** — new intent overlaps existing | Suggest split or merge, show collision details | Force-create but tag as `experimental`, flag for next review |
| **format-rules.md validation fails** | Read error message, fix format and retry | Display full format-rules.md for manual inspection |
| **Backlog finding already processed** | Skip, mark as `already_processed` | Re-check sessions/evolution.json state |

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
| 4 | **Run audit without discovery/clustering** | Misses capabilities, produces orphan intents | Audit mode must follow order: discovery → clustering → interview |
| 5 | **Process multiple backlog findings in one invocation** | Mixes context, impossible to track which finding was handled | Exactly one pending finding per invocation |
| 6 | **Skip validation before commit** | May introduce format errors or collisions | closing.md has safety checks — always execute them |
| 7 | **Create a new intent when one already exists** | Causes duplication and collision | Check existing intents during interview phase |
| 8 | **Use vague descriptions as triggers** | Classification cannot match accurately | Triggers must be concrete phrases or keywords |
