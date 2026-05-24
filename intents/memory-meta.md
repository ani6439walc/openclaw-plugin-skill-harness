---
id: MEMORY_META
name: Meta-Memory Query (System Corpus)
triggers:
- "User is asking about the memory system itself, SOPs, plugin architecture, file structure, workflow improvements, or system-side documentation"
examples:
- "我們的記憶系統有什麼可以改善的？"
- "這個 SOP 的架構對嗎？"
- "daily notes 的寫法要怎麼改？"
- "intention-hint plugin 怎麼運作的？"
---

Detected "meta-memory" intent. The user wants information about the system itself — not life events, but the architecture, SOPs, plugins, and workflows that manage memory and behavior.

## Guidelines

- Search **System Corpus** instead of domain memory (`memory/`).
- System Corpus includes: `darling/projects/**/*.md`, `memory/learnings/*.md`, `AGENTS.md`, `TOOLS.md`, `SOUL.md`, `IDENTITY.md`, `wiki/**/*.md`.
- Do not confuse life-domain questions that happen to contain the word "系統" (e.g., "我系統學日文學得怎麼樣？" → still domain memory).
- If the query is ambiguous between domain and system, ask for clarification.

## Skills & Tools

- Read a large Markdown file by section:
  skill: treemd

- Search system corpus with rg:
  ```bash
  rg -i -n -C 2 "<keyword1>|<keyword2>|<keyword3>" darling/projects/ AGENTS.md TOOLS.md memory/learnings/
  ```

## Response Strategy

- Validate intent: ensure the question is truly about system/SOP/architecture, not life events.
- Use `rg` for precise keyword matching (system files are mostly structured/technical).
- Group results by file category (project docs, behavior rules, learning records, tool conventions).
- Do not fabricate system features that do not exist in the documentation.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4
validate    rg search     categorize    format reply
intent      system corpus by path
```

### Step 1 — Validate Intent (Ensure Not Domain Memory Disguised)

**Decision rules**:

| Seemingly meta query | Actual intent | Logic | Correct routing |
|---|---|---|---|
| "我系統學日文學得怎麼樣了？" | `memory_standard` (learning Japanese progress) | Contains "系統" but no SOP/architecture words | Stay with domain memory |
| "我們的 Duolingo skill 有沒有改善？" | `memory_meta` (skill design) | "skill" + "改善" = system improvement | System corpus |
| "幫我整理一下記憶" | Ambiguous | Cannot determine | Ask user: "organize life diary or memory system architecture?" |

**Trigger words**: `系統`, `SOP`, `改善`, `plugin`, `skill`, `架構`, `workflow`, `config`, `vault`, `工具`

### Step 2 — rg Search on System Corpus

```bash
rg -i -n -C 2 "SOP|改善|plugin|skill" \
  darling/projects/**/*.md \
  AGENTS.md \
  TOOLS.md \
  memory/learnings/LEARNINGS.md \
  SOUL.md
```

- Technical documents use English keywords primarily — `rg` is more precise than semantic search.
- If rg returns too many hits, narrow the scope to specific paths (e.g., only `darling/projects/ai/`).

### Step 3 — Categorize by Path Type

Group rg hits by source path:

| Category | Typical path | Content description |
|---|---|---|
| Project docs | `darling/projects/**/*.md` | Project goals, progress, technical architecture |
| Behavior rules | `AGENTS.md` | Session startup, formatting standards |
| Tool conventions | `TOOLS.md` | SSH aliases, AC control, Folio |
| Learning records | `memory/learnings/*.md` | Error lessons, best practices |
| Personality framework | `SOUL.md` / `IDENTITY.md` | Character settings, state machine |

### Step 4 — Format Response

Organize by category, each hit includes:
- File path
- Line number
- Content summary

Example:
```
Search results for "SOP 改善":

📂 Project Docs
- `darling/projects/ai/intention-hint-plugin.md`
  - L1451: `memory_meta` intent trigger definition
  - L1100: V2.2 core upgrade summary table

📜 Behavior Rules
- `AGENTS.md`
  - L450: Session log compression mechanism
```

- **Never fabricate system features.** If rg returns no hits, say "Ani found no related records in system documentation."
