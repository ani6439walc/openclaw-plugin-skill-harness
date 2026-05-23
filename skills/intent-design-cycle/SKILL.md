---
name: intent-design-cycle
description: Run a structured 5-phase cycle to analyze agent skills/tools, cluster them by intent, interview the user for calibration, and generate intention-hint plugin intent definition files. Use when the user wants to audit, redesign, or bulk-create intent files for the intention-hint plugin.
---

Run a structured workflow to audit existing skills and tools, then produce intention-hint intent definition files. This is a **cycle** — follow the phases sequentially, do not skip ahead.

## Phases

1. **Discovery** — Inventory all skills and tools.
2. **Clustering** — Group capabilities by usage intent.
3. **Interview** — Calibrate clusters with the user.
4. **Generation** — Produce intent definition files.
5. **Review** — Validate and deliver the final files.

## Phase 1 — Discovery (能力盤點)

**Goal:** Build a complete inventory of all actionable capabilities.

**Actions:**

1. Scan skills: `exec(command="ls -1 ~/.openclaw/skills/ && for d in ~/.openclaw/skills/*/; do [ -f \"$d/SKILL.md\" ] && basename \"$d\"; done")` then read each `SKILL.md` frontmatter (`name`, `description`) to extract capability summaries.
2. Scan tool schema: review currently available tool schemas to list built-in tools (exec, web_search, web_fetch, memory_search, etc.).
3. Scan existing intents: `exec(command="ls ~/.openclaw/extensions/intention-hint/intents/")` to see what intent coverage already exists.
4. Read `extensions/intention-hint/README.md` to refresh the intent format rules.

**Output:** A table with columns: `capability | type(skill/tool) | summary | source`.

**Validation:** Skill count matches the actual directory. Every tool schema is listed.

**Handoff:** Proceed to Phase 2 only after the inventory is complete and verified.

## Phase 2 — Clustering (意圖分群)

**Goal:** Group all capabilities by usage intent, not by directory name.

**Actions:**

1. Cluster capabilities into intent families based on what the user is trying to achieve (e.g., "review code quality", "debug a system", "design architecture", "look up past memories").
2. Map each capability to exactly one cluster — no duplicates.
3. Compare against existing intents in `intents/` to identify:
   - **Covered**: existing intent already handles this cluster.
   - **Gaps**: no existing intent for this cluster.
   - **Overlaps**: one cluster maps to multiple existing intents — recommend merge or split.
4. Produce a cluster map showing: cluster name, capabilities, existing intent match (or "new"), and recommended intent ID for gaps.

**Output:** Cluster map + gap analysis + recommended new intent list.

**Validation:** Every skill/tool belongs to exactly one cluster. No capability is orphaned.

**Handoff:** Proceed to Phase 3 with the cluster map for user calibration.

## Phase 3 — Interview (使用者校準)

**Goal:** Calibrate the clustering with the user's actual usage patterns.

**Actions:**

Ask questions one at a time. Wait for each reply before moving to the next. Do not batch questions.

Use these discovery questions (adapted from cycle/discovery.md):

1. **Frequency**: Which of these clusters do you use most often in daily work?
2. **Pain points**: Which tasks feel slow or unclear with the current intent setup?
3. **Boundaries**: Are there clusters that feel too broad or overlapping? Which should split or merge?
4. **Gaps**: Did I miss any usage pattern you actually do regularly?
5. **Naming**: Do the cluster names feel natural? Any renames?

For each question:
- Explain briefly why the decision matters for intent classification quality.
- Give a recommended default based on Phase 2 analysis.
- Wait for the user's reply.

**Rules:**
- If the user's answer can be grounded by reading existing intent files or the skills-catalog, do that instead of asking.
- Prefer narrowing scope over making broad catch-all intents.
- If two intents are colliding, recommend the smallest clean split.

**Output:** Calibrated intent definitions (names, IDs, triggers, examples, body scope).

**Validation:** User confirms the clustering feels right. No unresolved boundary questions.

**Handoff:** Proceed to Phase 4 with the calibrated definitions.

## Phase 4 — Generation (檔案產生)

**Goal:** Produce properly formatted intent definition files.

**Actions:**

1. Read `extensions/intention-hint/README.md` to confirm format rules:
   - Frontmatter: `id`, `name`, `enabled`, `triggers[]`, `examples[]`
   - Body: `Detected "..." intent.` + `## Guidelines` + `## Response Strategy`
2. For each new or revised intent, generate a `.md` file following the format.
3. Write files to a staging location (e.g., `/tmp/intent-drafts/`) for preview — do not overwrite existing files yet.
4. Produce a diff showing what will change (new files, modified files, deletions).

**Format template:**

```markdown
---
id: <INTENT_ID>
name: <Human Readable Name>
enabled: true
triggers:
  - "..."
examples:
  - "..."
---

Detected "<intent>" intent. <One-sentence explanation.>

## Guidelines

- ...

## Response Strategy

- ...
```

**Rules:**
- No cross-references in body text — boundaries must be expressed through triggers and examples alone.
- When hinting skills, use the README format: `skill: <name>`.
- When hinting tools, use explicit call shapes: `web_search({ query: "..." })`.

**Output:** Draft intent files + diff preview.

**Validation:** YAML frontmatter is valid. No trigger collisions between intents. Body follows README rules.

**Handoff:** Proceed to Phase 5 for final review.

## Phase 5 — Review (驗收)

**Goal:** Final validation and delivery.

**Actions:**

1. Show the user the diff preview of all changes.
2. Check for intent boundary collisions — ensure triggers between intents are distinct enough.
3. Verify each file:
   - Frontmatter fields present and correct
   - Body follows `Detected...` + `## Guidelines` + `## Response Strategy` structure
   - Skill/tool hints use correct format
   - No cross-references to other intents in body
4. Ask for final approval. On approval, copy files to `intents/` directory (overwrite existing only with user confirmation).

**Output:** Confirmed intent files in `intents/` + summary of changes.

**Validation:** Files are live in the intents directory. Plugin hot-reload picks them up automatically.

## Error Recovery

- **Discovery fails** (can't read skills dir): fall back to reading the skills-catalog.md from the productivity vault.
- **Interview stalls**: summarize current progress, identify the blocking decision, and ask the single smallest question to unblock.
- **Generation fails**: output the collected intent definitions as raw markdown for manual review instead of aborting.
- **User rejects a cluster**: backtrack to Phase 2, re-cluster that group, and resume.

## When to Propose

- User wants to audit or redesign their entire intent setup.
- User adds many new skills and wants matching intents.
- Existing intents feel too broad, overlapping, or outdated.
- User asks "what intents should I have for my current skills?"
