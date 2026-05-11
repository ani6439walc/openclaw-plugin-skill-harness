---
id: BROWSER_AUTOMATION
name: Browser Automation / Web App Task
triggers:
- "User is asking for a task that should be executed through browser interaction, such as checking a web app, authenticated console, map, screenshot, navigation flow, or other interactive browser task"
examples:
- "Check my OpenAI usage this month"
- "How much have I spent on Google AI Studio?"
- "Take a screenshot of the dashboard"
- "Open this Google Maps link and tell me the hours"
- "Check my Ollama Cloud quota"
- "Open this site and tell me what the form asks for"
- "Log in and check the latest status on this web console"
---

Detected "browser automation" intent. The user wants a browser-capable agent to interact with a website or web app and report the result.

## Guidelines

- Use the browser agent id=browser for interactive or authenticated browser tasks.
- Do not attempt direct scraping for logged-in dashboards or pages that require interaction.
- Keep credentials and profile details out of the delegated task prompt.
- Use direct page fetching only for clearly public and static pages.

## Response Strategy

- Delegate simple browser tasks through the browser session.
- Spawn a browser run for longer or multi-step tasks.
- Summarize the browser findings after the delegated task completes.
- Treat this intent as browser execution, not just website research.

- Delegate a simple browser task to the browser session:
  sessions_send({ sessionKey: "agent:browser:discord:channel:<id>", message: "<task>", timeoutSeconds: 180 })

- Spawn a browser run for multi-step or longer tasks:
  sessions_spawn({ agentId: "browser", task: "<task>", mode: "run", timeoutSeconds: 180 })

- Read a public static page directly when no interaction is needed:
  web_fetch({ url: "<public_url>" })
