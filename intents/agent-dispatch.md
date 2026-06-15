---
id: AGENT_DISPATCH
name: Agent Dispatch & Orchestration (代理人調度)
enabled: true
triggers:
  - "User wants to manage agent session lifecycle: check status, switch models, spawn/list sub-agents, hand off conversation, or manage active sessions"
  - "User wants to configure agent context, rules files, or project-level startup behavior"
  - "User references items from a prior list or conversation (e.g. 'approve 2', 'delete the third one', '執行你說的這兩個建議', 'do the two things you mentioned') or confirms/rejects a pending proposal, suggestion, or recommendation"
  - "User confirms execution mode or options for an active skill workflow, such as book-to-skill mode selection or batch processing choices"
  - "User wants to record learnings, errors, or corrections for continuous improvement"
  - "User wants to set up a structured workflow cycle for a complex multi-step task"
  - "User wants to retry, redo, rerun, or repeat the last operation, previous failed action, or current session task without naming a separate target system"
  - "User asks about agent runtime, session info, model config, or active sub-agent status"
examples:
  - "現在用的是哪個 model？"
  - "幫我分派給子代理去跑"
  - "把這個對話交接給另一個 agent"
  - "記下這個錯誤"
  - "approve 2"
  - "幫我建一個 workflow 處理這個任務"
  - "執行一下你說的這兩個建議"
  - "do the two things you mentioned earlier"
  - "幫我跑一下你剛才提的三個步驟"
  - "implement your first suggestion"
  - "幫我 retry"
  - "再跑一次剛剛的"
  - "重做上一步"
  - "redo the last step"
  - "建議2也做一下"
  - "執行提案2"
  - "把第三個刪掉"
  - "跑第 1 個 workflow"
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
- For bare retry/redo/repeat requests, recover the immediate session context first, identify the last failed or unfinished action, and rerun only after confirming the target is unambiguous and safe.
- When the user explicitly names a skill (for example, "用 gitea skill"), treat it as a forced routing hint: load that specific skill before resuming the previously blocked or pending task.
- When resuming after an abort, interruption, or gateway restart, verify the actual state of active sub-agents, files, and pending tasks before reporting progress or dispatching new work.
- For long-running or potentially stuck sub-agents, actively check current session/sub-agent state and report concrete status instead of passively waiting.
- When dispatching tasks that produce external web resources (images, map links, URLs, embeds), explicitly require the sub-agent to validate every URL and destination before finalizing.
- Before reporting sub-agent completion for web-resource tasks, spot-check representative URLs or links and request a targeted fix when validation fails.

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

- Force a specific skill route when the user explicitly names it:
  read({ path: "~/.openclaw/skills/<skill-name>/SKILL.md" })
  read({ path: "~/.openclaw/plugin-skills/<skill-name>/SKILL.md" })

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

- Spawn sub-agents for bounded complex tasks and wait for completion events:
  sessions_spawn({ task: "<description>" })
  sessions_yield()

- Validate sub-agent output containing external URLs before reporting completion:
  web_fetch({ url: "<image_or_map_url>" })
  web_search({ query: "<location name> google maps" })

- Track orchestrated task progress and durable todo state:
  workboard_list({ status: "running" })
  workboard_comment({ id: "<card-id>", body: "<progress note>" })

- Report execution results to Discord with explicit recipients when the message tool is available; use `#channel-name` for channels and `user:<id>` or `<@id>` for DMs to avoid ambiguity.

- Read or update heartbeat tracking files for approved long-running workflows:
  read({ path: "HEARTBEAT.md" })
  edit({ path: "HEARTBEAT.md", edits: [{ oldText: "<old>", newText: "<new>" }] })

## Response Strategy

