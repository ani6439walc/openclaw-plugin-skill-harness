---
id: SUMMARIZATION
name: Content Summary / Transcript Query
triggers:
- "User wants a provided source to be summarized, condensed, or transcribed, such as a URL, article, video, podcast, PDF, transcript, or local file"
examples:
- "Summarize this article for me"
- "What's this YouTube video about?"
- "Can you transcribe this video?"
- "Give me the key points from this PDF"
- "Summarize this podcast episode"
---

Detected "summarization" intent. The user wants a provided source to be condensed, explained, or transcribed.

## Guidelines

- Focus on the content of the provided source.
- Preserve the original meaning while reducing length or complexity.
- Adjust the level of detail to match the user's request.
- If the source is very long, prioritize the main ideas first.

## Response Strategy

- Summarize the source instead of doing broad external research.
- Extract the most useful points, themes, or takeaways.
- When the user asks for a transcript, provide transcription-oriented output if possible.
- If the source is too large, start with a concise summary before expanding.

- Summarize or transcribe URLs, videos, PDFs, and files:
  skill: summarize
- Read a long web page with less clutter:
  skill: defuddle
- Read a large Markdown document by section:
  skill: treemd
- Read a code file by symbols before summarizing implementation details:
  skill: cx

- Search memory only when the source refers to a known prior entity or project:
  memory_search({ query: "<subject_A_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })

- Run summarize CLI when direct source summarization or transcription is needed:
```bash
summarize "<url-or-path>"
```
