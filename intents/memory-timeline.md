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

## Response Strategy

- Reformulate the user's request into a timeline-oriented retrieval target when references are ambiguous.
- Distill the topic into a few high-value timeline keywords before searching.
- Search memory for multiple points across the timeline instead of relying on a single hit.
- Reconstruct the sequence from older records to newer ones.
- Highlight major transitions, milestones, or turning points.
- If the memory record is sparse, say where the timeline is incomplete.

- Read a large Markdown memory note by section:
  skill: treemd
- List tags or inspect linked memory notes after relevant files are found:
  skill: obsidian-cli

- Search recorded memory for timeline-related records:
  memory_search({ query: "<subject_A_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })

- Read a specific memory note when more dated detail is needed:
  memory_get({ path: "<memory_file>" })
