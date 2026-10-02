---
name: skill-harness
description: "On explicit user request, maintain Skill Harness experiences or inspect runtime statistics, skill usage, routing diagnostics, and Review outcomes on demand."
---

# Skill Harness

Use this skill for explicit, user-triggered maintenance of Skill Harness experiences or for a report-only runtime health audit. The plugin owns per-turn skill discovery, experience retrieval, TypeSafe Jev selection, automated Review, statistics, and session cleanup.

## Quick routing

```
What does the user want?
├─ Inspect, draft, refine, or prune skill experiences → experience
└─ Inspect runtime state, Review outcomes, or retention → runtime-health
```

When optional Review is enabled (disabled by default), the reviewer subagent autonomously evaluates turns for capability fit and routing uncertainty, generating or refining experiences in `experiences/<id>/`.

## Mode: experience

Use this when the user asks to inspect, author, refine, or prune skill experiences manually. Read and follow `references/experience.md`. Maintain valid experience directory structure (`summary.md`, `keywords.md`, `body.md`, and optional `skills.md`) under `<dataRoot>/experiences/<id>/`.

## Mode: runtime-health

Use this when the user asks for Skill Harness health, Review outcome distributions, experience and skill discovery metrics, session retention, QMD state, or disk growth. Read and follow `references/runtime-health-audit.md`. Run the report-only `scripts/runtime-health-audit.py` locally. Report data coverage first, then query/selection observations, skill usage, experience retrieval, Review outcomes, and suggested checks or bounded experiments with supporting sample counts. Keep output private and never modify runtime state from audit findings. A healthy report does not prove Gateway loaded the plugin.

## Shared safety rules

- Keep runtime session text, tool payloads, Review evidence, and agent artifacts private.
- Do not hand-edit `review.json`, `stats.json`, or raw session files.
- Keep experience definitions focused, reusable, and self-contained: valid directory ID, plain-text summary, keywords, actionable body, and optional linked skill names. Prefer kebab-case; follow the validator’s actual ID rules. Validate manual changes with `scripts/validate-experiences.mjs` before relying on them.
- Do not store secrets, keys, or user-private conversation data in experience files.

## Test prompts

| Prompt                                              | Expected mode                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| “Help me create an experience for git rebase error” | `experience` → draft → validate structure (`references/experience.md`)     |
| “統計過去 Review 產生的修改分布”                    | `runtime-health` → private report → structural check → bounded observation |
