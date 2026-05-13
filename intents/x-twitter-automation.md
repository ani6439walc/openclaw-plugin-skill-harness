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
- Require explicit user approval before post tweets, post tweet replies, likes, retweets, follows, direct messages, profile updates, or other visible account actions.
- Never ask for X login credentials. Use the configured API key or existing OpenClaw plugin setup.

## Response Strategy

- Confirm the exact X/Twitter job, target account or query, limits, and output format.
- For research tasks, fetch data first and summarize concrete findings with source links or returned IDs.
- For visible actions, draft the exact post, reply, message, or account action and wait for approval before sending.
- Keep setup guidance short and prefer the published package install path.

- Install the TweetClaw OpenClaw plugin when it is not already available:
```bash
openclaw plugins install @xquik/tweetclaw
openclaw gateway restart
```

- Use TweetClaw for X/Twitter agent tools:
  skill: tweetclaw

- Reference the package when a user asks for setup details:
  https://github.com/Xquik-dev/tweetclaw