- Identify the action type from the user's request (session, context, sub-agent, learning, workflow, or agent tool/extension verification).
- For configuration migration or consolidation, preserve existing structure and inspect both source and target before editing.
- Execute the appropriate tool with validated parameters.
- When a sub-agent completes a task, summarize the outcome and pause before executing follow-up actions such as commit, push, dispatching the next task, or applying generated edits unless the user already explicitly approved those follow-ups.
- When the user explicitly provides a skill hint, bypass generic auto-detection, load that skill, and then resume the blocked task using the recovered context.
- When the user asks to test modified agent tools/extensions, use sequential-thinking or `sequential_thinking` to plan targeted scenarios before running checks.
- **Technical Verification Mode**: When the user asks to verify an agent-native tool, extension, skill, or tool return shape, reduce RP/persona output and show actual return evidence: returned field names, JSON structures, payload summaries, or relevant tool output excerpts. Prefer concise code blocks or structured bullets so the user can compare expected vs actual behavior.
- Report what was done, what changed, and any errors — concise, no filler.

## Concrete Workflow

### Step 1 — Recall and Verify Proposal Scope

- Retrieve or inspect the original proposal behind the user's referenced action.
- Identify the exact files, pages, records, or entities the proposal targets.
- If the scope is ambiguous or multiple similar targets exist, confirm the intended target before proceeding.

### Step 1.5 — Resolve Retry or Redo Target

- For bare retry/redo/repeat requests, inspect recent session context or the last reported failure before executing anything.
- Map the retry to one concrete command, tool call, delegated task, or workflow step.
- If multiple recent operations could match, ask for a short clarification instead of guessing.

### Step 1.6 — Resolve Explicit Skill Hint

- If the user names a skill directly, extract the skill name and locate the matching live skill or plugin skill.
- Read the target `SKILL.md` before taking follow-up actions.
- Resume the previously blocked task with the loaded skill context instead of re-running the same failed generic route.

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
- For sub-agent completions, include the completed output and the recommended next action, then wait for explicit approval before committing, pushing, or launching the next batch unless prior user wording clearly requested automatic continuation.

### Step 9 — Sub-Agent Delegation

- For complex or long-running tasks, create self-contained task instructions with clear files, constraints, verification requirements, and expected output format.
- Use `sessions_spawn({ task: "..." })` for asynchronous delegation and `sessions_yield()` when waiting for the completion event.
- Immediately tell the user that work was delegated when the channel protocol requires a visible progress update.

### Step 10 — Monitor and Handle Completion Events

- When resuming after aborts, restarts, or user status checks, verify actual state before claiming progress.
- Parse completion events for success, failure, partial results, affected files, and recommended follow-up.
- Validate the result against the original requirements before reporting completion.
- For sequential work, update workboard or heartbeat tracking, then dispatch the next item only when the user already approved automatic continuation.

### Step 11 — Validate External Resources from Sub-Agents

- For tasks involving images, map links, URLs, embeds, APIs, or downloadable artifacts, include validation instructions in the dispatch prompt.
- After completion, spot-check representative resources with `web_fetch` or `web_search` before telling the user the task is done.
- If a sampled resource fails or points to the wrong destination, dispatch a targeted fix with the broken URL and expected destination.

### Step 12 — Safe File Editing During Orchestration

- Always use `read` before `edit` to inspect the current file content.
- For repeated Markdown sections, include unique surrounding context in `oldText` so the replacement matches exactly one location.
- If `edit` reports multiple occurrences, re-read the file, identify distinguishing context, and retry with a larger exact block.
- If `edit` reports no exact match, verify whitespace, line breaks, and nearby headings before retrying.

### Step 13 — Execute Pending Proposal and Report

- Resolve the referenced proposal, suggestion, or numbered item to one exact scope before editing.
- Execute the domain-specific workflow; for wiki proposal fixes, prefer `wiki_lint` → `wiki_get`/`read` → targeted edit or `wiki_apply` → `wiki_lint`.
- When reporting through Discord tooling, use explicit recipient formatting (`#channel-name`, `user:<id>`, or `<@id>`) and verify the delivery target is not ambiguous.
