# Intention Hint Plugin

[![OpenClaw](https://img.shields.io/badge/Platform-OpenClaw-blue.svg)](https://github.com/openclaw/openclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An OpenClaw plugin that pre-scans user intent before main-agent replies and injects routing hints via the `before_prompt_build` hook.

## How it works

1. **Before Prompt Build** — When the user sends a message, the plugin intercepts the prompt construction.
2. **Fast Sub-agent** — A lightweight sub-agent classifies the intent by matching against dynamically loaded intent definitions.
3. **Dynamic Intents** — Intent definitions live in YAML-frontmatter Markdown files under `intents/`. Add, remove, or edit intents without rebuilding the plugin. Each intent file specifies:
   - `id` — unique identifier (e.g. `chat`, `memory-recent`)
   - `name` — human-readable label
   - `enabled` — whether the intent is active
   - `triggers` — natural-language descriptions that guide the classifier
   - `examples` — few-shot examples for the classifier
   - Markdown body — the injection prompt template (supports `{{goal}}`, `{{suggestion}}`, `{{suggestedTools}}`, `{{suggestionSkills}}`, `{{reason}}`)
4. **Structured Output** — The classifier returns a key-value format:
   ```
   intent: <id> (<name>)
   reason: <brief reason for classification>
   goal: <what the user likely wants to achieve>
   suggestion: <optional correction or recommendation>
   suggestedTools: <optional comma-separated tool names>
   suggestionSkills: <optional comma-separated skill names>
   ```
   The plugin parses this into an `IntentionResult` and injects the matching intent's body as untrusted context.
5. **Recent Context Support** — In `queryMode: "recent"`, the plugin extracts recent `user` / `assistant` turns from `event.messages`, strips previously injected plugin metadata blocks, and builds a recent conversation tail for the classifier.
6. **Internal Run Guard** — The classifier skips internal runs for `active-memory`, `intention-hint`, and generic `:subagent:` session keys.
7. **Zero File Write** — The plugin does not write any files to disk. All session metadata stays in memory; the embedded subagent runs with `modelRun: true` and no session file persistence.

## Installation

This plugin is a workspace package inside `/home/wei/Projects/openclaw/extensions/`.  
Build it with:

```bash
cd extensions/intention-hint
bun install
bun run build
```

## Configuration (`openclaw.json`)

```json5
{
  plugins: {
    entries: {
      "intention-hint": {
        enabled: true,
        config: {
          agents: ["main"],
          model: "google/gemini-3-flash", // lightweight scanner model
          modelFallback: "openai/gpt-5-mini",
          allowedChatTypes: ["direct"],
          allowedChatIds: [],
          deniedChatIds: [],
          queryMode: "recent",
          timeoutMs: 3000,
          intentsDir: "./intents",          // relative to plugin root
          intentsHotReload: true,           // auto-reload on change
          intentsHotReloadIntervalMs: 5000, // poll interval
        },
      },
    },
  },
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agents` | `string[]` | `["main"]` | Agent IDs eligible for intention scanning. |
| `model` | `string` | — | Lightweight model for the intention scanner. Falls back to the agent's default if empty. |
| `modelFallback` | `string` | — | Fallback model when `config.model` cannot be resolved. |
| `allowedChatTypes` | `string[]` | `["direct"]` | Which chat types are eligible (`direct`, `group`, `channel`, `explicit`). |
| `allowedChatIds` | `string[]` | `[]` | Allow-list of chat IDs. |
| `deniedChatIds` | `string[]` | `[]` | Deny-list of chat IDs. |
| `queryMode` | `string` | `"recent"` | Context sent to scanner: `message` (latest only), `recent` (recent turns), or `full` (full history). |
| `timeoutMs` | `number` | `3000` | Budget in milliseconds for the intention scanner sub-agent. |
| `intentsDir` | `string` | `"./intents"` | Directory containing dynamic intent `.md` files. Resolved relative to the plugin installation directory. |
| `intentsHotReload` | `boolean` | `true` | Automatically reload intent definitions when files change. |
| `intentsHotReloadIntervalMs` | `number` | `5000` | How often to check for intent file changes (clamped to 1000–300000 ms). |

## Intent Definition Format

Create a `.md` file in the `intents/` directory:

```markdown
---
id: research
name: Research Question
enabled: true
triggers:
  - "User asks a technical, factual, or real-world question"
  - "User wants to learn about a library, framework, or API"
examples:
  - "How does React useEffect cleanup work?"
  - "What's the best practice for handling CORS in Flask?"
---
The user is asking a research/technical question. Consider using:
- `websearch` or `webfetch` for up-to-date documentation
- `librarian` for codebase-wide exploration
- `grep_app` for finding real-world usage examples

Suggested approach: explore first, then answer with source-cited information.
```

### Frontmatter Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | **yes** | `string` | Unique identifier (letters, numbers, hyphens, underscores). |
| `name` | no | `string` | Human-readable label (defaults to `id`). |
| `enabled` | no | `boolean` | Whether this intent is active (defaults to `true`). |
| `triggers` | **yes** | `string[]` | Natural-language descriptions that guide the classifier. |
| `examples` | no | `string[]` | Few-shot examples for the classifier. |

### Injection Format

When the classifier matches an intent, the plugin injects the following structure as untrusted context:

```xml
<intention_hint_plugin>
reason: <brief reason for classification>
goal: <what the user likely wants to achieve>
suggestion: <optional correction or recommendation>
suggestedTools: <optional comma-separated tool names>
suggestionSkills: <optional comma-separated skill names>

[Intent Hint] <the Markdown body from the matched intent definition>
</intention_hint_plugin>
```

The subagent output fields (`reason`, `goal`, `suggestion`, `suggestedTools`, `suggestionSkills`) are placed **above** the intent's Markdown body. The body itself is injected as-is without any template substitution.

## Default Intents

The plugin ships with these pre-defined intents:

| ID | Name | Description |
|----|------|-------------|
| `CHAT` | Casual Chat | Greetings, small talk, or emotional connection. |
| `CODE_REVIEW` | Code Review | Reviewing code, architecture, or quality concerns. |
| `MEMORY_CHRONOLOGY` | Memory Chronology | How something changed over time. |
| `MEMORY_COMPARE` | Memory Compare | Comparing two topics or time periods. |
| `MEMORY_EMOTIONAL` | Memory Emotional | Feelings, mood, or emotional state. |
| `MEMORY_META` | Memory Meta | System, SOP, or memory structure questions. |
| `MEMORY_RECENT` | Memory Recent | Time-bounded queries ("today", "yesterday"). |
| `MEMORY_STANDARD` | Memory Standard | General memory retrieval. |
| `RESEARCH` | Research | Technical questions, facts, library usage. |
| `TYPO` | Typo Correction | Obvious typos or unclear phrasing. |

To customize, edit the files in `intents/` or create new ones. Files are loaded in alphabetical order; duplicate `id`s override previous definitions.

## Architecture

```
index.ts
    → createPlugin(api)
        → src/plugin.ts
            → loadIntents(intentsDir)      // scan .md files
            → before_prompt_build Hook
                ├── Gate checks (agent whitelist, chat type, chat id, internal runs)
                ├── buildQuery (message / recent / full)
                ├── recent mode reads event.messages
                ├── runIntentionSubagent (lightweight embedded Pi agent)
                │       ├── buildIntentionPrompt (dynamic from IntentDefinition[])
                │       ├── parseIntentionResult (key-value → IntentionResult)
                │       └── buildPromptPrefix (template replacement → XML injection)
                └── prependContext
```

## Credits

- Plugin architecture based on [openclaw/openclaw/extensions/active-memory](https://github.com/openclaw/openclaw/tree/main/extensions/active-memory)
- Intent classification adapted from `sisyphus` Intent Gate

---

_🌸　Powered by Ａni | [OpenClaw Plugin] © 2026_
