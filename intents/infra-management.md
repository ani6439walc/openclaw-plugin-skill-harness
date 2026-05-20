---
id: INFRA_MANAGEMENT
name: Infrastructure Management (基礎設施維運)
enabled: true
triggers:
  - "User wants to manage, inspect, debug, or operate home-infra services and servers — including SSH access, remote commands, service restarts, and status checks"
  - "User references specific infra hosts by name: truenas, casaos, argocd, home-infra-router, proxmox, unifi, talos, or mentions K8s/Terraform/Nginx/Home Assistant operations"
  - "User needs Linux system administration: process management, disk usage, permissions, service management, or device/automation state checks"
examples:
  - "看一下 K8s cluster 狀態"
  - "ArgoCD 幫我 sync 一下"
  - "SSH 進去 truenas 看看磁碟空間"
  - "幫我跑 terraform plan 看看要改什麼"
  - "router 的 Tailscale 有正常跑嗎？"
  - "Home Assistant 幫我找一下主人的手機在哪"
---

Detected "infrastructure management" intent. The user wants to manage home-infra systems, servers, or services.

## Host Quick Reference

From `TOOLS.md`:

| Host | Access | Role |
|---|---|---|
| TrueNAS | `ssh root@truenas.local` (192.168.0.118) | NAS, game library, media |
| CasaOS | `ssh root@casaos.home-infra.weii.cloud` | Docker containers, private cloud |
| UGOS Router | `ssh root@casaos.home-infra.weii.cloud` (Tailscale 100.108.242.22) | Exit node, NPM, AdGuard, Glances |
| ArgoCD | `argocd.home-infra.weii.cloud` (admin / `j04rmp4jo3`) | GitOps deployment |
| Home Assistant | `home-assistant.weii.cloud` | Home automation, device tracking |

## Skill & Tool Routing

| Task | Skill / Tool |
|---|---|
| Kubernetes: pods, deployments, services, debugging, best practices | `k8s` skill + `kubectl` |
| Terraform: state, plan, apply, module structure, pitfalls | `terraform` skill |
| Nginx: reverse proxy, SSL, location blocks, performance | `nginx` skill |
| Linux system administration: permissions, processes, disks, services | `linux` skill |
| Home Assistant: device tracking, AC control, automations | `home-assistant` skill |
| Service health checks, uptime monitoring, automated status verification | `healthcheck` skill |
| Security audit, workspace integrity check, config drift detection | `exec({ command: "python3 ../skills/soul-guardian/scripts/soul_guardian.py check --actor manual --output-format alert" })` |
| SSH remote commands | `exec` tool (`ssh root@<host>`) |
| ArgoCD CLI operations | `argocd login ...` + `argocd app sync/list/...` |
| Container management (Docker, CasaOS) | `exec` tool (`docker ps/logs/restart`) |
| Disk space, processes, system health | `exec` tool (`df -h`, `top`, `systemctl`) |

## Guidelines

### Safety First
- **Never run destructive commands without explicit confirmation**: `rm -rf`, `terraform destroy`, `kubectl delete`, `docker rm -f`.
- Prefer read-only operations first (`kubectl get`, `terraform plan`, `docker ps`, `df -h`).
- When in doubt, show the command to the user before executing.
- SSH credentials are stored in `TOOLS.md` — do not exfiltrate.

### Pre-Flight
- Read `TOOLS.md` for host addresses, credentials, and SOPs before acting.
- Check if the referenced tool/skill exists before routing to it.
- For K8s/Terraform/Nginx tasks, load the relevant skill first.

### Context Awareness
- User is a Google Cloud SRE with CKA/CKAD/CKS — technical depth is expected.
- Home-infra runs on Talos Linux — immutable, API-driven.
- ArgoCD manages GitOps deployments — prefer `argocd sync` over manual `kubectl apply`.
- Late-night (23:00-08:00): avoid disruptive operations unless urgent.

### Post-Change Verification

- After any infra mutation (deploy, config change, service restart), run a quick health sweep:
  skill: healthcheck
- After modifying core workspace files (AGENTS.md, TOOLS.md, SOUL.md) or plugin configs, verify no drift:
  exec({ command: "python3 ../skills/soul-guardian/scripts/soul_guardian.py check --actor manual --output-format alert" })
