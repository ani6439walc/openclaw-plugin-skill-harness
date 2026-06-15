---
id: PRODUCTIVITY
name: Productivity / Task & Project Management
triggers:
  - "User is asking to view, create, update, or manage tasks, projects, goals, habits, kanban cards, or next-action items in the productivity vault (darling/)"
  - "User wants to check current task status, upcoming deadlines, active projects, goal progress, or request a weekly/monthly review, inbox triage, or vault audit"
  - "User asks where to place, organize, move, or structure files and content within the productivity vault (darling/), including vault folder conventions and organization rules"
  - "User wants to resume, continue, or pick up unfinished tasks, projects, or workflows from a previous session or context"
  - "User asks to review recent conversation or context specifically to continue executing pending actions"
examples:
  - "今天有什麼任務"
  - "看看 kanban 上有幾個 active project"
  - "建立一個 Gitea 遷移的新專案卡片"
  - "幫我跑一次本週 review"
  - "inbox 裡有什麼要處理的"
  - "新增一個 Framework Laptop 設定的 next action"
  - "這個 PDF 放在哪個資料夾比較好？按照 vault 的規範"
  - "幫我下載這個 PDF 存到 productivity 然後建一個任務之後翻譯"
  - "幫我找 iPhone 上同步 Obsidian 的方式，並評估哪個最適合我的 vault workflow"
  - "接續剛剛未完成的事情繼續執行"
  - "review 一下剛剛的對話，然後繼續做"
  - "幫我繼續上次沒做完的任務"
  - "看看 workboard 有什麼要接著處理的"
---

Detected "productivity" intent. The user is interacting with the productivity vault (darling/) for task management, project tracking, goal monitoring, reviews, or organizational workflows.

## Guidelines

- Keep Kanban boards scope-aware: identify whether the target board is global, project-specific, review-specific, or Workboard-backed before reading or moving cards.
- When the user asks to resume unfinished work, review recent context only enough to identify pending actions, then continue the task workflow with verified files, Workboard cards, or vault artifacts.
- Before any operation, read `darling/AGENTS.md` to understand the vault's structure, rules, and SOPs.
- This intent covers operations on the live productivity vault at `darling/`.
- It does NOT cover retrieving past events from memory — use a separate memory intent for that.
- The vault follows the PARA framework: Goals → Projects (Kanban) → Next Actions → Reviews.
- All operations should respect the vault's AGENTS.md rules, especially content integrity and canonical tags.
- Many files in this vault are large. Always use `treemd` to survey a file's structure before reading it in full.
- Small changes (1-2 files): execute directly. Structural changes (> 5 files): pause and present a plan for approval.
- Bulk file operations, long-running document processing, or complex multi-step vault updates should be delegated to a sub-agent after the scope and file paths are verified.
- Always preserve the author's voice; only modify status, links, and metadata.
- Use canonical tags (`#deep-work`, `#quick-win`, `#low-energy`, domain tags) when creating new items.
- For `.canvas` files: follow the `json-canvas` skill constraints for node/edge structure.
- For `.base` files: follow the `obsidian-bases` skill constraints for YAML syntax and formula rules.
- When reporting task or project status, verify completion against the actual work artifact (notes, code, documents, or generated deliverables) instead of relying only on kanban/card metadata, which may be stale.
- When the user asks to check or verify status, capture their stated expectation first; if evidence contradicts it, explicitly surface the mismatch before reporting raw findings or cleanup recommendations.

## Skills & Tools

- Survey large Markdown files by heading tree before reading:
  skill: treemd

- Read vault content with Obsidian CLI:
  skill: obsidian

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

- Delegate bulk edits or long-running vault processing to a sub-agent:
  skill: delegate

- Master any inbox with triage frameworks:
  skill: inbox

- Show changes as diffs when modifying vault files:
  skill: diffs

- Extract transcripts or structured content from learning platforms when course work requires browser interaction:
  skill: browser-automation

- Download external content from URLs, such as PDFs, articles, or files, and save it into the vault:
  web_fetch({ url: "<url>" })
  exec({ command: "curl -L -o '<target-path>' '<url>'", workdir: "<workspace>" })

- Preserve incremental progress with safe branch, diff, and commit practices when the project lives in Git:
  skill: git-workflow-and-versioning

- Retrieve git commit history from repositories to enrich productivity artifacts:
  skill: version-control

