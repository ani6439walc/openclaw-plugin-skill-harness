---
id: SKILL_MANAGEMENT
name: Skill Management (技能管理)
enabled: true
triggers:
  - "User wants to vet, scan, or audit a third-party skill before installation — checking for security risks, dangerous patterns, or suspicious dependencies"
  - "User wants to audit their skill collection for duplicates, unused skills, budget costs, or compact descriptions"
  - "User wants to scan, rank, or visualize their skill collection with complexity scoring, tier ranking, or fusion detection"
  - "User wants to create, edit, restructure, validate, propose, revise, list, inspect, approve, reject, or quarantine a reusable agent skill or Skill Workshop proposal"
  - "User mentions: skill vetting, scan, clean, audit, rank, medusa, clawscan, skill-cleaner, skill-creator, skill workshop, Skill Workshop proposal"
examples:
  - "幫我掃描這個新 skill 有沒有問題"
  - "看一下有沒有未使用的 skills 可以清掉"
  - "幫我 rank 一下目前的 skills"
  - "vet 一下這個從 ClawdHub 裝的技能"
  - "skill collection 有沒有重複的？"
  - "可以幫我把這些 skill 讓 Skill Workshop 列管嗎？"
---

Detected "skill management" intent. The user wants to vet, audit, clean, analyze, or manage Skill Workshop proposals for their skill collection.

## Guidelines

- When creating, scaffolding, or editing a skill directly, restrict all file read/write operations strictly to the target skill directory (for example `~/.openclaw/skills/<skill-name>/` or an explicitly requested workspace skill path). Never drift into `darling/`, `wiki/`, or unrelated workspace files during skill creation.
- Always vet skills before installation — security-first approach.
- Run clawscan or skill-vetter before installing any third-party skill.
- When cleaning: show what would be removed before deleting.
- When auditing skill budget: report total tokens, highlight outliers.
- For medusa analysis: report tier ranking and any fusion/overlap detection.
- When creating skills: follow agentskills.io spec — lean SKILL.md (<500 lines), progressive disclosure, `name` + `description` in frontmatter, move long docs to `references/`.
- For new skill authoring, clarify lifecycle scope, research authoritative domain sources when needed, draft the skill structure, then save durable proposals through `skill_workshop` unless the user explicitly requested direct live-file editing.
- When creating, editing, or rewriting `SKILL.md` or reference files, use file-system tools (`read`, `write`, `edit`, `exec`) for local paths; never use the browser tool for `file://` or local filesystem operations.

## Skills & Tools

- Security scan for ClawHub skills before installation:
  skill: clawscan

- Security-first skill vetting (red flags, permission scope, suspicious patterns):
  skill: skill-vetter

- Audit skills: loaded roots, duplicates, unused, budget costs, compact descriptions:
  skill: skill-cleaner

- Scan, audit, rank, visualize skill collections (complexity, tier ranking, fusion detection):
  skill: medusa

- Deep audit, review, and quality scoring of a specific skill with rubric dimensions or reference checks:
  skill: darwin-skill

- Convert a book or document into a structured agent skill:
  skill: book-to-skill

- Plan skill structure, lifecycle coverage, and validation steps:
  sequential_thinking({ thought: "<skill_authoring_plan>" })

- Research official documentation, examples, and domain requirements for the skill:
  web_search({ query: "<domain skill best practices>" })
  web_fetch({ url: "<official_doc_url>" })

- Convert a finalized draft into a local file only when direct file editing is explicitly requested:
  write({ path: "/home/ani/.openclaw/workspace/skills/<skill-name>/SKILL.md", content: "<skill markdown>" })

- Create, edit, audit, tidy, validate, restructure, or enrich AgentSkills and SKILL.md files with domain-specific knowledge:
  skill: skill-creator

- Create, update, revise, list, inspect, apply, reject, or quarantine Skill Workshop proposals:
  skill_workshop({ action: "create", name: "skill-name", description: "short purpose", proposal_content: "<SKILL.md markdown>" })
  skill_workshop({ action: "list", query: "skill-name", status: "pending" })
  skill_workshop({ action: "apply", proposal_id: "<proposal-id>", reason: "approved by user" })

- Inventory and edit skill directories during explicit live-file maintenance:
  exec({ command: "find /path/to/skill -type f | sort" })
  read({ path: "/path/to/skill/SKILL.md" })
  write({ path: "/path/to/skill/SKILL.md", content: "<updated skill markdown>" })

- Delegate large multi-file translation or refactoring work with exact paths and transformation rules:
  skill: delegate

## Response Strategy

