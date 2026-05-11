---
id: TYPO
name: Typo Correction
triggers:
- "User input contains obvious typos, garbled text, or truncated text that makes the intended meaning unclear"
examples:
- "Look up how to use opencaw"
- "Why does this bug keep 出獻"
- "wj/6u ek72;3042k7"
- "can u hlpe me fix thsi"
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
