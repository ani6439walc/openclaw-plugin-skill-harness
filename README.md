# Intention Hint Plugin

[![OpenClaw](https://img.shields.io/badge/Platform-OpenClaw-blue.svg)](https://github.com/openclaw/openclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An OpenClaw plugin that pre-scans user intent before main-agent replies and injects routing hints via the `before_prompt_build` hook. It also tracks session-level metrics via `after_tool_call` and `agent_end`, then cleans up tracker state and session JSON retention via `session_end`.

## Architecture

```
index.ts
  └─ plugin.ts → createPlugin()
       │
       ├─ file-utils.ts → shared filesystem helpers
       │    └─ pluginRoot, sessionsPath(), ensureDir(), writeJsonAtomic(), readJsonFile(), safeWriteJson(), fileExists()
       │
       ├─ constants.ts → shared defaults
       │    └─ DEFAULT_TIMEOUT_MS, FALLBACK_INTENT, default complexity prompts, UNTRUSTED_CONTEXT_HEADER
       │
       ├─ types.ts → all shared type definitions
       ├─ evolution-types.ts → Self-Evolution review types (ReviewState, ReviewSnapshot, EvolutionFinding, EvolutionSource)
       │
       ├─ intent-loader.ts → defaultCatalog (loads intent .md files from intentsDir)
       │    └─ uses file-utils.ts for pluginRoot
       │
       ├─ subagent.ts → runIntentionSubagent() (classifies intent via lightweight sub-agent)
       │    ├─ resolveCurrentTime() — timezone-aware local time formatting
       │    ├─ buildIntentionEmbeddedRunParams() — builds isolated sub-agent run config
       │    └─ uses constants.ts for FALLBACK_INTENT
       │
       ├─ hooks.ts → createHookHandlers()
       │    ├─ onBeforePromptBuild → rotate() → record() → write() → inject hint
       │    ├─ onAfterToolCall → record() → write() (tracks tool usage)
       │    ├─ onAgentEnd → record() → aggregate stats → enqueue evolution review
       │    ├─ onSessionEnd → cleanup() + cleanupExpired() (lifecycle cleanup + 14-day retention)
       │    └─ review-queue.ts → ReviewQueue (serialized background evolution reviews)
       │
       ├─ prompt.ts → buildIntentionPrompt() (pure function — no API dependency)
       │    ├─ JSON output format with <id> (<name>) intent style
       │    ├─ parseIntentionResult() — JSON parser with code-block tolerance
       │    ├─ <intent_categories> — auto-derived from ID prefixes
       │    ├─ <current_time> — injects local timezone time
       │    ├─ <conversation> — omitted when empty
       │    ├─ buildPromptPrefix() — builds injected hint text
       │    └─ uses constants.ts for complexity prompt defaults
       │
       ├─ hooks.ts → attachHistoricalIntents() → limitConversationTurns()
       │    └─ conversation-extract.ts (internal-turn filtering + per-turn historical intent context)
       │
       ├─ session-tracker.ts → SessionTracker (JSON session persistence)
       │    ├─ uses file-utils.ts for fileExists(), readJsonFile(), safeWriteJson()
       │    ├─ uses evolution-types.ts for ReviewState, ReviewSnapshot
       │    └─ sessions/<sessionId>.json
       │
       ├─ stats-aggregator.ts → StatsAggregator (atomic runtime usage aggregation)
       │    ├─ uses file-utils.ts for fileExists(), readJsonFile(), safeWriteJson()
       │    └─ sessions/stats.json
       │
       ├─ trigger-checker.ts + review-subagent.ts → Intent Self-Evolution review
       │    ├─ trigger-checker.ts → checkEvolutionTriggers() (six configurable triggers)
       │    ├─ review-subagent.ts → buildReviewPrompt() + parseReviewFindings() + runReviewSubagent()
       │    └─ backlog-writer.ts + evolution-backlog.ts → sessions/evolution.json
       │         ├─ backlog-writer.ts uses file-utils.ts for safeWriteJson()
       │         └─ evolution-backlog.ts uses file-utils.ts for readJsonFile(), writeJsonAtomic()
       │
       ├─ backlog-cli.ts + intent-validation.ts → transactional backlog processing support
       │    └─ skills/intention-hint/references/process-backlog.md
       │
       ├─ session.ts → session guards (isEnabledForAgent, isEligibleInteractiveSession, etc.)
       │
       └─ config.ts → resolveConfig() (zod schema validation with contextWindow)
            ├─ uses constants.ts for DEFAULT_TIMEOUT_MS and default values
            └─ uses types.ts for config type definitions
```

### Module Responsibilities

| Module                    | Purpose                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `plugin.ts`               | Plugin entry point, registers hooks on OpenClaw lifecycle events                                          |
| `hooks.ts`                | Event handlers for prompt building, tool/agent tracking, and session cleanup                              |
| `subagent.ts`             | Runs the intention classification sub-agent with model selection                                          |
| `intent-loader.ts`        | Loads and catalogs intent definitions from YAML-frontmatter `.md` files                                   |
| `file-utils.ts`           | Shared filesystem helpers — atomic JSON I/O, directory management, path resolution                        |
| `constants.ts`            | Shared defaults — timeouts, fallback intent, complexity prompts, untrusted header                         |
| `types.ts`                | All shared type definitions for plugin, config, intent, result, and turn shapes                           |
| `evolution-types.ts`      | Shared types for Self-Evolution pipeline — ReviewState, ReviewSnapshot, EvolutionFinding, EvolutionSource |
| `session-tracker.ts`      | Persist and clean up session data in `sessions/` JSON files                                               |
| `stats-aggregator.ts`     | Aggregate idempotent runtime usage statistics into `sessions/stats.json`                                  |
| `trigger-checker.ts`      | Detect six configurable Self-Evolution triggers from completed turns                                      |
| `review-subagent.ts`      | Build trigger-specific review prompts and run the tool-free review sub-agent                              |
| `review-queue.ts`         | Serialized promise queue for background evolution reviews                                                 |
| `backlog-writer.ts`       | Merge review findings atomically into `sessions/evolution.json`                                           |
| `evolution-backlog.ts`    | Validate/migrate backlog schema and provide atomic mutation primitives                                    |
| `backlog-cli.ts`          | List, target, validate, and optimistically complete pending backlog items                                 |
| `intent-validation.ts`    | Validate Intent Markdown structure, IDs, targets, and catalog loading                                     |
| `conversation-extract.ts` | Extract and truncate recent conversation turns for intent context                                         |
| `prompt.ts`               | **Core prompt & parser** — builds classification prompt, parses JSON result                               |
| `session.ts`              | Session eligibility guards (agent allow-list, chat type, internal run detection)                          |
| `config.ts`               | Zod schema validation with defaults and clamping for plugin configuration                                 |

Every `session_end` removes the ended session from tracker memory. Final lifecycle reasons (`new`, `reset`, `idle`, `daily`, `compaction`, and `deleted`) also delete that session's JSON; restart-oriented reasons preserve it for reload. Each `session_end` additionally removes top-level session JSON files whose modification time is strictly older than 14 days. Cleanup is fail-open and does not touch `stats.json`, `evolution.json`, transcripts, or other plugin data.

### Hook Execution Flow

```mermaid
graph LR
    A[before_prompt_build] --> B{session eligible?}
    B -->|yes| C{internal user turn?}
    B -->|no| Z[skip]
    C -->|yes| Z
    C -->|no| D[record input + conversation]
    D --> E[runIntentionSubagent]
    E --> F[parse intention result]
    F --> G{parsed?}
    G -->|yes| H[write session data]
    G -->|no| I[warn parse failed]
    H --> J[inject hint into prompt]
    I --> K[skip hint injection]
    J --> L[main agent generates]
    K --> L
```

### Session Data Structure

```typescript
interface SessionData {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  current: {
    input?: string;
    intent: {
      input?: RecentTurn[];
      result?: IntentionResult;
    };
    skillsUsed?: SkillRecord[];
    toolCalls?: Array<{
      name: string;
      params: Record<string, unknown>;
      result?: string;
      error?: string;
      durationMs?: number;
    }>;
    result?: string;
    error?: string;
    timestamps?: { start?: string; end?: string };
  };
  history?: (typeof current)[];
}
```

### Runtime Usage Statistics

After a tracked turn is persisted, `agent_end` synchronously updates `sessions/stats.json`. The aggregator is observation-only, fail-open, and idempotent by `sessionId + timestamps.start`; it never scans existing session JSON for backfill. Writes use a temporary file and atomic rename. Invalid or corrupt existing stats are preserved and the update is skipped.

The versioned stats document contains:

- `summary`: all-time turn, completion/error, skill/tool assistance, confidence, and `OTHER` totals and rates
- `intents`: per-intent share, confidence, complexity, assistance/error counts, and 7-day activity
- `skills`: actual usage, recommendations parsed from exact `skill: <name>` intent lines, adoption, 7-day activity, lifecycle, and review status
- `routing`: global and per-intent recommendation/adoption counts for turns and individual skill opportunities
- `tools`: calls, assisted turns, errors, average duration, and 7-day calls
- `daily`: UTC daily buckets retained for 90 days
- `processedEvents`: event IDs retained for 90 days to prevent duplicate `agent_end` counting

Rates use `0.0–1.0`. Skill lifecycle is `active` within 30 days, `stale` after 30 days, `archive` after 90 days, or `never_used` when recommended but never used. `needsReview` becomes true after at least five recommendations with adoption below `0.7`. All-time counters do not decrease when rolling data is pruned.

## Installation

This plugin is a workspace package inside the OpenClaw extensions directory. Build it with:

```bash
cd extensions/intention-hint
pnpm install
pnpm run build
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
          intentDeny: {
            main: ["MEMORY_*"], // deny matching intent IDs for main
            "research-*": ["CHAT", "TYPO"],
            "*": ["AGENT_DISPATCH"], // global deny for every agent
          },
          model: "google/gemini-3-flash", // lightweight scanner model
          modelFallback: "openai/gpt-5-mini",
          thinking: "medium", // intent classifier subagent thinking level
          allowedChatTypes: ["direct"],
          allowedChatIds: [],
          deniedChatIds: [],
          queryMode: "recent",
          contextWindow: {
            user: { turns: 5, chars: 500 },
            assistant: { turns: 3, chars: 300 },
          },
          timeoutMs: 3000,
          intentsDir: "./intents",
          complexityPrompts: {
            low: "Custom low-complexity prompt...",
            medium: "Custom medium-complexity prompt...",
            high: "Custom high-complexity prompt...",
          },
          evolution: {
            enabled: false,
            model: "google/gemini-3-flash",
            modelFallback: "openai/gpt-5-mini",
            thinking: "medium", // self-evolution review subagent thinking level
            timeoutMs: 30000,
            triggers: {
              skillCandidate: { enabled: true, toolCalls: 5 },
              processGap: { enabled: true, toolFailures: 2 },
              satisfactionCheck: { enabled: true, everyTurns: 10 },
              missingIntent: { enabled: true },
              weakIntent: { enabled: true, confidenceBelow: 0.5 },
              behaviorFix: {
                enabled: true,
                keywords: ["不對", "應該是", "wrong", "should be"],
              },
            },
          },
        },
      },
    },
  },
}
```

### Configuration Reference

| Option              | Type       | Default       | Description                                                                                           |
| ------------------- | ---------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `agents`            | `string[]` | `["*"]`       | Which agents trigger the plugin. Use `["*"]` for all agents.                                          |
| `intentDeny`        | `object`   | `{}`          | Per-agent deny list of intent IDs. Keys support `*` glob patterns.                                    |
| `model`             | `string`   | —             | Lightweight model for the intention scanner. Falls back to the agent's default if empty.              |
| `modelFallback`     | `string`   | —             | Fallback model when `config.model` cannot be resolved.                                                |
| `thinking`          | `string`   | `"medium"`    | Thinking level for the intent classifier subagent.                                                    |
| `allowedChatTypes`  | `string[]` | `["direct"]`  | Chat types (direct, group, channel) that allow intent analysis.                                       |
| `allowedChatIds`    | `string[]` | `[]`          | Allowlist of chat IDs. Empty means no allowlist restriction.                                          |
| `deniedChatIds`     | `string[]` | `[]`          | Blocklist of chat IDs. Plugin skips intent analysis for listed IDs.                                   |
| `queryMode`         | `string`   | `"recent"`    | Context window mode: `recent` (recent turns), `message` (latest message only), `full` (full history). |
| `contextWindow`     | `object`   | see below     | Turn/char limits for conversation extraction.                                                         |
| `timeoutMs`         | `number`   | `3000`        | Max wait time for subagent response. Clamped to 250–120000ms.                                         |
| `intentsDir`        | `string`   | `"./intents"` | Directory containing intent definition `.md` files with YAML frontmatter.                             |
| `complexityPrompts` | `object`   | built-in      | Custom classification prompt overrides per complexity level.                                          |
| `evolution`         | `object`   | disabled      | Post-turn trigger review configuration. Findings are stored in `sessions/evolution.json`.             |

`evolution.thinking` independently controls the Self-Evolution review
subagent's thinking level. Both thinking settings accept `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `adaptive`, or `max`.

### Intent Self-Evolution

Intent Self-Evolution is an opt-in observation and proposal pipeline. It does
not edit intent files automatically. When enabled, each completed tracked turn
is checked for six trigger types:

| Trigger              | Default condition                                      | Intent Markdown correction target                         |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `skill_candidate`    | Current turn has at least 5 tool calls                 | `Skills & Tools` and repeatable `Concrete Workflow` steps |
| `process_gap`        | Current turn has at least 2 tool errors                | Guidelines, tool examples, and recovery workflow          |
| `satisfaction_check` | Every 10th tracked turn                                | Boundaries, examples, Guidelines, or Response Strategy    |
| `missing_intent`     | Classified intent is `OTHER`                           | A narrowly scoped new intent draft                        |
| `weak_intent`        | Classification confidence is below 0.5                 | Frontmatter triggers/examples and boundary clarity        |
| `behavior_fix`       | Current input contains a configured correction keyword | Guidance or workflow that encodes the corrected behavior  |

All matching triggers are reviewed in one background, tool-free sub-agent run.
Each trigger receives a distinct review focus and correction goal, and may return
no finding. Valid findings are merged by pending `type + dedupeKey` into the
atomic, event-idempotent `sessions/evolution.json` backlog. Review failures are
fail-open and never block or alter the main reply.

The reviewer is intentionally scoped to improving `intents/*.md`, following the
bundled `intention-hint` Skill rules. It receives the full matched intent definition and
a compact frontmatter catalog for collision checks, plus the current turn and up
to nine previous tracked turns with truncated content. Depending on the trigger,
it proposes a new intent draft or targeted changes to frontmatter, Guidelines,
Skills & Tools, Response Strategy, or Concrete Workflow. It never proposes
changes to skills, tools, AGENTS.md, SOUL.md, or other production files.

`sessions/evolution.json` is protected like `sessions/stats.json`: it is not
loaded as session state and is never removed by session lifecycle or 14-day
retention cleanup. Schema v2 findings include `operation` (`create`, `refine`,
`split`, or `merge`) and all affected `targetIntentIds`. Existing schema v1
items migrate to `operation: "unknown"` and empty targets until they can be
grounded safely.

### Intention-Hint Backlog Mode

The bundled `intention-hint` Skill has an explicit-only `backlog` mode that
processes exactly one pending finding per invocation. The mode treats current
Intent Markdown as the source of truth, backs up affected files under `/tmp`,
validates the result, and only then marks the item `processed`. Validation or
optimistic-concurrency failures restore the pre-processing files and leave the
item `pending`. `split`, `merge`, and deletions require user confirmation. The
mode never commits, pushes, dismisses items, or edits the backlog JSON directly.
Detailed transactional steps live in
`skills/intention-hint/references/process-backlog.md`.

Backlog CLI:

```bash
pnpm run backlog -- list --json
pnpm run backlog -- show --id IMP-...
pnpm run backlog -- set-target --id IMP-... --operation refine --target-intent PRODUCTIVITY
pnpm run backlog -- validate-intents --id PRODUCTIVITY
pnpm run backlog -- mark-processed --id IMP-... --expected-updated-at <timestamp>
```

All mutations validate schema v2 and use a same-directory temporary file plus
atomic rename. `mark-processed` rejects a stale item `updatedAt`.

## Key Design Decisions

### Pure Function Prompt Building

`buildIntentionPrompt()` takes no API dependency. Timezone resolution and time formatting happen in `subagent.ts` via `resolveCurrentTime()`. The pure function receives `currentTime?: string` and injects it directly into the prompt.

### JSON Output Format

The classification sub-agent returns JSON:

```json
{
  "intent": "MEMORY_LOOKUP (Memory Lookup)",
  "reason": "User asked to recall previous conversation",
  "goal": "Retrieve memory of past discussion",
  "confidence": 0.9,
  "complexity": "medium",
  "suggestion": "Only present when confidence < 0.8"
}
```

- `intent` format: `<id> (<name>)` e.g. `MEMORY_LOOKUP (Memory Lookup)` or `OTHER (Fallback)`
- Parser extracts ID via regex `^([A-Za-z0-9_-]+)\s*\(` and normalizes case-insensitively against valid intent IDs
- Fallbacks to `OTHER` if parsed intent not found in catalog

### Intent Categories

The classification prompt auto-derives categories from intent ID prefixes:

- **2+ intents with same prefix** → `<PREFIX>\_\*: <id1>, <id2>, ...)
- **Standalone intents** → `STANDALONE: <id1>, <id2>, (...)

Example:

```
<intent_categories>
The following categories group intents by their ID prefix:
- MEMORY_*: MEMORY_COMPARE, MEMORY_EMOTION, MEMORY_LOOKUP, MEMORY_META, MEMORY_RECENT, MEMORY_TIMELINE
- RESEARCH_*: RESEARCH_GENERAL, RESEARCH_GOOGLE_DEV, RESEARCH_OPENSOURCE, RESEARCH_REALTIME
- OTHER_*: CHAT, HUMANITIES, PRODUCTIVITY, SUMMARIZATION, TYPO, OTHER
- STANDALONE: ANI_VISUAL, IMAGE_ANALYSIS, IMAGE_GENERATION
</intent_categories>
```

### Time Injection

`<current_time>` block is injected into the classification prompt using the user's configured timezone:

- Resolves timezone via `api.runtime.config?.current?.()?.agents?.defaults?.userTimezone`
- Fallbacks to `Intl.DateTimeFormat().resolvedOptions().timeZone` then `UTC`
- Format: `YYYY-MM-DDTHH:mm:ss (timezone: Asia/Taipei)` — **local time**, not UTC

### Conversation Handling

- `<conversation>` block is **omitted entirely** when conversation is empty or undefined
- Each turn wraps its text in `<message>` inside `<turn role="...">`
- Matching historical user turns include `<historical_intent>` with only the prior `intent` and `goal`; assistant, unmatched, and latest user turns do not
- Historical records are matched by normalized user-message text, with duplicate messages paired newest-first
- Classification rules use historical goals as context while requiring fresh classification on topic switches
- Extracted via `conversation-extract.ts` with configurable turn/char limits from `contextWindow` config

### Internal User Turns

OpenClaw-generated inter-session turns, such as subagent completion announcements
and `sessions_send` messages, are not direct end-user intent. The
`before_prompt_build` hook skips them before refreshing config, running the intent
scanner, recording intent data, or returning `prependContext`.

Detection uses the following priority:

1. Structured `message.provenance.kind === "inter_session"` on the latest matching
   user message.
2. OpenClaw's `[Inter-session message] ... isUser=false` marker when provenance is
   unavailable.
3. A complete protected OpenClaw runtime-context envelope containing
   `[Internal task completion event]`.

An explicit `external_user` or `internal_system` provenance is not skipped. A
standalone internal-context delimiter or an incomplete protected envelope is also
not enough to classify a normal user message as internal.

Inter-session user turns and their corresponding assistant replies are excluded
from extracted conversation history, so later direct-user intent scans are not
influenced by internal task-completion traffic.

### Output Parsing

`parseIntentionResult()` handles:

- Plain JSON (no markers)
- JSON wrapped in \`\`\`json ... \`\`\` code blocks (tolerant stripping)
- JSON wrapped in stray \`\`\` markers
- Required field validation (`intent`, `reason`, `goal`, `confidence`, `complexity`)
- Confidence range validation (0.0–1.0)
- Complexity enum validation (`low`, `medium`, `high`)
- Optional `suggestion` field (only included when present in JSON)
- Graceful fallback to `undefined` on any parse failure

### Testing

```bash
pnpm test          # typecheck + vitest run
pnpm run typecheck # tsc --noEmit
pnpm run test:unit # vitest run
```

The test suites cover:

- `buildIntentionPrompt()` prompt structure
- `parseIntentionResult()` JSON parsing (plain, code blocks, malformed, missing fields)
- Intent ID extraction and normalization from `<id> (<name>)` format
- Timezone-aware time formatting
- Config resolution and clamping
- Session tracker persistence
- Intent filtering via deny patterns
- Internal/inter-session turn detection and conversation-history filtering
- Per-turn historical intent matching, duplicate handling, and prompt injection
- Six Self-Evolution triggers, thresholds, and multi-trigger turns
- Intention-hint Skill review prompts, response parsing, and tool-free reviewer runs
- Serialized background reviews and atomic, idempotent evolution backlog writes
- Schema v1-to-v2 migration, structured finding targets, and backlog CLI concurrency checks
- Intent Markdown structure/catalog validation and explicit-only intention-hint backlog mode
- Protection of `sessions/evolution.json` from session loading and retention cleanup
