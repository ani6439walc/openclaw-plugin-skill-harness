# Extract Workflow

Analyze intent complexity and recommend extracting oversized intents into standalone skills. This is a **proactive** analysis mode that identifies structural bloat before it degrades classification quality.

## When to enter

- User asks to check intent complexity, find oversized intents, or upgrade intents to skills.
- Inventory mode reveals intents above the complexity threshold.
- The user suspects an intent has grown too large or handles too many responsibilities.

## Safety rules

- Never modify intent files or create skills without explicit user confirmation.
- Treat the analysis as advisory — the user decides what to extract.
- Preserve existing triggers and examples when proposing intent slim-down.
- Prefer drafts and diff previews before writes.

## Step 1 — Complexity scan

Score every runtime intent in the active OpenClaw-resolved catalog. With the default local state directory, this is `~/.openclaw/plugins/skill-harness/intents/`.

Use structured file/search tools where available:

- List all intent Markdown files.
- Count lines per intent.
- Parse frontmatter to count triggers and examples.
- Search body sections for skill/tool references.
- Read suspiciously large intents to identify distinct sub-responsibilities.

### Complexity score

```
complexity_score =
  line_count × 0.3 +
  trigger_count × 2.0 +
  example_count × 0.5 +
  unique_tool_or_skill_refs × 1.5 +
  distinct_sub_responsibility_count × 5
```

Count `distinct_sub_responsibility_count` by identifying separate thematic clusters in `## Guidelines`, `## Response Strategy`, and `## Concrete Workflow`. Each unrelated concern counts as one.

### Thresholds

| Score   | Level      | Action                        |
| ------- | ---------- | ----------------------------- |
| 0–50    | 🟢 Healthy | No action needed              |
| 51–100  | 🟡 Monitor | Flag in next inventory review |
| 101–150 | 🟠 Warning | Recommend rewrite or split    |
| 150+    | 🔴 Extract | Strongly recommend extraction |

Output a ranked table: `intent-id | lines | triggers | examples | sub-responsibilities | score | level`.

## Step 2 — Sub-responsibility analysis

For each 🔴 or high 🟠 intent:

1. Read the full intent file.
2. Identify distinct sub-responsibilities — groups of guidelines, tools, and examples that serve different user goals and could operate independently.
3. For each sub-responsibility, assess:
   - **Independence**: Can it function as a standalone skill with its own workflow?
   - **Cohesion**: Does it have a clear, single purpose?
   - **Volume**: Does it have enough depth (tools, steps, edge cases) to justify a skill?
4. Propose an extraction plan:

```
Intent: <intent-id> (<lines> lines, score: <score>)
├── Extract → Skill: <proposed-skill-name>
│   ├── Sub-responsibilities: <list>
│   ├── Tools/skills referenced: <list>
│   └── Estimated SKILL.md size: <small/medium/large>
├── Extract → Skill: <proposed-skill-name-2> (if applicable)
│   └── ...
└── Remainder → Slimmed intent (<estimated lines> lines)
    ├── Retained triggers: <count>
    └── Retained guidelines: <summary>
```

**🔴 CHECKPOINT**: Present the extraction plan to the user. Do not proceed without confirmation.

## Step 3 — Draft skill blueprints

For each confirmed extraction:

1. Draft a `SKILL.md` following standard skill format:
   - frontmatter with `name` and `description`
   - clear workflow steps derived from the intent's guidelines
   - tool and skill references preserved from the original intent
   - failure modes and anti-patterns if the original intent included them

2. Draft the slimmed-down intent:
   - Keep only classification triggers and examples needed for routing.
   - Replace detailed guidelines with frontmatter `skills[]` plus concise routing guidance:

     ```yaml
     ---
     triggers:
       - "<retained trigger>"
     examples:
       - "<retained example>"
     domain: "<domain>"
     skills:
       - <new-skill-name>
     ---
     ```

     ```markdown
     ## Guidelines

     - Route this request to the extracted skill workflow for detailed execution.

     ## Response Strategy

     - Keep the intent focused on classification and handoff; do not duplicate the extracted workflow.

     ## Experience

     - Use `<new-skill-name>` skill when this intent matches and detailed execution is required.
     ```

   - Target: under 50 lines for the slimmed intent.

3. Show both drafts to the user as a diff preview:
   - Original intent → slimmed intent.
   - New skill `SKILL.md` draft.

## Step 4 — Deliver

There is no required specialized skill-authoring tool path. Use the tools available in the host environment:

- If the user only wants a proposal, deliver drafts and stop.
- If the user confirms writing, create the new skill directory and `SKILL.md` under the appropriate skills path, then update the slimmed runtime intent.
- If the target skill path is ambiguous, ask where to write before making changes.

## Step 5 — Format checks

Use structured file/search tools to check:

- New `SKILL.md` frontmatter exists and includes `name` and `description`.
- The slimmed intent frontmatter has required fields with the right shapes.
- The slimmed intent keeps enough triggers/examples for routing.
- Skill dependencies are listed in frontmatter `skills[]`; no legacy `## Skills & Tools` section remains.
- Experience entries follow `references/format.md`, including `Use `<skill-name>` skill when ...` phrasing for skill-specific guidance.
- Concrete shell commands and mcporter-backed documentation lookups remain as bare commands in `## Experience`; `mcporter` is included in `skills[]` when those commands are required.
- Proposed triggers do not obviously collide with remaining runtime intents.
- The slimmed intent and any moved/renamed domain relationship pass the domain-intent consistency criteria in `references/clustering.md`.

Report files created/modified, format-check results, and remaining pending extractions if any.

## Failure modes

| Trigger                                   | First fix                                              | Fallback                                              |
| ----------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| **No intents above threshold**            | Report all scores, confirm system is healthy           | Suggest re-running after adding more intents          |
| **Sub-responsibility boundaries unclear** | Ask user to clarify which parts should stay vs extract | Keep intent unchanged, flag for next review           |
| **Skill name collision**                  | Suggest alternative name, check existing skills        | Use namespaced name (e.g., `<domain>-ops`)            |
| **User rejects extraction**               | Respect decision, mark as reviewed                     | Suggest lighter alternative (rewrite guidelines only) |

## Anti-patterns

| #   | Anti-pattern                            | Why not                                        | Do instead                                                   |
| --- | --------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| 1   | **Auto-extract without confirmation**   | Destructive change to intent routing           | Always present plan and get explicit approval                |
| 2   | **Extract too aggressively**            | Creates skill sprawl, fragments related logic  | Only extract when sub-responsibilities are truly independent |
| 3   | **Leave intent empty after extraction** | Intent still needed for classification routing | Keep slimmed intent with triggers + frontmatter `skills[]`   |
| 4   | **Ignore format rules when drafting**   | Inconsistent skill and intent structure        | Follow `references/format.md` and standard skill format      |
| 5   | **Skip format checks after delivery**   | May break classification or skill loading      | Always run local format checks before reporting done         |
