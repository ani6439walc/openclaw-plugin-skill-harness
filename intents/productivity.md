---
id: PRODUCTIVITY
name: Productivity / Task & Project Management
triggers:
- "User is asking to view, create, update, or manage tasks, projects, goals, habits, kanban cards, or next-action items in the productivity vault (darling/)"
- "User wants to check current task status, upcoming deadlines, active projects, goal progress, or request a weekly/monthly review, inbox triage, or vault audit"
examples:
- "今天有什麼任務"
- "看看 kanban 上有幾個 active project"
- "建立一個 Gitea 遷移的新專案卡片"
- "幫我跑一次本週 review"
- "inbox 裡有什麼要處理的"
- "新增一個 Framework Laptop 設定的 next action"
---

Detected "productivity" intent. The user is interacting with the productivity vault (darling/) for task management, project tracking, goal monitoring, reviews, or organizational workflows.

## Guidelines

- **MANDATORY**: Before any operation, read `darling/AGENTS.md` to understand the vault's structure, rules, and SOPs.
- This intent covers operations on the live productivity vault at `darling/`.
- It does NOT cover retrieving past events from memory — use MEMORY_LOOKUP for that.
- The vault follows the PARA framework: Goals → Projects (Kanban) → Next Actions → Reviews.
- All operations should respect the vault's AGENTS.md rules, especially content integrity and canonical tags.
- Many files in this vault are large. **Always use `treemd` to survey a file's structure before reading it in full.** This avoids loading entire documents into context and helps locate the relevant sections efficiently.

## Response Strategy

### Read Operations
- Start at `darling/index.md` or the relevant file (e.g., `tasks/next-actions.md`, `projects/kanban.md`).
- For large files, use `treemd` to get the heading tree first, then read only the relevant sections.
- Report status concisely: what's active, what's due, what's blocked.
- Highlight items with approaching deadlines or overdue status.

### Write Operations
- Small changes (1-2 files): execute directly.
- Structural changes (> 5 files): pause and present a plan for approval.
- Always preserve the author's voice; only modify status, links, and metadata.
- Use canonical tags (`#deep-work`, `#quick-win`, `#low-energy`, domain tags) when creating new items.

### Review & Maintenance
- For reviews: read the relevant period's notes, summarize key outcomes, and draft the review file.
- For inbox triage (SOP #3): classify new notes into the PARA structure and update wikilinks.
- For vault audit (SOP #4): check for orphans, broken links, and misplaced files; fix minor issues autonomously.

### Special File Types
- **`.canvas`** (JSON Canvas): visual mind maps and flowcharts. Follow the `json-canvas` skill constraints for node/edge structure.
- **`.base`** (Obsidian Bases): structured data views with filters and formulas. Follow the `obsidian-bases` skill constraints for YAML syntax and formula rules.

## Skill Routing

- Survey large Markdown files by heading tree before reading:
  skill: treemd
- Read vault content with Obsidian CLI:
  skill: obsidian-cli
- Edit vault files following Obsidian Markdown conventions:
  skill: obsidian-markdown
- Handle `.base` files (structured data views):
  skill: obsidian-bases
- Handle `.canvas` files (visual maps):
  skill: json-canvas
- Use the productivity framework for planning and reviews:
  skill: productivity
- Show changes as diffs when modifying vault files:
  skill: diffs
