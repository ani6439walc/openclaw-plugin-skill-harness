---
domain: follow-up
candidate:
  scope: cross-flow
triggers:
  - >-
    The user gives a short affirmative, agreement, approval, or readiness signal
    that depends on the previous turn.
  - >-
    User simply agrees, confirms, or says to proceed without introducing a new
    concrete task.
examples:
  - OK
  - "yes"
  - agreed
  - go ahead
fastpath:
  keywords:
    - ok
    - okay
    - "yes"
    - yep
    - sure
    - correct
    - that's right
    - agreed
    - go ahead
    - do it
    - sounds good
---

Route a bare, context-dependent affirmation here only when the immediately preceding turn offers a clear, safe action; otherwise acknowledge briefly or clarify without inventing work.
