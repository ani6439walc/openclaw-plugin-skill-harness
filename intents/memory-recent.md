---
id: MEMORY_RECENT
name: Recent Memory Query
triggers:
- "User asks about events from the last few days, today, yesterday, or other near-past timeframes (e.g., recently, this morning, last night, just now)"
- "User asks for confirmation or recall of something that happened within the current week or past 7 days"
- "User inquires about specific recent activities, meals, commits, travel, appointments, purchases, health tracking, or status updates"
- "User's question implies checking daily notes, session logs, or routine tracking (e.g., Duolingo, exercise, work commits)"
- "User references a specific date by weekday (e.g., Monday, last Wednesday)"
examples:
- "What did I tell you yesterday?"
- "What's been important recently?"
- "How's the progress on that project we discussed a few days ago?"
- "Are last week's meeting notes still available?"
- "Did I do Duolingo today?"
- "Where did I go yesterday?"
- "Have I had a massage recently?"
- "Have I taken the high-speed rail recently?"
- "Did I commit anything today?"
- "What did we talk about last night?"
- "Who did I meet with last Wednesday?"
- "What did I eat this morning?"
- "Have I exercised this week?"
- "How was the weather yesterday?"
- "What did I buy the other day?"
---

Detected "recent memory" intent. Use the **Fast Path** lightweight retrieval protocol below. Do NOT use `memory_search` (vector search); use `rg` (ripgrep) instead. This minimizes latency from 30–60 s down to 3–5 s.

## ⚠️ CRITICAL SAFETY RULES (apply to ALL steps)

1. **NEVER fabricate information**. If no hits, explicitly report that no records were found.
2. **NEVER cite `dreaming/` files as factual evidence** unless raw diaries were searched and found empty.
3. **NEVER guess dates**. Use only dates derived from the user's explicit temporal cues or the current system date.
4. Always prefer **raw diary** (`memory/YYYY-MM-DD.md`) over `dreaming/` summaries.
5. If raw file exists but is empty or contains only frontmatter, report `EMPTY_RAW_DIARY`.
6. If the user's query uses words like "剛剛", "剛才", "just now" AND the current time is late evening, append a disclaimer that the activity may still be in progress and not yet written to the raw diary.

## Step 1 — Infer Time Window & List Candidate Files

1. Parse the user query for temporal cues:
   - `今天` → today. **Use the current system date from the conversation context**. If uncertain, default to the most recent existing `memory/YYYY-MM-DD.md` file.
   - `昨天` → date − 1 day from the current system date.
   - `這幾天` / `最近` / `前幾天` → last 3–7 days
   - `上週` → last 7 days from previous Sunday

2. For each candidate date, check `memory/YYYY-MM-DD.md` existence and state **before** searching:
   ```bash
   stat --format="%s" memory/YYYY-MM-DD.md
   ```
   - **If file does NOT exist** → mark as `MISSING_RAW_DIARY`. **Skip this date entirely** for raw search.
   - **If file exists but size < 200 bytes or contains only frontmatter** → mark as `EMPTY_RAW_DIARY`.
   - **Only if raw exists and is non-empty** → include it in Step 2 `rg` target list.

   `memory/dreaming/light/YYYY-MM-DD.md` and `memory/dreaming/rem/YYYY-MM-DD.md` are **not primary sources**; they are session summaries. Only reference them under the strict conditions in Step 3-D.

## Step 2 — Multi-Round `rg` Matching (up to 3 tool calls)

> **Stop immediately when any round produces hits.** Do NOT proceed to the next round.

### Round 1: Semantic Keyword Search

1. Extract 1–3 core keywords from the user's question (nouns or verbs). Skip stop words.

   **Keyword De-noising Rules** (prevent false positives):
   - **Avoid single-character verbs** like `吃`, `做`, `去` when used alone. They cause massive false matches (`吃力`, `吃驚`, `吃過...嗎`).
   - Instead, extract **semantic phrases or nouns**:
     - "吃了什麼" → keywords: `午餐|晚餐|早餐|美食|餐廳|甜點`
     - "做了什麼" → keywords: `完成|練習|工作|會議|運動`
     - "去了哪裡" → keywords: `地點|地址|旅行|出差|嘉義|台北`
   - If the user question contains a **proper noun** (name, place, project), always include it as the first keyword.

2. Run `rg` against **only** the non-empty raw candidate files from Step 1.

**Tool Call:**
```bash
rg -in "<keyword1>|<keyword2>|<keyword3>" memory/2026-MM-DD.md memory/2026-MM-DD.md ...
```

**Parameters explained:**
- `-i` = case-insensitive
- `-n` = show line numbers
- `"word1|word2"` = OR pattern for multiple keywords
- Target paths = only the non-empty raw candidate files from Step 1 (do NOT search entire repo)

**Execution Example:**
```bash
rg -in "按摩|御仙堂|林森" memory/2026-05-04.md memory/2026-05-03.md memory/2026-05-02.md
```

### Round 2: Synonym Expansion Search

**Only execute if Round 1 returns zero hits on ALL raw files.**

Determine the semantic category of the query and run an expanded `rg`:

