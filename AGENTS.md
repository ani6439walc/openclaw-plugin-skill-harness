# Agent Guide: Skill Harness

This repository is an OpenClaw plugin. It appends fixed skill-discovery system context to authorized main-agent turns, classifies eligible user intent, prepends dynamic routing hints through `before_prompt_build`, records per-session runtime data, aggregates usage stats, and optionally applies direct Review intent edits.

Use this file as the working contract for coding agents. The README explains the product in more detail; this guide explains how to change the code safely.

## How Coding Agents Should Use This Guide

Treat this file as the source of truth for repository operations, not as product documentation. For product behavior, read `README.md`; for implementation details, inspect the source before editing.

Work in this order:

1. Identify the change type: hook behavior, prompt/parser behavior, config/schema, runtime data path, intent asset, Intent Review/logging, docs-only, or package/SDK integration.
2. Read the source map below and inspect the owning module plus its colocated tests before changing anything.
3. Make the smallest change that satisfies the request. Do not refactor adjacent modules unless the current change requires it.
4. Update the focused tests and synchronized docs/manifest entries in the same change.
5. Run the verification tier that matches the change, then inspect `git diff` before handoff.

Use this routing table for common tasks:

| Task type                                       | Start with                                                                                                                 | Usually update                                                                                          | Minimum verification                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Hook routing, fast paths, session lifecycle     | `src/hooks/index.ts`, `src/session/guards.ts`, `src/classification/conversation.ts`                                        | `src/hooks/index.test.ts`, `src/classification/conversation.test.ts`                                    | `pnpm run typecheck`, `pnpm run test`                                                             |
| Prompt output, parsing, compact-model contracts | `src/classification/prompts.ts`, `src/classification/subagent.ts`                                                          | `src/classification/prompts.test.ts`, `src/classification/subagent.test.ts`, README if behavior changes | `pnpm run typecheck`, `pnpm run test`                                                             |
| Config or manifest-visible option               | `src/config.ts`, `src/types.ts`, `openclaw.plugin.json`                                                                    | `src/config.test.ts`, README configuration table                                                        | `pnpm run typecheck`, `pnpm run test`                                                             |
| Runtime data layout or first-install seeding    | `src/plugin.ts`, `src/file-utils.ts`, `src/intents/catalog.ts`                                                             | `src/plugin.test.ts`, `src/file-utils.test.ts`, README/AGENTS path docs                                 | `pnpm run typecheck`, `pnpm run test`, `pnpm run build` if CLI/package output depends on it       |
| Stats or skill recommendation accounting        | `src/stats/aggregator.ts`, `src/intents/skill-references.ts`                                                               | `src/stats/aggregator.test.ts`, `src/intents/skill-references.test.ts`, README stats docs               | `pnpm run typecheck`, `pnpm run test`                                                             |
| Intent Review trigger/log behavior              | `src/review/triggers.ts`, `src/review/subagent.ts`, `src/review/log-writer.ts`, `src/review/log.ts`, `src/review/queue.ts` | Matching `*.test.ts`, README Intent Review docs                                                         | `pnpm run typecheck`, `pnpm run test`, `pnpm run build` for CLI changes                           |
| Package/build output hygiene                    | `package.json`, `tsconfig.json`, `dist/` after build                                                                       | README Current Status / package notes when publish contents change                                      | `pnpm run build`, `pnpm pack --dry-run`, `pnpm run typecheck`, `pnpm run test`                    |
| Bundled first-install intent examples           | `skills/skill-harness/assets/*.md`                                                                                         | `src/intents/validation.test.ts` fixtures/expectations if needed                                        | `pnpm run test`                                                                                   |
| Documentation-only sync                         | Source files that prove the claim                                                                                          | `README.md`, `AGENTS.md`, or `skills/skill-harness/**`                                                  | `pnpm run format`; run `pnpm run typecheck` and `pnpm run test` when docs assert current behavior |

## First Checks

Before editing, inspect the current state:

```bash
git status --short
pnpm run typecheck
pnpm run test
```

If tests already fail, capture the failure before changing code. Do not hide pre-existing failures inside unrelated edits.

For read-only inspection or docs-only updates, still run `git status --short` first and inspect the exact source files behind any claim you plan to document.

## Commands

```bash
pnpm run typecheck          # TypeScript, no emit
pnpm run test               # Full Vitest suite
pnpm run build              # Clean and compile dist/
pnpm run format             # Prettier for md/json/ts files
```

