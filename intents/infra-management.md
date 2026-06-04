---
id: INFRA_MANAGEMENT
name: Infrastructure Management (基礎設施維運)
enabled: true
triggers:
  - "User wants to manage, inspect, debug, or operate home-infra services and servers — including SSH access, remote commands, service restarts, and status checks"
  - "User references specific infra hosts by name: truenas, casaos, argocd, home-infra-router, proxmox, unifi, talos, or mentions K8s/Terraform/Nginx/Home Assistant operations"
  - "User needs Linux system administration: process management, disk usage, permissions, service management, or device/automation state checks"
  - "User wants to manage the OpenClaw gateway: restart, config inspection/patch, update"
  - "User wants to manage cron jobs: add, list, remove, run, or check scheduled tasks"
  - "User wants to execute shell commands, install dependencies (pnpm, npm, pip, brew, apt, uv), or run scripts"
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

## Skills & Tools

- Manage OpenClaw installation, config, gateway, crons, channels:
  skill: openclaw

- Manage Kubernetes resources, probes, selectors, RBAC:
  skill: kubernetes

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
- Check if late-night restrictions apply (23:00-08:00).

### Step 3 — Load Skill & Route
- Load the appropriate skill for the target system.
- Use `dev-lifecycle` to verify the skill exists before routing.

### Step 4 — Execute
- Start with read-only operations (status checks, plan, ps).
- For mutations, confirm with the user before executing.
- Show the command preview for potentially risky operations.

### Step 5 — Verify Health
- After any mutation, run a health sweep using `healthcheck` skill.
- For workspace file changes, run `soul-guardian` check.
- Report the final state to the user.
