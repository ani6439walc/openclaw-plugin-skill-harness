---
id: AGENT_DISPATCH
name: Agent Dispatch & Orchestration (代理人調度)
enabled: true
triggers:
  - "User wants to manage agent session lifecycle: check status, switch models, spawn/list sub-agents, hand off conversation, or manage active sessions"
  - "User wants to configure agent context, rules files, or project-level startup behavior"
  - "User references a numbered item from a prior list (e.g. 'approve 2', 'delete the third one') or confirms/rejects a pending proposal"
  - "User confirms execution mode or options for an active skill workflow, such as book-to-skill mode selection or batch processing choices"
  - "User wants to record learnings, errors, or corrections for continuous improvement"
  - "User wants to set up a structured workflow cycle for a complex multi-step task"
  - "User asks about agent runtime, session info, model config, or active sub-agent status"
examples:
  - "現在用的是哪個 model？"
  - "幫我分派給子代理去跑"
  - "把這個對話交接給另一個 agent"
  - "記下這個錯誤"
  - "approve 2"
  - "幫我建一個 workflow 處理這個任務"
---

Detected "agent self-administration" intent. The user is managing the agent's session, context, sub-agents, or workflow lifecycle.

## Guidelines

- This is an action request, not a discussion. Execute, then report.
- For destructive operations or gateway restarts: confirm before acting.
- Always resolve numbered references: if user says "approve 2", list pending first to map index → id.
- For active skill mode confirmations, map the selected option back to the current skill workflow and continue with the confirmed parameters.
- When executing a referenced proposal such as "執行方案 A" or "approve 2", verify the original proposal scope and exact target files before taking action.
- If related source documents, generated summaries, or synthesis pages could be confused, confirm the intended target before editing.
- Long-running commands: use background mode to avoid blocking.

## Skills & Tools

- Manage context setup, rules files, and project context:
  skill: context-engineering

- Route tasks to sub-agents with optimal model selection:
  skill: delegate

- Hand off current conversation to another agent:
  skill: handoff

- Auto-detect and invoke the right skill for current task:
  skill: dev-lifecycle

- Initialize every task with consistent startup protocol:
  skill: auto-skill

- Capture learnings, errors, and corrections:
  skill: self-improvement

- Guard workspace files against drift and baseline changes:
  skill: soul-guardian

- Run structured workflow cycles for complex multi-step tasks:
  skill: cycle

- Design step-by-step test scenarios for modified agent tools/extensions:
  skill: sequential-thinking

- Manage multi-perspective collaboration patterns:
  skill: collaborate

- Invoke structured reasoning and inspect its returned fields during tool verification:
  sequential_thinking({ thought: "<step>", thoughtNumber: 1, totalThoughts: 3, nextThoughtNeeded: true })

- Read existing configuration, rules, and prompt files before changing them:
  read({ path: "<file>" })

- Write or precisely update merged configuration content:
  write({ path: "<file>", content: "<merged content>" })
  edit({ path: "<file>", edits: [{ oldText: "<old>", newText: "<new>" }] })

- Search and verify workspace-wide text replacements:
  exec({ command: "rg '<pattern>' <path>", workdir: "<repo>" })

- Get current session diagnostics (model, usage, time):
  session_status()

- List active sub-agents:
  subagents({ action: "list" })

- List active sessions:
  sessions_list()

## Response Strategy

- Identify the action type from the user's request (session, context, sub-agent, learning, workflow, or agent tool/extension verification).
- For configuration migration or consolidation, preserve existing structure and inspect both source and target before editing.
- Execute the appropriate tool with validated parameters.
- When the user asks to test modified agent tools/extensions, use sequential-thinking or `sequential_thinking` to plan targeted scenarios before running checks.
- **Technical Verification Mode**: When the user asks to verify an agent-native tool, extension, skill, or tool return shape, reduce RP/persona output and show actual return evidence: returned field names, JSON structures, payload summaries, or relevant tool output excerpts. Prefer concise code blocks or structured bullets so the user can compare expected vs actual behavior.
- Report what was done, what changed, and any errors — concise, no filler.

## Concrete Workflow

### Step 1 — Recall and Verify Proposal Scope

- Retrieve or inspect the original proposal behind the user's referenced action.
- Identify the exact files, pages, records, or entities the proposal targets.
- If the scope is ambiguous or multiple similar targets exist, confirm the intended target before proceeding.

### Step 2 — Route Skill Mode Confirmation

- When the user selects options from an active skill menu, parse the selected numbers, labels, or "all" choice.
- Identify the active skill context from the conversation and map the selection to that skill's parameters or flags.
- Continue the active skill workflow with the confirmed parameters, then monitor execution and report results.

### Step 3 — Inspect Current State

- Read the source and target configuration files before deciding the merge strategy.
- Verify the files match the proposal scope, especially when distinguishing source documents from summaries or synthesis pages.
- Check nearby repository rules or prompt files when the request includes workspace-wide wording updates.

### Step 4 — Merge Configuration Content

- Preserve the target file's existing structure, headings, and local conventions.
- Add only the missing source content, resolving duplicates or conflicts explicitly.

### Step 5 — Scan for Workspace Text Updates

- Search the requested workspace scope for the old wording or pattern.
- Use narrow search paths and avoid generated, dependency, or cache directories unless explicitly requested.

### Step 6 — Apply Targeted File Changes

- Use precise edits for existing files whenever possible.
- Avoid broad rewrites that could clobber unrelated user changes.

### Step 7 — Test Modified Agent Tools or Extensions

- Clarify what changed and what correct behavior should look like.
- Use sequential-thinking or `sequential_thinking` to design 3-5 scenarios covering normal operation, boundaries, and likely failure modes.
- Execute the modified tool/extension against each scenario and capture actual return fields, JSON structures, or payload summaries when verification is requested.
- Compare actual behavior with expected behavior and call out pass/fail results plus anomalies.

### Step 8 — Verify and Report

- Re-scan for stale wording and inspect the resulting diff.
- Report affected files, skipped files, verification evidence, and any remaining ambiguity.
