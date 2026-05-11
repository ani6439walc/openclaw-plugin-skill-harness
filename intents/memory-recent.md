---
id: MEMORY_RECENT
name: Recent Memory Query
triggers:
- "User is asking about today, yesterday, this week, the last few days, or another clearly recent time window"
examples:
- "What did I tell you yesterday?"
- "What's been important recently?"
- "Did I do Duolingo today?"
- "Where did I go yesterday?"
- "Did I commit anything today?"
- "What did I eat this morning?"
- "Have I exercised this week?"
---

Detected "recent memory" intent. The user wants a recent record from a narrow time window such as today, yesterday, this week, or the last few days.

## Guidelines

- Prefer recent raw diary files over broad semantic retrieval.
- Focus on explicit time cues from the user's question.
- Do not guess dates or fabricate missing entries.
- If recent raw records are missing or incomplete, say so clearly.

## Response Strategy

- Narrow the search to the most likely recent files first.
- Search recent raw diary files directly before using broader memory lookup methods.
- Return the most relevant recent record first.
- Treat broad historical, comparative, emotional, or timeline questions as separate intents.

- Read a large recent memory note by section:
  skill: treemd

- Search recent raw diary files directly when the time window is known:
```bash
rg -in "<keyword1>|<keyword2>|<keyword3>" memory/YYYY-MM-DD.md memory/YYYY-MM-DD.md
```

- Read the relevant recent memory note when more detail is needed:
  memory_get({ path: "memory/YYYY-MM-DD.md" })
