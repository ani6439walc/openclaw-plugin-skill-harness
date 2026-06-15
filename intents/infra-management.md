---
id: INFRA_MANAGEMENT
name: Infrastructure Management (基礎設施維運)
enabled: true
triggers:
  - "User wants to manage, inspect, debug, or operate home-infra services and servers — including SSH access, remote commands, service restarts, and status checks"
  - "User references specific infra hosts by name: truenas, casaos, argocd, home-infra-router, proxmox, unifi, talos, or mentions K8s/Terraform/Nginx/Home Assistant operations"
  - "User needs Linux system administration: process management, disk usage, permissions, service management, or device/automation state checks"
  - "User wants to manage the OpenClaw gateway at runtime: restart, config inspection/patch, update (excluding plugin code development or hook modification)"
  - "User wants to manage cron jobs: add, list, remove, run, or check scheduled tasks"
  - "User wants to execute shell commands, install dependencies (pnpm, npm, pip, brew, apt, uv), or run scripts"
  - "User wants to locate or track a device's physical location using GPS, network, or infrastructure tools such as Home Assistant device tracking, phone location lookup, or GPS coordinates"
  - "User asks the agent to guess or determine their current location using location data, GPS coordinates, or device tracking infrastructure"
examples:
  - "看一下 K8s cluster 狀態"
  - "ArgoCD 幫我 sync 一下"
  - "SSH 進去 truenas 看看磁碟空間"
  - "幫我跑 terraform plan 看看要改什麼"
  - "router 的 Tailscale 有正常跑嗎？"
  - "Home Assistant 幫我找一下主人的手機在哪"
  - "幫我 restart gateway"
  - "加個每天早上 9 點的 cron"
  - "幫我執行 pnpm add -g sharp"
  - "uv run --with paho-mqtt python3 script.py"
  - "用 GPS 猜猜我在哪"
  - "繼續用 gps 座標啊"
  - "幫我查一下我現在的位置"
  - "用定位看看我在哪裡"
  - "我的手機現在在哪裡"
---

Detected "infrastructure management" intent. The user wants to manage home-infra systems, servers, or services.

## Guidelines

- Read `TOOLS.md` for host addresses, credentials, and SOPs before acting.
- Never run destructive commands without explicit confirmation: `rm -rf`, `terraform destroy`, `kubectl delete`, `docker rm -f`.
- Prefer read-only operations first (`kubectl get`, `terraform plan`, `docker ps`, `df -h`).
- When in doubt, show the command to the user before executing.
- SSH credentials are stored in `TOOLS.md` — do not exfiltrate.
- User is a Google Cloud SRE with CKA/CKAD/CKS — technical depth is expected.
- Home-infra runs on Talos Linux — immutable, API-driven.
- ArgoCD manages GitOps deployments — prefer `argocd sync` over manual `kubectl apply`.
- Late-night (23:00-08:00): avoid disruptive operations unless urgent.
- After any infra mutation (deploy, config change, service restart), run a quick health sweep.
- After modifying core workspace files (AGENTS.md, TOOLS.md, SOUL.md) or plugin configs, verify no drift.
- When inspecting service, plugin, gateway, or scheduler configuration, verify the actual runtime state from the live config file or config inspection tool before relying on source-code or documentation defaults.
- Scope boundary: this intent covers runtime operations, config patching, and shell execution. Do not handle code development, hook modification (for example `agent_end` or `before_prompt_build`), or architectural changes to plugins, intent logic, or self-improvement Markdown files.
- For location tracking or GPS-based guessing, treat it as infrastructure/device-state work only when the user asks to use location data, Home Assistant, GPS coordinates, or phone/device tracking; otherwise playful guessing stays in CHAT.
- OpenClaw gateway `commands.restart` is a protected config path; do not try to enable or toggle it through config patching.
- If a gateway tool call reports a protected-path error or the CLI is missing from the local PATH, switch to the documented host/SSH execution path instead of retrying the blocked mechanism.
- Before deleting workspace directories, ensure data is ingested to wiki, backed up, or recoverable from git.
- For git-based restoration of deleted files, use `git restore <path>` or `git checkout HEAD -- <path>` before retrying archival or cleanup.

## Skills & Tools

- Manage Home Assistant entities, device tracking, automations, and IoT sensor queries:
  skill: home-assistant

- Manage OpenClaw installation, config, gateway, crons, channels:
  skill: openclaw

- Manage Kubernetes resources, probes, selectors, RBAC:
  skill: kubernetes

- Provision guest namespaces, generate kubeconfig, and manage registry pull secrets:
  skill: home-infra-guest-namespace

