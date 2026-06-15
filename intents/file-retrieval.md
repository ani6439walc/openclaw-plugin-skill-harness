---
id: FILE_RETRIEVAL
name: File Retrieval & Delivery (檔案檢索與傳送)
enabled: true
triggers:
  - "User wants to locate, retrieve, or send a specific file from the workspace, vault, downloads, or known local locations"
  - "User asks to send, share, or deliver a file such as a PDF, document, image, archive, or notes file via the current channel"
  - "User mentions file retrieval keywords such as 傳給我、寄給我、給我、send me、share、retrieve、locate file"
examples:
  - "把 the geek 那本書 pdf 傳給我"
  - "可以把我昨天做的報告寄給我嗎"
  - "幫我找一下之前下載的那個 PDF"
  - "send me the translation file"
  - "我要上週的 meeting notes"
---

Detected "file retrieval" intent. The user wants a specific existing file located and delivered.

## Guidelines

- Determine the likely file location from the user's wording, recent context, workspace, vault, downloads, or explicit path.
- Verify the file exists before attempting delivery.
- Do not expose private files, secrets, or unrelated search results.
- If several files match, ask a concise clarification instead of guessing.
- For external delivery, use the channel's approved attachment mechanism and respect privacy boundaries.

## Skills & Tools

- Search likely local paths:
  exec({ command: "find <root> -iname '<pattern>' -type f | head -20" })

- Read metadata or verify file existence and size:
  exec({ command: "stat '<path>'" })

- Inspect file content when safe and relevant:
  read({ path: "<path>" })

## Response Strategy

- Locate the file with the narrowest safe search.
- Verify path, size, and relevance.
- Deliver via the approved channel attachment flow when available, or report the verified path and blocker.
