---
id: MEMORY_TIMELINE
name: Memory Timeline Query
triggers:
- "User is asking how something changed, progressed, evolved, or unfolded over time"
examples:
- "How has this project progressed from start to now?"
- "How has our architecture evolved?"
- "What has changed in the past three months?"
- "When did this bug first appear?"
- "What was my journey like from the beginning to now?"
---

Detected "memory timeline" intent. The user wants a time-ordered view of how something changed or developed over time.

## Guidelines

- Focus on progression, milestones, and transitions across time.
- Keep the answer chronological instead of treating the query as a single-point lookup.
- Do not invent missing stages; call out gaps when memory is sparse.
- Use this intent when the user is asking about evolution rather than a single recent event.

## Response Strategy

- Search memory for multiple points across the timeline.
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
