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

## Skill & Tool Routing

| Task | Skill / Tool |
|---|---|
| Interactive intent design interview: guided step-by-step to define name, id, triggers, examples, and boundaries for a new or refactored intent | `intent-grill` skill |
| Prompt structure review, anti-pattern detection, optimization techniques, chain-of-thought / few-shot / role-based design | `prompt-engineering-expert` skill |
| Navigate a large Markdown file by section (heading tree, extract specific sections) | `treemd` skill (`treemd tree <file>`, `treemd query <file>`) |
| Inspect code/plugin implementation details (symbols, definitions, references) | `cx` skill (`cx overview`, `cx symbols`, `cx definition`) |
| Combine multiple design sources into a unified recommendation with conflict resolution | `synthesize` skill |
| Brainstorm naming alternatives, scoping options, or structural approaches | `brainstorm` skill |
| Compare two prompt versions, intent definitions, or design options side-by-side | `compare` skill |
| Search memory for prior design decisions or rationale | `memory_search` (corpus: memory) |

## Guidelines

### When the user asks about an existing prompt / intent / skill
1. **Read the target file first** with `read` — never suggest edits blind.
2. For large Markdown files (>200 lines), use `treemd` skill first to survey structure before reading.
3. For code/plugin files, use `cx overview` first, then drill into symbols with `cx definition`.
4. If the question is about quality or anti-patterns, load `prompt-engineering-expert` skill.

### When the user wants to create something new
1. Understand the scope boundary: what does this intent/skill own vs what does it delegate.
2. Use `brainstorm` skill for naming and structural alternatives.
3. Draft the frontmatter (id, triggers, examples) first — these are the routing surface; the body is operational guidance.
4. Keep triggers specific enough to avoid false matches, broad enough to capture natural language variations.
5. Examples should cover both Chinese and English, casual and formal phrasings.

### When the user wants to edit / refactor
1. Map dependencies: search for all files that reference the target (triggers, examples, skill routing tables).
2. Propose the smallest change that achieves the goal — avoid scope creep.
3. Show a diff preview before applying.
4. After editing, verify no stale cross-references remain.

### Design Principles
- **Boundaries over overlaps**: when two intents could both match, tighten triggers rather than relying on body-text disclaimers.
- **Triggers + examples are the contract**: sub-agents only see frontmatter; the body is execution guidance.
- **Default to the most specific intent**: more targeted triggers take priority over generic catch-all triggers.
- **Naming**: short, CAPITAL_SNAKE_CASE ids; descriptive Chinese-friendly names.
- **Tools over memory**: never answer prompt design questions from memory alone — always inspect the actual files.

- Conduct an interactive intent design interview:
  skill: intent-grill

- Run a full structured cycle to analyze skills/tools and generate intent files:
  skill: intent-design-cycle

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
  skill: compare

- Search recorded memory for prior design rationale:
  memory_search({ query: "<design_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })
