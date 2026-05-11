---
id: MEMORY_LOOKUP
name: General Memory Lookup
triggers:
- "User is asking about past events, records, preferences, habits, or prior discussions without a clearly recent, comparative, emotional, or timeline-oriented focus"
examples:
- "What was that idea I told you about before?"
- "Where is the related info for that project?"
- "Have we discussed this topic before?"
- "Help me find records about xxx"
- "What do I usually order at that restaurant?"
- "Do you remember my flight preferences?"
- "What was my previous laptop setup?"
---

Detected "general memory lookup" intent. The user wants past records or prior information without a specific recent, comparative, emotional, or timeline focus.

## Guidelines

- Treat the latest user message as the primary retrieval target.
- Use recent conversation only to disambiguate what the latest message refers to.
- Search recorded memory instead of guessing.
- Use this intent for broad past recall without a narrow time window.
- If memory is weak or missing, say so clearly.

## Response Strategy

- Reformulate the user's request into a self-contained memory target when references are ambiguous.
- Distill a few high-value keywords before searching.
- Use a permissive retrieval threshold for preferences, habits, routines, or personal facts.
- Return the most relevant recorded memory first.
- Treat recent, emotional, timeline, or comparison questions as separate intents.

- Read a large Markdown memory note by section:
  skill: treemd
- List tags or inspect linked memory notes after a relevant file is found:
  skill: obsidian-cli

- Search recorded memory:
  memory_search({ query: "<subject_A_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })

- Read the most relevant memory file when more detail is needed:
  memory_get({ path: "<memory_file>" })
