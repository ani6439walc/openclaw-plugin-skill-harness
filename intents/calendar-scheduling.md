---
id: CALENDAR_SCHEDULING
name: Calendar & Scheduling (行事曆與排程)
enabled: true
triggers:
  - "User wants to check, create, update, or manage calendar events, appointments, schedules, or upcoming agenda — including adding attendees and sending invitations"
  - "User wants to set a reminder, alarm, or time-based notification (one-off or recurring)"
  - "User mentions scheduling keywords: 行事曆、行程、提醒、鬧鐘、倒數、計時、幾點做什麼、等一下提醒我"
examples:
  - "今天有什麼行程？"
  - "幫我新增一個明天下午三點的會議"
  - "提醒我 20 分鐘後去拿外送"
  - "每天早上九點提醒我做 Duolingo"
  - "這個行事曆活動幫我加 Helen 進來"
  - "幫我查一下這週末有沒有空"
---

Detected "calendar & scheduling" intent. The user wants to manage events, reminders, or time-based tasks.

## Skill & Tool Routing

| Task | Skill / Tool |
|---|---|
| Google Calendar: read events, create, update, add attendees, send invites | `gog` skill (`gog calendar` CLI) |
| One-off reminder (flexible timing, ±30s OK) | `cron` tool (action: add, schedule: at) |
| Recurring reminder (daily/weekly/cron-pattern) | `cron` tool (action: add, schedule: cron or every) |
| Check existing reminders | `cron` tool (action: list) |
| Delete a reminder | `cron` tool (action: remove) |
| Quick timer / countdown (< 30 min) | `exec` with `sleep` + notification (keep it simple) |
| Email-based scheduling (check Gmail for invites) | `gog` skill (`gog mail`) |

## Guidelines

### Calendar Operations (via `gog`)
- Read events: `gog calendar list primary --from <date> --to <date>`
- Create event: `gog calendar create primary --summary "..." --start "<ISO>" --end "<ISO>" [--attendees "..."]`
- Add attendee: `gog calendar update primary <eventId> --add-attendee "<email>" --send-updates all`
- Always check today + tomorrow by default when user asks "what's on my calendar".
- For event creation, confirm timezone (Asia/Taipei) is correct before creating.

### Reminders (via `cron`)
- **One-shot**: use `schedule.kind="at"` with ISO timestamp.
- **Recurring**: use `schedule.kind="cron"` with `tz="Asia/Taipei"`.
  - "Every day at 9am" → `{ kind: "cron", expr: "0 9 * * *", tz: "Asia/Taipei" }`
  - "Every Monday 10am" → `{ kind: "cron", expr: "0 10 * * 1", tz: "Asia/Taipei" }`
- Reminder payload: use `agentTurn` with a message that includes what to remind about + relevant context.
- Use `sessionTarget="main"` with `payload.kind="systemEvent"` to inject into current session; or `"isolated"` for standalone jobs.
- Always describe the reminder clearly in `payload.text` so it reads naturally when fired.

### Time Boundaries
- Respect late-night quiet (23:00-08:00 Asia/Taipei): don't schedule reminders in that window unless urgently requested.
- For reminders < 30 min: `cron` is fine; for ultra-short (< 5 min), just `exec sleep`.