Run `pnpm run typecheck` and `pnpm run test` before handing off code changes. Run `pnpm run build` when changing package metadata, SDK imports, or anything that depends on emitted `dist/` output. The build script must remove `dist/` before `tsc`; package hygiene checks should verify `pnpm pack --dry-run` does not include stale renamed artifacts such as `dist/src/classification/embedded-agent.*` or root tooling output such as `dist/vitest.config.*`.

## Runtime Data Layout

Keep package files and runtime data separate.

Package root:

- Resolved by `resolvePackageRoot()` in `src/file-utils.ts`.
- Contains source code, plugin skills under `skills/`, skill asset examples, and metadata.
- Does not contain the active writable intent catalog.

Runtime data root:

- Resolved at plugin registration with `api.runtime.state.resolveStateDir(process.env)`, then `resolvePluginDataRoot(stateDir, "skill-harness")`.
- With OpenClaw's default local state directory, the normal path is `~/.openclaw/plugins/skill-harness`.
- Active runtime files live here:
  - `intents/*.md`
  - `sessions/<sessionId>.json`
  - `stats.json`
  - `review.json`

Rules:

- The active intent catalog always loads from `intentsPath(dataRoot)`; with the default local state directory this is `~/.openclaw/plugins/skill-harness/intents`.
- `stats.json` and `review.json` are root-level runtime files. They must not be placed under `sessions/`.
- Startup initialization may copy example intent files from `skills/skill-harness/assets/*.md` when the runtime `intents/` directory is absent or contains no Markdown files.
- Startup initialization must not overwrite existing runtime intent files.

## Skill visibility policy

`skill_list`, `skill_search`, and `skill_view` deliberately inventory every skill in the invoking agent's resolved roots. The invoking agent ID selects its workspace roots, but the indexer must not apply OpenClaw's `agents.defaults.skills` or `agents.list[].skills` allowlists. This is an intentional product boundary: these tools expose the root inventory, subject only to source precedence and disabled bundled skill entries. Do not add `resolveAgentSkillsFilter()` or equivalent filtering unless Baby explicitly changes this policy; that change requires focused tests plus README and migration documentation.

The indexer uses `skills.load.watchDebounceMs` as its cache TTL only when `skills.load.watch` is `true`; otherwise it retains the 60-second default. This is polling, not a filesystem watcher. Keep the TTL in the cache key so live configuration changes cannot reuse indexes created under a different refresh interval.

## Source Map

Use the existing module boundaries:

- `src/plugin.ts`: assembly layer. Resolve config and runtime data root, initialize runtime directories, seed a missing or Markdown-empty runtime intent catalog from skill assets, instantiate runtime-scoped services, and register OpenClaw hooks.
- `src/hooks/index.ts`: hook behavior for prompt building, tracking, stats updates, review queueing, and cleanup. Keep OpenClaw event logic here, not in `plugin.ts`.
- `src/hooks/system-context.ts`: fixed `appendSystemContext` skill-discovery contract. Keep runtime skill names, paths, intent results, and generated hints out of this string.
- `src/config.ts`: Zod-backed config parsing, defaults, and clamps.
- `src/file-utils.ts`: shared path helpers and atomic filesystem primitives.
- `src/intents/catalog.ts`: runtime intent catalog loading.
- `src/session/tracker.ts`: session JSON state under `dataRoot/sessions`.
- `src/stats/aggregator.ts`: usage aggregation into `dataRoot/stats.json`.
- `src/review/log-writer.ts`: direct Intent Review outcomes and trigger keyword updates into `dataRoot/review.json`.
- `src/review/log.ts`: review log schema validation/migration and root trigger keyword state. Legacy `items` are dropped during migration; there is no tool/command action surface.
- `src/subagent-runtime.ts`: shared embedded subagent run defaults and error-payload extraction helpers used by classification and review subagents.
- `src/classification/prompts.ts`, `src/classification/subagent.ts`, `src/classification/conversation.ts`, `src/review/subagent.ts`, `src/review/triggers.ts`: classification and review logic.
- `src/intents/skill-references.ts`: resolves frontmatter `skills[]` dependencies into available `SKILL.md` metadata for instruction writing and Intent Review. Intent prompt/body text is not scanned for skill references.
- `src/review/queue.ts`: serializes background Intent Review work so hook handling stays fail-open.
- `src/review/trigger-keywords.ts`: default and normalized runtime keyword sets for `successful-pattern`, `behavior-fix`, and `entity-context` triggers.
- `src/session/guards.ts`: session eligibility guards.
- `src/*.test.ts`: tests are colocated with the module they protect.

