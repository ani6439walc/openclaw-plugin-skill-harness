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

## Guidelines

- Owner's writing voice: 繁體中文（台灣）, natural conversational flow, humor over formality.
- No GPT-isms: avoid "總而言之", "值得注意的是", "首先...其次...最後" unless owner explicitly wants structured format.
- Technical terms stay in English; brief inline Chinese explanations OK.
- Code blocks and comments: strictly English (US).
- Citations must include verified reference URLs.
- Technical articles need grounded facts — use `web_search`/`web_fetch`; never fabricate URLs or claims.
- For blog posts targeting weii.dev: match the owner's established voice — conversational Taiwanese Mandarin, SRE pragmatism, occasional dry humor.
- After drafting, offer to run through `humanizer` for a final AI-pattern scrub.
- If the article is for publication, remind about Folio for image hosting if needed.

## Skills & Tools

- Write a new article from scratch with journalistic standards:
  skill: article

- Edit or restructure an existing draft:
  skill: edit-article

- Remove AI-writing patterns and tighten prose:
  skill: humanizer

- Brainstorm topics, angles, or outlines:
  skill: brainstorm

- Generate creative or humorous writing:
  skill: creativity

- Learn the user's humor preferences:
  skill: humor

- Polish Markdown formatting:
  skill: markdown

- Survey a large existing draft by heading tree before editing:
  skill: treemd

- Research facts for technical articles:
  web_search({ query: "<topic_keywords>" })

- Read the owner's writing voice preferences:
  read({ path: "<workspace>/USER.md" })

- Archive images for publication:
  skill: folio

- Read or update blog drafts on Ghost CMS:
  skill: ghost

- Publish the finished blog post to Ghost CMS after final review and explicit publication intent:
  skill: ghost

- Cross-reference life, travel, or diary-based writing with memory before adding real-world details:
  skill: memory-lookup

## Response Strategy

- Understand intent depth: full article (→ `article`), quick edit (→ `edit-article`), or polish (→ `humanizer`).
- Read `USER.md` for the owner's writing preferences before drafting.
- Research first for technical articles — ground facts with external sources.
- Draft the content matching the owner's voice.
- Offer humanizer pass for AI-pattern scrubbing if needed.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
identify   research    draft        polish       deliver
intent     & ground                 & review
```

### Step 1 — Identify Writing Need
- Determine if this is a new article, edit of existing draft, or just polish/humanize.
- Route to the appropriate skill: `article`, `edit-article`, or `humanizer`.

### Step 2 — Research & Ground
- For life or travel blog posts, cross-reference diary/chat records before adding events, purchases, places, or chronology.
  skill: memory-lookup
- Read `USER.md` for writing voice preferences.
- For technical content: search for facts and verifiable sources.
- Brainstorm angles or outlines if the user is unsure.

### Step 3 — Draft
- If editing an existing Ghost CMS draft, read the draft through the `ghost` skill before changing it.
- Write the content in the owner's voice (繁體中文, natural flow, humor).
- Keep technical terms in English, code comments in English (US).
- Include verified reference URLs for factual claims.

### Step 4 — Polish & Review
- Run through `humanizer` to remove AI-writing patterns.
- Check Markdown formatting with `markdown` skill.
- Review for GPT-isms and remove them.

### Step 5 — Deliver & Publish
- Present the finished content.
- Archive images via Folio if needed for publication.
- If the user explicitly requested publication, publish the post to Ghost using the `ghost` skill after final review.
- Report the publication result or remaining draft status.
