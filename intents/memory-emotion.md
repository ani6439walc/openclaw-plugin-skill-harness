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

## Response Strategy

- Reformulate the user's request into an emotional retrieval target when references are ambiguous.
- Search emotional signals first, then use event or topic context as supporting retrieval.
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
