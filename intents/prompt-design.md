---
id: PROMPT_DESIGN
name: Prompt / Intent / Skill Design Query
enabled: true
triggers:
  - "User wants to design, refine, rename, audit, or improve prompts, custom instructions, skills, plugin intents, or agent routing behavior — including naming, scoping, and boundary setting"
  - "User asks about prompt engineering techniques (chain-of-thought, few-shot, XML tags, role-based prompting) or needs help debugging a prompt that produces wrong results"
  - "User is reviewing or auditing existing prompts, intents, or skills for quality, consistency, overlaps, or anti-patterns"
examples:
  - "這個 intent 要改名嗎？"
  - "幫我設計一個新的 intent"
  - "這個行為應該放到獨立的 intent 嗎？"
  - "這個 prompt 一直出不對的結果，怎麼修？"
  - "review 一下現有的 intent 有沒有重疊"
  - "這個 skill 的 scope 太大了，怎麼拆？"
---

Detected "prompt design" intent. The user wants help designing or refining prompts, intents, skills, or agent behavior.

## Guidelines

- When working with existing prompts/intents/skills: read the target file first with `read` — never suggest edits blind.
- For large Markdown files (>200 lines), use `treemd` skill first to survey structure before reading.
- For code/plugin files, use `cx overview` first, then drill into symbols with `cx definition`.
- Understand the scope boundary: what does this intent/skill own vs what does it delegate.
- Keep triggers specific enough to avoid false matches, broad enough to capture natural language variations.
- Examples should cover both Chinese and English, casual and formal phrasings.
- Boundaries over overlaps: when two intents could both match, tighten triggers rather than relying on body-text disclaimers.
- Triggers + examples are the contract: sub-agents only see frontmatter; the body is execution guidance.
- Default to the most specific intent: more targeted triggers take priority over generic catch-all triggers.
- Naming: short, CAPITAL_SNAKE_CASE ids; descriptive Chinese-friendly names.
- Never answer prompt design questions from memory alone — always inspect the actual files.
- Map dependencies before refactoring: search for all files that reference the target.
- Propose the smallest change that achieves the goal — avoid scope creep.
- Show a diff preview before applying any edits.
- After editing, verify no stale cross-references remain.

## Skills & Tools

- Design, refine, or audit intent definitions (single-intent interview or full bootstrap audit):
  skill: intent-craft

- Review prompt structure and anti-patterns:
  skill: prompt-engineering-expert

- Navigate a large Markdown file by section before reading:
  skill: treemd

- Inspect code/plugin implementation details:
  skill: cx

- Combine multiple design sources into unified recommendation:
  skill: synthesize

- Brainstorm naming or scoping alternatives:
  skill: brainstorm

- Compare two intent definitions or design options:
  skill: dev-lifecycle
  skill: compare

- Search recorded memory for prior design rationale:
  memory_search({ query: "<design_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })

## Response Strategy

- Determine the user's goal: design new, refine existing, audit, or debug.
- For existing items: read the file first, then analyze.
- For new designs: use `intent-craft` for interactive interview.
- For audits: check for overlaps, anti-patterns, inconsistencies.
- For debugging: inspect the prompt/skill, identify the failure mode, suggest fixes.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
classify   ground      analyze      draft/fix    verify
goal       files       & compare    & edit       & diff
```

### Step 1 — Classify Goal
- Create new intent/skill/prompt.
- Refine existing (rename, split, merge, tighten).
- Audit for quality, overlaps, anti-patterns.
- Debug a prompt that produces wrong results.

### Step 2 — Ground in Existing Files
- Read the target file(s) — never edit blind.
- For large files: use `treemd` to survey structure first.
- For code files: use `cx overview` then `cx definition`.
- Search memory for prior design decisions or rationale.

### Step 3 — Analyze & Compare
- Check for overlaps with neighboring intents.
- Identify anti-patterns or scope creep.
- Use `compare` skill to evaluate design options side-by-side.
- Use `brainstorm` for naming or scoping alternatives.

### Step 4 — Draft or Fix
- For new designs: use `intent-craft` interactive interview.
- For refinements: propose the smallest change.
- For debugging: identify failure mode and suggest targeted fixes.
- Show a diff preview before applying.

### Step 5 — Verify
- After editing, verify no stale cross-references remain.
- Check triggers are specific enough to avoid false matches.
- Confirm examples cover both Chinese and English phrasings.
