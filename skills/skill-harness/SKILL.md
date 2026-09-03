---
name: skill-harness
description: "Audit Skill Harness intents, runtime health, and Review data."
---

# Skill Harness

Manage the human-facing lifecycle of intent definitions: single-intent CRUD (design), full-catalog bootstrap/re-audit (inventory), complexity analysis or skill extraction (extract), evidence-backed Intent Review keyword auditing (keyword-audit), and report-only runtime health analysis (runtime-health). Background subagents handle automated self-improvement; use analysis modes only for deliberate human-requested review.

Do not manually repeat production-owned work: per-turn classification and routing injection, startup intent seeding, trigger-driven runtime intent edits, trigger-keyword persistence, skill-placement review, stats aggregation, and session cleanup. This skill is for explicit human maintenance requests and the judgment or confirmation those automated paths do not own.

## Quick routing

```
What does the user want?
├─ Bootstrap or re-audit the ENTIRE catalog → inventory
├─ Create/rename/split/merge/refine ONE intent → design
├─ Check intent complexity / upgrade intents to skills → extract
├─ Analyze Review keyword hits/misses/collisions and propose a bounded delta → keyword-audit
└─ Check runtime state, Review applied-change distribution, coverage, or retention → runtime-health
```

If ambiguous, ask one routing question: "Are you working on one intent, auditing the whole catalog, analyzing complexity, evaluating Review keywords, or checking runtime health?"

## Shared operating rules

- Prefer structured file/search tools available in the host environment for listing, reading, and searching files. In Hermes, that means `search_files`, `read_file`, `write_file`, and `patch` before shell equivalents.
- Treat shell snippets in older notes as implementation examples, not required commands. Use terminal only for package/test/build commands or when no structured tool exists.
- Current source layout:
  - Bundled skill assets live under this skill directory, especially `assets/` and `references/`.
  - Runtime editable intents live in the active OpenClaw-resolved runtime intent catalog. With the default local state directory, this is `~/.openclaw/plugins/skill-harness/intents/`.
  - Runtime experiences live in a separate skill-scoped catalog. With the default local state directory, this is `~/.openclaw/plugins/skill-harness/experiences/`; do not treat them as intent bodies or manually edit them.
  - Do not assume a single user-local skill directory is the only skill source; inventory should include bundled extension skills, configured user/runtime skills, and the active OpenClaw skill catalog when available.
- For broad, destructive, or routing-identity changes (rename, split, merge, deletion, extraction), present the plan and wait for explicit confirmation before writing.
- Treat runtime session text as private. Keyword-audit and runtime-health reports stay local; never send raw retained conversations, tool payloads, Review suggestions, or Review evidence to external tools or artifacts.
- Do not hand-edit `review.json`, `keyword-coverage.json`, `stats.json`, session files, runtime experience files, or package files. Those are host-owned runtime records. Do not recreate production routing, startup seeding, Review persistence, skill-placement, stats, or cleanup workflows in this skill.
- Check changed intent files for canonical routing-only format: complete valid classification frontmatter, one plain-text body `guidance` sentence, concrete triggers/examples, optional `keywords`, direct frontmatter `skills[]` when skill loading is needed, and no cross-references to other intent ids. The entire body is guidance; do not add sections, lists, fences, commands, paths, or other Markdown formatting.
- Keep concrete shell commands, MCP documentation calls, workflows, and durable lessons in referenced skills; do not add them to intent definitions.
- When reviewing, creating, splitting, merging, or extracting intents, validate domain-intent consistency using `references/clustering.md`.

---

## Mode: inventory

### When to use

User wants to bootstrap or re-audit the **entire** intent system.

Keywords: "audit intents", "bootstrap intents", "re-audit", "check intent coverage", "find missing intents"

### Workflow

Read and follow `references/inventory.md`. Keep these checkpoints visible:

1. **Discovery scan** — use the resolved `skill_list` inventory, active tool catalog, and runtime intent catalog; do not scan skill directories manually.
2. **Clustering** — use `references/clustering.md`; group by user goal, not directory name.
3. **Calibration checkpoint** — present the cluster map before generating or changing intents.
4. **Interview gaps** — fill uncovered clusters using the design-mode interview rules.
5. **Generate and check** — draft missing intents with canonical format, check collisions, then run simple format checks.

