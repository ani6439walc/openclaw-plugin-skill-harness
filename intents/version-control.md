---
id: VERSION_CONTROL
name: Source Code Version Control
triggers:
  - "User wants to perform git operations: commit, push, pull, branch management, merge, rebase, or submodule updates — including staging files and writing commit messages"
  - "User wants to inspect git history: status, log, diff, blame, or resolve conflicts"
  - "User wants to retry, redo, or repeat a previous git operation that failed, was interrupted, or needs to be reattempted"
examples:
  - "幫我 commit"
  - "看看 git 記錄"
  - "git status"
  - "幫我 rebase 到 main"
  - "git blame 這一行是誰改的"
  - "把 feature 分支合併到 main"
  - "retry"
  - "再試一次 commit"
  - "重新 push"
  - "redo the last push"
  - "commit push"
---

Detected "version control" intent. The user wants to perform git operations such as commit, push, pull, branch management, or submodule updates.

## Guidelines

- Always check `git status` first to understand the current state.
- Use `gaic` for standardized emoji-style commits when available.
- Prefer `git add` with specific files instead of `git add .` to avoid unintended changes, unless the user explicitly requests committing all current changes and status has been verified.
- Verify staged changes with `git diff --cached --stat` before committing.
- When `git status` shows unmerged paths, resolve conflicts before staging unrelated files or committing.
- For workspaces with multiple repositories, detect all repos first and handle each independently.
- For submodule updates, enter the submodule directory first before performing git operations.
- Keep commit messages concise and follow Conventional Commit format with emoji.
- Deliver changes incrementally to avoid giant diffs.
- Do not attempt to fix code, rewrite files, or perform unrelated implementation work unless the user explicitly asks; keep the scope to the requested git operation.

## Skills & Tools

- Atomic commits, rebase, squash, and git history search:
  skill: git-master

- Structure git workflow for commits, branches, and conflicts:
  skill: git-workflow-and-versioning

- Manage Gitea issues, PRs, and releases via tea CLI only when PR/release creation is explicitly requested:
  skill: gitea

- Check repository status:
  exec({ command: "git status" })

- Stage specific files:
  exec({ command: "git add <file1> <file2>" })

- Stage all verified changes only when explicitly requested:
  exec({ command: "git add ." })

- Verify staged changes before committing:
  exec({ command: "git diff --cached --stat" })

- Resolve merge conflicts manually:
  read({ path: "<conflicted_file>" })
  edit({ path: "<conflicted_file>", edits: [{ oldText: "<conflict_block>", newText: "<resolved_content>" }] })
  exec({ command: "git add <conflicted_file>" })

- Generate AI-assisted standardized commit messages:
  exec({ command: "gaic" })

- Commit changes with an explicit message when needed:
  exec({ command: "git commit -m \"<type>(<scope>): <message>\"" })

- Push to remote:
  exec({ command: "git push origin <branch>" })

- Pull from remote:
  exec({ command: "git pull origin <branch>" })

- View recent history:
  exec({ command: "git log --oneline -10" })

## Response Strategy

- For simple operations (status, log, pull, push): use `exec` directly.
- For commit/rebase/squash/history search: use `git-master` skill.
- Always check status first, then stage specific files, verify, and commit.
- Never fabricate git results. Every commit, push, pull, status, or history claim must be backed by an actual `exec` tool call running the corresponding git command.
- Report real git output such as commit hash, branch name, changed file list, `Everything up-to-date`, or clean working tree status before declaring success.
- If the user asks to commit and push, run `git status`, selective `git add`, `git diff --cached --stat`, `git commit`, and `git push` in sequence unless the verified status shows there is nothing to commit.
- Report the result with commit hash or branch state grounded in command output.

## Concrete Workflow

```
Step 0 → Step 1 → Step 2 → Step 3 → Step 4
detect   check     stage     commit    report
repos    status    files               & push
```

### Step 0 — Detect Repositories

- Identify git repositories in the current workspace context with a bounded discovery command such as `find . -maxdepth 3 -name .git -type d`.
- If multiple repos are found, list them and handle each separately with its own status, stage, commit, and push cycle.
- For single-repo contexts, proceed directly to Step 1.

### Step 1 — Check Status

- Run `git status` in each target repository to understand the current state.
- Identify which files have changed and need staging.
- Before commit, push, merge, rebase, or retry operations, check submodule health with `git submodule status` when the repository uses submodules.
- If the main repository or any submodule is mid-rebase, mid-merge, or has unresolved conflicts, finish or abort that operation before staging new changes.
- For submodule problems, enter the affected submodule and resolve its state independently, then return to the parent repository and re-check status.

### Step 2 — Stage Files & Resolve Conflicts

- Use `git add` with specific files by default; use `git add .` only when the user explicitly requested all current changes and `git status` has been inspected.
- If `git status` shows unmerged paths or conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`):
  1. Use `read` to inspect every conflicted file.
  2. Use `edit` to resolve the conflict manually and remove markers.
  3. Run `git add <conflicted_file>` only for files that are actually resolved.
- Verify staged changes with `git diff --cached --stat`.

### Step 3 — Commit

- Use `gaic` for standardized emoji-style commits.
- Keep commit messages concise with Conventional Commit format.
- For complex operations (rebase, squash): use `git-master` skill.

### Step 4 — Report & Push

- Report the commit hash and summary for each repository handled.
- Push to remote if requested.
- For PRs: use `gitea` skill to create and manage.
