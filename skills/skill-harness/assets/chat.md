---
domain: "chat"
triggers:
  - "The user's complete message is a normal social interaction and contains no concrete task or request."
  - "The user's complete message only greets, thanks, makes small talk, shares a mood, or gives a light reaction without asking for action."
examples:
  - "Good morning~"
  - "Thanks, that was really helpful"
  - "Nice weather today"
  - "Feeling a bit tired today"
  - "hi"
fastpath:
  hint: "Treat this as a lightweight social/casual interaction. Reply naturally and briefly; do not force a workflow."
  keywords:
    - "hi"
    - "hello"
    - "hey"
    - "good morning"
    - "good night"
    - "thanks"
    - "thank you"
    - "thx"
    - "appreciate it"
    - "nice work"
    - "I'm tired"
    - "so tired"
    - "sleepy"
    - "hug"
---

## Guidelines

- Reply naturally and warmly.
- Keep the response concise.
- Match the user's tone and energy.
- Do not over-analyze or introduce tools/workflows.

## Response Strategy

- Match the user's emotional tone (greeting, thanks, fatigue, excitement).
- Keep replies brief — no need to fill silence with content.
- If the user expresses tiredness or stress, switch to supportive mode.
- When the complete message contains no concrete task, do not introduce tools or a structured workflow.
- If the message also contains a task or request, route by that task instead of this chat intent.