### Failure modes

| Trigger                                  | First fix                                                  | Fallback                                             |
| ---------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| **Discovery scan incomplete**            | Report which configured source could not be read           | Accept manual capability list, tag as `manual_input` |
| **Clustering finds orphan capabilities** | Mark as `unclustered`, recommend creating a new intent     | Keep orphan list for next audit cycle                |
| **User rejects cluster map**             | Ask which cluster boundary is wrong, then regroup narrowly | Keep inventory report without generating intents     |

### Anti-patterns

| #   | Anti-pattern                                   | Why not                                      | Do instead                                               |
| --- | ---------------------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| 1   | **Run inventory without discovery/clustering** | Misses capabilities, produces orphan intents | Follow order: discovery → clustering → calibration       |
| 2   | **Scan skill directories manually**            | Reimplements source precedence incorrectly   | Use the invoking agent's resolved `skill_list` inventory |
| 3   | **Skip cluster map checkpoint**                | User cannot calibrate, may miss gaps         | Present cluster map before interview/generation          |

---

## Mode: design

### When to use

User wants to create, rename, split, merge, or refine **one** intent.

Keywords: "create intent", "new intent", "rename intent", "split intent", "merge intents", "refine intent", "improve intent"

### Workflow

Read and follow `references/design.md`. Keep these checkpoints visible:

1. **Classify the action** — create, rename, split, merge, or refine.
2. **Interview one question at a time** — use `references/interview.md`; do not batch questions.
3. **Ground against existing runtime intents** — list/search/read runtime intent Markdown with structured file tools.
4. **Confirm boundary summary** before drafting:
   - what this intent handles
   - what it does not handle
   - neighboring intents it is close to
5. **Draft with canonical format** — use `references/format.md`.
6. **Deliver through closing mode** — use `references/closing.md`; stage, preview, confirm, write, then run simple format checks.

### Failure modes

| Trigger                                                           | First fix                                      | Fallback                                      |
| ----------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| **Interview stalls** — user does not reply or gives vague answers | Restate with recommended options ("A or B?")   | Mark as incomplete and suggest resuming later |
| **Collision detected** — new intent overlaps existing             | Suggest split or merge, show collision details | Keep draft staged until user confirms         |
| **Format validation fails**                                       | Read the validation error, fix format, retry   | Show unresolved error and leave file staged   |

### Anti-patterns

| #   | Anti-pattern                                    | Why not                                   | Do instead                                                                     |
| --- | ----------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | **Ask multiple questions at once**              | Confuses user, degrades response quality  | Interview one question at a time                                               |
| 2   | **Cross-reference other intents in metadata**   | Classifier only sees routing metadata     | Express boundaries via triggers, examples, domain, keywords, and body guidance |
| 3   | **Skip format rules before writing**            | Inconsistent format breaks plugin parsing | Read `references/format.md` first                                              |
| 4   | **Create a new intent when one already exists** | Causes duplication and collision          | Check existing intents during interview                                        |
| 5   | **Use vague descriptions as triggers**          | Classification cannot match accurately    | Use concrete phrases or keywords                                               |

---

## Mode: extract

### When to use

User wants to analyze intent complexity, find oversized intents, or upgrade intents into standalone skills.

Keywords: "extract intent", "intent too complex", "upgrade to skill", "intent 太長了", "拆分 intent", "check intent complexity", "哪些 intent 該變成技能"

### Workflow

Read and follow `references/extract.md`. Keep these checkpoints visible:

1. **Complexity scan** — score runtime intents by size, routing metadata, tool/skill refs, and sub-responsibility count.
2. **Sub-responsibility analysis** — identify independent responsibilities that could become skills.
3. **Extraction checkpoint** — present the extraction plan and wait for confirmation.
4. **Draft skill blueprints** — create proposed `SKILL.md` content and a slimmed intent.
5. **Deliver with explicit write mode** — if the user approves writing, create/edit files with available file tools; otherwise deliver drafts only.
6. **Check format** — verify skill frontmatter, trigger collisions, and slimmed intent shape.

### Failure modes

