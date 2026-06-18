---
id: BROWSER_AUTOMATION
name: Browser Automation / Web App Task
triggers:
  - "User is asking for a task that should be executed through browser interaction, such as checking a web app, authenticated console, map, screenshot, navigation flow, map link conversion, or other interactive browser task"
  - "User provides a URL to a site that blocks scraping, requires rendering, or needs authentication, such as Instagram, Twitter/X, or TikTok, to extract content or perform a task"
examples:
  - "幫我查 OpenAI 這個月花了多少"
  - "截圖看一下 dashboard"
  - "開 Google Maps 幫我查營業時間"
  - "把這些 Google Maps 連結轉成 Apple Maps"
  - "用 gog 技能幫我查 wei840222@gmail.com 的信箱"
  - "幫我查一下我的 Gmail 有沒有 Klook 的確認信"
  - "登入 console 幫我查目前的 quota 剩多少"
  - "幫我開這個 IG 限動看看是什麼餐廳"
  - "這個 Twitter 連結幫我截圖"
---

Detected "browser automation" intent. The user wants a browser-capable agent to interact with a website or web app and report the result.

## Guidelines

- Use the browser agent id=browser for interactive or authenticated browser tasks.
- Do not attempt direct scraping for logged-in dashboards or pages that require interaction.
- Do not include raw passwords or secrets in the delegated task prompt. Always pass user-specified profile names, email addresses, or skill hints to the browser agent or execution context.
- Use direct page fetching only for clearly public and static pages.
- Treat this intent as browser execution, not just website research.
- If the user explicitly names a skill or CLI path (for example, `gog`), invoke that skill or command path directly instead of generic browser delegation.
- If a browser sub-agent fails because an endpoint, profile, or site is unavailable, retry once with an alternative user-specified profile or fallback method before suggesting manual work.
- For restricted sites, anti-bot blocks, or browser-environment limitations, use public search/fetch fallbacks when they can answer the request safely.
- When extracted browser data must be saved locally, read the target file first and use precise edits rather than rewriting from stale content.
- When delegating tasks that require a specific page, section, lecture, or element, explicitly include the navigation target in the task prompt; do not assume the browser agent will infer the right location from context alone.
- For tasks requiring navigation to a specific page, section, lecture, account, or UI state, require the browser agent to verify successful navigation by checking page title, URL, visible heading, selected sidebar item, or another stable element before extraction or interaction.
- For multi-step browser workflows, write delegated task prompts as explicit numbered steps with verification gates between navigation and action phases.
- Recognize sequential content extraction patterns such as course lectures, document series, or dashboard pages as stable workflows; process them with explicit target verification and consider whether a dedicated skill/workflow is warranted after repeated use.
- For direct download links such as PDFs, images, and files, prefer `exec` with `curl` when `web_fetch` is blocked by security restrictions or when browser interaction is unnecessary.
- For SaaS spending, usage, invoice, or receipt checks, use browser automation or browser-harness with the known profile/account hint; do not search for local billing scripts or unrelated local skills.

## Skills & Tools

- Delegate a simple browser task (≤3 steps) to the browser session:
  sessions_send({ sessionKey: "agent:browser:discord:channel:<id>", message: "<task>", timeoutSeconds: 180 })

- Spawn a browser run for multi-step or longer tasks (>3 steps):
  sessions_spawn({ agentId: "browser", task: "<task>", mode: "run", timeoutSeconds: 180 })

- Include browser profile hints for authenticated sessions in the delegated task payload:
  sessions_spawn({ agentId: "browser", task: "Use <profile> browser profile to open <url>, verify <page/account/element>, then <action>.", mode: "run", timeoutSeconds: 180 })

- Structure sequential content extraction workflows with explicit navigation verification:
  1. Navigate to the target location.
  2. Verify successful navigation by checking page title, URL, selected item, or visible element.
  3. Perform content extraction or interaction.
  4. Return structured results plus the verification evidence.

- Read a public static page directly when no interaction is needed:
  web_fetch({ url: "<public_url>" })

- Fallback to web search when browser automation is blocked by site restrictions or environment limits:
  web_search({ query: "<target_info>" })

- Persist extracted data to local vault or Markdown files with precise matching:
  read({ path: "<target_md>" })
  edit({ path: "<target_md>", edits: [{ oldText: "<exact_match>", newText: "<new_content>" }] })

