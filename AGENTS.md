# Agent Guide: Intention Hint

This repository is an OpenClaw plugin. It classifies the user's intent before the main reply, injects a routing hint through `before_prompt_build`, records per-session runtime data, aggregates usage stats, and optionally writes evolution backlog findings.

Use this file as the working contract for coding agents. The README explains the product in more detail; this guide explains how to change the code safely.

## How Coding Agents Should Use This Guide

Treat this file as the source of truth for repository operations, not as product documentation. For product behavior, read `README.md`; for implementation details, inspect the source before editing.

Work in this order:

1. Identify the change type: hook behavior, prompt/parser behavior, config/schema, runtime data path, intent asset, Evolution backlog, docs-only, or package/SDK integration.
2. Read the source map below and inspect the owning module plus its colocated tests before changing anything.
3. Make the smallest change that satisfies the request. Do not refactor adjacent modules unless the current change requires it.
4. Update the focused tests and synchronized docs/manifest entries in the same change.
5. Run the verification tier that matches the change, then inspect `git diff` before handoff.

Use this routing table for common tasks:

| Task type                                       | Start with                                                                                              | Usually update                                                                               | Minimum verification                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Hook routing, fast paths, session lifecycle     | `src/hooks.ts`, `src/session.ts`, `src/conversation-extract.ts`                                         | `src/hooks.test.ts`, `src/conversation-extract.test.ts`                                      | `pnpm run typecheck`, `pnpm run test`                                                             |
| Prompt output, parsing, compact-model contracts | `src/prompt.ts`, `src/subagent.ts`                                                                      | `src/prompt.test.ts`, `src/subagent.test.ts`, README if behavior changes                     | `pnpm run typecheck`, `pnpm run test`                                                             |
| Config or manifest-visible option               | `src/config.ts`, `src/types.ts`, `openclaw.plugin.json`                                                 | `src/config.test.ts`, README configuration table                                             | `pnpm run typecheck`, `pnpm run test`                                                             |
| Runtime data layout or first-install seeding    | `src/plugin.ts`, `src/file-utils.ts`, `src/intent-loader.ts`                                            | `src/plugin.test.ts`, `src/file-utils.test.ts`, README/AGENTS path docs                      | `pnpm run typecheck`, `pnpm run test`, `pnpm run build` if CLI/package output depends on it       |
| Stats or skill recommendation accounting        | `src/stats-aggregator.ts`, `src/skill-catalog.ts`                                                       | `src/stats-aggregator.test.ts`, `src/skill-catalog.test.ts`, README stats docs               | `pnpm run typecheck`, `pnpm run test`                                                             |
| Evolution trigger/review/backlog behavior       | `src/trigger-checker.ts`, `src/review-subagent.ts`, `src/backlog-writer.ts`, `src/evolution-backlog.ts` | Matching `*.test.ts`, `skills/intention-hint/references/evolution.md`, README Evolution docs | `pnpm run typecheck`, `pnpm run test`, `pnpm run build` for CLI changes                           |
| Bundled first-install intent examples           | `skills/intention-hint/assets/*.md`                                                                     | `src/intent-validation.test.ts` fixtures/expectations if needed                              | `pnpm run test`                                                                                   |
| Documentation-only sync                         | Source files that prove the claim                                                                       | `README.md`, `AGENTS.md`, or `skills/intention-hint/**`                                      | `pnpm run format`; run `pnpm run typecheck` and `pnpm run test` when docs assert current behavior |

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

- Resolved at plugin registration with `api.runtime.state.resolveStateDir(process.env)`, then `resolvePluginDataRoot(stateDir, "intention-hint")`.
- Normal local path: `~/.openclaw/plugins/intention-hint`.
- Active runtime files live here:
  - `intents/*.md`
  - `sessions/<sessionId>.json`
  - `stats.json`
  - `evolution.json`

Rules:

