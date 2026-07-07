# Extract Workflow

Analyze intent complexity and recommend extracting oversized intents into standalone skills.
This is a **proactive** analysis mode — unlike `evolve` (reactive backlog processing), `extract`
identifies structural bloat before it degrades classification quality.

## When to Enter

- User asks to check intent complexity, find oversized intents, or upgrade intents to skills.
- After `inventory` mode reveals intents above the complexity threshold.
- When the user suspects an intent has grown too large or handles too many responsibilities.

## Safety Rules

- Never modify intent files or create skills without explicit user confirmation.
- Treat the analysis as advisory — the user decides what to extract.
- Do not confuse `extract` with `evolve`: extract analyzes complexity, evolve processes backlog findings.
- Preserve existing triggers and examples when proposing intent slim-down.

## Step 1 — Complexity Scan

Score every intent in `~/.openclaw/plugins/skill-harness/intents/`:

```bash
# Line count per intent
wc -l ~/.openclaw/plugins/skill-harness/intents/*.md | sort -rn

# Trigger count per intent
for f in ~/.openclaw/plugins/skill-harness/intents/*.md; do
  count=$(grep -c "^  - " "$f" 2>/dev/null || echo 0)
  echo "$count $(basename "$f")"
done | sort -rn

# Example count per intent
for f in ~/.openclaw/plugins/skill-harness/intents/*.md; do
  count=$(awk '/^examples:/,/^---$/' "$f" | grep -c "^  - " 2>/dev/null || echo 0)
  echo "$count $(basename "$f")"
done | sort -rn
```

### Complexity Score

```
complexity_score =
  line_count × 0.3 +
  trigger_count × 2.0 +
  example_count × 0.5 +
  unique_tool_or_skill_refs × 1.5 +
  distinct_sub_responsibility_count × 5
```

Count `distinct_sub_responsibility_count` by identifying separate thematic clusters in
`## Guidelines` — each unrelated concern (e.g., "device tracking" vs "K8s operations"
in the same intent) counts as one.

### Thresholds

| Score   | Level      | Action                        |
| ------- | ---------- | ----------------------------- |
| 0–50    | 🟢 Healthy | No action needed              |
| 51–100  | 🟡 Monitor | Flag in next inventory review |
| 101–150 | 🟠 Warning | Recommend rewrite or split    |
| 150+    | 🔴 Extract | Strongly recommend extraction |

Output a ranked table: `intent-id | lines | triggers | examples | sub-responsibilities | score | level`

## Step 2 — Sub-Responsibility Analysis

For each 🔴 or high 🟠 intent:

1. Read the full intent file.
2. Identify distinct sub-responsibilities — groups of guidelines, tools, and examples
   that serve different user goals and could operate independently.
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

## Step 3 — Draft Skill Blueprints

For each confirmed extraction:

1. Draft a `SKILL.md` following the standard skill format:
   - `name`, `description`, `metadata` frontmatter
   - Clear workflow steps derived from the intent's guidelines
   - Tool and skill references preserved from the original intent
   - Failure modes and anti-patterns if the original intent included them

2. Draft the slimmed-down intent:
   - Keep only classification triggers and examples (enough for the classifier to route)
   - Replace detailed guidelines with a skill hint:

     ```markdown
     ## Skills & Tools

     - skill: <new-skill-name>
       Load and follow the skill workflow for detailed execution.
     ```

   - Target: <50 lines for the slimmed intent

3. Show both drafts to the user as a diff preview:
   - Original intent → slimmed intent
   - New skill SKILL.md (full draft)

## Step 4 — Deliver

### If `skill_workshop` tool is available

Use `skill_workshop` with `action=create` to create each new skill:

```
skill_workshop(
  action="create",
  skill_name="<proposed-name>",
  description="<concise description under 160 bytes>",
  proposal_content=<full SKILL.md content>
)
```

Then update the original intent file with the slimmed version.

### If `skill_workshop` tool is NOT available

Ask the user:

> "Ani 已經準備好技能藍圖了！要把這些寫成檔案嗎？
>
> - 寫入檔案（Ani 會建立 SKILL.md 並更新 intent）
> - 先不寫，只看草稿就好"

If the user confirms, write:

1. New skill directory and `SKILL.md` under the appropriate skills path.
2. Updated (slimmed) intent file in `~/.openclaw/plugins/skill-harness/intents/`.

### Post-delivery validation

```bash
# Verify new skill file exists and has valid frontmatter
cat <new-skill-path>/SKILL.md | head -5

# Check for trigger collisions between new skills and remaining intents
grep -l "<key-trigger>" ~/.openclaw/plugins/skill-harness/intents/*.md
```

Verify the slimmed intent still matches the plugin schema with
`pnpm test src/intent-validation.test.ts`.

Report: files created/modified, validation results, and remaining pending extractions (if any).

## Failure Modes

| Trigger                                   | First fix                                              | Fallback                                              |
| ----------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| **No intents above threshold**            | Report all scores, confirm system is healthy           | Suggest re-running after adding more intents          |
| **Sub-responsibility boundaries unclear** | Ask user to clarify which parts should stay vs extract | Keep intent unchanged, flag for next review           |
| **Skill name collision**                  | Suggest alternative name, check existing skills        | Use namespaced name (e.g., `<domain>-ops`)            |
| **User rejects extraction**               | Respect decision, mark as `reviewed`                   | Suggest lighter alternative (rewrite guidelines only) |

## Anti-Patterns

| #   | Anti-pattern                              | Why not                                        | Do instead                                                   |
| --- | ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| 1   | **Auto-extract without confirmation**     | Destructive change to intent routing           | Always present plan and get explicit approval                |
| 2   | **Extract too aggressively**              | Creates skill sprawl, fragments related logic  | Only extract when sub-responsibilities are truly independent |
| 3   | **Leave intent empty after extraction**   | Intent still needed for classification routing | Keep slimmed intent with triggers + skill hint               |
| 4   | **Ignore format.md when drafting skills** | Inconsistent skill structure                   | Follow standard skill format conventions                     |
| 5   | **Skip validation after delivery**        | May break classification or skill loading      | Always run post-delivery validation checks                   |
