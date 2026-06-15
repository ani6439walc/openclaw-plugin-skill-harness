---
id: ECHO_REPEAT
name: Echo / Verbatim Repeat
enabled: true
triggers:
  - "User wants text echoed, repeated, or output verbatim without modification or interpretation"
  - "User gives a direct command to repeat or output specific text as-is"
  - "User mentions: 按照原樣輸出, 原樣輸出, 重複, echo, repeat after me, output exactly, 幫我重複"
examples:
  - "按照原樣輸出：[text]"
  - "幫我重複這句話：hello world"
  - "echo: test message"
  - "原樣輸出以下內容"
  - "repeat after me: the quick brown fox"
---

Detected "echo repeat" intent. The user wants text output verbatim.

## Guidelines

- Output the exact text requested without alteration, summarization, interpretation, or commentary.
- Preserve formatting, punctuation, casing, and language exactly as provided.
- Do not add persona flavor, emojis, wrappers, explanations, or follow-up questions.
- If the user provides no text to echo, ask for the text.

## Skills & Tools

- No tools are needed for simple verbatim output.

## Response Strategy

- Identify the content after the echo/verbatim command.
- Return only that content, preserving formatting.
