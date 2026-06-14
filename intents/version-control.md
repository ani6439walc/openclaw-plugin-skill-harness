---
id: VERSION_CONTROL
name: Source Code Version Control
triggers:
  - "User wants to perform git operations: commit, push, pull, branch management, merge, rebase, or submodule updates — including staging files and writing commit messages"
  - "User wants to inspect git history: status, log, diff, blame, or resolve conflicts"
examples:
  - "幫我 commit"
  - "看看 git 記錄"
  - "git status"
  - "幫我 rebase 到 main"
  - "git blame 這一行是誰改的"
  - "把 feature 分支合併到 main"
---

Detected "version control" intent. The user wants to perform git operations such as commit, push, pull, branch management, or submodule updates.

## Guidelines

- Always check `git status` first to understand the current state.
- Use `gaic` for standardized emoji-style commits when available.
- Prefer `git add` with specific files instead of `git add .` to avoid unintended changes.
- Verify staged changes with `git diff --cached --stat` before committing.
- For submodule updates, enter the submodule directory first before performing git operations.
- Keep commit messages concise and follow Conventional Commit format with emoji.
- Deliver changes incrementally to avoid giant diffs.
- Record architectural decisions and migration rationale.

## Skills & Tools

- Atomic commits, rebase, squash, and git history search:
  skill: git-master

- Structure git workflow for commits, branches, and conflicts:
  skill: git-workflow-and-versioning

- Manage Gitea issues, PRs, and releases via tea CLI:
  skill: gitea

- Deliver changes incrementally to avoid giant diffs:
  skill: incremental-implementation

- Record architectural decisions and migration rationale:
  skill: documentation-and-adrs

- Handle deprecation and migration of old systems:
  skill: dev-lifecycle
  skill: deprecation-and-migration

- Check git status:
  exec({ command: "git status" })

- Stage specific files for commit:
  exec({ command: "git add <file1> <file2>" })

- Verify staged changes before committing:
  exec({ command: "git diff --cached --stat" })

- Generate standardized commit message and commit:
  exec({ command: "gaic" })

- View recent git log:
  exec({ command: "git log --oneline -10" })

- Push to remote:
  exec({ command: "git push origin <branch>" })

- Pull from remote:
  exec({ command: "git pull origin <branch>" })

## Response Strategy

- For simple operations (status, log, pull, push): use `exec` directly.
- For commit/rebase/squash/history search: use `git-master` skill.
- Always check status first, then stage specific files, verify, and commit.
- Report the result with commit hash or branch state.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4
check      stage       commit       report
status     files                   & push
```

### Step 1 — Check Status
- Run `git status` to understand the current state.
- Identify which files have changed and need staging.

### Step 2 — Stage Files
- Use `git add` with specific files (never `git add .`).
- Verify staged changes with `git diff --cached --stat`.

### Step 3 — Commit
- Use `gaic` for standardized emoji-style commits.
- Keep commit messages concise with Conventional Commit format.
- For complex operations (rebase, squash): use `git-master` skill.

### Step 4 — Report & Push
- Report the commit hash and summary.
- Push to remote if requested.
- For PRs: use `gitea` skill to create and manage.
