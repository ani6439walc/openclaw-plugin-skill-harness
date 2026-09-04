---
domain: follow-up
triggers:
  - >-
    The user gives a short rejection, correction, cancellation, or wait signal
    that depends on the previous turn.
  - >-
    User says something is wrong, rejects a suggestion, cancels a proposed
    action, or corrects their previous message without a full new task.
examples:
  - "That's wrong, please stop the execution."
  - "Not that one, I meant the second option."
  - "Don't do that, wait a moment."
  - Cancel the previous operation and revert changes.
  - "That's not what I meant, let me clarify."
keywords:
  - "no"
  - not that
  - wrong
  - don't
  - cancel
  - not yet
  - that's not what I meant
  - I was wrong
  - wait
  - hold on
  - start over
---

Route a context-dependent rejection, cancellation, or correction here, stop the rejected action, identify what changed from the recent context, and clarify only when the target is ambiguous.
