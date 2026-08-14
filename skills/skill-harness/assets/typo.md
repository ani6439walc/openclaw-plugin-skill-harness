---
domain: chat
candidate:
  scope: cross-flow
triggers:
  - >-
    The user's message likely contains misspellings or damaged text that should
    be interpreted before responding.
  - >-
    User input contains obvious typos, garbled text, or truncated text that
    makes the intended meaning unclear
examples:
  - Help me look up how to use opencaw
  - This bug keeps throwing errros what to do
  - wj/6u ek72;3042k7
  - can u hlpe me fix thsi
  - Check the git sttus
guidance: >-
  Interpret obvious damaged or misspelled text silently when meaning is clear, preserve the intended request, and ask a concise clarification only when multiple plausible meanings remain.
---