- Resolve and convert map URLs between services (Google Maps ↔ Apple Maps) by expanding public links and extracting place names or coordinates:
  web_fetch({ url: "<public_map_url>" })

- Wait for browser sub-agent to complete before summarizing:
  sessions_yield()

- Handle SaaS spending, usage, invoice, or receipt queries through authenticated browser profiles:
  skill: browser-harness
  sessions_spawn({ agentId: "browser", task: "Use <profile/account> to open <billing-or-usage-url>, verify the account and billing page, extract amount/date/plan, and return evidence.", mode: "run", timeoutSeconds: 180 })

- Download a direct file URL when `web_fetch` is blocked or the URL is a file download:
  exec({ command: "curl -L -o <filename> <url>" })

- Manage browser tabs or recover from lost tab context:
  browser({ action: "tabs" })
  browser({ action: "<action>", targetId: "<tabId>", ... })

## Response Strategy

- Classify the task complexity: simple (≤3 steps) vs complex (>3 steps).
- For authenticated or profile-dependent tasks, preserve the user's profile hint (for example, `wei840222`) in the delegated task prompt.
- Delegate via `sessions_send` for simple tasks or `sessions_spawn` for complex ones.
- Wait for the browser sub-agent to complete its work.
- Summarize the browser findings after delegation completes.
- Before summarizing, verify the browser result matches the expected target such as page title, section, lecture number, account, dashboard, or element; if it is wrong, re-delegate once with more explicit navigation instructions.
- If the delegated browser task fails, acknowledge the failure, try one bounded alternative when available, then ask for preference or report the blocker instead of jumping straight to manual workaround.
- Preserve user-specified profile, account, email, skill, and target-site hints throughout delegation and follow-up.
- Notify the user that a browser task has been dispatched before waiting.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
classify  delegate    yield        summarize  persist
          or spawn
```

### Step 1 — Classify Task Complexity

- Simple (≤3 steps): direct query, single page check, screenshot → use `sessions_send`.
- Direct download: for PDF/image/file URLs or `web_fetch` security failures, use `exec` with `curl` and verify the saved file path/size instead of forcing a browser workflow.
- Complex (>3 steps): multi-page navigation, login flows, form filling, authenticated content extraction → use `sessions_spawn`.
- Sequential extraction (course lectures, document series, repeated dashboard checks): use `sessions_spawn` with explicit navigation verification steps.
- Notify the user that a browser task has been dispatched.

### Step 2 — Delegate to Browser Agent

- For simple tasks: `sessions_send` with timeout 180s.
- For complex or authenticated tasks: `sessions_spawn` with `mode: "run"` and a clear profile hint when saved session state is needed.
- Include task description plus relevant user-provided profile, account, email, skill, target-site hints, and exact page/section/element navigation target in the delegation.
- For billing tasks, include the service name, profile/account hint, target billing/usage/receipt page, exact fields to extract (amount, date range, invoice/receipt title), and a requirement to verify the account before reading numbers.
- For navigation-dependent tasks, structure the prompt with explicit steps:
  ```
  1. Navigate to [target location]
  2. Verify navigation by confirming [page title/URL/visible element]
  3. Perform [extraction/interaction]
  4. Return [structured results] with verification evidence
  ```

### Step 3 — Wait for Completion

- Use `sessions_yield` to wait for the browser sub-agent result.
- Do not busy-poll for status.

### Step 4 — Verify and Summarize Results

- Check whether the browser sub-agent output matches the requested page, account, lecture, section, dashboard, or UI state.
- If the output is from the wrong location, re-delegate once with explicit navigation steps before summarizing.
- For sequential extraction workflows, confirm the extracted content matches the requested target before proceeding to the next item.
- Digest the browser sub-agent output.
- Present findings to the user in a clear, concise format.
- For map URL conversion, identify the source URL format, resolve or extract coordinates/place names, then construct the target service URL and verify it opens to the intended location.

### Step 4.5 — Recover from Tab Errors

- If a `browser` tool call fails with "tab not found", do not retry blindly.
- Execute `browser({ action: "tabs" })` to list active tabs.
- Retry the original action using a valid `targetId`, `tabId`, or `label` from the response.

### Step 5 — Persist Extracted Data (If Applicable)

- If the task requires updating local files, identify and read the target file immediately before editing.
- Apply updates using `edit` with exact `oldText`; if matching fails, re-read the relevant section and retry once with corrected text.
- Report the changed file path and any unresolved browser or source limitations.