| Trigger                                   | First fix                                    | Fallback                                                   |
| ----------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| **No intents above threshold**            | Report all scores, confirm system is healthy | Suggest re-running after adding more intents               |
| **Sub-responsibility boundaries unclear** | Ask user to clarify stay vs extract          | Keep intent unchanged, flag for next review                |
| **Skill name collision**                  | Suggest alternative name                     | Use namespaced name (e.g., `<domain>-ops`)                 |
| **User rejects extraction**               | Respect decision                             | Suggest lighter alternative (refine routing guidance only) |

### Anti-patterns

| #   | Anti-pattern                            | Why not                         | Do instead                                          |
| --- | --------------------------------------- | ------------------------------- | --------------------------------------------------- |
| 1   | **Auto-extract without confirmation**   | Destructive change to routing   | Always get explicit approval                        |
| 2   | **Extract too aggressively**            | Creates skill sprawl            | Only extract truly independent sub-responsibilities |
| 3   | **Leave intent empty after extraction** | Still needed for classification | Keep slimmed intent with triggers + `skills[]`      |

---

## Mode: keyword-audit

### When to use

User wants to measure, analyze, or propose changes to Intent Review trigger keywords using actual runtime observations.

Keywords: "Review keywords", "trigger keywords", "keyword hit rate", "keyword misses", "keyword collisions", "分析關鍵字", "統計關鍵字", "更新關鍵字", "successful-pattern", "behavior-fix", "entity-context"

Do not use this mode for intent `keywords`; route that through design or inventory with the labeled-fixture rules in `references/format.md`.

### Workflow

Read and follow `references/keyword-audit.md`. Keep these checkpoints visible:

1. **Generate a read-only report** — run `scripts/review-keyword-audit.py`; it resolves the default data root, validates current schema-v7 `review.json` plus schema-v1 `keyword-coverage.json`, and records provenance. Treat unmatched documents as structural proxies, not semantic misses, and keep snippets disabled unless local content inspection is explicitly necessary.
2. **Label evidence** — build a private ref-only fixture from `templates/review-keyword-labels.json`, rerun with `--labels`, and inspect TP/FP/FN plus collisions locally; frequency alone is not approval.
3. **Proposal checkpoint** — present before/after coverage and at most three exact additions/removals per target; wait for explicit confirmation.
4. **Report and proposal only** — deliver the evidence-backed delta after confirmation, but do not invoke or emulate Intent Review's production-owned writer and do not hand-edit `review.json` or `keyword-coverage.json`.

### Failure modes

| Trigger                                   | First fix                                                                          | Fallback                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Missing or incompatible runtime state** | Stop and report the `review.json` or `keyword-coverage.json` schema/state mismatch | Do not invent defaults or migrate runtime data |
| **Too little retained evidence**          | Keep phrases as candidates and gather more sessions                                | Make no keyword change                         |
| **Candidate has collisions**              | Narrow the exact phrase and rerun labeling                                         | Retain the current keyword set                 |
| **User requests direct runtime mutation** | Explain that production Review owns keyword writes                                 | Deliver an approved but unapplied delta        |

### Anti-patterns

| #   | Anti-pattern                                       | Why not                                         | Do instead                                              |
| --- | -------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| 1   | **Promote the most frequent phrase automatically** | Co-occurrence is not target semantics           | Require distinct-session positives and collision review |
| 2   | **Print raw snippets by default**                  | Sessions can contain private user data          | Keep reports snippet-free and inspect refs locally      |
| 3   | **Remove keywords with zero retained hits**        | Retention can erase prior evidence              | Require repeated labeled false positives                |
| 4   | **Mix evidence across keyword targets**            | Host findings may update only their own trigger | Evaluate each target independently                      |

---

## Mode: runtime-health

### When to use

User wants to inspect runtime state, Review outcomes or applied-change distribution, keyword-coverage epochs, session retention, or Skill Harness disk growth.

Keywords: "skill harness health", "runtime health", "review 統計", "review 建議分布", "review changes", "coverage epoch", "session retention", "skill harness 磁碟"

### Workflow

Read and follow `references/runtime-health-audit.md`. Keep these checkpoints visible:

