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

## Response Strategy

For all git operations, prefer using the **`git-master` skill** for commit, rebase, squash, and history search tasks. It provides atomic commits, style detection, conflict resolution, and blame/bisect workflows.

- For simple operations (status, log, pull, push)
  exec({command: "git etc..."})
- For commit/rebase/squash/history search
  skill: git-master

```bash
# Quick status + log
git status
git log --oneline -10

# Push to remote
git push origin <branch>

# Pull from remote
git pull origin <branch>
```
