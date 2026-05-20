---
id: IMAGE_ANALYSIS
name: Image Analysis / Visual Understanding
enabled: true
triggers:
  - "User wants to analyze, describe, or extract information from an image, photo, screenshot, diagram, chart, or PDF — including OCR, text extraction, and visual inspection"
  - "User attaches an image and asks what it shows, what it says, or what can be found inside it"
examples:
  - "這張圖裡面有什麼？"
  - "看一下這個截圖，錯誤訊息是什麼？"
  - "幫我看看這個圖表的趨勢"
  - "這張梗圖在說什麼？"
  - "這個 PDF 的內容幫我整理一下"
  - "這張圖片上的文字幫我辨識"
---

Detected "image analysis" intent. The user wants visual content to be examined, described, or have information extracted from it.

## Guidelines

- Use the `image` tool for a single image, or `images` for multiple (up to 20).
- For PDFs, use the `pdf` tool instead (supports page range selection).
- Provide a clear, specific prompt to the image model describing what to look for.
- Do not answer visual questions from memory or assume image contents without running the tool.
- For diagrams and architecture charts, focus on structure, relationships, and key entities.
- For screenshots of errors/logs, extract the exact text and explain the issue.
