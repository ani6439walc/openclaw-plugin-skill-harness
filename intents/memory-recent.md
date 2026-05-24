---
id: MEMORY_RECENT
name: Recent Memory Query
triggers:
- "User is asking about today, yesterday, this week, the last few days, or another clearly recent time window"
examples:
- "我昨天跟你說了什麼？"
- "今天 Duolingo 做了嗎？"
- "昨天去了哪裡？"
- "今天有 commit 什麼嗎？"
---

Detected "recent memory" intent. The user wants a recent record from a narrow time window such as today, yesterday, this week, or the last few days.

## Guidelines

- Treat the latest user message as the primary retrieval target.
- Use recent conversation only to disambiguate what the latest message refers to.
- Prefer recent raw diary files over broad semantic retrieval.
- Focus on explicit time cues from the user's question.
- Do not guess dates or fabricate missing entries.
- If recent raw records are missing or incomplete, say so clearly.

## Skills & Tools

- Read a large recent memory note by section:
  skill: treemd

- Search recent raw diary files directly when the time window is known:
  ```bash
  rg -in "<keyword1>|<keyword2>|<keyword3>" memory/YYYY-MM-DD.md
  ```

- Read the relevant recent memory note when more detail is needed:
  memory_get({ path: "memory/YYYY-MM-DD.md" })

## Response Strategy

- Infer the recent time window from the user's wording.
- Reformulate the request into a few high-value keywords before searching.
- Search recent raw diary files directly before using broader memory lookup methods.
- Return the most relevant recent record first.
- If raw recent files are missing or thin, say so instead of overreaching.
- Treat broad historical, comparative, emotional, or timeline questions as separate intents.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4
infer       check         keyword       synthesize
window      files         match
```

### Step 1 — Infer Time Window
- Extract time keywords from the user's question → map to specific dates or date ranges.
- **Time word mapping**:
  | User says | Lookback range | Files to check |
  |---|---|---|
  | 今天 (today) | Today | `memory/YYYY-MM-DD.md` (current) |
  | 昨天 (yesterday) | Yesterday | `memory/YYYY-MM-DD.md` (yesterday) |
  | 前天 (day before) | 2 days ago | `memory/YYYY-MM-DD.md` |
  | 這幾天 / 最近幾天 (recent days) | Last 3 days | 3 date files backward |
  | 這週 / 最近 (this week / recent) | Last 7 days | 7 date files backward |
  | 上週 (last week) | Mon–Sun last week | 7 corresponding date files |
  | 週末 / 連假 (weekend / holiday) | Infer from context | Based on context |
- Use system time as the reference point (confirm via `session_status` or `date`).

### Step 2 — Check Diary File Existence
- Verify the inferred `memory/YYYY-MM-DD.md` files actually exist:
  ```bash
  ls -la memory/2026-05-24.md memory/2026-05-23.md ...
  ```
- If a file does not exist, clearly state "no diary record for that day" — do not fabricate.
- If the file exists but is small (< 500 bytes), note "the record for that day is brief."

### Step 3 — Keyword Match (rg Fallback Search)
- If the user mentions a specific topic (e.g., Duolingo, coffee, meeting), use `rg` to search within the relevant date's diary:
  ```bash
  rg -i "<keyword1>|<keyword2>" memory/2026-05-24.md memory/2026-05-23.md
  ```
- **Prefer `rg` over `memory_search`** for recent diaries — direct text matching is more precise on raw natural language.
- If `rg` returns no hits, fall back to `memory_search` for semantic search.

### Step 4 — Synthesize Response
- Read matched diary content and reply naturally about what the user did today/yesterday.
- If the diary mentions the user's emotional state or mood (e.g., #專注, #開心), include it.
- **Do not** mix in older data beyond the time window. If the user asks "today," answer only about today.
- If the day's diary is blank or missing, say so directly, and optionally check adjacent days as supplementary context.
