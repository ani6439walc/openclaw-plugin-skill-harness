---
id: SUMMARIZATION
name: Content Summary / Transcript Query
triggers:
  - "User wants a provided source to be summarized, condensed, or transcribed, such as a URL, article, video, podcast, PDF, transcript, or local file"
  - "User wants to convert a book, document, or PDF into a structured agent skill, extracting frameworks and mental models"
examples:
  - "這個 YouTube 影片在講什麼？"
  - "幫我聽寫這段影片"
  - "總結這集 podcast"
  - "這個網址的內容幫我整理一下"
---

Detected "summarization" intent. The user wants a provided source to be condensed, explained, or transcribed.

## Guidelines

- Focus on the content of the provided source.
- Preserve the original meaning while reducing length or complexity.
- Adjust the level of detail to match the user's request.
- If the source is very long, prioritize the main ideas first.
- Summarize the source instead of doing broad external research.
- When the user asks for a transcript, provide transcription-oriented output if possible.

## Skills & Tools

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
  exec({ command: "summarize \"<url-or-path>\"" })

## Response Strategy

- Identify the source type (URL, video, PDF, local file, transcript).
- Use the appropriate tool (`summarize` skill, `defuddle`, `treemd`, or `cx`).
- Extract the most useful points, themes, or takeaways.
- Lead with the main ideas; expand on request.
