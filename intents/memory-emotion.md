---
id: MEMORY_EMOTION
name: Emotional Memory Query
triggers:
- "User is asking about feelings, mood, emotional states, stress, or subjective reactions to past events"
examples:
- "How was I feeling at that time?"
- "How did that thing I mentioned last time make me feel?"
- "Have I been under a lot of stress lately?"
- "Why was I so frustrated back then?"
- "Was I happy when working on that project?"
---

Detected "emotional memory" intent. The user wants to understand feelings, mood, or emotional reactions in past records.

## Guidelines

- Focus on emotional signals instead of only technical facts.
- Do not infer emotions that are not supported by the record.
- Use this intent when the user's question is about feelings, stress, happiness, frustration, or similar states.
- If emotional evidence is weak or absent, say so clearly.

## Response Strategy

- Search memory for emotional signals and relevant context.
- Prioritize records with explicit emotional language or tags.
- Explain the emotion together with the event or trigger that appears to be related.
- If the surrounding context matters, read the relevant note before summarizing.

- Read a large Markdown memory note by section:
  skill: treemd
- List tags or inspect linked memory notes after relevant files are found:
  skill: obsidian-cli

- Search recorded memory for emotional or context-relevant records:
  memory_search({ query: "<subject_A_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })

- Read the most relevant memory note when more detail is needed:
  memory_get({ path: "<memory_file>" })