Conversation prompts are intentionally structured as XML-like blocks. Keep recent-turn context inside `<conversation_context>` and split historical topics with `<topic_segment>` and `<topic_boundary>`. Prompt-facing topic checker output requires bounded `basis`, `reason`, continuity `confidence`, keywords, topic, domain, and downstream-task complexity; it must not ask the model for `changed`. Host parsing derives `changed` exclusively from `reason`. Same-topic inheritance requires confidence at or above `0.8` plus historical intent data, keeps only the prior intent and intent confidence, and refreshes topic, domain, keywords, and complexity from the latest topic check. Uncertain same-topic results must reach the full classifier rather than keyword similarity. Persisted intent results may still store `topicChangeReason`; do not reintroduce separate `intentChange` state.

Prompt-build authorization has two layers. First resolve the canonical agent/session and enforce configured agent, chat-type, and chat-ID scope. Then exclude Skill Harness embedded-agent sessions, generic/Review subagents, dreaming sessions, and active-memory sessions from all injection. Authorized internal/inter-session, non-user, and trigger-omitted turns receive fixed `appendSystemContext` only; eligible external-user turns may additionally receive dynamic `prependContext`. Once static authorization succeeds, dynamic fallbacks and failures must preserve the fixed system context.

Eligible dynamic routing must emit one parent `pipeline:started` event before any exact or model-backed phase and exactly one terminal `pipeline:completed` or `pipeline:failed` event after no further phase can run. Terminal parent events carry producer-measured `durationMs`; phase events remain nested progress details. Do not make consumers infer overall completion from `topic-triage`, `intent-classify`, or `hint-generate` completion.

Do not repeat fixed mandatory/tool guidance inside dynamic `<skill_harness_plugin>` output. Dynamic context contains only its context policy, `domain_skill_candidates`, and optional `## Instruction Hint`. The `before_prompt_build` hook does not expose final per-turn tool names; normal main-agent availability of registered Skill Harness tools is a deployment contract, while restricted runs must obey their narrower tool allowlist.

## Coding Rules

- Ground implementation in the current source. Do not invent OpenClaw SDK APIs, hook payload fields, config names, or intent frontmatter fields.
- Use ESM imports with `.js` suffix for local TypeScript modules.
- Prefer `interface` for object shapes and `type` for unions or complex aliases.
- Use `import type` for type-only imports.
- Avoid `any`; use `unknown` with narrowing when input is untrusted.
- Keep code fail-open for plugin runtime paths. Log non-fatal problems with `logger.warn()` and avoid blocking the user flow for stats, seed copying, cleanup, or review failures.
- Keep `src/plugin.ts` thin. If behavior grows, put it in a focused module or existing service and inject it through `createHookHandlers()` when tests need isolation.
- Do not introduce broad abstractions just to reduce a few repeated lines. This plugin favors explicit lifecycle behavior over framework-style indirection.
- Preserve compact helper-model contracts: prompts should end with short JSON/output reminders, use explicit enum values, and keep dynamic user/conversation text inside XML-like blocks. Prefer deterministic section joining for helper prompts; do not add runtime Markdown formatters that can rewrite dynamic evidence or add runtime dependencies.
- Prefer deterministic checks before LLM work. Exact fastpath, same-topic inheritance, low-thinking behavior, confidence guards, and deny lists should remain cheap and local where possible.
- Keep high-risk operations conservative. Deploy/delete/secret/production-like wording should not be routed through a weak deterministic shortcut without an explicit guard and tests.

## File I/O Rules

All JSON reads and writes should go through `src/file-utils.ts` unless a test is explicitly arranging fixtures.

Use:

```typescript
import {
  fileExists,
  readJsonFile,
  safeWriteJson,
  writeJsonAtomic,
} from "./file-utils.js";
```

Rules:

- Use `writeJsonAtomic()` for synchronous durable JSON writes.
- Use `safeWriteJson()` for fail-open writes that should log instead of throw.
- Use `readJsonFile<T>()` for JSON reads.
- Do not add production code that combines `fs.readFileSync` with `JSON.parse`, or `fs.writeFileSync` with `JSON.stringify`, when the file-utils helpers fit.
- Session cleanup may delete expired `sessions/*.json` through the 14-day retention sweep only. `session_end` should preserve the ended session JSON for audit/reload; it must not delete current session files or touch root-level `stats.json`, root-level `review.json`, intent files, skills, transcripts, or package files.

## Testing Expectations

Add or update focused tests with the code change.

Typical mapping:

