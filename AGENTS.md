# Agent Guide: Intention Hint

This repository is an OpenClaw plugin. It classifies the user's intent before the main reply, injects a routing hint through `before_prompt_build`, records per-session runtime data, aggregates usage stats, and optionally writes evolution backlog findings.

Use this file as the working contract for coding agents. The README explains the product in more detail; this guide explains how to change the code safely.

## First Checks

Before editing, inspect the current state:

```bash
git status --short
pnpm run typecheck
pnpm run test
```

If tests already fail, capture the failure before changing code. Do not hide pre-existing failures inside unrelated edits.

## Commands

```bash
pnpm run typecheck          # TypeScript, no emit
pnpm run test               # Full Vitest suite
pnpm run build              # Compile to dist/
pnpm run format             # Prettier for md/json/ts files
pnpm run evolution-backlog -- <cmd>   # Operate on the evolution backlog after build
```

Run `pnpm run typecheck` and `pnpm run test` before handing off code changes. Run `pnpm run build` when changing CLI behavior, package metadata, SDK imports, or anything that depends on emitted `dist/` output.

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
- `src/evolution-backlog-command.ts`: command-line backlog workflow. Default root must use the OpenClaw state-dir helper, not package root.
- `src/prompt.ts`, `src/subagent.ts`, `src/review-subagent.ts`, `src/trigger-checker.ts`: classification and evolution logic.
- `src/session.ts`: session eligibility guards.
- `src/*.test.ts`: tests are colocated with the module they protect.

Conversation prompts are intentionally structured as XML-like blocks. Keep recent-turn context inside `<conversation_context>`, split historical topics with `<topic_segment>` and `<topic_boundary>`, and treat `topicChanged`/`topicChangeReason` as the only topic-continuity metadata. Do not reintroduce separate `intentChange` state.

## Coding Rules

- Use ESM imports with `.js` suffix for local TypeScript modules.
- Prefer `interface` for object shapes and `type` for unions or complex aliases.
- Use `import type` for type-only imports.
- Avoid `any`; use `unknown` with narrowing when input is untrusted.
- Keep code fail-open for plugin runtime paths. Log non-fatal problems with `logger.warn()` and avoid blocking the user flow for stats, seed copying, cleanup, or evolution-review failures.
- Keep `src/plugin.ts` thin. If behavior grows, put it in a focused module or existing service and inject it through `createHookHandlers()` when tests need isolation.
- Do not introduce broad abstractions just to reduce a few repeated lines. This plugin favors explicit lifecycle behavior over framework-style indirection.

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
- Session persistence and cleanup: `src/session-tracker.test.ts`.
- Stats behavior: `src/stats-aggregator.test.ts`.
- Evolution backlog writes: `src/backlog-writer.test.ts` and `src/evolution-backlog.test.ts`.
- Evolution backlog command behavior: `src/evolution-backlog-command.test.ts`.

When changing runtime paths, include tests for both the desired new location and non-overwrite startup behavior.

## Intent Files

Runtime editable intents live in `~/.openclaw/plugins/intention-hint/intents/*.md`. First-install examples live in `skills/intention-hint/assets/*.md` and are copied only when the runtime intent directory is absent or empty.

When changing first-install examples, edit `skills/intention-hint/assets/*.md` and run validation through the test suite. When changing a live local intent for the user's current OpenClaw environment, edit the runtime intent directory instead.

Intent markdown must keep valid YAML frontmatter and the expected sections used by `intent-validation.ts` and the intention-hint skill references.

## Evolution Backlog Workflow

Do not edit `~/.openclaw/plugins/intention-hint/evolution.json` manually. Use:

```bash
pnpm run build
pnpm run evolution-backlog -- show
pnpm run evolution-backlog -- list --json
pnpm run evolution-backlog -- validate-intents --id <intent-id>
pnpm run evolution-backlog -- mark-processed --id <item-id> --expected-updated-at <timestamp>
pnpm run evolution-backlog -- mark-dismissed --id <item-id> --expected-updated-at <timestamp>
```

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
