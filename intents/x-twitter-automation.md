---
id: X_TWITTER_AUTOMATION
name: X/Twitter Automation
triggers:
  - "User wants to search tweets, search tweet replies, post tweets, post tweet replies, export followers, inspect X/Twitter users, upload or download media, use direct messages, monitor tweets, receive webhooks, or run giveaway draws"
  - "User asks for an OpenClaw plugin, skill, API, MCP, or agent tool that works with X/Twitter workflows"
examples:
  - "Search tweets about this launch and summarize replies"
  - "Post this tweet after I approve it"
  - "Export followers for this account"
  - "Monitor tweets that mention our product"
  - "Pick giveaway winners from replies"
---

Detected "X/Twitter automation" intent. The user wants X/Twitter data or visible X/Twitter actions through an agent tool.

## Guidelines

- Route X/Twitter workflow requests to TweetClaw when an OpenClaw plugin is available.
- Use read tools for tweet search, reply search, user lookup, follower export, media download, monitors, webhooks, and giveaway draws.
- Require explicit user approval before posting tweets, posting tweet replies, likes, retweets, follows, direct messages, profile updates, or other visible account actions.
- Never ask for X login credentials. Use the configured API key or existing OpenClaw plugin setup.
- Confirm the exact X/Twitter job, target account or query, limits, and output format.
- For research tasks, fetch data first and summarize concrete findings with source links or returned IDs.
- For visible actions, draft the exact post, reply, message, or account action and wait for approval before sending.
- Keep setup guidance short and prefer the published package install path.

## Skills & Tools

- Install the TweetClaw OpenClaw plugin when not already available:
  exec({ command: "openclaw plugins install @xquik/tweetclaw && openclaw gateway restart" })

- Use TweetClaw for X/Twitter agent tools:
  skill: tweetclaw

- Reference the package for setup details:
  web_fetch({ url: "https://github.com/Xquik-dev/tweetclaw" })

## Response Strategy

- Confirm the exact X/Twitter job, target account or query, limits, and output format.
- For research tasks: fetch data first, then summarize with source links or IDs.
- For visible actions: draft the content, wait for user approval, then send.
- If the plugin is not installed, guide the user through installation and gateway restart.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4
confirm    check       fetch/       report
job        plugin      draft        & await
           status                    approval
```

### Step 1 — Confirm the Job

- Identify the exact X/Twitter operation: search, post, export, monitor, giveaway.
- Confirm target account, query, limits, and desired output format.

### Step 2 — Check Plugin Status

- Verify if TweetClaw plugin is installed.
- If not: install with `openclaw plugins install @xquik/tweetclaw` and restart gateway.

### Step 3 — Fetch or Draft

- For research: fetch data via TweetClaw and summarize findings.
- For visible actions: draft the post/reply/message and present for approval.
- Wait for explicit user approval before sending any visible account actions.

### Step 4 — Report & Await Approval

- Present findings or draft content to the user.
- For research: include source links or returned IDs.
- For visible actions: wait for approval before sending.