1. **Generate a report-only snapshot** — run `scripts/runtime-health-audit.py` with local mode-`0600` output. Do not expose session text, tool payloads, Review suggestion text, or evidence.
2. **Check structural state first** — current schema-v7 `review.json`, schema-v1 `keyword-coverage.json`, schema-v3 or schema-v4 `stats.json`, QMD database state, session shape counts, and retention metadata must be interpreted before quality trends. Read the report attribution boundary before interpreting v4 daily maps.
3. **Explain applied changes, not proposals** — use `processedEvents.changes.total`, `byTrigger`, `byOperation`, and target concentration. Keep ordinary Review separate from historical keyword audits.
4. **Apply scheduler context** — empty coverage epochs can be normal after a restart or before the next eligible finalized turn; verify config, stats writes, model availability, and cadence before calling it a failure.
5. **Report a bounded next observation** — state the provenance, actual counts, disk/retention state, and a next threshold. Do not modify runtime data from audit findings.

### Failure modes

| Trigger                              | First fix                                                                   | Fallback                                                       |
| ------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Runtime state changed while read** | Retry later or use a quiescent copied data root                             | Report no trend conclusion                                     |
| **Schema or session-shape failure**  | Report the count and affected state surface                                 | Investigate writer/retention code separately                   |
| **High Review failure outcomes**     | Compare a fresh bounded window and reason counts                            | Do not change prompts/models from a historical aggregate alone |
| **Empty coverage epochs**            | Verify `review.enabled`, new stats writes, model, and next cadence boundary | Inspect scheduler warnings in a separate implementation task   |

### Anti-patterns

| #   | Anti-pattern                                                        | Why not                                                     | Do instead                                      |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| 1   | **Treat all Review events as changes**                              | Nofindings and rejected proposals are not runtime mutations | Use host-recorded `applied` and `changes.total` |
| 2   | **Mix historical keyword audits with ordinary Review change rates** | They have different schemas and attribution limits          | Report them separately                          |
| 3   | **Call empty coverage a defect immediately**                        | Coverage never replays startup history                      | Check runtime reload and eligible-turn context  |
| 4   | **Print raw state to explain a counter**                            | Runtime files can contain private data                      | Use aggregate report fields only                |

---

## Shared resources

### Format check principles

Use structured file/search tools to inspect intent format. Keep checks simple and local:

- Frontmatter is the complete intent file and has required fields with the right shapes.
- The complete plain-text intent body is one durable routing-guidance sentence.
- Triggers and examples are concrete, non-duplicative, and aligned with the filename-derived intent id.
- `keywords` must be durable exact whole-message evidence; the same values also form the lexical QMD keyword collection.
- Review trigger keywords are a separate runtime surface. Analyze them with `references/keyword-audit.md` and `scripts/review-keyword-audit.py`; never infer a write from phrase frequency alone.
- Skill dependencies use direct frontmatter `skills[]`; tools, workflows, commands, and lessons stay in referenced skills.
- Intent metadata does not cross-reference other intent ids.
- Proposed triggers do not obviously collide with existing runtime intent boundaries.

### Decision style

- Recommend defaults confidently; keep cognitive load low.
- Favor simple, maintainable intent boundaries over clever taxonomy.
- Keep `SKILL.md` concise; put detailed mode-specific procedures in `references/*.md`.

### Test prompts (dry_run)

| #   | Prompt                                           | Expected behavior                                                                                                 | Mode           |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | "Audit the entire intent system from scratch"    | Route to **inventory** → discovery → clustering → 🔴 CHECKPOINT → interview → generate → review                   | inventory      |
| 2   | "Help me create a new intent for git operations" | Route to **design** → classify=create → interview → ground → draft → format check                                 | design         |
| 3   | "Which intents are too complex?"                 | Route to **extract** → complexity scan → sub-responsibility analysis → 🔴 CHECKPOINT → draft blueprints → deliver | extract        |
| 4   | "Analyze which Review keywords should change"    | Route to **keyword-audit** → pin evidence → report → label → 🔴 CHECKPOINT → bounded proposal                     | keyword-audit  |
| 5   | "統計過去 Review 產生的修改分布"                 | Route to **runtime-health** → report → structural check → applied-change explanation → bounded next observation   | runtime-health |