- Deploy and manage Knative Serving resources and services:
  skill: knative-serving

- Manage self-hosted Gitea operations, PATs, and package registry authentication:
  skill: gitea

- Handle Terraform state, for_each, lifecycle, dependency ordering:
  skill: terraform

- Configure Nginx reverse proxy, SSL termination, caching:
  skill: nginx

- Operate Linux systems avoiding permission traps and silent failures:
  skill: linux

- Setup CI/CD pipelines and quality gates:
  skill: ci-cd-and-automation

- Prepare production launches with monitoring and rollback:
  skill: shipping-and-launch

- Check if the referenced tool/skill exists before routing to it:
  skill: dev-lifecycle

- Run system health checks across workspace, config, and integrations:
  skill: healthcheck

- Restart the gateway with notification:
  gateway({ action: "restart", note: "..." })

- Restart gateway through the host CLI when protected config or local PATH restrictions block native tooling:
  exec({ command: "ssh <host> 'openclaw gateway restart'" })

- Inspect a config subtree before editing:
  gateway({ action: "config.schema.lookup", path: "agents.defaults" })

- Apply a partial config change:
  gateway({ action: "config.patch", path: "...", raw: "..." })

- List cron jobs:
  cron({ action: "list" })

- Add a cron job:
  cron({ action: "add", job: { schedule: { kind: "cron", expr: "...", tz: "Asia/Taipei" }, payload: { ... } } })

- Remove a cron job:
  cron({ action: "remove", jobId: "<id>" })

- Execute a shell command:
  exec({ command: "...", background: true })

- Run security audit, workspace integrity check, config drift detection:
  exec({ command: "python3 ../skills/soul-guardian/scripts/soul_guardian.py check --actor manual --output-format alert" })

## Response Strategy

- Read `TOOLS.md` for host reference (addresses, credentials, SOPs).
- Identify the target service/system from the user's request.
- Load the appropriate skill (kubernetes, terraform, nginx, linux, etc.).
- Execute read-only operations first; confirm before destructive commands.
- After mutations, run a health sweep to verify stability.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
read       identify    load skill   execute      verify
TOOLS.md   target      & route      & mutate     health
```

### Step 1 — Read TOOLS.md
- Look up host addresses, credentials, and SOPs for the target system.
- Confirm access method (SSH, CLI, API, web console).

### Step 2 — Identify Target
- Determine which system the user wants to manage (K8s, Terraform, Nginx, TrueNAS, ArgoCD, etc.).
- For configuration inspection requests, read the actual runtime config file (for example `openclaw.json`) or use an available config inspection tool before referencing defaults.
- Check if late-night restrictions apply (23:00-08:00).

### Step 3 — Load Skill & Route
- Load the appropriate skill for the target system.
- Use `dev-lifecycle` to verify the skill exists before routing.

### Step 4 — Execute
- Start with read-only operations (status checks, plan, ps).
- For mutations, confirm with the user before executing.
- Show the command preview for potentially risky operations.
- When creating a Gitea Personal Access Token (PAT) for Ani's own account via `tea`:
  1. Verify authenticated `tea` context with `tea login list`.
  2. Prefer the Gitea API through `tea api` when `tea` has no direct PAT subcommand.
  3. Request only the required scopes for the downstream task, such as package registry read/write.
  4. Parse the returned token from the JSON response and use it immediately for the registry login or Kubernetes `imagePullSecret`.
  5. Do not persist the token in plaintext memory, chat, logs, or intent files.

### Step 4.5 — Gateway Restart Recovery
- If the native gateway restart tool is disabled, do not patch protected restart-related config paths.
- Verify the host and access method from `TOOLS.md`, then run the gateway CLI through the host or SSH execution path.
- After the restart command returns, check gateway status or a lightweight health endpoint before reporting success.
- If host access fails, report the exact failing command and error; do not claim the restart happened.

### Step 4.6 — Workspace Directory Archival & Cleanup
- Verify source files are ingested to wiki, backed up, committed, or otherwise recoverable before deletion.
- If files were prematurely deleted, restore them with `exec({ command: "git restore <path>" })` or `exec({ command: "git checkout HEAD -- <path>" })`.
- Execute destructive cleanup such as `rm -rf <path>` only after explicit user confirmation.
- Verify the final filesystem and git state with `ls`, `test -e`, and `git status --short`.

### Step 5 — Verify Health
- After any mutation, run a health sweep using `healthcheck` skill.
- For workspace file changes, run `soul-guardian` check.
- Report the final state to the user.