- Config schema changes: `src/config.test.ts`.
- Runtime data paths or startup seeding: `src/file-utils.test.ts` and `src/plugin.test.ts`.
- Hook behavior: `src/hooks/index.test.ts`.
- Intent loading or validation: `src/intents/catalog.ts` consumers and `src/intents/validation.test.ts`.
- Prompt/parser behavior: `src/classification/prompts.test.ts`.
- Conversation extraction/history matching: `src/classification/conversation.test.ts`.
- Session persistence and cleanup: `src/session/tracker.test.ts`.
- Stats behavior: `src/stats/aggregator.test.ts`.
- Intent skill-reference resolution: `src/intents/skill-references.test.ts`.
- Review trigger keyword normalization: `src/review/trigger-keywords.test.ts`.
- Intent Review writes and log migration: `src/review/log-writer.test.ts` and `src/review/log.test.ts`.
- Review tool/command removal behavior: `src/plugin.test.ts` and `manifest.test.ts`.

When changing runtime paths, include tests for both the desired new location and non-overwrite startup behavior.

## Intent Files

Runtime editable intents live under `intentsPath(dataRoot)`; with the default local state directory this is `~/.openclaw/plugins/skill-harness/intents/*.md`. First-install examples live in `skills/skill-harness/assets/*.md` and are copied only when the runtime intent directory is absent or contains no Markdown files.

When changing first-install examples, edit `skills/skill-harness/assets/*.md` and run validation through the test suite. When changing a live local intent for the user's current OpenClaw environment, edit the runtime intent directory instead.

Intent markdown must keep valid YAML frontmatter and the expected sections used by `src/intents/validation.ts` and the skill-harness skill references.

## Review Workflow

Review no longer creates pending items or exposes a manual backlog tool or slash command. This is a breaking workflow change and must be highlighted in release notes. Background reviews are serialized through `src/review/queue.ts`, stage runtime intent edits in an isolated temporary workspace, validate changed/targeted intents, then reconcile validated creates, changes, and deletions back to `intentsPath(dataRoot)`. They record compact outcomes under `processedEvents` in `reviewLogPath(dataRoot)`; with the default local state directory that is `~/.openclaw/plugins/skill-harness/review.json`.

Do not edit `reviewLogPath(dataRoot)` manually for normal work. It stores schema v4 `triggerKeywords` plus `processedEvents`; legacy `items` are discarded during migration.

For manual runtime intent edits, read current runtime intent Markdown, make the smallest grounded change, then run at least:

```bash
pnpm test src/intents/validation.test.ts
pnpm run test
pnpm run build
```

For split, merge, rename, deletion, or any broad intent-boundary change, show the planned file operations and get explicit confirmation first.

## OpenClaw SDK Usage

- Use `api.pluginConfig` plus `resolveLivePluginConfigObject()` for live plugin config.
- Use `api.runtime.state.resolveStateDir(process.env)` for OpenClaw state directory resolution.
- Use `api.runtime.agent.runEmbeddedAgent()` for embedded review/classifier runs; do not use legacy PI aliases.
- Tool-free classifier runs may use `modelRun=false`, `promptMode="none"`, and `toolsAllow: []`. When an embedded workflow needs tools, use `modelRun=false`, `promptMode="minimal"`, `disableTools=false`, and an exact allowlist: the instruction writer uses `skill_view` and `skill_search`; Intent Review uses `read`, `write`, and `apply_patch`, adding `skill_view` only for skill-candidate reviews. The instruction writer must return raw JSON with exactly `instruction_hint` and the intentionally spelled `additional_candinate_skills`; resolved additional names are deduplicated into the main agent's injected skill candidates. Do not use `promptMode="none"` for a run that needs tools because it skips tool construction.
- If an SDK import path is uncertain or looks deprecated, verify it against the installed `openclaw` package before coding from memory.
- Keep `zod` imports direct from `"zod"`; this plugin owns `zod` as a runtime dependency.

## Documentation Updates

Update documentation when behavior or public configuration changes:

- `README.md` for architecture, runtime behavior, configuration, and user-facing workflows.
- `openclaw.plugin.json` for manifest-visible config descriptions/defaults.
- `AGENTS.md` for coding-agent rules and known gotchas.
- `skills/skill-harness/**` when an agent workflow or path changes.

Search for stale names and paths before finishing. For runtime layout changes, at minimum search for:

```bash
rg "sessions/(stats|review)\\.json|extensions/skill-harness/intents|~/.openclaw/extensions/skill-harness/intents|packageRoot.*intents|migrateLegacy|seedBundled"
```

## Finish Checklist

Before final handoff:

- `git diff` contains only intentional changes.
- `pnpm run typecheck` passes.
- `pnpm run test` passes.
- `pnpm run build` passes when emitted CLI/package behavior is involved.
- Docs and manifest are synchronized with source behavior.
- No unrelated user changes were reverted.