**How to determine category**: Match the user's core verb/noun to the Category column.
- If the query mentions body movement, fitness, walking, cycling, or outdoor activity → use 運動健身
- If the query mentions food, meals, eating, restaurants, or snacks → use 飲食
- If the query mentions transportation, tickets, commuting, or travel vehicles → use 交通
- If the query mentions code, deployment, PR, git, or release → use 工作產出
- If the query mentions health, body care, recovery, or medical → use 健康
- If no category matches → **skip Round 2 and proceed directly to Dreaming Fallback**

| Category | Original Keywords | Expansion Keywords |
|---|---|---|
| 運動健身 | 運動 | `走路|散步|爬山|騎車|健身|跑步|游泳|瑜珈|腳踏車|健行` |
| 飲食 | 午餐/晚餐 | `美食|餐廳|小吃|火鍋|拉麵|甜點|咖啡|早餐|宵夜` |
| 交通 | 高鐵 | `火車|車票|台鐵|捷運|飛機|租車|Ubike|搭車` |
| 工作產出 | commit | `PR|merge|push|deploy|上線|發布|程式碼|分支` |
| 健康 | 按摩 | `推拿|SPA|整復|泡湯|溫泉|復健|看醫生` |

```bash
rg -in "<expanded1>|<expanded2>|<expanded3>" memory/2026-MM-DD.md ...
```

### Round 3: Dreaming Fallback

**Only execute if raw files exist but have zero hits in BOTH Round 1 and Round 2.**

```bash
rg -in "<keyword>" memory/dreaming/light/2026-MM-DD.md memory/dreaming/rem/2026-MM-DD.md
```

## Step 3 — Response Strategy (Choose One)

> This is an **intent hint**, not the final user-facing answer. Produce a structured summary that the Main Agent can consume and act upon. The Main Agent may need to execute additional retrieval or actions based on this hint.

Classify the `rg` results and produce a structured hint:

### A. Multiple Raw Diary Hits (≥ 2 files)
Return a structured summary with file list:
```
[Memory Hint: Recent]
- Found {N} records across {dateRange}:
  - `memory/YYYY-MM-DD.md` — <brief summary>
  - `memory/YYYY-MM-DD.md` — <brief summary>
- Suggested next step: Read relevant files for detail, or ask user for clarification.
```

### B. Single Raw Diary Hit (1 file)
Return a structured summary with exact citation:
```
[Memory Hint: Recent]
- Found 1 record in `memory/YYYY-MM-DD.md`:
  - Line {L}: "<exact quote>"
- Suggested next step: Provide direct answer to user, or read more context around this line.
```

### C. Raw Missing or Empty (MISSING_RAW_DIARY / EMPTY_RAW_DIARY)
If `memory/YYYY-MM-DD.md` does **not exist** or is **empty**:
```
[Memory Hint: Recent]
- Status: MISSING_RAW_DIARY / EMPTY_RAW_DIARY for {date}
- No verified records available.
- Do NOT reference dreaming/ content as factual evidence.
- Suggested next step: Inform user that diary for this date is not yet available.
```

### D. In-Progress (Raw exists but 0 hits; dreaming has hits)
If raw files **exist and were searched** but returned **0 hits in both Round 1 and Round 2**, AND `dreaming/` files contain matches:
```
[Memory Hint: Recent]
- Status: IN_PROGRESS
- Raw diary has no record yet, but dreaming summary mentions related activity.
- Suggested next step: Inform user that this activity may be ongoing and not yet written to the official diary.
```

### E. Zero Hits — But Check for Major Events
If nothing found in raw or dreaming:
```
[Memory Hint: Recent]
- Status: ZERO_HITS
- No records found for "{keyword}" in {dateRange}.
```

**Additional check**: If the date range includes known major events (travel, exams, moving, etc.) mentioned in other diary titles, append:
```
- Note: This period includes {event}. The queried activity may be recorded under different keywords.
- Suggested next step: Offer to search with alternative keywords, or ask user for clarification.
```

### F. Zero Hits — Raw Missing
If all candidate dates are `MISSING_RAW_DIARY`:
```
[Memory Hint: Recent]
- Status: ALL_RAW_MISSING
- No raw diaries exist for the queried time period.
- Suggested next step: Inform user that diaries for this period are not yet available.
```

## Tools Used

All CLI commands below are executed via the **`exec` tool**.

| CLI Command | Purpose | When to Use | exec Parameters |
|---|---|---|---|
| `rg` (ripgrep) | Fast full-text search in raw markdown diaries | **Primary tool** for all search rounds | `command: "rg -in ..."` |
| `stat` | Check file existence and size | Step 1, before any search | `command: "stat --format=%s ..."` |
| `ls` | List candidate files | Step 1, when determining date range | `command: "ls memory/YYYY-MM-DD.md ..."` |

## Skills Referenced

| Skill | Purpose | When to Use |
|---|---|---|
| `treemd` | Survey structure of large diary files before extracting | Optional, when a hit file is very large and you need to locate the relevant section |
| `obsidian-cli` | Vault navigation and backlink traversal | **NOT recommended** for Fast Path — `obsidian search` has poor CJK support and only returns filenames |
| `memory_search` | Vector semantic search across long-term memory | **NOT used** in Fast Path; reserved for `MEMORY_STANDARD` / `MEMORY_CHRONOLOGY` / `MEMORY_EMOTIONAL` intents |
