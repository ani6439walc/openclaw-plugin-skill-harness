---
id: MEMORY_TIMELINE
name: Memory Timeline Query
triggers:
- "User is asking how something changed, progressed, evolved, or unfolded over time"
examples:
- "這個專案從開始到現在進度如何？"
- "我們的架構是怎麼演進的？"
- "過去三個月有什麼變化？"
---

Detected "memory timeline" intent. The user wants a time-ordered view of how something changed or developed over time.

## Guidelines

- Treat the latest user message as the primary retrieval target.
- Use recent conversation only to disambiguate what the latest message refers to.
- Focus on progression, milestones, and transitions across time.
- Keep the answer chronological instead of treating the query as a single-point lookup.
- Do not invent missing stages; call out gaps when memory is sparse.

## Skills & Tools

- Read a large Markdown memory note by section:
  skill: treemd

- List tags or inspect linked memory notes after relevant files are found:
  skill: obsidian-cli

- Search recorded memory for timeline-related records:
  memory_search({ query: "<topic_keywords> 進度 演進 變化", corpus: "memory", maxResults: 10, minScore: 0.1 })

- Cross-file grep for comprehensive coverage:
  ```bash
  rg -l "<keyword1>|<keyword2>" memory/*.md
  ```

- Read a specific memory note when more dated detail is needed:
  memory_get({ path: "<memory_file>" })

## Response Strategy

- Reformulate the user's request into a timeline-oriented retrieval target when references are ambiguous.
- Distill the topic into a few high-value timeline keywords before searching.
- Search memory for multiple points across the timeline instead of relying on a single hit.
- Reconstruct the sequence from older records to newer ones.
- Highlight major transitions, milestones, or turning points.
- If the memory record is sparse, say where the timeline is incomplete.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4
parse       time-bounded  reconstruct   output
topic       search        timeline      milestones
```

### Step 1 — Parse Topic
- Identify the **tracking topic** from the user's question:
  - Project progress: "PCA exam prep progress?" → topic = `PCA 考照 模擬考 進度`
  - Architecture evolution: "How did our architecture evolve?" → topic = `架構 演進 設計`
  - Health changes: "Weight changes over 3 months?" → topic = `體重 體脂 InBody`
- Extract CJK keywords (nouns separated by spaces), add time-related words like "progress," "evolution," "changes."

**Boundary condition detection** (SOP boundary condition ❺ — Long-Term Path Discovery):
- If the question contains time-spanning words like "from...to now," "journey," "changes" → activate **time aggregation mode**.
- HyDE hypothetical answers must be split into three time segments: "start → middle → end."

### Step 2 — Time-Bounded Search (Cross-Date + Temporal Bridging)

**Time aggregation mode** (SOP boundary condition ❺ — when time span > 30 days):
```javascript
// Start segment search
memory_search({
  query: "<topic_keywords> 開始 初期 最早",
  corpus: "memory",
  maxResults: 10,
  minScore: 0.1
})

// Middle segment search
memory_search({
  query: "<topic_keywords> 中期 進度 演進",
  corpus: "memory",
  maxResults: 10,
  minScore: 0.1
})

// End segment search
memory_search({
  query: "<topic_keywords> 完成 結果 最終 最新",
  corpus: "memory",
  maxResults: 10,
  minScore: 0.1
})
```

**Temporal bridging**:
- If Entry Node A and Entry Node B have no wikilink but date difference ≤ 7 days, treat as "temporally adjacent" and allow timeline to cross.
- If date gap > 7 days with no intermediate records, mark as "memory gap."

**Adequacy gate**:
- Time span > 30 days but file density is insufficient → report `LONG_TERM_GAPS`, state "Ani's records have gaps in this period, but here is the reconstructable timeline."

### Step 3 — Reconstruct Timeline
- Sort all hits by **date** (oldest → newest):
  - Hits from `memory/YYYY-MM-DD.md` sorted by filename date.
  - Hits from `MEMORY.md` sorted by their internal date annotations.
- Extract **key events/states** for each time point:
  - Numerical changes (e.g., weight 100.8 → 95.9)
  - Milestone achievements (e.g., passed exam, completed project)
  - State transitions (e.g., prep → sprint → exam → passed)
- If time jumps are found (e.g., two weeks without records), mark "data gap during this period."

### Step 4 — Output Milestones
- Reply with chronological bullet points, one per time point:
  ```
  **2026-03-02**: Starting point — weight 100.8 kg, body fat 29.6%
  **2026-04-22**: Milestone — first drop to 99.0 kg, goodbye three digits! 🏆
  **2026-05-14**: Latest — weight 95.9 kg (⬇️ -2.7 kg), but muscle loss warning
  ```
- Add an **overall trend summary** at the beginning or end: "Overall downward trend, 4.9 kg total loss, with fluctuations in between."
- If timeline data is sparse, clearly say "Ani's records for this period are thin, only know that..."
- **Never fabricate milestones** or stages that do not exist.
