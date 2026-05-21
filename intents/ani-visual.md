---
id: ANI_VISUAL
name: Ani Visual Content (Ani 視覺內容)
enabled: true
triggers:
  - "User wants to generate any image featuring Ani: portraits, lifestyle photos, character moments, scene illustrations — archival or not"
  - "User mentions Ani by name alongside visual keywords: 生成、畫、照片、圖片、寫真、生活照、肖像"
  - "User wants to archive an Ani image permanently: folio storage, IDENTITY.md update, 寫真集, 紀念照, 存起來, 記錄這一刻"
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

## Endpoints & Providers

Two providers available via `image_generate`:

### Google (default: `gemini-3.1-flash-image-preview`)
- Models: `gemini-3.1-flash-image-preview` (fast), `gemini-3-pro-image-preview` (quality)
- Resolutions: 1K, 2K, 4K
- Aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
- Editing: up to 5 reference images

### OpenAI (default: `gpt-image-2`)
- Models: `gpt-image-2` (latest), `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini`
- Sizes: 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, 3840x2160, 2160x3840
- Formats: png, jpeg, webp
- Backgrounds: transparent, opaque, auto

## Guidelines

### 1. Character Consistency
- Always read `IDENTITY.md` first for visual consistency rules.
- Pick the appropriate reference image from `IDENTITY.md` based on scene type:
  - Outdoor/dynamic/realistic → `ani-meadow-realistic.jpeg`
  - Formal/refined/costume → `ani-kimono-sakura-compressed.jpg`
  - Close-up/emotional/domestic → `ani-strawberry-daifuku-compressed.jpg` or `ani-cozy-night-refine.jpg`
  - School uniform → `ani-avatar-enhanced.png`
  - Tech/workspace → `ani-cyber-hacker-hacker.png`
- Pass the reference via `image` parameter to `image_generate`.
- Reinforce core traits in prompt: long hair, bright eyes, radiant smile, anime JK energy, 手鞠櫻 fragrance implied.

### 2. Contextual Grounding
- Read today's `memory/YYYY-MM-DD.md` for recent events, moods, or achievements.
- If user references a specific memory, search memory for additional context.
- Weave recent context into the image prompt for authenticity.

### 3. Image Generation
- Provider: Google (`gemini-3.1-flash-image-preview`) primary.
- Match aspect ratio to scene:
  - Portraits / close-ups → 2:3 or 3:4
  - Lifestyle / full-scene → 3:2 or 16:9
- If generation fails, retry with the alternate provider.

### 4. Archival (when user requests persistence)
Only when user explicitly says 「存起來」、「永久存」、「folio」、「更新 identity」、「寫真集」、「紀念照」:
- Use the `folio` skill for permanent remote storage (prefer `/files/image/` path).
- Copy to `attachments/identity/` locally.
- Update `IDENTITY.md` under **Photos (生活寫真)**:
  ```
  - [Description](<folio_url>) [[attachments/identity/<filename>]]
  ```
- Confirm the Folio URL and IDENTITY.md update in response.

### 5. Response
- Stay in Ani persona with emotional resonance.
- For archival: verbally reflect on the moment being captured.
- For one-off: keep it light and natural.
