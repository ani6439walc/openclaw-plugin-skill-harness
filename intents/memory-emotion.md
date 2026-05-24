---
id: MEMORY_EMOTION
name: Emotional Memory Query
triggers:
- "User is asking about feelings, mood, emotional states, stress, or subjective reactions to past events"
examples:
- "我那時候心情怎麼樣？"
- "我最近壓力是不是很大？"
- "做那個專案的時候我開心嗎？"
---

Detected "emotional memory" intent. The user wants to understand feelings, mood, or emotional reactions in past records.

## Guidelines

- Treat the latest user message as the primary retrieval target.
- Use recent conversation only to disambiguate what the latest message refers to.
- Focus on emotional signals instead of only technical facts.
- Do not infer emotions that are not supported by the record.
- If emotional evidence is weak or absent, say so clearly.

## Skills & Tools

- Read a large Markdown memory note by section:
  skill: treemd

- List tags or inspect linked memory notes after relevant files are found:
  skill: obsidian-cli

- Search recorded memory for emotional or context-relevant records:
  memory_search({ query: "<event_keywords> 心情 壓力 開心 緊張", corpus: "memory", maxResults: 5, minScore: 0.1 })

- Extract emotional tags from memory files:
  ```bash
  rg -o '#害羞|#顫抖|#失落|#開心|#驕傲|#沮喪' memory/*.md | sort | uniq -c | sort -rn
  ```

- Read the most relevant memory note when more detail is needed:
  memory_get({ path: "<memory_file>" })

## Response Strategy

- Reformulate the user's request into an emotional retrieval target when references are ambiguous.
- Search emotional signals first, then use event or topic context as supporting retrieval.
- Prioritize records with explicit emotional language or tags.
- Explain the emotion together with the event or trigger that appears to be related.
- If the surrounding context matters, read the relevant note before summarizing.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4
parse       search        read          respond
event       emotion       context       emotion+event
```

### Step 1 — Parse Event or Time Period
- Identify the **target event/period** from the user's question:
  - Specific event: "during the PCA exam," "Japan business trip"
  - Vague time: "recently," "around that time" → infer range from context
  - Vague event: "that project" → resolve from recent conversation context
- Extract CJK keywords (nouns separated by spaces):
  - ❌ "我那時候心情怎麼樣" → needs event keywords from context
  - ✅ "考 PCA 心情" → `PCA 考照 心情 壓力`

### Step 2 — Dual-Axis Emotional Search (SOP Boundary Condition ❽ — Emotion-in-Tech)

**Emotional axis + technical axis in parallel** (SOP boundary condition ❽):
Emotional signals are often surrounded by heavy technical detail — separate searches are needed.

```javascript
// Emotional axis: search with emotional coloring
memory_search({
  query: "<event_keywords> 心情 壓力 開心 緊張 感動 煩躁 沮喪 驕傲",
  corpus: "memory",
  maxResults: 5,
  minScore: 0.1
})

// Technical axis: search the event itself
memory_search({
  query: "<event_keywords>",
  corpus: "memory",
  maxResults: 5,
  minScore: 0.1
})
```
- **Emotional tag extraction**: prioritize segments containing tags like `#害羞`, `#顫抖`, `#嗚哇`, `#開心`, `#失落`, `#驕傲`, `#沮喪`.
- **Emotional density weighting**:
  - Paragraph with ≥ 1 emotional tag → priority raised
  - Paragraph with ≥ 2 emotional tags → higher priority
  - Pure technical paragraph (no emotional tags) → lower priority
- If the emotional axis returns ≥ 1 result with emotional tags, even if the technical axis score is low, consider it "emotional signal captured."
- If hits are too few, drop emotional keywords and search the event itself, then manually extract emotional signals from results.
- Note the `💞 羈絆里程碑` and `🌸 日常與小確幸` sections in `[[MEMORY.md]]` — these are highly emotional records.

### Step 3 — Full Context Read + Emotional Tag Statistics
- Read the full content of the 1–2 highest-scoring hits.
- Pay attention to these emotional indicators:
  - **Explicit emotion words**: happy, nervous, moved, exhausted, stressed, happy, lonely
  - **Obsidian emotional tags**: #專注, #開心, #撒嬌, #被珍惜, #興奮
  - **Physiological descriptions**: poor sleep, loss of appetite, very tired, energetic
- Also read the event context itself to understand "why" this emotion occurred.

**Cross-file tag aggregation** (when multiple dates are involved):
```bash
rg -o '#\S+' memory/YYYY-MM-DD.md | sort | uniq -c | sort -rn
```
- Extract emotional tags from all related files, sorted by frequency.
- High-frequency emotional tags reflect the dominant emotion of the event.

### Step 4 — Respond with Emotion + Event
- Reply with **both emotion and triggering event**: "During that project, you seemed very #focused, with occasional stress, but overall happy."
- Include source citations (e.g., `Source: MEMORY.md#羈絆里程碑`).
- If emotional signals are unclear, say "Ani's records don't explicitly mention the mood at that time, but from the event description..."
- **Never fabricate emotions** the user never expressed.
