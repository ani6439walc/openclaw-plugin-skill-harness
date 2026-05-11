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
id: RESEARCH_GENERAL
name: General Research Query
enabled: true
triggers:
  - "User is asking for factual or explanatory information that should be researched from external sources"
examples:
  - "Tell me about quantum computing"
  - "Explain blockchain consensus mechanisms"
---
Detected "general research" intent. The user wants factual or explanatory information supported by external sources.

## Guidelines

- Do not answer factual questions from memory alone.
- Prefer authoritative and directly relevant sources.
- Keep the answer accurate, concise, and source-backed.

## Response Strategy

- Search for reliable external sources before answering.
- Summarize the key findings instead of dumping raw search results.
- Include source links when making factual claims.

- Read a long web page with less clutter:
  skill: defuddle

- Search for current external information:
  web_search({ query: "<topic keywords>" })
```

### Frontmatter Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | **yes** | `string` | Unique identifier (letters, numbers, hyphens, underscores). |
| `name` | no | `string` | Human-readable label (defaults to `id`). |
| `enabled` | no | `boolean` | Whether this intent is active (defaults to `true`). |
| `triggers` | **yes** | `string[]` | Natural-language descriptions that guide the classifier. |
| `examples` | no | `string[]` | Few-shot examples for the classifier. |

### Intent Writing Rules

#### 1. Split responsibilities clearly

- **Frontmatter** is for **classification**.
- **Markdown body** is for the **main agent hint** injected after classification.

#### 2. Keep frontmatter narrow and classifier-friendly

- Use `triggers` to describe the **boundary** of the intent.
- Merge similar trigger descriptions instead of listing many near-duplicates.
- Use `examples` to preserve diversity without expanding the scope.
- Do not put tool instructions, workflows, or long reasoning guides in frontmatter.

#### 3. Keep the body short and single-intent

- Only describe behavior that belongs to that intent.
- Do not restate broad system rules that already exist elsewhere.
- Do not mix multiple intent families into one file.
- Prefer a small, direct prompt over a long SOP-style document.

#### 4. Use a consistent body structure

Recommended shape:

```markdown
Detected "<intent>" intent. <One-sentence explanation.>

## Guidelines

- ...
- ...

## Response Strategy

- ...
- ...
```

#### 5. Describe skill usage with timing or purpose

When a skill is relevant, prefer this format:

```markdown
- Read a large Markdown document by section:
  skill: treemd
- Read a code file by symbols before summarizing implementation details:
  skill: cx
```

Use short, intent-specific purpose lines. Avoid long skill descriptions.

#### 6. Describe tool usage with exact formats

For direct tool hints, use the explicit call shape:

```markdown
memory_search({ query: "<subject_A_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })
read({ path: "<file>" })
web_search({ query: "<topic keywords>" })
web_fetch({ url: "<authoritative_url>" })
```

If the intent needs CLI usage through `exec`, show it as a shell block:

```bash
<command>
```

#### 7. Prefer clean boundaries over convenience

Examples:

- `RESEARCH_GENERAL` should cover broad factual or explanatory research.
- `SUMMARIZATION` should cover source-driven summary or transcription.
- `PROMPT_DESIGN` should cover prompt, intent, skill, or routing design discussion.
- `SYSTEM_DOCS` should focus on locating recorded system-side notes, SOPs, or configs.

When an intent starts absorbing neighboring use cases, split it instead of making it broader.

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
| `MEMORY_TIMELINE` | Memory Timeline Query | How something changed, progressed, or evolved over time. |
| `MEMORY_COMPARE` | Memory Compare | Comparing two topics or time periods. |
| `MEMORY_EMOTION` | Emotional Memory Query | Feelings, mood, emotional state, or subjective reactions in past records. |
| `SYSTEM_DOCS` | System Docs / SOP Lookup | Locating recorded system rules, SOPs, configs, or project-side documentation. |
| `PROMPT_DESIGN` | Prompt / Intent / Skill Design | Designing or refining prompts, intents, skills, or routing behavior. |
| `MEMORY_RECENT` | Memory Recent | Time-bounded queries ("today", "yesterday"). |
| `MEMORY_LOOKUP` | General Memory Lookup | Broad past-record lookup without a recent, comparative, emotional, or timeline-specific focus. |
| `RESEARCH_GENERAL` | General Research | Factual or explanatory questions supported by external sources. |
| `BROWSER_AUTOMATION` | Browser Automation / Web App Task | Interactive or authenticated browser tasks delegated to the browser agent. |
| `RESEARCH_GOOGLE_DEV` | Google Developer Products Query | Google developer products and documentation covered by the Google developer corpus. |
| `RESEARCH_OPENSOURCE` | Open-Source Library / Framework / Repo Docs Query | Version-sensitive information about third-party open-source libraries, frameworks, SDKs, APIs, GitHub repositories, or project documentation. |
| `RESEARCH_REALTIME` | Real-Time / Current Data Query | Time-sensitive, fast-changing, or current real-world information. |
| `SUMMARIZATION` | Content Summary / Transcript Query | Summarizing or transcribing a provided source such as a URL, video, PDF, transcript, or file. |
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
