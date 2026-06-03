---
id: AGENT_ADMIN
name: Agent Self-Administration (代理人自我管理)
enabled: true
triggers:
  - "User issues a direct command for agent self-management or workspace operations: skill management (vet/scan/clean), gateway restart, config inspection, cron jobs, shell commands, dependency management (pnpm, npm, pip, brew, apt, uv), or script execution"
  - "User references a numbered item from a prior list (e.g. 'approve 2', 'delete the third one') or confirms/rejects a pending proposal from a skill queue"
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

## Guidelines

- This is an action request, not a discussion. Execute, then report.
- Report results concisely — what was done, what changed, any errors.
- For destructive operations or gateway restarts: confirm before acting.
- No filler, no "how can I help you further" endings.
- Always resolve numbered references: if user says "approve 2", list pending first to map index → id.
- Config writes hot-reload when possible; restart only when required.
- Restart during active work: warn the user first.
- Destructive commands (`rm -rf`, mass delete): pause and request explicit confirmation.
- Long-running commands: use `background: true` or `yieldMs` to avoid blocking.
- For TTY-required CLIs (coding agents, terminal UIs): use `pty: true`.
- For Python scripts with dependencies: `uv run --with <pkg> python3 <script>` (the owner's preferred pattern).
- SSL fix for brew-installed Python: prepend `export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`.

## Skills & Tools

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
  skill: dev-lifecycle

- Initialize every task with consistent startup protocol:
  skill: auto-skill

- Capture learnings, errors, and corrections:
  skill: self-improvement

- Guard workspace files against drift and baseline changes:
  skill: soul-guardian

- Vet third-party skills before installation:
  skill: skill-vetter
  skill: clawscan

- Scan, audit, and clean skills (budget, duplicates, unused):
  skill: skill-cleaner

- Run structured workflow cycles for complex multi-step tasks:
  skill: cycle

- Design and audit prompts, intents, and skills:
  skill: intent-craft

- Restart the gateway with notification:
  gateway({ action: "restart", note: "..." })

- Inspect a config subtree before editing:
  gateway({ action: "config.schema.lookup", path: "agents.defaults" })

- Apply a partial config change:
  gateway({ action: "config.patch", path: "...", raw: "..." })

- List cron jobs (including disabled):
  cron({ action: "list" })

- Add a one-off cron job:
  cron({ action: "add", job: { schedule: { kind: "at", at: "<ISO>" }, payload: { ... } } })

- Add a recurring cron job:
  cron({ action: "add", job: { schedule: { kind: "cron", expr: "...", tz: "Asia/Taipei" }, payload: { ... } } })

- Remove a cron job:
  cron({ action: "remove", jobId: "<id>" })

- Execute a shell command:
  exec({ command: "...", background: true })

- Get current session diagnostics (model, usage, time):
  session_status()

- List active sub-agents:
  subagents({ action: "list" })

- List active sessions:
  sessions_list()

- List background exec processes:
  process({ action: "list" })

## Response Strategy

- Identify the action type from the user's request (gateway, cron, shell, session, skill management).
- Execute the appropriate tool with the correct parameters.
- Report the result concisely — what was done, what changed, any errors.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4
classify  resolve     execute      report
```

### Step 1 — Classify Action Type
- Determine which category the request falls into:
  - Gateway management (restart/config/update)
  - Cron management (add/list/remove/run)
  - Shell execution (command/install/script)
  - Session diagnostics (status/model/sessions)

### Step 2 — Resolve References
- If user references a numbered item ("approve 2"), list pending items first to map index → id.
- Confirm the target is correct before executing any mutating action.

### Step 3 — Execute
- Run the appropriate tool with validated parameters.
- For destructive operations, pause and confirm with the user first.
- For long-running commands, use background mode.

### Step 4 — Report
- Report what was done, what changed, and any errors.
- Keep it concise — no filler or follow-up prompts.
