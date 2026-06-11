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

## Failure modes

| Trigger | First fix | Fallback |
|---------|-----------|----------|
| **Interview stalls** — user does not reply or gives vague answers | Restate the question with recommended options ("A or B?") | Mark as `incomplete`, suggest resuming later |
| **Discovery scan fails** — skills directory missing or empty | Verify path, prompt user to confirm skills location | Accept manual capability list, tag as `manual_input` |
| **Clustering finds orphan capabilities** | Mark as `unclustered`, recommend creating a new intent | Keep orphan list for next audit cycle |
| **Closing collision warning** — new intent overlaps existing | Suggest split or merge, show collision details | Force-create but tag as `experimental`, flag for next review |
| **format-rules.md validation fails** | Read error message, fix format and retry | Display full format-rules.md for manual inspection |
| **Backlog finding already processed** | Skip, mark as `already_processed` | Re-check sessions/evolution.json state |

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