- Access internal infrastructure services such as Gitea or Argo CD via CLI when direct web fetching is blocked:
  skill: infra-management

- Query Workboard boards, status counts, task cards, and dependency chains:
  workboard_boards()
  workboard_list({ status: "ready", limit: 10 })
  workboard_create({ title: "<task>", notes: "<context>", parents: ["<parent-id>"] })
  workboard_link({ parentId: "<parent-id>", childId: "<child-id>" })
  workboard_comment({ id: "<card-id>", body: "<context update>" })
  workboard_read({ id: "<card-id>" })
  workboard_claim({ id: "<card-id>" })
  workboard_release({ id: "<card-id>", status: "todo" })
  workboard_complete({ id: "<card-id>", token: "<claim-token>", summary: "<what changed>" })

## Response Strategy

- Read `darling/AGENTS.md` to understand vault structure and rules.
- For read operations: use `treemd` on large files first, then read only relevant sections.
- For status reports: cross-check kanban or Workboard status against actual deliverables before responding; do not present metadata status as ground truth without artifact verification.
- For write operations: execute directly for small changes, plan for structural changes.
- For bulk edits, hundreds-of-lines updates, or long-running document processing: verify scope first, then delegate with clear file paths and acceptance criteria so the main session stays responsive.
- For reviews: read relevant period notes, summarize outcomes, draft review file.
- For inbox triage: classify new notes into PARA structure and update wikilinks.
- For vault audit: check orphans, broken links, misplaced files; fix minor issues autonomously.
- For workflow research or tool integration: check existing vault setup and memory first, research external options, evaluate them against current constraints, then recommend the most compatible workflow.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
read       classify    execute      verify     report
SOPs       operation   or claim     status
```

### Step 1 — Read Vault SOPs & Structure
- Identify the target Kanban board(s) and their specific scope, such as global vs. project-specific, before merging or moving items across boards.
- Read `darling/AGENTS.md` for vault rules and specific SOPs before any productivity operation.
- For named routines such as weekly review, monthly review, inbox triage, kanban cleanup, or vault audit, follow the matching SOP in `darling/AGENTS.md` instead of inventing a new sequence.
- Survey target file structure with `treemd` if the file is large.

### Step 2 — Classify Operation Type and Reconcile Expectations
- Read: check tasks, projects, goals, reviews, inbox.
- Write: create new items, update status, add metadata.
- Bulk/long-running: update many sections, process hundreds of lines, or coordinate a complex multi-step vault update through a sub-agent.
- Ingest: download external content (PDF, article, or file), store it in the appropriate vault folder, then create related tasks or next actions.
- Review: weekly/monthly summary, inbox triage, vault audit, kanban cleanup, or recurring SOP-driven maintenance.
- Workboard: list, create, link dependencies, add context, claim, execute, release, and complete task cards when the user asks to continue or process queued work.
- Research: workflow improvements, third-party integrations, sync methods, plugin choices, or tool evaluations for the productivity system.
- Status checks: note the user's stated belief such as "should be done" or "already cleared", compare file and artifact evidence against it, and lead with any discrepancy before proceeding.

### Step 2.5 — Enrich with External Data (When Applicable)
- For kanban cards or project notes that reference code repositories, inspect recent commit history, branches, or PRs before updating the productivity artifact.
- If `web_fetch` cannot access an internal or private URL, fall back to authenticated CLI, git, SSH, or browser-based access rather than treating the source as unavailable.
- Extract only relevant commit messages, dates, authors, and changed components; synthesize them into task/project context without dumping raw logs.
- Cite the repository path, command used, or verified source in the updated note when useful.

### Step 2.6 — Verify Completion Status
- For tasks marked in progress or done, inspect the actual work product (notes file, code commit, document, or deliverable) when available.
- When the user asks about file structure, item count, section outline, or completeness, run `treemd <target-file>` or an equivalent outline command before drawing conclusions.
- Compare counted headings, questions, sections, or deliverable artifacts against the user's expectation and the task tracker.
- If metadata and artifact disagree, trust the verified artifact and update the task tracker when appropriate.
- Report the verified status, not just the claimed kanban or Workboard status.

### Step 3 — Execute Safely, Delegate, or Claim Workboard Task
- Respect board boundaries during reads and writes; do not merge separate boards, scopes, or workflows unless the user explicitly asked for consolidation.
- For reads: report active items, due dates, blocked items concisely.
- For writes: preserve author's voice, use canonical tags.
- For delegated bulk work: provide the sub-agent with exact file paths, relevant excerpts, acceptance criteria, and required verification; record the task as in progress or delegated when the vault workflow tracks execution state.
- Before using `edit`, immediately read the exact target section or file excerpt and copy the exact text to avoid whitespace or stale-content mismatches.
- If `edit` fails because text is missing, non-unique, or stale, re-read the target section, expand the context, then retry once with a precise replacement.
- If precise replacement still fails and the change is safe and local, use `write` only after reconstructing the whole file from the latest read content; otherwise roll back or ask for confirmation.
- For ingests: download the external file, verify the saved path and size, then create a follow-up task or next action that references the stored file.
- For reviews: execute the specific SOP from `darling/AGENTS.md` (for example: sync state, triage inbox, update kanban, archive done tasks, and write the review note when that SOP requires it).
- For workflow research: survey current setup via `memory_search` and targeted vault reads, research external options with `web_search`, evaluate options against existing constraints such as OS, plugins, Git workflow, mobile access, and data ownership, then recommend the safest compatible workflow.
- For Workboard operations: use `workboard_list` to inspect cards, `workboard_read` for details, `workboard_create` for new tasks, `workboard_link` for dependencies, and `workboard_comment` for added context.
- For Workboard task execution: claim the card with `workboard_claim`, execute the task directly, release it with `workboard_release` if pausing or handing off, and do not spawn subagents unless explicitly requested or the task is too large for safe inline execution.
- For structural changes (> 5 files): present plan for approval.

### Step 4 — Update Related Artifacts and Verify Status
- Persist any dependent file updates such as outlines, summaries, project notes, or next-action lists.
- Run the smallest meaningful verification: readback, diff, grep, lint, test, or artifact inspection.
- Show diffs for file modifications.
- Complete the claimed Workboard card with `workboard_complete`, including a concise summary and proof when available.

### Step 5 — Report Status
- Show what changed or what's active.
- Highlight approaching deadlines, overdue items, blockers, or follow-up tasks.
- For ingests, include the download size, storage path, and newly created task title.
- If a Workboard card was processed, include the card ID, completion status, and artifacts changed.

### Workboard Task Execution Workflow

Use this workflow when the user asks to continue queued work, process the next Workboard item, or complete a sequence of task cards directly.

1. **Claim and read** — Use `workboard_claim`, then `workboard_read` with the claim token to verify scope, acceptance criteria, links, and dependencies.
2. **Inspect source material** — Read the referenced files or artifacts before changing anything; use `treemd` for large Markdown documents.
3. **Process and write** — Create or update the requested notes, outlines, project files, or vault artifacts with `write` / `edit`, preserving exact structure and author voice.
4. **Recover edit conflicts** — If `edit` fails due to non-unique or mismatched text, re-read the target section, expand the exact context, then retry once with a precise replacement.
5. **Verify and preserve progress** — Run the smallest meaningful check (diff, grep, lint, test, or direct readback). Commit/push only when explicitly requested or required by the active workflow.
6. **Complete or release** — Use `workboard_complete` with proof when done; use `workboard_release` with the next status when pausing or handing off.
7. **Report results** — Include card ID, files changed, verification result, blockers, and the next queued item when relevant.

### Structured Course / Learning Project Workflow

Use this workflow when the user asks to organize a multi-lecture, multi-section, or course-note project that combines content extraction, note writing, and progress tracking.

1. **Verify scope and structure** — Confirm section boundaries, lecture numbers, expected output files, and existing project trackers before changing notes.
2. **Extract content in small batches** — Use browser automation or delegated browser work only for the lecture pages needed; process one lecture at a time or a small explicit range.
3. **Organize notes incrementally** — Convert each transcript or source chunk into the established note format, update project tracking files, and preserve existing headings and links.
4. **Checkpoint with version control** — After each lecture or logical batch, inspect the diff and preserve progress with the repository's approved Git workflow if commits were requested.
5. **Handle extraction failures clearly** — If browser/CDP/network/platform access fails, report the exact failing step, avoid inventing transcript content, and pause until the access issue is resolved.
6. **Report progress cadence** — Summarize completed lectures, changed files, remaining range, and any blockers before continuing to the next batch.
