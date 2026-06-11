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

## Mode: audit

User wants to bootstrap or re-audit the entire intent system (first install or after many new skills/tools).

Read order:

1. `references/discovery.md`
2. `references/clustering.md`
3. `references/interview.md`
4. `references/format-rules.md`
5. `references/closing.md`

Then follow: discovery → clustering → interview → generate → review.

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

## First-time setup (assets)

When bootstrapping from scratch, copy example intent templates from `assets/` as starting points:

- `assets/chat.md` / `assets/typo.md` — minimal behavior-only intents (no tools)
- `assets/memory-lookup.md` / `assets/memory-compare.md` / `assets/memory-timeline.md` — memory retrieval SOPs
- `assets/summarization.md` / `assets/research-general.md` — multi-source routing patterns

These are English example templates. Adapt to the project's language and intent scope.

## Decision style

- Recommend defaults confidently; keep cognitive load low.
- Favor simple, maintainable intent boundaries over clever taxonomy.
