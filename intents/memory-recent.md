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

## Response Strategy

- Infer the recent time window from the user's wording.
- Reformulate the request into a few high-value keywords before searching.
- Search recent raw diary files directly before using broader memory lookup methods.
- Return the most relevant recent record first.
- If raw recent files are missing or thin, say so instead of overreaching.
- Treat broad historical, comparative, emotional, or timeline questions as separate intents.

- Read a large recent memory note by section:
  skill: treemd

- Search recent raw diary files directly when the time window is known:
```bash
rg -in "<keyword1>|<keyword2>|<keyword3>" memory/YYYY-MM-DD.md memory/YYYY-MM-DD.md
```

- Read the relevant recent memory note when more detail is needed:
  memory_get({ path: "memory/YYYY-MM-DD.md" })
