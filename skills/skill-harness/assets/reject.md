---
domain: follow-up
candidate:
  scope: cross-flow
triggers:
  - >-
    The user gives a short rejection, correction, cancellation, or wait signal
    that depends on the previous turn.
  - >-
    User says something is wrong, rejects a suggestion, cancels a proposed
    action, or corrects their previous message without a full new task.
examples:
  - wrong
  - not that
  - don't
  - cancel
  - that's not what I meant
fastpath:
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
guidance: >-
  Route a context-dependent rejection, cancellation, or correction here, stop the rejected action, identify what changed from the recent context, and clarify only when the target is ambiguous.
---
