---
name: intent-grill
description: Interview the user to create or refine a new intention-hint-plugin intent definition that follows the project's README intent rules. Use when the user wants to add a new intent, rename an intent, split or merge intent boundaries, or design triggers/examples/body structure for an intent file.
---

Interview the user to define one new intent at a time for the intention-hint plugin.

Use the project's intent rules in `extensions/intention-hint/README.md` as the source of truth for:

- frontmatter vs body responsibilities
- trigger and example scope
- body structure
- memory-family escalation and boundary rules when relevant

Ask questions one at a time.

For each question:

- explain briefly why the decision matters
- give your recommended answer or default
- wait for the user's reply before moving on

Your job is to help the user converge on a clean intent definition, not to brainstorm endlessly.

## Opening decision tree

At the start of the interview, first classify the user's request into one of these paths:

1. create a brand-new intent
2. rename an existing intent
3. split an overloaded intent into smaller ones
4. merge two overlapping intents
5. refine an existing intent without renaming it

If the path is ambiguous, ask a single routing question first.
For that opening question:

- explain why the path matters
- recommend the most likely path
- then continue the interview using that path as the frame

## Interview goals

Reach a shared decision on these fields in order:

1. intent purpose and boundary
2. best name and `id`
3. filename
4. `triggers`
5. `examples`
6. body scope
7. skills and tools worth hinting (→ `## Skills & Tools` section)
8. whether the intent overlaps with an existing one and should instead be split, merged, or renamed

## Interview rules

- Ask only one question at a time.
- If the answer can be grounded by reading the current `README.md` or existing `intents/*.md`, do that instead of asking a vague question.
- Prefer narrowing scope over making a broad catch-all intent.
- If the user is really describing an existing intent, say so directly.
- If two intents are colliding, recommend the smallest clean split.
- Do not write the final intent file until the user has answered enough to make the boundary clear.
- **No cross-references in body**: the markdown body must never mention other intents by name or id. The classification sub-agent only sees frontmatter (triggers + examples), so body-text disclaimers like "not covered: go to INTENT_X" are invisible at routing time. All scope boundaries must be expressed through triggers and examples alone.

## Closing mode

When enough information is collected, stop asking discovery questions and switch into closing mode.

In closing mode, produce these sections in order:

1. boundary summary
2. recommended `id`, `name`, and filename
3. collision warning, if the proposed intent still overlaps an existing one
4. final draft intent file

The boundary summary should explain:

- what this intent should handle
- what it should not handle
- which neighboring intents it is closest to

If the proposed design is still too broad or collides badly with an existing intent, do not force a final draft yet. Say what decision is still unresolved and ask the smallest next question.

When proposing skill or tool hints inside the final draft:

- use the README's required skill format
- use the README's required tool-call format
- do not invent ad-hoc labels or freeform tool prose when a concrete call shape is more appropriate

Examples:

```markdown
- Read a large Markdown document by section:
  skill: treemd
- Search recorded memory:
  memory_search({ query: "<subject_A_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })
```

**Skill/tool hint format (required):**
- Description and skill/tool on the same list item, separated by a colon.
- The skill line is indented two spaces under the list item: `  skill: <skill_name>`
- Tool calls follow the same pattern: `- <description>: <tool_name>({ ... })`

## Output shape after the interview

When enough information is collected, produce a draft in this shape:

```markdown
---
id: <INTENT_ID>
name: <Human Readable Name>
triggers:
  - "..."
examples:
  - "..."
---

Detected "<intent>" intent. <One-sentence explanation.>

## Guidelines

- ...
- ...

## Skills & Tools

- ...
- ...

## Response Strategy

- ...
- ...

## Concrete Workflow

```
Step 1 → Step 2 → ...
```

### Step 1 — ...
...
```

**When to include `## Concrete Workflow` in the generated intent:**

- **Always include it** for intent families that involve multi-step retrieval or operational procedures (e.g., memory-*, system-diagnostics, browser-automation, research-*).
- **Include it** when the intent requires a specific sequence: keyword extraction → search → validate → read → respond.
- **Skip it** for simple intents where Guidelines + Response Strategy already fully capture the behavior (e.g., `chat`, `typo`, `x-twitter-automation`).
- **Rule of thumb**: if you can describe the intent's execution as "Step 1 → Step 2 → ...", add a `## Concrete Workflow`. If it's just "follow these rules", skip it.

**How to generate the workflow content:**

1. During the interview, ask the user:「這個意圖需要具體的執行步驟嗎？像是 Step 1→2→3 的流程？」
2. If yes, co-design the steps: extract the key actions from the intent's purpose.
3. Structure each step as: `### Step N — <name>` with bullet-point details underneath.
4. Include tool call examples inside relevant steps when the step involves a specific tool invocation.
5. Keep steps numbered, short, and actionable — not explanatory prose.

**Section ordering (fixed):****
1. YAML frontmatter (id, name, triggers, examples)
2. Detected intent detection line
3. `## Guidelines` — behavioral rules and constraints
4. `## Skills & Tools` — skill names and tool call shapes the Main Agent should use
5. `## Response Strategy` — step-by-step retrieval and response logic

**Skills & Tools section rules:**
- This section sits between Guidelines and Response Strategy.
- It lists **skills** the agent should load and **tool calls** the agent should execute for this intent.
- Use the required skill format:
  ```markdown
  - <description>:
    skill: <skill_name>
  ```
- Use the required tool-call format:
  ```markdown
  - <description>:
    <tool_name>({ ... })
  ```
- Do not mix prose instructions here — keep it to actionable skill/tool references.
- The Main Agent reads this section to know which capabilities to activate before executing the Response Strategy.

## Grounding checklist

Before proposing the final draft:

- read `extensions/intention-hint/README.md`
- inspect neighboring intent files in `extensions/intention-hint/intents/`
- check whether the proposed name or scope overlaps an existing intent

## Concrete Workflow

**User-specified flow override:**

If the user **explicitly specifies a custom step order** during creation (e.g., "do X first then Y", "follow SOP Step 1→2→3"):

1. **Follow the user's flow**, overriding this SKILL.md's default steps.
2. If the user's flow is incomplete (missing key steps), supplement with calibration questions after completing their steps.
3. If the user's flow conflicts with intent rules (e.g., skips boundary confirmation), warn but comply: "Confirming the boundary first would be safer, but I'll follow your order."
4. Record the user's flow preference for reuse in future similar creations.

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
classify    interview   ground        draft        deliver
```

### Step 1 — Classify Intent (Opening Decision Tree)
- Classify the user's request into one of five paths: create, rename, split, merge, refine.
- If ambiguous, ask a single routing question first.

### Step 2 — Interview Calibration (Interview Goals)
- Confirm fields in order: boundary → id/name → filename → triggers → examples → body → skills/tools → collision check.
- **Ask only one question at a time, wait for reply, then proceed.**

### Step 3 — Ground (Research)
- Before asking questions, read `README.md` and existing `intents/*.md` to avoid duplication or conflicts.
- If documentation can answer the question, don't ask vague questions.

### Step 4 — Draft (Closing Mode)
- Produce the final intent file draft with full frontmatter + Guidelines + Skills & Tools + Response Strategy.
- Write to a staging location first, do not overwrite production files directly.

### Step 5 — Deliver Confirmation
- Show the user a diff preview, confirm no conflicts, then write to `intents/`.

## Decision style

- Recommend defaults confidently.
- Keep the user's cognitive load low.
- Favor simple, maintainable intent boundaries over clever taxonomy.
