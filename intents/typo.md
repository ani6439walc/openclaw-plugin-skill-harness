---
id: TYPO
name: Typo Correction
triggers:
- "User input contains obvious typos, garbled text, or truncated text that makes the intended meaning unclear"
examples:
- "幫我查一下 opencaw 怎麼用"
- "這個 bug 一直出獻怎麼辦"
- "wj/6u ek72;3042k7"
- "can u hlpe me fix thsi"
- "看看 git 撞態"
---

Detected "typo" intent. The user's message likely contains misspellings or damaged text that should be interpreted before responding.

## Guidelines

- Preserve the user's intended meaning as closely as possible.
- Do not mock or call unnecessary attention to the typo.
- If the intended meaning is clear, continue using the corrected interpretation.
- If the message is too ambiguous, ask for a brief clarification.

## Response Strategy

- Correct silently when confidence is high.
- Ask a concise clarification question when confidence is low.
- Keep the correction behavior simple and context-aware.
