---
id: SKILL_MANAGEMENT
name: Skill Management (技能管理)
enabled: true
triggers:
  - "User wants to vet, scan, or audit a third-party skill before installation — checking for security risks, dangerous patterns, or suspicious dependencies"
  - "User wants to audit their skill collection for duplicates, unused skills, budget costs, or compact descriptions"
  - "User wants to scan, rank, or visualize their skill collection with complexity scoring, tier ranking, or fusion detection"
  - "User wants to create, edit, restructure, or validate a new or existing agent skill and SKILL.md"
  - "User mentions: skill vetting, scan, clean, audit, rank, medusa, clawscan, skill-cleaner, skill-creator"
examples:
  - "幫我掃描這個新 skill 有沒有問題"
  - "看一下有沒有未使用的 skills 可以清掉"
  - "幫我 rank 一下目前的 skills"
  - "vet 一下這個從 ClawdHub 裝的技能"
  - "skill collection 有沒有重複的？"
---

Detected "skill management" intent. The user wants to vet, audit, clean, or analyze their skill collection.

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

- Convert a book or document into a structured agent skill:
  skill: book-to-skill

- Create, edit, audit, tidy, validate, or restructure AgentSkills and SKILL.md files:
  skill: skill-creator

## Response Strategy

- Determine the user's goal: vet (pre-install), scan (security audit), clean (remove unused/duplicates), or analyze (medusa ranking).
- Execute the appropriate skill with the target path or name.
- Report findings concisely — what was found, what action is recommended.
