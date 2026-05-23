---
id: RESEARCH_GENERAL
name: General Research Query
triggers:
- "User is asking for factual or explanatory information that should be researched from external sources"
- "User wants general explanations of concepts, history, or how things work (not version-sensitive, not Google developer products, not open-source library docs)"
examples:
- "量子運算是什麼？"
- "艾菲爾鐵塔的歷史"
- "解釋區塊鏈的共識機制"
- "碳捕獲是怎麼運作的？"
- "第一性原理是什麼？"
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
- Conduct exhaustive multi-source investigation:
  skill: in-depth-research
- Search for current external information:
  web_search({ query: "<topic keywords>" })
- Read a specific authoritative page when a strong source is known:
  web_fetch({ url: "<authoritative_url>", extractMode: "markdown" })
- Analyze an image, chart, diagram, or screenshot for visual content:
  image({ image: "<url_or_path>", prompt: "<what_to_look_for>" })
- Analyze a PDF document for text, charts, or structured content:
  pdf({ pdf: "<url_or_path>", prompt: "<what_to_extract>" })
- Cross-validate claims: prefer 2+ independent authoritative sources before presenting as fact.

## Escalation

- For exhaustive multi-source investigation with methodology tracking, source evaluation, and iterative depth:
  skill: Deep Research
