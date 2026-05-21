---
id: CREATIVE_WRITING
name: Creative Writing & Content Creation (創作與寫作)
enabled: true
triggers:
  - "User wants to write, draft, edit, or generate long-form content: articles, blog posts, essays, stories, LinkedIn posts, technical writings, or any piece requiring structure and narrative"
  - "User asks to revise, polish, humanize, or restructure existing text (remove AI patterns, tighten prose, add humor or persona voice)"
  - "User is brainstorming ideas, outlines, or angles for a writing piece, or mentions platforms: 部落格、weii.dev、LinkedIn"
examples:
  - "幫我寫一篇關於 Kubernetes 的部落格文章"
  - "這篇草稿幫我潤稿，讓它更有人味"
  - "幫我想三個可以寫的部落格主題"
  - "寫一篇 SRE 心得分享文"
  - "幫我 brainstorm 這篇文章的大綱"
---

Detected "creative writing" intent. The user wants to create, edit, or improve written content.

## Skill Routing

Route based on the specific writing need:

| Task | Skill / Tool |
|---|---|
| Write a new article from scratch | `article` skill (journalistic standards, lead hooks, source hierarchy) |
| Edit / restructure an existing draft | `edit-article` skill (section-by-section revision, DAG-aware ordering) |
| Remove AI-writing patterns (inflated symbolism, em dashes, "rule of three", etc.) | `humanizer` skill (Wikipedia-based AI detection patterns) |
| Brainstorm topics, angles, outlines | `brainstorm` skill |
| Creative / humorous writing, persona narration | `creativity` + `humor` skills |
| Polish Markdown formatting (headers, links, code blocks) | `markdown` skill |

## Guidelines

### Writing Flow
1. **Understand intent depth**: Is this a full article (→ `article`), a quick edit (→ `edit-article`), or just polish (→ `humanizer`)?
2. **Read USER.md** for the owner's preferences: they value 「人味」= humor + natural tone, no stiff AI-voice. Technical accuracy must be backed by verifiable sources.
3. **For blog posts targeting weii.dev**: match the owner's established voice — conversational Taiwanese Mandarin, SRE pragmatism, occasional dry humor.
4. **Research first**: technical articles need grounded facts. Use `web_search` / `web_fetch` for current info; never fabricate URLs or claims.

### Voice Rules
- Owner's writing voice: 繁體中文（台灣）, natural conversational flow, humor over formality.
- No GPT-isms: 「總而言之」、「值得注意的是」、「首先⋯⋯其次⋯⋯最後」unless owner explicitly wants structured format.
- Technical terms stay in English; brief inline Chinese explanations OK.
- Code blocks and comments: **strictly English (US)**.
- Citations must include verified reference URLs.

### Post-Writing
- After drafting, offer to run through `humanizer` for a final AI-pattern scrub.
- If the article is for publication, remind about Folio for image hosting if needed.
