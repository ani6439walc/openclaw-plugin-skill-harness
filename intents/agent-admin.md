---
id: AGENT_ADMIN
name: Agent Self-Administration (代理人自我管理)
enabled: true
triggers:
  - "User issues a direct command for agent self-management or workspace operations: skill workshop (approve/reject/list), gateway restart, config inspection, cron jobs, shell commands, dependency management (pnpm, npm, pip, brew, apt, uv), or script execution"
  - "User references a numbered item from a prior list (e.g. 'approve 2', 'delete the third one') or confirms/rejects a pending proposal from a workshop or similar queue"
  - "User wants to check agent status, session info, model config, or runtime diagnostics"
examples:
  - "approve 2"
  - "show me pending skills"
  - "restart the gateway"
  - "幫我執行 pnpm add -g sharp"
  - "uv run --with paho-mqtt python3 script.py"
  - "現在用的是哪個 model？"
---

Detected "agent self-administration" intent. The user is issuing a direct command for agent self-management or local workspace operations.

## Tool Routing by Action

| User says | Tool | Notes |
|---|---|---|
| "approve / reject / show pending / check skills" | `skill_workshop` (action: list_pending, approve, reject, inspect, status) | Resolve numbered references first |
| "restart gateway / update / config" | `gateway` (action: restart, config.get, config.patch, config.apply, update.run) | Use config.schema.lookup before config edits; pass a `note` for restart notifications |
| "check cron / add reminder / list jobs / delete job" | `cron` (action: list, add, update, remove, run, status) | Use schedule.kind based on timing need |
| "run this command / install package / execute script" | `exec` | Check TOOLS.md for env quirks (uv pattern, SSL cert fix) |
| "session info / model / status / usage" | `session_status` | Show current model, usage, time |
| "subagent / background task / running sessions" | `subagents` (action: list, kill, steer) or `sessions_list` | Check active state before killing |

## Operation Guidelines

### Skill Workshop
- `skill_workshop(action="list_pending")` to show what's queued.
- `skill_workshop(action="approve", id="<id>")` to apply a suggestion.
- `skill_workshop(action="reject", id="<id>")` to dismiss.
- `skill_workshop(action="inspect", id="<id>")` to see details before deciding.
- Always resolve numbered references: if user says "approve 2", list pending first to map index → id.

- Manage OpenClaw installation, config, gateway, crons, channels:
  skill: openclaw

- Manage context setup, rules files, and project context:
  skill: context-engineering

- Route tasks to sub-agents with optimal model selection:
  skill: delegate

- Manage multi-perspective collaboration patterns:
  skill: collaborate

- Hand off current conversation to another agent:
  skill: handoff

- Auto-detect and invoke the right skill for current task:
  skill: using-agent-skills

- Initialize every task with consistent startup protocol:
  skill: auto-skill

- Capture learnings, errors, and corrections:
  skill: self-improvement

- Guard workspace files against drift and baseline changes:
  skill: soul-guardian

- Vet third-party skills before installation:
  skill: skill-vetter
  skill: clawscan

- Run structured workflow cycles for complex multi-step tasks:
  skill: cycle

- Design and audit prompts, intents, and skills:
  skill: intent-design-cycle
  skill: intent-grill

### Gateway Management
- **Restart**: `gateway(action="restart")` + provide a `note` so the user gets notified on completion.
- **Config inspection**: `gateway(action="config.schema.lookup", path="agents.defaults")` to inspect a subtree before editing.
- **Config update**: `gateway(action="config.patch", path="...", raw="...")` for partial changes (merges safely). Use `config.apply` only for full replacement.
- Config writes hot-reload when possible; restart only when required.
- Restart during active work: warn the user first.

### Cron Management
- List: `cron(action="list")` — include `includeDisabled:true` to see everything.
- Add one-off: `cron(action="add", job={ schedule: { kind: "at", at: "<ISO>" }, payload: { ... } })`.
- Add recurring: use `schedule.kind="cron"` with `tz="Asia/Taipei"`.
- Remove: `cron(action="remove", jobId="<id>")`.
- Trigger immediately: `cron(action="run", jobId="<id>")`.

### Shell Commands
- Use `exec(command="...")` — default to workspace directory.
- For Python scripts with dependencies: `uv run --with <pkg> python3 <script>` (the owner's preferred pattern).
- SSL fix for brew-installed Python: prepend `export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`.
- Destructive commands (`rm -rf`, mass delete): pause and request explicit confirmation.
- Long-running commands: use `background: true` or `yieldMs` to avoid blocking.
- For TTY-required CLIs (coding agents, terminal UIs): use `pty: true`.

### Session Diagnostics
- `session_status` for current model, token usage, reasoning mode.
- `sessions_list` to see all active sessions and their states.
- `subagents(action="list")` to check spawned sub-agents.
- `process(action="list")` for background exec sessions.

## Post-Task Learning

- After multi-step operations, failure corrections, or discovered pitfalls, capture reusable lessons for future reference:
  skill: self-improvement

## Response Style
- This is an action request, not a discussion. Execute, then report.
- Report results concisely — what was done, what changed, any errors.
- For destructive operations or gateway restarts: confirm before acting.
- No filler, no "how can I help you further" endings.
