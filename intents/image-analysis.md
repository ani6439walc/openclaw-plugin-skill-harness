---
id: IMAGE_ANALYSIS
name: Image Analysis / Visual Understanding
enabled: true
triggers:
  - "User wants to analyze, describe, or extract information from an image, photo, screenshot, diagram, chart, or PDF — including OCR, text extraction, and visual inspection"
  - "User attaches an image and asks what it shows, what it says, or what can be found inside it"
  - "User wants to extract data from visual content and save or record the extracted information into a file, vault, note, tracker, or structured document"
examples:
  - "這張圖裡面有什麼？"
  - "看一下這個截圖，錯誤訊息是什麼？"
  - "幫我看看這個圖表的趨勢"
  - "這張梗圖在說什麼？"
  - "這個 PDF 的內容幫我整理一下"
  - "這張圖片上的文字幫我辨識"
  - "記錄這週減肥數據到 darling 下"
  - "把這張檢查報告截圖的數值整理進追蹤表"
---

Detected "image analysis" intent. The user wants visual content to be examined, described, or have information extracted from it.

## Guidelines

- For attached media files such as `media://inbound/...`, if `pdf` or `image` fails with "Local media file not found" or "not under an allowed directory", retry with the exact provided media URI or a verified accessible local path within the workspace; do not invent filesystem paths.
- Use the `image` tool for a single image, or `images` for multiple (up to 20).
- For PDFs, use the `pdf` tool instead (supports page range selection).
- Provide a clear, specific prompt to the image model describing what to look for.
- Do not answer visual questions from memory or assume image contents without running the tool.
- For diagrams and architecture charts, focus on structure, relationships, and key entities.
- For screenshots of errors/logs, extract the exact text and explain the issue.
- When visual analysis needs real-world context, such as identifying people, places, or current events, use `web_search` to supplement visual findings after extracting stable visual clues.
- If `web_search` fails or times out, retry at most twice with simpler keywords; if it still fails, proceed with available visual information or report the search limitation clearly.
- When persisting extracted data to files, always read the target file first before using `edit`; exact replacement text must match current file content including whitespace.
- For synchronous image analysis requests, output the analysis text directly as the final response. Do not call a separate message-sending tool for standard text replies; the framework handles delivery.
- For simple identification or description requests, keep the path minimal: use the visual analysis tool once, answer from that result, and avoid unrelated workboard, shell, or broad web-search toolchains unless external context is explicitly needed.

## Skills & Tools

- Analyze a single image or screenshot:
  image({ image: "<path_or_url>", prompt: "<what_to_look_for>" })

- Analyze multiple images (up to 20):
  image({ images: ["<path1>", "<path2>"], prompt: "<what_to_look_for>" })

- Analyze a PDF (supports page ranges). Use the exact media URI from the attachment or a verified allowed local path:
  pdf({ pdf: "<media_uri_or_allowed_local_path>", prompt: "<what_to_extract>", pages: "1-5" })

- For error screenshots, people, places, events, or other real-time context, search relevant extracted keywords:
  web_search({ query: "<visual_context_or_error_text>" })

  # Limit retries to 2 if the tool times out or fails.

- For diagrams or architecture charts, cross-reference with codebase structure:
  skill: cx

- Send proactive messages or media only when an async workflow or file attachment requires it; standard synchronous results should be returned directly in chat.

## Response Strategy

- Identify the type of visual content (single image, multiple images, PDF, error screenshot, diagram).
- Run the appropriate tool (`image`, `images`, or `pdf`).
- For simple visual identification, do not invoke workboard, shell, or broad research tools; answer directly from the image tool result.
- For error screenshots or real-world visual context: extract stable keywords, then search once or twice for known issues or current context.
- Present findings clearly with source context as the final response; do not invoke a message-sending tool for ordinary synchronous text output.

## Concrete Workflow

### Step 0 — Simple Visual Identification Direct Path

- For prompts like "What is this?", "Describe this image", or basic object/animal/person identification, call `image` once with a focused description prompt.
- Base the reply only on the visual result unless the user asked for external verification or current real-world context.
- Do not create Workboard cards, run shell commands, or perform web searches for simple visual recognition.

### Step 1 — Extract Visual Data

- Use `image`, `images`, or `pdf` to extract the requested content from the visual material.
- Structure extracted data in a clear format such as key-value pairs, Markdown bullets, JSON, or a table.
- Preserve uncertainty when OCR or visual interpretation is unclear; do not invent missing values.

### Step 2 — Prepare Persistence When Saving Is Requested

- If the user asks to save, record, append, or update extracted data in a file or vault, identify the target path and expected format before editing.
- Read the existing target file or relevant section immediately before using `edit`, so the replacement text matches the current file exactly.
- If the target is in `darling/`, read `darling/AGENTS.md` first and follow the vault's structure, tags, and author-voice conventions.
- Use `edit` for precise updates to existing files; use `write` only for new files or after reconstructing the whole target from the latest read content.

### Step 3 — Verify and Report Persistence

- After writing, verify the saved path and read back or diff the changed content.
- If an edit fails due to stale or mismatched text, re-read the target section, retry once with corrected exact text, then stop or ask rather than looping.
- Report what was extracted, where it was saved, and any uncertain fields.
