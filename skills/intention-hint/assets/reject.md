---
domain: "follow-up"
fastpath:
  hint: "Treat this as a rejection or correction of the current context. Pause the prior action, acknowledge the correction, and resolve the intended change before continuing."
  keywords:
    - "no"
    - "不是"
    - "不對"
    - "錯了"
    - "不要"
    - "取消"
    - "先不要"
    - "不是這樣"
    - "我說錯了"
    - "等等"
    - "等一下"
    - "重來"
triggers:
  - "The user gives a short rejection, correction, cancellation, or wait signal that depends on the previous turn."
  - "User says something is wrong, rejects a suggestion, cancels a proposed action, or corrects their previous message without a full new task."
examples:
  - "不對"
  - "不是"
  - "不要"
  - "取消"
  - "我說錯了"
---

## Guidelines

- Treat the message as a context-dependent rejection or correction, not casual chat.
- Pause any proposed action until the corrected intent is clear.
- If the correction target is ambiguous, ask what should change before proceeding.

## Response Strategy

- Acknowledge the correction directly.
- Do not continue the rejected action.
- Use the prior conversation to identify what is being rejected or corrected.
