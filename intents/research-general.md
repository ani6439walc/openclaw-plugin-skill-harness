---
id: RESEARCH_GENERAL
name: General Research Query
triggers:
  - "User is asking for factual or explanatory information that should be researched from external sources"
  - "User wants general explanations of concepts, history, or how things work (not version-sensitive, not Google developer products, not open-source library docs)"
  - "User wants to understand, interpret, or get an explanation of a concept, idea, or phenomenon at an adaptive depth"
  - "User wants a rigorous comparison between two or more options, tools, or concepts with weighted criteria and confidence assessment"
examples:
  - "量子運算是什麼？"
  - "艾菲爾鐵塔的歷史"
  - "解釋區塊鏈的共識機制"
  - "碳捕獲是怎麼運作的？"
  - "第一性原理是什麼？"
  - "好幫我都換一下"
  - "全部都幫我改"
  - "其他的也一樣"
  - "對，幫我把剩下的都處理掉"
---

Detected "general research" intent. The user wants factual or explanatory information supported by external sources.

## Guidelines

- Directly answer the user's explicit factual question first; do not ignore the current query to react to previous-turn context.
- If no image or media is attached in the current turn, do not generate image-reaction text or pretend to see a photo, screenshot, or video.
- Do not answer factual questions from memory alone.
- Prefer authoritative and directly relevant sources.
- Keep the answer accurate, concise, and source-backed.
- When sources disagree, reflect the uncertainty clearly.
- When researching agent skills, prompts, or system design topics, check relevant internal skill documentation and recorded memory before relying only on external sources.
- When `web_search` times out or returns an error, retry once with a simpler and broader query; if the retry fails, try `web_fetch` on a known authoritative URL when one is available.
- Limit repeated failing-tool attempts; after bounded retries, proceed with an alternate source path or report the blocker clearly.
- If an internal skill or reference file is missing (`ENOENT`), do not retry the same missing path; acknowledge the gap when relevant and continue with available internal or external sources.
- If all external retrieval fails for a non-time-sensitive question, answer from general knowledge only with explicit source-limit caveats; for current or mutable facts, state the blocker instead of pretending verification succeeded.
- Never return only a persona teaser, intro line, or acknowledgement without the substantive researched content or a clear blocker.

## Skills & Tools

- Read a long web page with less clutter:
  skill: defuddle

- Conduct exhaustive multi-source investigation:
  skill: in-depth-research

- Adaptively explain concepts at the right depth for the user:
  skill: explain

- Rigorous comparison with confidence parity and weighted criteria:
  skill: compare

- Search recorded memory for prior agent, skill, prompt, or system-design context:
  memory_search({ query: "<agent_skill_or_prompt_keywords>", corpus: "memory", maxResults: 5 })

- Read relevant internal skill documentation when researching agent or skill topics:
  read({ path: "~/.openclaw/skills/<skill-name>/SKILL.md" })

- Search for current external information:
  web_search({ query: "<topic_keywords>" })

- Read a specific authoritative page when a strong source is known:
  web_fetch({ url: "<authoritative_url>", extractMode: "markdown" })

- Analyze an image, chart, diagram, or screenshot for visual content:
  image({ image: "<url_or_path>", prompt: "<what_to_look_for>" })

- Analyze a PDF document for text, charts, or structured content:
  pdf({ pdf: "<url_or_path>", prompt: "<what_to_extract>" })

## Response Strategy

- Search for reliable external sources before answering.
- Summarize the key findings instead of dumping raw search results.
- Include source links when making factual claims.
- Mention time sensitivity when the information may change.
- Cross-validate claims: prefer 2+ independent authoritative sources before presenting as fact.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4
search     extract     synthesize   cite
sources    content     findings     & deliver
```

### Step 0 — Check Internal Sources for Agent Topics

- If researching agent skills, prompts, or system design, use `memory_search` for prior discussions and decisions.
- Read relevant `SKILL.md` files from `~/.openclaw/skills/` or plugin skill directories when they exist.
- Continue to external research when internal sources are insufficient, missing, or not authoritative for the question.

### Step 1 — Search Sources

- Use `web_search` with topic keywords to find authoritative sources.
- For exhaustive investigation: use `in-depth-research` skill.

### Step 1b — Recover From Tool Failure

- If `web_search` times out or returns an error, retry once with fewer, broader keywords.
- If the retry also fails, use `web_fetch` on a known authoritative source when one is available.
- If a `read` call fails with `ENOENT`, do not retry the same missing path; use another relevant file, external source, or report the missing-source limitation when it matters.
- After bounded retries for a critical tool, inform the user of the blocker instead of looping silently.
- If all external search and fetch attempts fail, answer non-time-sensitive questions with explicit source-limit caveats, or report a blocker for current and mutable facts.
- Always continue to synthesis or deliver a clear blocker; do not stop at an intro line.

### Step 2 — Extract Content

- Use `web_fetch` to read authoritative pages directly.
- Use `defuddle` for cleaner web page extraction.
- For visual content: use `image` or `pdf` tools as appropriate.

### Step 3 — Synthesize Findings

- Summarize key findings instead of raw search dumps.
- Cross-validate: prefer 2+ independent sources.
- When sources disagree, reflect uncertainty clearly.

### Step 4 — Cite & Deliver

- Include source links for factual claims.
- Mention time sensitivity if information may change.
- Keep the answer accurate, concise, and source-backed.

### Step 5 — Batch Link or Reference Conversion

Use this continuation workflow when prior research identified a repeated conversion pattern, such as replacing map links or equivalent references across a document.

1. Read the target Markdown file and identify all matching source links or placeholders.
2. Research replacements for each unique item with `web_search` or `web_fetch`, caching results to avoid duplicate lookup.
3. Apply replacements with `edit` using unique `oldText`; if a match is duplicated, include surrounding lines to make the replacement unambiguous.
4. Read back or diff the target file and summarize replacements, skipped items, and unresolved links.
