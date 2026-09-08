---
name: skill-harness
description: "Maintain Skill Harness intents on demand and inspect runtime health."
---

# Skill Harness

Use this skill for explicit, user-triggered maintenance of the Skill Harness intent catalog or for a report-only runtime health audit. The plugin still owns per-turn routing, first-install seeding, automated Review, statistics, and session cleanup.

## Quick routing

```
What does the user want?
├─ Verify or seed a new plugin install → first-install initialization
├─ Bootstrap or re-audit the ENTIRE catalog → inventory
├─ Create, rename, or refine ONE intent → design
└─ Inspect runtime state, Review outcomes, or retention → runtime-health
```

Do not route `extract`, complexity analysis, split, merge, or deletion requests into a manual skill workflow. The reviewer subagent owns evidence-backed intent complexity and lifecycle operations, including `create`, `refine`, `split`, `merge`, and guarded `delete`. A standalone delete is limited to one existing obsolete intent per Review finding.

## First-install initialization

Use this only when the plugin is newly installed or the runtime intent catalog has never been initialized:

1. Confirm the plugin is built and enabled in OpenClaw.
2. Resolve the runtime data root. With the default state directory, it is `~/.openclaw/plugins/skill-harness/`.
3. Inspect `intents/`. Missing or empty Markdown means first-install seeding; any existing Markdown means preserve the catalog.
4. Start or restart the plugin. `initializePluginDataRoot()` copies `skills/skill-harness/assets/*.md` only when no runtime Markdown exists.
5. Verify seeded files and report what was initialized or retained. Do not hand-edit runtime intents, Review logs, stats, sessions, or experiences.

## Mode: inventory

Use this when the user asks to bootstrap or re-audit the entire intent system. Read and follow `references/inventory.md`; keep discovery, capability mapping, clustering, calibration, gap drafting, and format checks visible. Inventory may propose gaps, but boundary-changing split, merge, or deletion decisions remain reviewer-owned.

## Mode: design

Use this when the user asks to create, rename, or refine one intent. Read `references/design.md`, ask one interview question at a time with `references/interview.md`, ground the request against the active runtime catalog, draft with `references/format.md`, and deliver through `references/closing.md`. Do not use design to analyze complexity, split, merge, or delete intents; hand those decisions to Intent Review.

## Mode: runtime-health

Use this when the user asks for Skill Harness health, Review outcome distributions, per-intent route reasons and scores, session retention, QMD state, or disk growth. Read and follow `references/runtime-health-audit.md`. Run the report-only `scripts/runtime-health-audit.py` locally, keep output private, and never modify runtime state from audit findings.

## Shared safety rules

- Keep runtime session text, tool payloads, Review evidence, and agent artifacts private.
- Do not hand-edit `review.json`, `stats.json`, session files, experience records, or package files.
- Keep intent files routing-only: canonical frontmatter, concrete triggers/examples, optional lowercase `keywords` and `skills`, and one plain-text guidance sentence.
- Keep workflows, commands, and durable lessons in referenced skills rather than intent definitions.
- For a broad, destructive, or boundary-changing request, show the plan and wait for explicit confirmation before writing. If the requested action is split, merge, or delete, route it to the reviewer-owned lifecycle instead of applying it manually.

## Test prompts

| Prompt                                           | Expected mode                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| “Audit the entire intent system from scratch”    | `inventory` → discovery → clustering → calibration → gap draft             |
| “Help me create a new intent for git operations” | `design` → interview → ground → draft → format check                       |
| “統計過去 Review 產生的修改分布”                 | `runtime-health` → private report → structural check → bounded observation |
