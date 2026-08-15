---
domain: chat
triggers:
  - >-
    The user's complete message is a normal social interaction and contains no
    concrete task or request.
  - >-
    The user's complete message only greets, thanks, makes small talk, shares a
    mood, or gives a light reaction without asking for action.
examples:
  - Good morning~
  - "Thanks, that was really helpful"
  - Nice weather today
  - Feeling a bit tired today
  - hi
fastpath:
  keywords:
    - hi
    - hello
    - hey
    - good morning
    - good night
    - thanks
    - thank you
    - thx
    - appreciate it
    - nice work
    - I'm tired
    - so tired
    - sleepy
    - hug
---

Route purely social messages with no concrete request here and answer briefly, warmly, and in the user's tone, while routing any embedded task by its actual intent.
