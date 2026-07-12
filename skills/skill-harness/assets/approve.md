---
domain: "follow-up"
triggers:
  - "The user gives a short affirmative, agreement, approval, or readiness signal that depends on the previous turn."
  - "User simply agrees, confirms, or says to proceed without introducing a new concrete task."
examples:
  - "OK"
  - "yes"
  - "agreed"
  - "go ahead"
fastpath:
  hint: "Treat this as a simple affirmation of the current context. Continue only if the previous turn clearly proposed a safe next step; otherwise acknowledge briefly."
  keywords:
    - "ok"
    - "okay"
    - "yes"
    - "yep"
    - "sure"
    - "correct"
    - "that's right"
    - "agreed"
    - "go ahead"
    - "do it"
    - "sounds good"
---

## Guidelines

- Treat the message as context-dependent confirmation, not a standalone new task.
- Continue only when the previous assistant turn clearly offered a safe, specific next step.
- If the prior context is ambiguous, acknowledge and ask the smallest clarifying question.

## Response Strategy

- Keep the response brief.
- Do not invent a task from the affirmation alone.
- Preserve the prior topic and workflow unless the user adds new scope.
