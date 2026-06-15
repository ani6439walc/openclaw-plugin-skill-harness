---
id: CHAT
name: Casual Chat
triggers:
  - "User is engaging in pure casual social interaction with no concrete task, question, or request for advice, such as greeting, thanking, small talk, sharing mood, or making a light reaction. Do not match if the user is correcting, clarifying, or adjusting the scope of an ongoing concrete task (e.g., 'Actually start from 27', 'I meant the second one', 'Skip that, do X instead')."
  - "User asks for conversational clarification about something just mentioned or explained, without requesting external research, memory lookup, or a concrete task change"
  - "User is engaging in playful conversational prompts, guessing games, riddles, or light interactive banter without a concrete task or tool-backed lookup (e.g., 猜猜我在哪, 猜猜我是誰, 來玩個遊戲, 你猜)"
  - "User is engaging in casual flirtation or light romantic banter without explicit sexual roleplay or graphic sexual content"
  - "User wants a quick gut-check, intuition-based judgment, or rapid pattern recognition without lengthy analysis"
examples:
  - "早安～"
  - "謝謝你，很有幫助"
  - "今天天氣不錯"
  - "有點累欸今天"
  - "hi"
  - "這是甚麼意思"
  - "你剛剛說的那個是什麼"
  - "不太懂，可以解釋一下嗎"
  - "等等，你說的 XX 是什麼意思"
  - "猜猜我在哪"
  - "猜猜我是誰"
  - "來玩個猜謎遊戲"
  - "你猜看看"
---

Detected "casual chat" intent. This is a normal social interaction without a concrete task or request, including lightweight clarification of something just said.

## Guidelines

- **CRITICAL EXCLUSION**: If the user input contains any concrete question, request for advice, problem to solve, or actionable task, even when mixed with casual observations, small talk, or mood sharing, do not route to CHAT. Identify the primary concrete task instead.
- Reply naturally and warmly.
- Keep the response concise.
- Match the user's tone and energy.
- Do not over-analyze or introduce tools/workflows.
- Keep playful guessing games in CHAT only while they remain banter; if the user asks to use GPS, device tracking, web search, memory, or another concrete tool, route to the relevant task intent instead.
- Treat casual flirtation as CHAT, but do not classify explicit sexual roleplay or graphic sexual content as casual chat.
- For quick gut-check requests: use intuition (System 1) rather than lengthy analysis.
- Clarify prior statements directly when the user asks what something just mentioned means.
- **Task correction boundary**: If the user's message corrects, clarifies, or adjusts an ongoing concrete task — even if phrased casually (e.g., "阿對說錯了 從 27 開始", "Oh wait, I meant the second option") — this is NOT casual chat. Recognize it as a task continuation and apply the relevant task workflow instead of responding with small talk.

## Skills & Tools

- Make rapid pattern-based judgments without explicit reasoning:
  skill: intuition

## Response Strategy

- Match the user's emotional tone (greeting, thanks, fatigue, excitement).
- Keep replies brief — no need to fill silence with content.
- If the user expresses tiredness or stress, switch to supportive mode.
- If the user asks what a recent explanation means, briefly explain the prior statement in simpler words.
- If the message is a task correction or scope adjustment, do NOT respond with casual chat; acknowledge the correction and continue the original task workflow.
- Never escalate to tool usage or structured workflows.
