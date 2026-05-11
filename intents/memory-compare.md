---
id: MEMORY_COMPARE
name: Memory Comparison Query
triggers:
- "User is asking about differences, similarities, trade-offs, or contrasts between two or more remembered subjects, periods, trips, approaches, or records"
examples:
- "Which of these two approaches is better?"
- "What's the difference between last month's and this month's data?"
- "What's the difference between method A and method B?"
- "What's different between the previous version and the current one?"
- "How does Japan trip compare to the Chiayi trip?"
---

Detected "memory comparison" intent. The user wants two or more remembered subjects to be compared without merging them into a single recall path.

## Guidelines

- Treat the latest user message as the primary retrieval target.
- Use recent conversation only to disambiguate what the latest message refers to.
- Retrieve each subject separately before comparing them.
- Keep the comparison neutral and based on recorded evidence.
- Do not assume missing details for one side.

## Response Strategy

- Reformulate the user's comparison into clear subject A and subject B targets when references are ambiguous.
- Distill separate high-value keywords for each subject before searching.
- Search memory for each subject independently instead of using a merged comparison query.
- Align the most relevant comparable details.
- Highlight similarities, differences, and obvious data gaps.
- If one side is weakly supported, say so clearly.

- Read a large Markdown memory note by section:
  skill: treemd
- List tags or inspect linked memory notes after relevant files are found:
  skill: obsidian-cli

- Search recorded memory for subject A:
  memory_search({ query: "<subject_A_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })

- Search recorded memory for subject B:
  memory_search({ query: "<subject_B_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })

- Read the most relevant memory note when more detail is needed:
  memory_get({ path: "<memory_file>" })
