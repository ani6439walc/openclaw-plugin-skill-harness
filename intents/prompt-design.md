---
id: PROMPT_DESIGN
name: Prompt / Intent / Skill Design Query
enabled: true
triggers:
  - "User wants to design, refine, rename, audit, or improve prompts, custom instructions, skills, plugin intents, or agent routing behavior — including naming, scoping, and boundary setting"
  - "User asks about prompt engineering techniques (chain-of-thought, few-shot, XML tags, role-based prompting) or needs help debugging a prompt that produces wrong results"
  - "User is reviewing or auditing existing prompts, intents, or skills for quality, consistency, overlaps, or anti-patterns"
  - "User wants to edit, modify, or update the content of an existing intent Markdown file — adding or removing sections, changing guidelines, or updating tools in an intent file"
  - "User wants to be interviewed one-question-at-a-time to discover their real underlying intent behind an underspecified request"
  - "User wants to stress-test, grill, or adversarially review a plan, design, or decision until reaching shared understanding"
  - "User wants to challenge their plan against existing domain models, CONTEXT.md, or ADRs"
examples:
  - "這個 intent 要改名嗎？"
  - "幫我設計一個新的 intent"
  - "這個行為應該放到獨立的 intent 嗎？"
  - "這個 prompt 一直出不對的結果，怎麼修？"
  - "review 一下現有的 intent 有沒有重疊"
  - "這個 skill 的 scope 太大了，怎麼拆？"
  - "幫我修改 AGENT_ADMIN 這個意圖的 Markdown 檔案內容"
  - "把 skill-cleaner 加到某個意圖的 Skills & Tools 裡"
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
- If a referenced skill, prompt, or intent file returns `ENOENT` or a permission error, do not retry the same path unchanged; search likely skill/workspace locations, check memory for recorded paths, or ask for the correct source.
- Map dependencies before refactoring: search for all files that reference the target.
- Propose the smallest change that achieves the goal — avoid scope creep.
- When external specifications, guides, or standards are provided, fetch and compare them against the current prompt, intent, or skill before drafting changes.
- Show a diff preview before applying any edits.
- After editing, verify no stale cross-references remain.

## Skills & Tools

- Design, refine, or audit intent definitions (single-intent interview or full bootstrap audit):
  skill: intention-hint

- Interview the user one-question-at-a-time to discover real intent:
  skill: interview-me

- Stress-test a plan or design through adversarial questioning:
  skill: grill-me

- Stress-test a plan against existing domain models and ADRs:
  skill: grill-with-docs

- Review prompt structure and anti-patterns:
  skill: prompt-engineering-expert

- Navigate a large Markdown file by section before reading:
  skill: treemd

- Inspect code/plugin implementation details:
  skill: cx

- Combine multiple design sources into unified recommendation:
  skill: synthesize

- Fetch external specifications, guides, or standards for prompt/skill/intent refinement:
  web_fetch({ url: "<spec_or_guide_url>" })

- Brainstorm naming or scoping alternatives:
  skill: brainstorm

- Compare two intent definitions or design options:
  skill: dev-lifecycle
  skill: compare

- Search recorded memory for prior design rationale or missing file locations:
  memory_search({ query: "<design_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })

- Discover likely prompt, skill, or intent files when a referenced path is missing:
  exec({ command: "find ~/.openclaw/skills ~/.openclaw/workspace -name 'SKILL.md' -o -name '*.md' | grep -i '<keyword>'", workdir: "~/.openclaw" })

## Response Strategy

- Determine the user's goal: design new, refine existing, audit, or debug.
- For specific, concrete tweaks (for example changing a format, renaming a tag, adjusting one value, or updating an intent Markdown section): skip high-level design analysis, directly read the file, apply the exact change, and show the diff. Do not repeat previous design proposals or treat the request as a new design query.
- For existing items: read the file first, then analyze.
- For new designs: use `intention-hint` for interactive interview.
- For audits: check for overlaps, anti-patterns, inconsistencies.
- For debugging: inspect the prompt/skill, identify the failure mode, suggest fixes.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5 → Step 6 → Step 7
classify   ground      recover     specs       analyze      draft/fix    verify
goal       files       missing     if any      & compare    & edit       & diff
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

### Step 3 — Recover Missing References
- If a target skill, prompt, or intent `read` fails with `ENOENT` or permission errors, stop retrying the identical path.
- Search likely locations with `exec` and a keyword from the requested source.
- Use `memory_search` to check whether the source path or renamed skill was previously recorded.
- If discovery still fails, report the missing source and ask whether to skip it or provide the correct path.

### Step 4 — Incorporate External Specifications
- When URLs, standards, or external guide documents are provided, fetch them with `web_fetch`.
- Extract key principles, structural rules, naming conventions, and anti-patterns.
- Use `synthesize` when multiple external sources need to be unified into one recommendation.
- Compare the external guidance against the current file from Step 2 and identify concrete sections to reorganize, rename, split, merge, or refine.

### Step 5 — Analyze & Compare
- Check for overlaps with neighboring intents.
- Identify anti-patterns or scope creep.
- Use `compare` skill to evaluate design options side-by-side.
- Use `brainstorm` for naming or scoping alternatives.

### Step 6 — Draft or Fix
- For new designs: use `intention-hint` interactive interview.
- For refinements: propose the smallest change.
- For debugging: identify failure mode and suggest targeted fixes.
- Show a diff preview before applying.

### Step 7 — Verify
- After editing, verify no stale cross-references remain.
- Check triggers are specific enough to avoid false matches.
- Confirm examples cover both Chinese and English phrasings.