- The active intent catalog always loads from `~/.openclaw/plugins/intention-hint/intents`.
- `stats.json` and `evolution.json` are root-level runtime files. They must not be placed under `sessions/`.
- Startup initialization may copy example intent files from `skills/intention-hint/assets/*.md` into an absent or empty runtime `intents/` directory.
- Startup initialization must not overwrite existing runtime intent files.

## Source Map

Use the existing module boundaries:

- `src/plugin.ts`: assembly layer. Resolve config, resolve runtime data root, initialize runtime directories, seed empty runtime intents from skill assets, instantiate runtime-scoped services, and register OpenClaw hooks.
- `src/hooks.ts`: hook behavior for prompt building, tracking, stats updates, evolution queueing, and cleanup. Keep OpenClaw event logic here, not in `plugin.ts`.
- `src/config.ts`: Zod-backed config parsing, defaults, and clamps.
- `src/file-utils.ts`: shared path helpers and atomic filesystem primitives.
- `src/intent-loader.ts`: runtime intent catalog loading.
- `src/session-tracker.ts`: session JSON state under `dataRoot/sessions`.
- `src/stats-aggregator.ts`: usage aggregation into `dataRoot/stats.json`.
- `src/backlog-writer.ts`: evolution findings into `dataRoot/evolution.json`.
- `src/evolution-backlog.ts`: backlog schema validation, migration, and atomic mutations.
- `src/evolution-backlog-actions.ts`: shared action service for backlog reads, validation, targeting, and optimistic status updates.
- `src/evolution-tool.ts`: registers the agent tool surface `intention_hint_evolution`.
- `src/evolution-command.ts`: registers the plugin-owned command `/intention-hint evolution`.
- `src/prompt.ts`, `src/subagent.ts`, `src/review-subagent.ts`, `src/trigger-checker.ts`: classification and evolution logic.
- `src/conversation-extract.ts`: extracts recent turns, filters internal/inter-session traffic, attaches historical intent annotations, and applies context windows.
- `src/skill-catalog.ts`: resolves `skill: <name>` references in intent Markdown into available `SKILL.md` metadata for instruction writing and Evolution review.
- `src/review-queue.ts`: serializes background Evolution review work so hook handling stays fail-open.
- `src/evolution-trigger-keywords.ts`: default and normalized runtime keyword sets for `successful-pattern`, `behavior-fix`, and `entity-context` triggers.
- `src/session.ts`: session eligibility guards.
- `src/*.test.ts`: tests are colocated with the module they protect.

Conversation prompts are intentionally structured as XML-like blocks. Keep recent-turn context inside `<conversation_context>`, split historical topics with `<topic_segment>` and `<topic_boundary>`, and use compact topic-switch metadata names (`changed` and `reason`) in prompt-facing topic checker output. Persisted intent results may still store `topicChangeReason`; do not reintroduce separate `intentChange` state.

## Coding Rules

- Ground implementation in the current source. Do not invent OpenClaw SDK APIs, hook payload fields, config names, or intent frontmatter fields.
- Use ESM imports with `.js` suffix for local TypeScript modules.
- Prefer `interface` for object shapes and `type` for unions or complex aliases.
- Use `import type` for type-only imports.
- Avoid `any`; use `unknown` with narrowing when input is untrusted.
- Keep code fail-open for plugin runtime paths. Log non-fatal problems with `logger.warn()` and avoid blocking the user flow for stats, seed copying, cleanup, or evolution-review failures.
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
- Session cleanup may delete expired `sessions/*.json`; it must not touch root-level `stats.json`, root-level `evolution.json`, intent files, skills, transcripts, or package files.

## Testing Expectations

Add or update focused tests with the code change.

Typical mapping:

