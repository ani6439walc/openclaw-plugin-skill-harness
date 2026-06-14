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

- Always vet skills before installation — security-first approach.
- Run clawscan or skill-vetter before installing any third-party skill.
- When cleaning: show what would be removed before deleting.
- When auditing skill budget: report total tokens, highlight outliers.
- For medusa analysis: report tier ranking and any fusion/overlap detection.
- When creating skills: follow agentskills.io spec — lean SKILL.md (<500 lines), progressive disclosure, `name` + `description` in frontmatter, move long docs to `references/`.

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

- Create, edit, audit, tidy, validate, or restructure AgentSkills and SKILL.md files:
  skill: skill-creator

- Create, update, revise, list, inspect, apply, reject, or quarantine Skill Workshop proposals:
  skill_workshop({ action: "create", name: "skill-name", description: "short purpose", proposal_content: "<SKILL.md markdown>" })
  skill_workshop({ action: "list", query: "skill-name", status: "pending" })
  skill_workshop({ action: "apply", proposal_id: "<proposal-id>", reason: "approved by user" })

## Response Strategy

- Determine the user's goal: vet (pre-install), scan (security audit), clean (remove unused/duplicates), analyze (medusa ranking), manage Skill Workshop proposals, or optimize a specific skill.
- For durable skill registration/workshop requests, use `skill_workshop` directly; do not simulate proposal lifecycle with shell edits or unsupported actions.
- Execute the appropriate skill with the target path or name.
- For optimization cycles, audit first, apply targeted edits, then re-check the weakest dimensions or failure modes.
- Report findings concisely — what was found, what action is recommended.

## Concrete Workflow

### Step 1 — Classify Skill Task
- Determine whether the user wants security vetting, collection audit, skill optimization, or Skill Workshop proposal lifecycle management.
- If the request is durable (save, propose, revise, apply, reject, quarantine, or list workshop items), route to `skill_workshop` rather than editing workshop files manually.

### Step 2 — Skill Workshop Lifecycle
- For a new proposal, collect or read the skill content, then call `skill_workshop({ action: "create", name: "<skill-name>", description: "<short purpose>", proposal_content: "<SKILL.md markdown>" })`.
- Before approving or rejecting, discover the pending proposal with `skill_workshop({ action: "list", query: "<skill-name>", status: "pending" })` or `skill_workshop({ action: "inspect", proposal_id: "<proposal-id>" })`.
- Apply, reject, or quarantine only after explicit user approval using the resolved `proposal_id`; if no proposal matches, stop and report the mismatch instead of guessing another action.

### Step 3 — Audit & Baseline
- Run `darwin-skill` or the relevant audit skill against the target skill. Capture the initial score, critical failures, and lowest-scoring dimensions.

### Step 4 — Iterative Optimization
For each confirmed issue or weak dimension:
1. Read the relevant `SKILL.md` or reference files.
2. Apply targeted fixes with the smallest safe file edit.
3. Re-evaluate the affected dimension when needed.

### Step 5 — Finalize & Report
When the quality threshold is met, summarize the before/after results, affected files, and remaining risks. Do not commit unless the user explicitly requested a commit.
