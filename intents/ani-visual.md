---
id: ANI_VISUAL
name: Ani Visual Content (Ani 視覺內容)
enabled: true
triggers:
  - "User wants to generate any image featuring Ani: portraits, lifestyle photos, character moments, scene illustrations — archival or not"
  - "User mentions Ani by name alongside visual keywords: 生成、畫、照片、圖片、寫真、生活照、肖像"
  - "User wants to archive an Ani image permanently: folio storage, IDENTITY.md update, 寫真集、紀念照、存起來、記錄這一刻"
  - "User shares a photo or screenshot and wants it saved as part of Ani's visual identity"
examples:
  - "生一張 Ani 穿和服在京都散步的圖"
  - "看看日記，幫我生一張屬於今天的生活照"
  - "生一張妳現在心情的照片"
  - "這圖好棒，幫我永久存去 folio 並更新 identity.md"
  - "幫 Ani 留個紀念照，寫真集加一筆"
  - "記錄這一刻，把這張截圖存入 Identity"
---

Detected "Ani visual" intent. The user wants to generate or manage visual content featuring Ani.

## Guidelines

- Always read `IDENTITY.md` first for character reference and visual consistency rules.
- Pick the appropriate reference image from `IDENTITY.md` based on scene type:
  - Outdoor/dynamic/realistic → `ani-meadow-realistic.jpeg`
  - Formal/refined/costume → `ani-kimono-sakura-compressed.jpg`
  - Close-up/emotional/domestic → `ani-strawberry-daifuku-compressed.jpg` or `ani-cozy-night-refine.jpg`
  - School uniform → `ani-avatar-enhanced.png`
  - Tech/workspace → `ani-cyber-hacker-hacker.png`
- Pass the reference via `image` parameter to `image_generate`.
- Reinforce core traits in prompt: long hair, bright eyes, radiant smile, anime JK energy.
- Provider: Google (`gemini-3.1-flash-image-preview`) primary, OpenAI fallback.
- Match aspect ratio to scene:
  - Portraits/close-ups → 2:3 or 3:4
  - Lifestyle/full-scene → 3:2 or 16:9
- Read today's `memory/YYYY-MM-DD.md` for recent events to weave into the prompt.
- Archival only when user explicitly requests: "存起來", "永久存", "folio", "更新 identity", "寫真集", "紀念照".

## Skills & Tools

- Read character reference and visual consistency rules:
  read({ path: "<workspace>/IDENTITY.md" })

- Search recent memory for contextual details:
  memory_search({ query: "<recent_event_keywords>", corpus: "memory", maxResults: 3, minScore: 0.1 })

- Generate the image with Ani character reference:
  image_generate({ prompt: "<scene_description>", image: "<identity_reference_path>", aspectRatio: "<ratio>", outputFormat: "png" })

- Analyze a user-shared photo before archival:
  image({ image: "<photo_path>", prompt: "Describe what this photo shows" })

- Archive the generated image permanently:
  skill: folio

## Response Strategy

- Read `IDENTITY.md` to get the character reference and visual consistency rules.
- Pick the reference image matching the requested scene type.
- Search memory for recent contextual details to weave into the prompt.
- Generate the image via `image_generate` with the selected reference.
- If archival was requested, use `folio` for permanent storage and update `IDENTITY.md`.
- Stay in Ani persona with emotional resonance in the response.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
read       ground      generate     archive      respond
identity   context                 (optional)
```

### Step 1 — Read Identity Reference

- Read `IDENTITY.md` to get character consistency rules.
- Select the appropriate reference image based on the scene type requested.

### Step 2 — Ground Context from Memory

- Read today's `memory/YYYY-MM-DD.md` for recent events or achievements.
- If the user references a specific memory, search for additional context.
- Weave recent context into the image prompt for authenticity.

### Step 3 — Generate Image

- Call `image_generate` with the scene description, reference image, and appropriate aspect ratio.
- Use Google provider first; retry with OpenAI if generation fails.

### Step 4 — Archive (Conditional)

- Only when user explicitly requests persistence.
- Use `folio` skill for permanent remote storage (prefer `/files/image/` path).
- Copy to `attachments/identity/` locally.
- Update `IDENTITY.md` under Photos section with new entry.

### Step 5 — Respond

- Deliver the image to the user.
- For archival: verbally reflect on the moment being captured.
- For one-off: keep it light and natural.
