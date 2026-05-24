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

## Guidelines

- Always check today + tomorrow by default when user asks "what's on my calendar".
- For event creation, confirm timezone (Asia/Taipei) is correct before creating.
- One-shot reminders: use `schedule.kind="at"` with ISO timestamp.
- Recurring reminders: use `schedule.kind="cron"` with `tz="Asia/Taipei"`.
  - "Every day at 9am" → `{ kind: "cron", expr: "0 9 * * *", tz: "Asia/Taipei" }`
  - "Every Monday 10am" → `{ kind: "cron", expr: "0 10 * * 1", tz: "Asia/Taipei" }`
- Reminder payload: use `agentTurn` with a message that includes what to remind about + relevant context.
- Use `sessionTarget="main"` with `payload.kind="systemEvent"` to inject into current session; or `"isolated"` for standalone jobs.
- Always describe the reminder clearly in `payload.text` so it reads naturally when fired.
- Respect late-night quiet (23:00-08:00 Asia/Taipei): don't schedule reminders in that window unless urgently requested.
- For reminders < 30 min: `cron` is fine; for ultra-short (< 5 min), just `exec sleep`.

## Skills & Tools

- Read calendar events and manage agenda:
  skill: gog

- Set a one-off reminder:
  cron({ action: "add", job: { schedule: { kind: "at", at: "<ISO>" }, payload: { kind: "systemEvent", text: "<reminder_text>" } } })

- Set a recurring reminder:
  cron({ action: "add", job: { schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Taipei" }, payload: { kind: "systemEvent", text: "<reminder_text>" } } })

- Check or delete existing reminders:
  cron({ action: "list" })
  cron({ action: "remove", jobId: "<job_id>" })

- Add attendee and send calendar invitation:
  exec({ command: "gog calendar update primary <eventId> --add-attendee \"<email>\" --send-updates all" })

- List calendar events:
  exec({ command: "gog calendar list primary --from <date> --to <date>" })

- Create calendar event:
  exec({ command: "gog calendar create primary --summary \"...\" --start \"<ISO>\" --end \"<ISO>\" [--attendees \"...\"]" })

## Response Strategy

- Identify whether the request is calendar-related (gog) or reminder-related (cron).
- For calendar reads: check today + tomorrow by default.
- For calendar writes: confirm details (time, timezone, attendees) before creating.
- For reminders: choose one-shot vs recurring based on user request.
- Report the result concisely with event IDs or reminder IDs.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4
classify  execute     confirm      report
```

### Step 1 — Classify Request Type
- Calendar operation: read, create, update, add attendees.
- Reminder operation: one-off, recurring, list, delete.
- Quick timer: < 5 min → `exec sleep`.

### Step 2 — Execute
- Calendar: use `gog` CLI commands (list, create, update).
- Reminder: use `cron` tool with appropriate schedule kind.
- Add attendees with `--add-attendee` and `--send-updates all`.

### Step 3 — Confirm
- For event creation: verify timezone and attendee list.
- For reminders: confirm the payload text reads naturally.

### Step 4 — Report
- Report event details, reminder IDs, or calendar availability.
- Keep it concise.
