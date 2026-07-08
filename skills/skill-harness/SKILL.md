---
name: skill-harness
description: "Design, inventory, or extract intent definitions for the skill-harness plugin. Use when creating/refining a single intent (design), bootstrapping or re-auditing the full catalog (inventory), or analyzing intent complexity and extracting oversized intents into skills (extract)."
---

# Skill Harness

Manage the human-facing lifecycle of intent definitions: single-intent CRUD (design), full-catalog bootstrap/re-audit (inventory), and complexity analysis or skill extraction (extract). Background subagents handle automated self-improvement; do not process review findings manually through this skill.

## Quick routing

```
What does the user want?
├─ Bootstrap or re-audit the ENTIRE catalog → inventory
├─ Create/rename/split/merge/refine ONE intent → design
└─ Check intent complexity / upgrade intents to skills → extract
```

If ambiguous, ask one routing question: "Are you working on a single intent, auditing the whole system, or analyzing intent complexity?"

## Shared operating rules

- Prefer structured file/search tools available in the host environment for listing, reading, and searching files. In Hermes, that means `search_files`, `read_file`, `write_file`, and `patch` before shell equivalents.
- Treat shell snippets in older notes as implementation examples, not required commands. Use terminal only for package/test/build commands or when no structured tool exists.
- Current source layout:
  - Bundled skill assets live under this skill directory, especially `assets/` and `references/`.
  - Runtime editable intents live under `~/.openclaw/plugins/skill-harness/intents/` unless the user provides another runtime root.
  - Do not assume a single user-local skill directory is the only skill source; inventory should include bundled extension skills, configured user/runtime skills, and the active OpenClaw skill catalog when available.
- For broad, destructive, or routing-identity changes (rename, split, merge, deletion, extraction), present the plan and wait for explicit confirmation before writing.
- Check changed intent files for canonical format: valid frontmatter shape, required sections in order, concrete triggers/examples, consistent skill/tool hints, and no body cross-references to other intent ids.
- When reviewing, creating, splitting, merging, or extracting intents, validate domain-intent consistency using `references/clustering.md`.

---

## Mode: inventory

### When to use

User wants to bootstrap or re-audit the **entire** intent system.

Keywords: "audit intents", "bootstrap intents", "re-audit", "check intent coverage", "find missing intents"

### Workflow

Read and follow `references/inventory.md`. Keep these checkpoints visible:

1. **Discovery scan** — use `references/discovery.md` to inventory bundled skills, configured/user skills, active tools, and existing runtime intents.
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

| #   | Anti-pattern                                   | Why not                                      | Do instead                                         |
| --- | ---------------------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| 1   | **Run inventory without discovery/clustering** | Misses capabilities, produces orphan intents | Follow order: discovery → clustering → calibration |
| 2   | **Assume one hardcoded skill directory**       | OpenClaw may load bundled and runtime skills | Scan the active catalog and configured skill roots |
| 3   | **Skip cluster map checkpoint**                | User cannot calibrate, may miss gaps         | Present cluster map before interview/generation    |

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

| #   | Anti-pattern                                    | Why not                                                        | Do instead                                                           |
| --- | ----------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | **Ask multiple questions at once**              | Confuses user, degrades response quality                       | Interview one question at a time                                     |
| 2   | **Cross-reference other intents in body**       | Classifier only sees frontmatter, while fastpaths use metadata | Express boundaries via triggers, examples, domain, and fastpath only |
| 3   | **Skip format rules before writing**            | Inconsistent format breaks plugin parsing                      | Read `references/format.md` first                                    |
| 4   | **Create a new intent when one already exists** | Causes duplication and collision                               | Check existing intents during interview                              |
| 5   | **Use vague descriptions as triggers**          | Classification cannot match accurately                         | Use concrete phrases or keywords                                     |

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

### First-time setup assets

When bootstrapping from scratch, copy example intent templates from `assets/`:

- `assets/chat.md` / `assets/typo.md` — minimal behavior-only intents (no tools)
- `assets/approve.md` / `assets/reject.md` — approval-flow intents
- `assets/memory-lookup.md` / `assets/memory-compare.md` — memory retrieval SOPs

### Format check principles

Use structured file/search tools to inspect intent format. Keep checks simple and local:

- Frontmatter exists, closes before the body, and has required fields with the right shapes.
- Body sections appear in the canonical order from `references/format.md`.
- Triggers and examples are concrete, non-duplicative, and aligned with the filename-derived intent id.
- Skill/tool hints follow the expected Markdown shape.
- Body text does not cross-reference other intent ids.
- Proposed triggers do not obviously collide with existing runtime intent boundaries.

### Decision style

- Recommend defaults confidently; keep cognitive load low.
- Favor simple, maintainable intent boundaries over clever taxonomy.
- Keep `SKILL.md` concise; put detailed mode-specific procedures in `references/*.md`.

### Test prompts (dry_run)

| #   | Prompt                                           | Expected behavior                                                                                                 | Mode      |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | "Audit the entire intent system from scratch"    | Route to **inventory** → discovery → clustering → 🔴 CHECKPOINT → interview → generate → review                   | inventory |
| 2   | "Help me create a new intent for git operations" | Route to **design** → classify=create → interview → ground → draft → format check                                 | design    |
| 3   | "Which intents are too complex?"                 | Route to **extract** → complexity scan → sub-responsibility analysis → 🔴 CHECKPOINT → draft blueprints → deliver | extract   |
