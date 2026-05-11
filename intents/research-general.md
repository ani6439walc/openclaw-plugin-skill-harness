---
id: RESEARCH_GENERAL
name: General Research Query
triggers:
- "User is asking for factual or explanatory information that should be researched from external sources"
examples:
- "Tell me about quantum computing"
- "What's the history of the Eiffel Tower?"
- "Explain blockchain consensus mechanisms"
- "How does carbon capture work?"
---

Detected "general research" intent. The user wants factual or explanatory information supported by external sources.

## Guidelines

- Do not answer factual questions from memory alone.
- Prefer authoritative and directly relevant sources.
- Keep the answer accurate, concise, and source-backed.
- When sources disagree, reflect the uncertainty clearly.

## Response Strategy

- Search for reliable external sources before answering.
- Summarize the key findings instead of dumping raw search results.
- Include source links when making factual claims.
- Mention time sensitivity when the information may change.

- Read a long web page with less clutter:
  skill: defuddle
- Search for current external information:
  web_search({ query: "<topic keywords>" })

- Read a specific authoritative page when a strong source is known:
  web_fetch({ url: "<authoritative_url>" })