- Config schema changes: `src/config.test.ts`.
- Runtime data paths or startup seeding: `src/file-utils.test.ts` and `src/plugin.test.ts`.
- Hook behavior: `src/hooks.test.ts`.
- Intent loading or validation: `src/intent-loader.ts` consumers and `src/intent-validation.test.ts`.
- Prompt/parser behavior: `src/prompt.test.ts`.
- Conversation extraction/history matching: `src/conversation-extract.test.ts`.
- Session persistence and cleanup: `src/session-tracker.test.ts`.
- Stats behavior: `src/stats-aggregator.test.ts`.
- Skill metadata resolution: `src/skill-catalog.test.ts`.
- Evolution trigger keyword normalization: `src/evolution-trigger-keywords.test.ts`.
- Evolution backlog writes: `src/backlog-writer.test.ts` and `src/evolution-backlog.test.ts`.
- Evolution backlog action/tool/command behavior: `src/evolution-backlog-actions.test.ts`, `src/evolution-command.test.ts`, and `src/plugin.test.ts`.

When changing runtime paths, include tests for both the desired new location and non-overwrite startup behavior.

## Intent Files

Runtime editable intents live in `~/.openclaw/plugins/intention-hint/intents/*.md`. First-install examples live in `skills/intention-hint/assets/*.md` and are copied only when the runtime intent directory is absent or empty.

When changing first-install examples, edit `skills/intention-hint/assets/*.md` and run validation through the test suite. When changing a live local intent for the user's current OpenClaw environment, edit the runtime intent directory instead.

Intent markdown must keep valid YAML frontmatter and the expected sections used by `intent-validation.ts` and the intention-hint skill references.

## Evolution Backlog Workflow

Do not edit `~/.openclaw/plugins/intention-hint/evolution.json` manually. Use:

```text
/intention-hint evolution show
/intention-hint evolution list
/intention-hint evolution review-health --days 7
/intention-hint evolution validate-intents <intent-id>
/intention-hint evolution mark-processed --id <item-id> --expected-updated-at <timestamp>
/intention-hint evolution mark-dismissed --id <item-id> --expected-updated-at <timestamp>
```

Agents may call the structured `intention_hint_evolution` tool for the same operations.

Process one backlog finding at a time unless the user explicitly asks for a bounded batch. For split, merge, rename, deletion, or any broad intent-boundary change, show the planned file operations and get explicit confirmation first.

## OpenClaw SDK Usage

- Use `api.pluginConfig` plus `resolveLivePluginConfigObject()` for live plugin config.
- Use `api.runtime.state.resolveStateDir(process.env)` for OpenClaw state directory resolution.
- Use `api.runtime.agent.runEmbeddedAgent()` for embedded review/classifier runs. `runEmbeddedPiAgent` is deprecated.
- When an embedded run needs the core `read` tool, keep `modelRun=false`, use `promptMode="minimal"`, set `disableTools=false`, and narrow `toolsAllow` to `["read"]`. Do not use `promptMode="none"`; OpenClaw treats that as a raw model run and skips tool construction.
- If an SDK import path is uncertain or looks deprecated, verify it against the installed `openclaw` package before coding from memory.
- Keep `zod` imports direct from `"zod"`; this plugin owns `zod` as a runtime dependency.

## Documentation Updates

Update documentation when behavior or public configuration changes:

- `README.md` for architecture, runtime behavior, configuration, and user-facing workflows.
- `openclaw.plugin.json` for manifest-visible config descriptions/defaults.
- `AGENTS.md` for coding-agent rules and known gotchas.
- `skills/intention-hint/**` when an agent workflow or path changes.

Search for stale names and paths before finishing. For runtime layout changes, at minimum search for:

```bash
rg "sessions/(stats|evolution)\\.json|extensions/intention-hint/intents|~/.openclaw/extensions/intention-hint/intents|packageRoot.*intents|migrateLegacy|seedBundled"
```

## Finish Checklist

Before final handoff:

- `git diff` contains only intentional changes.
- `pnpm run typecheck` passes.
- `pnpm run test` passes.
- `pnpm run build` passes when emitted CLI/package behavior is involved.
- Docs and manifest are synchronized with source behavior.
- No unrelated user changes were reverted.
