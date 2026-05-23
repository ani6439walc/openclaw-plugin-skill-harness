---
id: IMAGE_GENERATION
name: Image Generation / Visual Content Creation
enabled: true
triggers:
  - "User is asking to generate, create, draw, or produce a non-persona image: diagram, logo, illustration, artwork, scenery, mockup, or conceptual visual"
  - "User wants to edit, modify, enhance, or transform an existing image (background swap, upscaling, style transfer)"
  - "User requests a visual output that is NOT Ani — no Ani in the scene, no IDENTITY.md reference needed"
examples:
  - "幫我生成一張貓咪坐在鍵盤上的圖"
  - "畫一張台北夜景的插畫"
  - "幫我把這張照片的背景換掉"
  - "生成一個 logo"
  - "生成一張賽博龐克風格的封面圖"
---

Detected "image generation" intent. The user wants a non-persona image created or edited.

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

- Always use the `image_generate` tool.
- Provider: Google primary; fall back to OpenAI for transparent backgrounds or specific size constraints.
- When editing, pass references via `image` (single) or `images` (up to 5).
- Infer aspect ratio from scene:
  - Diagrams / architecture → 16:9
  - Scenery / landscapes → 16:9 or 3:2
  - Logos / thumbnails → 1:1
- Transparent outputs: route to `openai/gpt-image-1.5` with `outputFormat="png"` + `background="transparent"`.
- JPEG compression tuning: OpenAI with `outputCompression` (0-100) + `outputFormat="jpeg"`.
- If a generation fails, try the alternate provider.
- Large reference images (>5MB): compress with Python Pillow first.

- Generate a new image:
  image_generate({ prompt: "<description>", aspectRatio: "<ratio>", outputFormat: "png" })

- Edit or modify an existing image (up to 5 references):
  image_generate({ prompt: "<modification_description>", image: "<reference_path>", outputFormat: "png" })

- Generate with transparent background:
  image_generate({ prompt: "<description>", model: "openai/gpt-image-1.5", outputFormat: "png", background: "transparent" })

- Archive the generated image:
  skill: folio

- For architecture diagrams, use the dedicated skill instead:
  skill: architecture-diagram
