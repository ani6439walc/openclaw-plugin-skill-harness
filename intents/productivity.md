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

- Before any operation, read `darling/AGENTS.md` to understand the vault's structure, rules, and SOPs.
- This intent covers operations on the live productivity vault at `darling/`.
- It does NOT cover retrieving past events from memory — use a separate memory intent for that.
- The vault follows the PARA framework: Goals → Projects (Kanban) → Next Actions → Reviews.
- All operations should respect the vault's AGENTS.md rules, especially content integrity and canonical tags.
- Many files in this vault are large. Always use `treemd` to survey a file's structure before reading it in full.
- Small changes (1-2 files): execute directly. Structural changes (> 5 files): pause and present a plan for approval.
- Always preserve the author's voice; only modify status, links, and metadata.
- Use canonical tags (`#deep-work`, `#quick-win`, `#low-energy`, domain tags) when creating new items.
- For `.canvas` files: follow the `json-canvas` skill constraints for node/edge structure.
- For `.base` files: follow the `obsidian-bases` skill constraints for YAML syntax and formula rules.

## Skills & Tools

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

- Plan vs execute decisions based on task risk:
  skill: plan

- Break large work into ordered tasks:
  skill: planning-and-task-breakdown

- Master any inbox with triage frameworks:
  skill: inbox

- Show changes as diffs when modifying vault files:
  skill: diffs

## Response Strategy

- Read `darling/AGENTS.md` to understand vault structure and rules.
- For read operations: use `treemd` on large files first, then read only relevant sections.
- For write operations: execute directly for small changes, plan for structural changes.
- For reviews: read relevant period notes, summarize outcomes, draft review file.
- For inbox triage: classify new notes into PARA structure and update wikilinks.
- For vault audit: check orphans, broken links, misplaced files; fix minor issues autonomously.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4
read       classify    execute      report
vault      operation               status
SOPs
```

### Step 1 — Read Vault Structure
- Read `darling/AGENTS.md` for vault rules and SOPs.
- Survey target file structure with `treemd` if it's large.

### Step 2 — Classify Operation Type
- Read: check tasks, projects, goals, reviews, inbox.
- Write: create new items, update status, add metadata.
- Review: weekly/monthly summary, inbox triage, vault audit.

### Step 3 — Execute
- For reads: report active items, due dates, blocked items concisely.
- For writes: preserve author's voice, use canonical tags.
- For reviews: read period notes, summarize, draft review file.
- For structural changes (> 5 files): present plan for approval.

### Step 4 — Report Status
- Show what changed or what's active.
- Highlight approaching deadlines or overdue items.
- Show diffs for any file modifications.
