---
domain: "session"
triggers:
  - "The user gives a short affirmative, agreement, approval, or readiness signal that depends on the previous turn."
  - "User simply agrees, confirms, or says to proceed without introducing a new concrete task."
examples:
  - "OK"
  - "好"
  - "可以"
  - "yes"
  - "同意"
fastpath:
  hint: "Treat this as a simple affirmation of the current context. Continue only if the previous turn clearly proposed a safe next step; otherwise acknowledge briefly."
  keywords:
    - "ok"
    - "okay"
    - "好"
    - "可以"
    - "對"
    - "沒錯"
    - "是"
    - "yes"
    - "yep"
    - "sure"
    - "同意"
    - "照做"
    - "好啊"
---

## Guidelines

- Treat the message as context-dependent confirmation, not a standalone new task.
- Continue only when the previous assistant turn clearly offered a safe, specific next step.
- If the prior context is ambiguous, acknowledge and ask the smallest clarifying question.

## Response Strategy

- Keep the response brief.
- Do not invent a task from the affirmation alone.
- Preserve the prior topic and workflow unless the user adds new scope.
