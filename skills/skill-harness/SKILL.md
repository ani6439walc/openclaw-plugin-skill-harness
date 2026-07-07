---
name: skill-harness
description: "Design, inventory, evolve, or extract intent definitions for the skill-harness plugin. Use when creating/refining a single intent (design), bootstrapping or re-auditing the full catalog (inventory), processing an evolution finding (evolve), or analyzing intent complexity and extracting oversized intents into skills (extract)."
---

# Skill Harness

Manage the full lifecycle of intent definitions: from single-intent CRUD (design), to full-catalog bootstrap (inventory), to automated self-improvement (evolve).

## Quick routing

```
What does the user want?
├─ Create/rename/split/merge/refine ONE intent → design
├─ Bootstrap or re-audit the ENTIRE catalog → inventory
├─ Process an evolution finding → evolve
└─ Check intent complexity / upgrade intents to skills → extract
```

If ambiguous, ask: "Are you working on a single intent, auditing the whole system, processing an evolution finding, or analyzing intent complexity?"

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
Q3: "Which domain should it belong to?" → capture one domain
Q4: "Any exact-match fastpath phrases or short hint?" → capture optional fastpath
Q5: "What tools or skills does it need?" → capture tool list
Q6: "Any existing intent this overlaps with?" → check collision
```

**🔴 CHECKPOINT**: Before drafting, confirm boundary summary with user:

- What this intent handles
- What it doesn't handle
- Neighboring intents it's close to

**Step 3 — Ground against existing intents**

```bash
# List all existing intents
ls ~/.openclaw/plugins/skill-harness/intents/

# Read the most similar existing intent for reference
cat ~/.openclaw/plugins/skill-harness/intents/<similar>.md

