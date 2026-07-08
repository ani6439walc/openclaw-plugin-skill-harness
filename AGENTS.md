# Agent Guide: Skill Harness

This repository is an OpenClaw plugin. It classifies the user's intent before the main reply, injects a routing hint through `before_prompt_build`, records per-session runtime data, aggregates usage stats, and optionally applies direct Review intent edits.

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

| Task type                                       | Start with                                                                                                                 | Usually update                                                                                                | Minimum verification                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Hook routing, fast paths, session lifecycle     | `src/hooks/index.ts`, `src/session/guards.ts`, `src/classification/conversation.ts`                                        | `src/hooks/index.test.ts`, `src/classification/conversation.test.ts`                                          | `pnpm run typecheck`, `pnpm run test`                                                             |
| Prompt output, parsing, compact-model contracts | `src/classification/prompts.ts`, `src/classification/embedded-agent.ts`                                                    | `src/classification/prompts.test.ts`, `src/classification/embedded-agent.test.ts`, README if behavior changes | `pnpm run typecheck`, `pnpm run test`                                                             |
| Config or manifest-visible option               | `src/config.ts`, `src/types.ts`, `openclaw.plugin.json`                                                                    | `src/config.test.ts`, README configuration table                                                              | `pnpm run typecheck`, `pnpm run test`                                                             |
| Runtime data layout or first-install seeding    | `src/plugin.ts`, `src/file-utils.ts`, `src/intents/catalog.ts`                                                             | `src/plugin.test.ts`, `src/file-utils.test.ts`, README/AGENTS path docs                                       | `pnpm run typecheck`, `pnpm run test`, `pnpm run build` if CLI/package output depends on it       |
| Stats or skill recommendation accounting        | `src/stats/aggregator.ts`, `src/intents/skill-references.ts`                                                               | `src/stats/aggregator.test.ts`, `src/intents/skill-references.test.ts`, README stats docs                     | `pnpm run typecheck`, `pnpm run test`                                                             |
| Intent Review trigger/log behavior              | `src/review/triggers.ts`, `src/review/subagent.ts`, `src/review/log-writer.ts`, `src/review/log.ts`, `src/review/queue.ts` | Matching `*.test.ts`, README Intent Review docs                                                               | `pnpm run typecheck`, `pnpm run test`, `pnpm run build` for CLI changes                           |
| Bundled first-install intent examples           | `skills/skill-harness/assets/*.md`                                                                                         | `src/intents/validation.test.ts` fixtures/expectations if needed                                              | `pnpm run test`                                                                                   |
| Documentation-only sync                         | Source files that prove the claim                                                                                          | `README.md`, `AGENTS.md`, or `skills/skill-harness/**`                                                        | `pnpm run format`; run `pnpm run typecheck` and `pnpm run test` when docs assert current behavior |

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
pnpm run build              # Compile to dist/
pnpm run format             # Prettier for md/json/ts files
```

Run `pnpm run typecheck` and `pnpm run test` before handing off code changes. Run `pnpm run build` when changing package metadata, SDK imports, or anything that depends on emitted `dist/` output.

## Runtime Data Layout

Keep package files and runtime data separate.

Package root:

- Resolved by `resolvePackageRoot()` in `src/file-utils.ts`.
- Contains source code, plugin skills under `skills/`, skill asset examples, and metadata.
- Does not contain the active writable intent catalog.

Runtime data root:

- Resolved at plugin registration with `api.runtime.state.resolveStateDir(process.env)`, then `resolvePluginDataRoot(stateDir, "skill-harness")`.
- Normal local path: `~/.openclaw/plugins/skill-harness`.
- Active runtime files live here:
  - `intents/*.md`
  - `sessions/<sessionId>.json`
  - `stats.json`
  - `review.json`

Rules:

- The active intent catalog always loads from `~/.openclaw/plugins/skill-harness/intents`.
- `stats.json` and `review.json` are root-level runtime files. They must not be placed under `sessions/`.
- Startup initialization may copy example intent files from `skills/skill-harness/assets/*.md` into an absent or empty runtime `intents/` directory.
- Startup initialization must not overwrite existing runtime intent files.

## Source Map

Use the existing module boundaries:

- `src/plugin.ts`: assembly layer. Resolve config, resolve runtime data root, initialize runtime directories, seed empty runtime intents from skill assets, instantiate runtime-scoped services, and register OpenClaw hooks.
- `src/hooks/index.ts`: hook behavior for prompt building, tracking, stats updates, review queueing, and cleanup. Keep OpenClaw event logic here, not in `plugin.ts`.
- `src/config.ts`: Zod-backed config parsing, defaults, and clamps.
- `src/file-utils.ts`: shared path helpers and atomic filesystem primitives.
- `src/intents/catalog.ts`: runtime intent catalog loading.
- `src/session/tracker.ts`: session JSON state under `dataRoot/sessions`.
- `src/stats/aggregator.ts`: usage aggregation into `dataRoot/stats.json`.
- `src/review/log-writer.ts`: direct Intent Review outcomes and trigger keyword updates into `dataRoot/review.json`.
- `src/review/log.ts`: review log schema validation/migration and root trigger keyword state. Legacy `items` are dropped during migration; there is no tool/command action surface.
- `src/classification/prompts.ts`, `src/classification/embedded-agent.ts`, `src/classification/conversation.ts`, `src/review/subagent.ts`, `src/review/triggers.ts`: classification and review logic.
- `src/intents/skill-references.ts`: resolves `skill: <name>` references in intent Markdown into available `SKILL.md` metadata for instruction writing and Intent Review.
- `src/review/queue.ts`: serializes background Intent Review work so hook handling stays fail-open.
- `src/review/trigger-keywords.ts`: default and normalized runtime keyword sets for `successful-pattern`, `behavior-fix`, and `entity-context` triggers.
- `src/session/guards.ts`: session eligibility guards.
- `src/*.test.ts`: tests are colocated with the module they protect.

Conversation prompts are intentionally structured as XML-like blocks. Keep recent-turn context inside `<conversation_context>`, split historical topics with `<topic_segment>` and `<topic_boundary>`, and use compact topic-switch metadata names (`changed` and `reason`) in prompt-facing topic checker output. Persisted intent results may still store `topicChangeReason`; do not reintroduce separate `intentChange` state.

## Coding Rules

- Ground implementation in the current source. Do not invent OpenClaw SDK APIs, hook payload fields, config names, or intent frontmatter fields.
- Use ESM imports with `.js` suffix for local TypeScript modules.
- Prefer `interface` for object shapes and `type` for unions or complex aliases.
- Use `import type` for type-only imports.
- Avoid `any`; use `unknown` with narrowing when input is untrusted.
- Keep code fail-open for plugin runtime paths. Log non-fatal problems with `logger.warn()` and avoid blocking the user flow for stats, seed copying, cleanup, or review failures.
- Keep `src/plugin.ts` thin. If behavior grows, put it in a focused module or existing service and inject it through `createHookHandlers()` when tests need isolation.
- Do not introduce broad abstractions just to reduce a few repeated lines. This plugin favors explicit lifecycle behavior over framework-style indirection.
- Preserve compact helper-model contracts: prompts should end with short JSON/output reminders, use explicit enum values, and keep dynamic user/conversation text inside XML-like blocks.
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

Runtime editable intents live in `~/.openclaw/plugins/skill-harness/intents/*.md`. First-install examples live in `skills/skill-harness/assets/*.md` and are copied only when the runtime intent directory is absent or empty.

When changing first-install examples, edit `skills/skill-harness/assets/*.md` and run validation through the test suite. When changing a live local intent for the user's current OpenClaw environment, edit the runtime intent directory instead.

Intent markdown must keep valid YAML frontmatter and the expected sections used by `src/intents/validation.ts` and the skill-harness skill references.

## Review Workflow

Review no longer creates pending items or exposes a manual backlog tool or slash command. This is a breaking workflow change and must be highlighted in release notes. Background reviews are serialized through `src/review/queue.ts`, stage runtime intent edits in an isolated temporary workspace, validate changed/targeted intents, copy validated target edits back to `~/.openclaw/plugins/skill-harness/intents/*.md`, and record compact outcomes under `processedEvents` in `~/.openclaw/plugins/skill-harness/review.json`.

Do not edit `~/.openclaw/plugins/skill-harness/review.json` manually for normal work. It stores schema v4 `triggerKeywords` plus `processedEvents`; legacy `items` are discarded during migration.

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
- When an embedded run needs the core `read` tool, keep `modelRun=false`, use `promptMode="minimal"`, set `disableTools=false`, and narrow `toolsAllow` to `["read"]`. Do not use `promptMode="none"`; OpenClaw treats that as a raw model run and skips tool construction.
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
