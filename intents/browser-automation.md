---
id: BROWSER_AUTOMATION
name: Browser Automation / Web App Task
triggers:
  - "User is asking for a task that should be executed through browser interaction, such as checking a web app, authenticated console, map, screenshot, navigation flow, or other interactive browser task"
examples:
  - "幫我查 OpenAI 這個月花了多少"
  - "截圖看一下 dashboard"
  - "開 Google Maps 幫我查營業時間"
  - "登入 console 幫我查目前的 quota 剩多少"
---

Detected "browser automation" intent. The user wants a browser-capable agent to interact with a website or web app and report the result.

## Guidelines

- Use the browser agent id=browser for interactive or authenticated browser tasks.
- Do not attempt direct scraping for logged-in dashboards or pages that require interaction.
- Keep credentials and profile details out of the delegated task prompt.
- Use direct page fetching only for clearly public and static pages.
- Treat this intent as browser execution, not just website research.

## Skills & Tools

- Delegate a simple browser task (≤3 steps) to the browser session:
  sessions_send({ sessionKey: "agent:browser:discord:channel:<id>", message: "<task>", timeoutSeconds: 180 })

- Spawn a browser run for multi-step or longer tasks (>3 steps):
  sessions_spawn({ agentId: "browser", task: "<task>", mode: "run", timeoutSeconds: 180 })

- Read a public static page directly when no interaction is needed:
  web_fetch({ url: "<public_url>" })

- Wait for browser sub-agent to complete before summarizing:
  sessions_yield()

- Handle spending/usage queries with known browser profiles:
  skill: browser-harness

## Response Strategy

- Classify the task complexity: simple (≤3 steps) vs complex (>3 steps).
- Delegate via `sessions_send` for simple tasks or `sessions_spawn` for complex ones.
- Wait for the browser sub-agent to complete its work.
- Summarize the browser findings after delegation completes.
- Notify the user that a browser task has been dispatched before waiting.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4
classify  delegate    yield        summarize
          or spawn
```

### Step 1 — Classify Task Complexity
- Simple (≤3 steps): direct query, single page check, screenshot → use `sessions_send`.
- Complex (>3 steps): multi-page navigation, login flows, form filling → use `sessions_spawn`.
- Notify the user that a browser task has been dispatched.

### Step 2 — Delegate to Browser Agent
- For simple tasks: `sessions_send` with timeout 180s.
- For complex tasks: `sessions_spawn` with `mode: "run"`.
- Include task description and relevant profile hint in the delegation.

### Step 3 — Wait for Completion
- Use `sessions_yield` to wait for the browser sub-agent result.
- Do not busy-poll for status.

### Step 4 — Summarize Results
- Digest the browser sub-agent output.
- Present findings to the user in a clear, concise format.