- Determine the user's goal: vet (pre-install), scan (security audit), clean (remove unused/duplicates), analyze (medusa ranking), manage Skill Workshop proposals, or optimize a specific skill.
- For durable skill registration/workshop requests, use `skill_workshop` directly; do not simulate proposal lifecycle with shell edits or unsupported actions.
- Execute the appropriate skill with the target path or name.
- For optimization cycles, audit first, apply targeted edits, then re-check the weakest dimensions or failure modes.
- For domain knowledge enrichment, read the existing skill first, extract source-backed domain content, then integrate only durable patterns, examples, constraints, or references that belong in the skill.
- When creating or editing skills with multiple file operations, always disclose tool errors or partial failures; do not report blanket success if any step failed.
- Report findings concisely — what was found, what action is recommended.

## Concrete Workflow

### Step 1 — Classify Skill Task

- Determine whether the user wants security vetting, collection audit, skill optimization, or Skill Workshop proposal lifecycle management.
- If the request is durable (save, propose, revise, apply, reject, quarantine, or list workshop items), route to `skill_workshop` rather than editing workshop files manually.

### Step 2 — Author Skill Drafts and Proposals

- Clarify the skill domain, target users, lifecycle stages, and success criteria.
- Use `sequential_thinking` when the skill must cover a multi-step lifecycle or several operating modes.
- Research official docs and examples with `web_search` and `web_fetch` when domain-specific behavior or commands are required.
- Draft `SKILL.md` with concise frontmatter, progressive disclosure, and long references moved out of the main file.
- For durable proposal workflows, call `skill_workshop({ action: "create", name: "<skill-name>", description: "<short purpose>", proposal_content: "<SKILL.md markdown>" })` instead of writing proposal files manually.
- Use `write` for live workspace skill files only when the user explicitly requested direct file creation or editing.

### Step 2.5 — Enrich Existing Skill with Domain Knowledge

- Read the target `SKILL.md` and relevant reference files to understand current scope, structure, and existing domain notes.
- Extract domain knowledge from verified sources such as course transcripts, official documentation, reference material, or user-provided examples.
- Integrate only reusable patterns, examples, constraints, and references that improve future skill execution while keeping `SKILL.md` lean.
- Validate that frontmatter, progressive disclosure, and reference paths remain intact after edits.

### Step 3 — Skill Workshop Lifecycle

- Before approving or rejecting, discover the pending proposal with `skill_workshop({ action: "list", query: "<skill-name>", status: "pending" })` or `skill_workshop({ action: "inspect", proposal_id: "<proposal-id>" })`.
- Apply, reject, or quarantine only after explicit user approval using the resolved `proposal_id`; if no proposal matches, stop and report the mismatch instead of guessing another action.

### Step 4 — Audit & Baseline

- Run `darwin-skill` or the relevant audit skill against the target skill. Capture the initial score, critical failures, and lowest-scoring dimensions.

### Step 5 — Iterative Optimization

For each confirmed issue or weak dimension:

1. Read the relevant `SKILL.md` or reference files.
2. Apply targeted fixes with the smallest safe file edit.
3. Re-evaluate the affected dimension when needed.

### Step 5.5 — Batch Skill Editing or Translation

- Inventory the target skill directory before editing, including `SKILL.md`, references, templates, and metadata files.
- Read representative files to identify language, structure, frontmatter, JSON, and Markdown constraints before rewriting.
- For bulk translation or extensive multi-file refactoring, delegate with exact file paths, required language, formatting constraints, and verification requirements.
- For minor single-file changes, edit directly and keep the existing skill structure intact.
- Verify modified files after the batch, including YAML frontmatter in `SKILL.md`, JSON syntax in metadata files, and any referenced paths.

### Step 5.6 — Rename Skills and Patch References

- Rename a live skill only after explicit confirmation of the old name, new name, directory path, and frontmatter updates.
- Use `exec` to inventory references first, excluding generated or dependency folders such as `node_modules/`, `.git/`, and `dist/`.
- Prefer scripted, reviewable replacements for broad reference updates; use `read` before `edit` when exact local context matters.
- Re-run reference search for the old skill name and inspect the git diff before reporting completion.

### Step 6 — Finalize & Report

When the quality threshold is met, summarize the before/after results, affected files, remaining risks, and any tool errors encountered. Clearly distinguish full success from partial success, and do not commit unless the user explicitly requested a commit.

### Step 2.1 — Scaffold Live Skill Directory

Use only when the user explicitly asks for direct live-file skill creation instead of a Skill Workshop proposal.

- Confirm the skill name, target directory, and initial triggers before creating files.
- Create only the target directory, usually `~/.openclaw/skills/<skill-name>/`, with `mkdir -p`.
- Generate a lean `SKILL.md` from scratch if no template exists; do not search unrelated vaults for templates.
- Minimal live-file skeleton:

```markdown
---
name: <skill-name>
description: <short purpose>
---

# <Skill Name>

Use this skill when <activation condition>.

## Workflow

1. <first step>
2. <second step>

## Validation

- <how to verify>
```

- Validate frontmatter and referenced support paths before reporting completion.
