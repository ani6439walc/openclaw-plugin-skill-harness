---
id: AGENT_DISPATCH
name: Agent Dispatch & Orchestration (代理人調度)
enabled: true
triggers:
  - "User wants to manage agent session lifecycle: check status, switch models, spawn/list sub-agents, hand off conversation, or manage active sessions"
  - "User wants to configure agent context, rules files, or project-level startup behavior"
  - "User references a numbered item from a prior list (e.g. 'approve 2', 'delete the third one') or confirms/rejects a pending proposal"
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

- Manage multi-perspective collaboration patterns:
  skill: collaborate

- Get current session diagnostics (model, usage, time):
  session_status()

- List active sub-agents:
  subagents({ action: "list" })

- List active sessions:
  sessions_list()

## Response Strategy

- Identify the action type from the user's request (session, context, sub-agent, learning, workflow).
- Execute the appropriate tool with validated parameters.
- Report what was done, what changed, and any errors — concise, no filler.