# Check for trigger collisions
grep -l "<trigger>" ~/.openclaw/plugins/skill-harness/intents/*.md
```

**Step 4 — Draft with exact format**

```markdown
---
triggers:
  - "<trigger phrase 1>"
  - "<trigger phrase 2>"
examples:
  - "<example user message 1>"
  - "<example user message 2>"
domain: "<one domain>"
fastpath:
  hint: "<optional short A1 injected hint>"
  keywords:
    - "<optional exact or fuzzy keyword>"
---

## Guidelines

<2-3 sentences describing when to use this intent>

## Skills & Tools

- <skill or tool name>: <one-line description>

## Response Strategy

<bullet list of what the agent should do>

## Experience

<optional durable tips, parameters, pitfalls, or recovery notes>
```

**Step 5 — Deliver with validation**

```bash
# Verify required sections exist
grep -E "^(## Guidelines|## Skills & Tools|## Response Strategy|## Experience)" intent.md

# If no collisions, write to target, then validate through the plugin
mv intent.md ~/.openclaw/plugins/skill-harness/intents/<intent-id>.md
```

Validate with `pnpm test src/intent-validation.test.ts` plus the relevant plugin gates.

### Failure modes

| Trigger                                                           | First fix                                      | Fallback                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| **Interview stalls** — user does not reply or gives vague answers | Restate with recommended options ("A or B?")   | Mark as `incomplete`, suggest resuming later                 |
| **Collision detected** — new intent overlaps existing             | Suggest split or merge, show collision details | Force-create but tag as `experimental`, flag for next review |
| **format.md validation fails**                                    | Read error message, fix format and retry       | Display full format.md for manual inspection                 |

### Anti-patterns

| #   | Anti-pattern                                    | Why not                                                        | Do instead                                                           |
| --- | ----------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | **Ask multiple questions at once**              | Confuses user, degrades response quality                       | Interview one question at a time                                     |
| 2   | **Cross-reference other intents in body**       | Classifier only sees frontmatter, while fastpaths use metadata | Express boundaries via triggers, examples, domain, and fastpath only |
| 3   | **Skip format.md before writing**               | Inconsistent format breaks plugin parsing                      | Always read format.md first                                          |
| 4   | **Create a new intent when one already exists** | Causes duplication and collision                               | Check existing intents during interview                              |
| 5   | **Use vague descriptions as triggers**          | Classification cannot match accurately                         | Triggers must be concrete phrases or keywords                        |

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
ls ~/.openclaw/plugins/skill-harness/intents/
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

| Trigger                                                      | First fix                                              | Fallback                                             |
| ------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------- |
| **Discovery scan fails** — skills directory missing or empty | Verify path, prompt user to confirm skills location    | Accept manual capability list, tag as `manual_input` |
| **Clustering finds orphan capabilities**                     | Mark as `unclustered`, recommend creating a new intent | Keep orphan list for next audit cycle                |

### Anti-patterns

| #   | Anti-pattern                                   | Why not                                      | Do instead                                            |
| --- | ---------------------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| 1   | **Run inventory without discovery/clustering** | Misses capabilities, produces orphan intents | Must follow order: discovery → clustering → interview |
| 2   | **Skip cluster map checkpoint**                | User cannot calibrate, may miss gaps         | Always present cluster map before interview           |

---

## Mode: evolve

### When to use

User explicitly asks to manually evolve runtime intent Markdown or inspect Evolution behavior.

Keywords: "evolve intent", "調整 intent", "修 intent", "check evolution", "inspect evolution"

**There is no pending-item workflow anymore.** Background Evolution reviews edit runtime intents directly and record outcomes in `~/.openclaw/plugins/skill-harness/evolution.json`.

Read and follow `references/evolution.md` before manual intent evolution.

### Workflow

**Step 1 — Ground current state**

Read the target runtime intent Markdown under `~/.openclaw/plugins/skill-harness/intents/`, the compact intent catalog, and relevant references.

**Step 2 — Decide scope**

Before changing routing metadata, filenames, or body sections, compare the filename-derived intent id, frontmatter triggers, examples, domain, fastpath metadata, and body:

- If the filename id and metadata are correct and only the body drifted, refine the body back to the declared boundary.
- If the body is more accurate than the current filename id or metadata, propose a rename or metadata update and ask for explicit confirmation before changing filenames or references.
- If the body contains multiple responsibilities or an oversized boundary, propose a split plan and ask for explicit confirmation before creating/moving/deleting intent files.
- If the mismatch is already fixed by current runtime intents, do nothing and report that no edit is needed.

**Step 3 — Apply smallest safe edit**

Apply only grounded runtime intent Markdown changes:

- `create` → create a new narrow intent.
- `refine` → update the target intent without broadening unrelated behavior.
- `rename` → only after user confirmation; update filename-derived id and stale references together.
- `split`/`merge` → only after user confirmation.

Do not edit `evolution.json`; normal runtime review owns processed event records.

**Step 4 — Validate**

```bash
pnpm test src/intent-validation.test.ts
pnpm run test
pnpm run build
```

**Step 5 — Report**

Report affected files, validation results, and whether any staged edits were applied. Never commit or push unless the user explicitly asks.

### Failure modes

| Trigger                              | First fix                                        | Fallback                                                   |
| ------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------- |
| **Target intent deleted or missing** | Re-read runtime intent directory and catalog     | Ask user whether to create a new intent                    |
| **Validation fails before apply**    | Keep staged edits out of the runtime catalog     | Report validation errors and leave runtime files unchanged |
| **Boundary change is broad**         | Present rename/split/merge plan for confirmation | Keep existing intent unchanged                             |

### Anti-patterns

| #   | Anti-pattern                                       | Why not                                       | Do instead                                       |
| --- | -------------------------------------------------- | --------------------------------------------- | ------------------------------------------------ |
| 1   | **Process non-existent pending items**             | Evolution no longer stores pending items      | Inspect processedEvents or edit intents directly |
| 2   | **Skip validation before handoff**                 | May introduce format errors or collisions     | Always run intent-validation, test, and build    |
| 3   | **Manually edit `evolution.json` for normal work** | Bypasses processedEvents audit and migrations | Let runtime review record outcomes               |

---

## Mode: extract

### When to use

User wants to analyze intent complexity, find oversized intents, or upgrade intents into standalone skills.

Keywords: "extract intent", "intent too complex", "upgrade to skill", "intent 太長了", "拆分 intent", "check intent complexity", "哪些 intent 該變成技能"

Read and follow `references/extract.md` for the full workflow.

### Workflow

**Step 1 — Complexity scan**

Score every intent using the complexity formula (line count, trigger count, example count, tool refs, sub-responsibility count). Output a ranked table with levels: 🟢 Healthy, 🟡 Monitor, 🟠 Warning, 🔴 Extract.

**Step 2 — Sub-responsibility analysis**

For each 🔴 or high 🟠 intent, identify distinct sub-responsibilities that could become independent skills. Propose an extraction plan showing what to extract and what remains.

**🔴 CHECKPOINT**: Present the extraction plan to the user. Do not proceed without confirmation.

**Step 3 — Draft skill blueprints**

For each confirmed extraction, draft:

- A `SKILL.md` for the new skill (workflow, tools, failure modes)
- A slimmed-down intent (<50 lines) retaining only classification triggers + a skill hint

**Step 4 — Deliver**

- If `skill_workshop` tool is available → use `action=create` to create each skill, then update the intent file.
- If `skill_workshop` tool is NOT available → ask the user whether to write the files or just show the drafts.

Post-delivery: validate frontmatter, check trigger collisions, report results.

### Failure modes

| Trigger                                   | First fix                                    | Fallback                                              |
| ----------------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| **No intents above threshold**            | Report all scores, confirm system is healthy | Suggest re-running after adding more intents          |
| **Sub-responsibility boundaries unclear** | Ask user to clarify stay vs extract          | Keep intent unchanged, flag for next review           |
| **Skill name collision**                  | Suggest alternative name                     | Use namespaced name (e.g., `<domain>-ops`)            |
| **User rejects extraction**               | Respect decision                             | Suggest lighter alternative (rewrite guidelines only) |

### Anti-patterns

| #   | Anti-pattern                            | Why not                         | Do instead                                          |
| --- | --------------------------------------- | ------------------------------- | --------------------------------------------------- |
| 1   | **Auto-extract without confirmation**   | Destructive change to routing   | Always get explicit approval                        |
| 2   | **Extract too aggressively**            | Creates skill sprawl            | Only extract truly independent sub-responsibilities |
| 3   | **Leave intent empty after extraction** | Still needed for classification | Keep slimmed intent with triggers + skill hint      |

---

## Shared resources

### First-time setup (assets)

When bootstrapping from scratch, copy example intent templates from `assets/`:

- `assets/chat.md` / `assets/typo.md` — minimal behavior-only intents (no tools)
- `assets/memory-lookup.md` / `assets/memory-compare.md` — memory retrieval SOPs

### Validation commands

Use test/build gates for runtime intent validation. The legacy Evolution tool has
been removed; Evolution writes processed event records automatically.

```bash
pnpm test src/intent-validation.test.ts
pnpm run test
pnpm run build
```

```bash
# Check for trigger collisions
grep -l "<trigger>" ~/.openclaw/plugins/skill-harness/intents/*.md

# List all existing intent IDs
find ~/.openclaw/plugins/skill-harness/intents -name '*.md' -exec basename {} .md \; | sort

# Verify required sections exist
grep -E "^(## Guidelines|## Skills & Tools|## Response Strategy|## Experience)" <file>
```

### Decision style

- Recommend defaults confidently; keep cognitive load low.
- Favor simple, maintainable intent boundaries over clever taxonomy.

### Test prompts (dry_run)

| #   | Prompt                                           | Expected behavior                                                                                                 | Mode      |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | "Help me create a new intent for git operations" | Route to **design** → classify=create → interview Q1-Q4 → ground → draft → validate                               | design    |
| 2   | "Audit the entire intent system from scratch"    | Route to **inventory** → discovery → clustering → 🔴 CHECKPOINT → interview → generate → review                   | inventory |
| 3   | "Refine the git intent wording"                  | Route to **evolve** → ground runtime intent → apply smallest safe edit → validate → report                        | evolve    |
| 4   | "Which intents are too complex?"                 | Route to **extract** → complexity scan → sub-responsibility analysis → 🔴 CHECKPOINT → draft blueprints → deliver | extract   |
