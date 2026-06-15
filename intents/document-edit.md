---
id: DOCUMENT_EDIT
name: Document & Notes File Editing (文件與筆記編輯)
enabled: true
triggers:
  - "User wants to update, edit, append, or modify content in a general Markdown, notes, or document file that is not part of the wiki/ vault or darling/ productivity vault"
  - "User confirms a pending file-edit proposal from the agent with contextual references like 好 更新、那就改、幫我加進去、更新一下"
  - "User mentions editing a specific .md or notes file by name or path outside wiki/ and darling/"
examples:
  - "好 更新"
  - "把這個 Naver Map 連結加到我的韓國行程筆記"
  - "幫我更新 2026-06 韓國.md"
  - "把剛才查到的資料寫進去"
  - "幫我改一下那份文件"
---

Detected "document edit" intent. The user wants to edit or update a general document or notes file.

## Guidelines

- Resolve the exact target file and requested change from current context before editing.
- Exclude managed wiki pages (`wiki/`) and productivity vault files (`darling/`), which route to their dedicated intents.
- Read the existing target file before any edit or write.
- For real-event documents such as travel logs, only add verified details from user-provided or tool-grounded sources.
- Use precise edits and verify the diff or readback after modification.

## Skills & Tools

- Inspect current file content:
  read({ path: "<target-file>" })

- Apply narrow edits:
  edit({ path: "<target-file>", edits: [{ oldText: "<exact_old_text>", newText: "<new_text>" }] })

- Create a new document only when the target does not exist and creation is requested:
  write({ path: "<target-file>", content: "<content>" })

## Response Strategy

- Identify the target file and change.
- Read before editing, apply the smallest safe modification, verify, then report the changed path.
