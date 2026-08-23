# Agent Guide: Skill Harness

This repository is an OpenClaw plugin. It appends fixed skill-discovery system context to authorized main-agent turns, classifies eligible user intent, prepends dynamic routing context through `before_prompt_build`, records per-session runtime data, aggregates usage stats, and optionally applies direct Review intent and trigger-keyword changes.

Use this file as the working contract for coding agents. The README explains the product in more detail; this guide explains how to change the code safely.

## How Coding Agents Should Use This Guide

Treat this file as the source of truth for repository operations, not as product documentation. For product behavior, read `README.md`; for implementation details, inspect the source before editing.

Work in this order:

1. Identify the change type: hook behavior, prompt/parser behavior, config/schema, runtime data path, intent asset, Intent Review/logging, docs-only, or package/SDK integration.
2. Use the architecture map below to frame the change, then use CodeGraph to locate the owning symbols, call paths, and colocated tests before changing anything.
3. Make the smallest change that satisfies the request. Do not refactor adjacent modules unless the current change requires it.
4. Update the focused tests and synchronized docs/manifest entries in the same change.
5. Run the verification tier that matches the change, then inspect `git diff` before handoff.

Use this change-routing matrix to choose the initial CodeGraph query and verification tier. It identifies domains, not files; let the graph establish the current implementation and test owners.

| Change area                                           | Explore first                                                           | Minimum verification                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Turn pipeline, classification, or session lifecycle   | Prompt-build flow, guards, and turn persistence                         | `pnpm run typecheck`, `pnpm run test`                                        |
| Prompt contract or intent behavior                    | Prompt builder, parser, classifier, and intent catalog                  | `pnpm run typecheck`, `pnpm run test`                                        |
| Configuration, runtime layout, or package integration | Plugin assembly, configuration, and persistence helpers                 | `pnpm run typecheck`, `pnpm run test`; build when emitted output is affected |
| Skills, curation, or statistics                       | Skill tools/inventory, curation, and accounting paths                   | `pnpm run typecheck`, `pnpm run test`                                        |
| Intent Review or keyword coverage                     | Trigger evaluation, snapshotting, review execution, and log persistence | `pnpm run typecheck`, `pnpm run test`; build for package-facing changes      |
| Bundled human-maintenance assets                      | Human-maintenance workflow and its runtime boundary                     | Formatting plus the focused TypeScript/Python checks identified by the graph |
| Documentation only                                    | Source symbols that support each claim                                  | `pnpm run format`; typecheck and tests when documenting behavior             |

## First Checks

Before editing, inspect the current state:

```bash
git status --short
pnpm run typecheck
pnpm run test
```

If tests already fail, capture the failure before changing code. Do not hide pre-existing failures inside unrelated edits.

For read-only inspection or docs-only updates, still run `git status --short` first and inspect the exact source files behind any claim you plan to document.

## Verification Scope

`pnpm run typecheck` and `pnpm run test` verify this checkout's TypeScript and
test contracts. They do not establish that a running OpenClaw Gateway has loaded
the built plugin, that its live configuration enables a behavior, or that its
runtime intent and Review data are healthy. When a task makes a runtime claim,
verify it separately through the Gateway's runtime inspection commands and the
resolved plugin data root.

## Commands

```bash
pnpm run typecheck          # TypeScript, no emit
pnpm run test               # Full Vitest suite
pnpm run build              # Compile dist/ (does not clean old output)
pnpm run format             # Prettier for md/json/ts files
```

Run `pnpm run typecheck` and `pnpm run test` before handing off code changes. Run `pnpm run build` when changing package metadata, SDK imports, or anything that depends on emitted `dist/` output. The current build script invokes `tsc` directly and does not remove stale `dist/` files, so package-facing work must also inspect `pnpm pack --dry-run` for stale renamed artifacts such as `dist/src/classification/embedded-agent.*` or root tooling output such as `dist/vitest.config.*`.

Root `scripts/` are intentionally not a workflow surface. The sealed runtime-data cutover toolchain was retired after its completed authorized application; do not treat its historical plan records or retained runtime evidence as a routine maintenance workflow. Package hygiene uses the direct `pnpm run build` and `pnpm pack --dry-run` gates. Day-to-day runtime intent changes follow the applicable validator, full test, and build rules below.

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
  - `experiences/<skill>/<entry>.md`
  - `sessions/<sessionId>.json`
  - `stats.json`
  - `review.json`
  - `keyword-coverage.json`

Rules:

- The active intent catalog always loads from `intentsPath(dataRoot)`; with the default local state directory this is `~/.openclaw/plugins/skill-harness/intents`.
- Runtime experience records load separately from `experiencesPath(dataRoot)`; with the default local state directory this is `~/.openclaw/plugins/skill-harness/experiences`. They are not intent bodies and startup seeding does not create or overwrite them.
- `stats.json`, `review.json`, and `keyword-coverage.json` are root-level runtime files. They must not be placed under `sessions/`.
- Startup initialization may copy example intent files from `skills/skill-harness/assets/*.md` when the runtime `intents/` directory is absent or contains no Markdown files.
- Startup initialization must not overwrite existing runtime intent files.

## Skill visibility policy

`skill_list`, `skill_search`, and `skill_view` deliberately inventory every skill in the invoking agent's resolved roots. The invoking agent ID selects its workspace roots, but the indexer must not apply OpenClaw's `agents.defaults.skills` or `agents.list[].skills` allowlists. This is an intentional product boundary: these tools expose the root inventory, subject only to source precedence and disabled bundled skill entries. Do not add `resolveAgentSkillsFilter()` or equivalent filtering unless Baby explicitly changes this policy; that change requires focused tests plus README and migration documentation.

Prompt-time workspace auto-injection is narrower than tool visibility: `<configured_skills>` unions explicit configured names with `listAvailableSkills({ source: "workspace" })` for the invoking agent only. Do not expand that automatic inventory to project-agent, personal-agent, managed, plugin, bundled, or extra sources; explicit names may still resolve from those roots. Skill tools continue to expose the full resolved inventory described above.

Related-skill declarations are a tool-discovery concern only. Dynamic routing must use the selected intent's direct skills and must not resolve or inject `relatedSkills` as additional candidates.

The indexer uses `skills.load.watchDebounceMs` as its cache TTL only when `skills.load.watch` is `true`; otherwise it retains the 60-second default. This is polling, not a filesystem watcher. Keep the TTL in the cache key so live configuration changes cannot reuse indexes created under a different refresh interval.

Stats schema v4 observes the resolved inventory per tracked agent on existing accepted stats events and adds attribution only from new accepted turns. Resolve the agent ID from persisted tracker state, never from a finalize-context fallback. Inventory identity consists of normalized skill name, source, a SHA-256 of the resolved winning `SKILL.md` path, and a SHA-256 of the raw file bytes. Canonicalize top-level recommendation and usage aggregate keys with trimmed locale-independent lowercase identity so `needsReview` joins the inventory's normalized key even when display casing differs. At the load boundary, merge valid existing mixed-case aggregate and daily-count collisions into the canonical key and recompute derived fields. Dynamic aggregate and count-map keys must use own-property-safe reads and writes so accepted reserved names such as `__proto__` cannot mutate `Object.prototype`. Keep both fingerprints internal to stats; public skill list/search/view results must not expose them. A source, winner, content, or visibility-continuity change starts a new per-skill epoch. If the disabled bundled-skill policy or inventory cannot be resolved trustworthily, preserve the existing stats event but skip the observation update. A valid v1/v2/v3 migration must retain historical aggregates, initialize `attribution.startedAt` at the migration event, and never fabricate pre-boundary daily intent outcomes/routing, skill routing, tool errors, or latency samples. New v4 daily attribution maps (`intentOutcomes`, `intentRouting`, `skillRouting`, `toolErrors`) store named keys as `value:<trimmed-name>`, are capped at 64 keys per UTC date, and reserve host-owned `__other__` overflow; top-level tool histograms use fixed latency buckets. Review outcomes remain owned only by `review.json`.

## Architecture Map and CodeGraph Workflow

This is deliberately a domain map, not a per-file inventory. The code changes over time; CodeGraph is the authority for the current symbol location, call path, impact radius, and colocated tests.

Before changing code, confirm the repository index is healthy with `codegraph status .`, then start with one focused query such as:

```bash
codegraph explore --path . 'before_prompt_build classification intent routing'
```

If that misses, use `codegraph query` to locate the symbol, `codegraph node` to read its exact source, and `codegraph callers`, `callees`, or `impact` to establish the change boundary. Use `affected` only as a file-level backstop, not proof of test-case coverage. Do not run `init`, `index`, `sync`, `unlock`, or `uninit` without explicit authorization because they modify the local graph.

The major domains are:

- **Assembly and configuration:** plugin registration creates runtime-scoped services, resolves live configuration and data paths, and registers host hooks and skill tools. Keep assembly thin; behavior belongs in its owning domain.
- **Turn pipeline:** host events add fixed context, decide dynamic-routing eligibility, classify eligible messages, inject bounded routing context, associate tool calls with turns, and finalize session/statistics/review work. Static context and dynamic routing have separate gates.
- **Intent and prompt contracts:** runtime intent Markdown is validated and loaded into a catalog. Classifier, topic-checker, curation, and Review prompts use structural XML-like formatting and strict compact-model output contracts.
- **Skills and experiences:** inventory resolution, deterministic search, safe skill-file access, authorized skill management, and bounded experience lookup are separate concerns. Tool visibility and prompt-time auto-injection intentionally have different scopes.
- **Session, curation, and statistics:** durable session state preserves turn evidence and curation decisions; curation is session-local and independent from Review. Statistics aggregate accepted turns, inventory observations, recommendation adoption, and attribution without fabricating history.
- **Intent Review and keyword coverage:** background work is serialized and fail-open. Review runs in an isolated workspace, validates proposed runtime changes, handles conflicts atomically, and records outcomes separately from trigger-keyword coverage state.
- **Human-maintenance assets:** bundled skills, example intents, and report-only audit scripts document human workflows. They must not duplicate production-owned routing, persistence, curation, or Review behavior.

The graph should also identify the focused tests: tests are colocated with the domain they protect, with integration coverage around plugin registration and hook orchestration.

Conversation prompts are intentionally structured as XML-like blocks. Keep recent-turn context inside `<conversation_context>` and split historical topics with `<topic_segment>` and `<topic_boundary>`. Curator subagent prompts receive recent `<conversation>` with `<role>user</role>` and `<role>assistant</role>` turns bounded by recent context limits. Prompt-facing topic checker output requires bounded `basis`, `reason`, joint `confidence`, keywords, topic, and domain; confidence measures the combined correctness of reason, domain, and keywords, and the prompt must not ask the model for `changed` or complexity. Host parsing derives `changed` exclusively from `reason`. Same-topic inheritance requires historical intent data, a topic-triage domain equal to that intent's current catalog domain, and confidence at or above resolved `routing.sameTopic.minConfidence`; it keeps the prior intent and intent confidence, refreshes topic/domain/keywords, and never inherits complexity. Exact fastpaths and QMD direct routes also leave complexity absent; uncertain results reach the classifier path instead. The intent classifier is the only result producer that owns required final complexity. Dynamic routing renders selected intent metadata, an optional classifier-produced `task_complexity`, the routing `guidance` derived from the complete plain-text body, direct matched-intent skill candidates, and immediate candidate-scoped experience metadata nested inside the matching `<skill>`. Render every matching experience identity and keywords, never its summary; session curation does not gate metadata but may select at most three high-relevance `recommendedExperienceRefs`. On the next turn, only those selected records add a bounded body with a `session_curation_recommendation` marker that says it is possibly relevant. The main agent uses `skill_experience` with the matching skill and identity query to read an unexpanded record or the full body. Stats still record the turn but increment complexity buckets only for known values. Persisted intent results may still store `topicChangeReason`; do not reintroduce separate `intentChange` state.

Format every multiline XML-like prompt tree with two spaces per nesting level. Each formatter should return a complete subtree rooted at column zero, and its parent wrapper should indent every non-empty child line by one level while preserving the payload's relative indentation and leaving blank lines empty. Apply this structurally while composing wrappers; never run a final regex formatter over the completed prompt because escaped user, assistant, tool, intent, or Markdown evidence may contain XML-like text. Omit optional evidence blocks when their content is absent, empty, or whitespace-only instead of emitting self-closing tags; preserve required structural boundaries such as `latest_message`, `review_snapshot`, `snapshot_manifest`, `current_turn`, and individual historical record wrappers.

QMD is mandatory and has no enable/disable or legacy-route switch. Build its managed runtime snapshot under `qmd/intents/` and database at `qmd/intent-routing.sqlite` in the background; `before_prompt_build` may only query a healthy store whose catalog fingerprint matches the active catalog. A topic change makes same-topic inheritance unavailable, but it does not skip either QMD stage or force a classifier call. All configurable threshold branches must read resolved `routing` configuration; do not reintroduce hard-coded topic-confidence or QMD-score thresholds. Defaults are `routing.sameTopic.minConfidence=0.8`, `routing.qmd.minTopicConfidence=0.8`, `routing.qmd.directRouteMinScore=0.85`, `routing.qmd.smallCandidateMinScore=0.65`, and `routing.qmd.minCandidateScore=0.35`. Reject, rather than silently clamp or replace, any routing score outside `0..1` or a QMD ordering that does not satisfy `minCandidateScore ≤ smallCandidateMinScore ≤ directRouteMinScore`. First, topic-keyword routing uses a per-domain QMD collection built exclusively from `fastpath.keywords`; it uses lexical retrieval only when topic-triage confidence meets `routing.qmd.minTopicConfidence`, and a score strictly greater than `routing.qmd.directRouteMinScore` routes directly. A non-direct topic-keyword result falls through and must not become classifier candidate evidence. Next, the trigger/example route makes one QMD search over `intent-triggers` and `intent-examples` with forced expansion, reranking, `minScore: 0`, and QMD explanation. When topic-triage confidence meets `routing.qmd.minTopicConfidence`, pass compact `expansionContext` in the exact order `domain=…; keywords=…; topic=…`, and pass only `rerankContext: domain=…`; otherwise pass neither context. Never pass raw conversation, history, historical intents, intent candidates, or intent bodies to either QMD context. Its `score` is authoritative: a score strictly greater than `routing.qmd.directRouteMinScore` routes directly; a score at or above `routing.qmd.smallCandidateMinScore` uses small classifier K; a score at or above `routing.qmd.minCandidateScore` uses large K; lower, empty, stale, timeout, mapping, or QMD errors require one full-catalog classifier call. Candidate projection must use that same inclusive `routing.qmd.minCandidateScore`. `baseK=clamp(6,12,ceil(log2(N))+2)`, `smallK=min(N,baseK)`, `largeK=min(N,min(baseK*2,24))`, and raw QMD limit is `2*largeK`. Hybrid-QMD classifier candidates preserve canonical catalog order and include only QMD-ranked intent IDs, `candidate.scope: cross-flow`, and the last two valid session-history intents. Remove host-local topic similarity, margins, and high-risk exceptions. Exact `fastpath.keywords` stays host-local normalized whole-message equality. Pipeline telemetry names these searches separately as `qmd-keyword` and `qmd-trigger-example`; do not merge them into a shared phase. Candidate telemetry includes the decision, counts, and bounded per-candidate provenance; classifier failures remain projection-eligible without creating an intent result. It must not be copied into Intent Review turn evidence.

Prompt-build scope has separate static and dynamic boundaries. First resolve the canonical agent/session, then exclude Skill Harness embedded-agent sessions, generic/Review subagents, dreaming sessions, and active-memory sessions from all injection. Every remaining agent receives fixed `appendSystemContext` plus any resolved explicit-and-workspace `<configured_skills>` union, regardless of chat type or chat-ID policy and including agents outside the configured intent-scanning `agents` list. Only after static resolution should the configured agent list, chat scope, internal/inter-session status, user trigger, and interactive-session checks gate dynamic intent work. Eligible external-user turns may additionally receive dynamic `prependContext`; static resolution and dynamic fallbacks must preserve fixed context.

Eligible dynamic routing must emit one parent `pipeline:started` event before any exact or model-backed phase and exactly one terminal `pipeline:completed` or `pipeline:failed` event after no further phase can run. Terminal parent events carry producer-measured `durationMs`; phase events remain nested progress details. Do not make consumers infer overall completion from `topic-triage` or `intent-classify` completion.

Do not repeat fixed mandatory/tool guidance inside dynamic `<skill_harness_plugin>` output. Dynamic context contains only its context policy, `selected_intent`, optional classifier-produced `task_complexity`, `intent_guidance`, and direct `skill_candidates`; each matching candidate skill may contain nested `skill_experience` records with identity/keywords metadata, while up to three `recommendedExperienceRefs` selected by session curation additionally have a bounded body and `session_curation_recommendation` marker. The `before_prompt_build` hook does not expose final per-turn tool names; normal main-agent availability of registered Skill Harness tools is a deployment contract, while restricted runs must obey their narrower tool allowlist. The dynamic `prependContext` ends with the `USER_MESSAGE_BOUNDARY` marker (`User Message:`) on its own line after the closing `</skill_harness_plugin>` tag so the host's following user input is unambiguous; `sanitizeConversationText` strips the marker together with the plugin block, and it must never be appended to the user's own message.

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
- Session cleanup may delete expired `sessions/*.json` and embedded-agent session artifacts (`agents/*/sessions/*.session.jsonl`, `*.session.trajectory.jsonl`, and `*.session.trajectory-path.json`) through the 14-day retention sweep only. Session loading strips retired unknown intent-state fields such as `instructionText` before use or migration rewrite. `session_end` should preserve the ended session JSON for audit/reload; it must not delete current session files or touch root-level `stats.json`, root-level `review.json`, intent files, skills, transcripts, or package files.

## Testing Expectations

Add or update focused tests with every behavior change. Locate them from the symbols you change: begin with `codegraph callers` or `impact`, then use `codegraph affected` only to catch file-level omissions. Do not claim test-case coverage from `affected` alone.

Tests are colocated by domain. Follow the changed behavior through its nearest unit tests and the relevant integration boundary: hook/registration changes need pipeline coverage, persistence changes need runtime-layout and non-overwrite coverage, and prompt/Review changes need parser and validation coverage. Changes to bundled human-maintenance scripts also require their focused Python checks.

## Intent Files

Runtime editable intents live under `intentsPath(dataRoot)`; with the default local state directory this is `~/.openclaw/plugins/skill-harness/intents/*.md`. First-install examples live in `skills/skill-harness/assets/*.md` and are copied only when the runtime intent directory is absent or contains no Markdown files.

When changing first-install examples, edit `skills/skill-harness/assets/*.md` and run validation through the test suite. When changing a live local intent for the user's current OpenClaw environment, edit the runtime intent directory instead.

Intent Markdown must keep valid YAML frontmatter for classification metadata and one complete plain-text body that is the routing guidance. The body is one durable sentence: no headings, lists, fences, commands, paths, or additional sections. Optional `candidate.scope` must equal `cross-flow`; manual `candidate.keywords` require durable exact-match evidence and collision fixtures and must not be inferred from one session.

## Review Workflow

Review no longer creates pending items or exposes a manual backlog tool or slash command. This is a breaking workflow change and must be highlighted in release notes. Background reviews are serialized through `src/review/queue.ts`, stage runtime intent edits and eligible new skill experiences in an isolated temporary workspace, validate them, then reconcile validated intent lifecycle changes back to `intentsPath(dataRoot)` and create-only experience writes back to `experiencesPath(dataRoot)`. They record compact outcomes under `processedEvents` in `reviewLogPath(dataRoot)`; with the default local state directory that is `~/.openclaw/plugins/skill-harness/review.json`.

Review prompt maintenance must preserve evidence-gated action bias. Global rules may prefer the smallest valid correction only after lens, trigger-specific evidence, durability, scope, and current-workspace coverage checks pass; each trigger owns its evidence criteria. Treat the queued review snapshot as historical evidence and current files in the isolated workspace as authoritative content. Every requested trigger must have at least one valid positive or no-finding decision before a run is accepted. Missing or schema-invalid decisions must not satisfy coverage and are recorded through the sanitized `missing-trigger-decision` schema-rejection reason.

Keep Review prompts task-first: requested trigger workflows precede the shared intent-craft rubric. Serialize dynamic evidence as a host-owned `snapshot_manifest`, then `current_turn`, `matched_intent`, `recent_turns`, `available_skills`, and the optional `intent_catalog`; current and matched evidence stay adjacent. Keep user input, assistant results, tool calls, intent metadata/body, and skill metadata inside their semantic child wrappers and escape untrusted text at this final serialization boundary. Do not expose session, event, agent, or session-key identifiers in the manifest.

Keep Review context projection conservative and deterministic. Group only runs of at least three consecutive, explicitly successful, parameter-identical calls to `read`, `skill_list`, `skill_search`, or `skill_view`; failures, mutations, unknown tools, and intervening calls remain expanded. Project only Recent assistant results longer than 1,000 Unicode code points, preserving the first and final 500 code points with an exact host-owned omission count; Current results keep their established tracker boundary. `missing-intent` and `weak-intent` always receive the full Intent Catalog, while `skill-candidate`, `behavior-fix`, and `satisfaction-check` may use the deterministic matched/observed/domain/exact-keyword candidate union only when all conservative fallback gates pass. Keep Available Skills complete and record only count and rendered-code-point measurements; do not add a skill selector without a separate measured decision.

Skill-placement Review is host-selected and agent-scoped. Select at most one candidate after an accepted stats event, using only the persisted tracker agent ID and current resolved inventory. Reserve the epoch immediately after selection and before any asynchronous snapshot or skill-resolution work. Snapshot skill resolution, model lookup, and the reviewer invocation must use that same tracked agent. If snapshot resolution no longer returns or cannot read the selected skill, do not enqueue the placement run, release the reservation for retry, and preserve any ordinary triggers by rebuilding their model and snapshot path without placement data. Add `skill-placement` to any ordinary triggers for the same run, include the full catalog with `skills[]`, supply only the selected skill's bounded content as host-owned snapshot evidence, and expose only `read`, `write`, and `apply_patch`. Host validation must require exactly one positive placement finding, one existing target intent, `operation: refine`, and a canonical trimmed-lowercase candidate reference in valid frontmatter. Always release the pending reservation after queue, reviewer, validation, or log completion; only atomically persisted `applied` or `nofinding` outcomes suppress a later run.

Trigger-keyword Review is event-driven and limited to requested `successful-pattern`, `behavior-fix`, and `entity-context` triggers. Each trigger must pass its structural gates and match a current keyword before the reviewer may return a JSON-only keyword finding for that same target. Enforce at most three additions and three removals, reject empty or cross-trigger findings, and keep normalization, deduplication, locking, atomic persistence, and cache refresh host-owned. Do not claim that ordinary Review discovers keyword false negatives that never triggered; there is no production corpus-level keyword audit, unmatched-turn aggregator, or keyword epoch reservation.

The bundled `keyword-audit` mode is the deliberate human evidence path for that coverage gap. It may inspect retained sessions locally, produce ref-only labels and TP/FP/FN/collision metrics, and propose an exact bounded delta. It must remain report-only: never hand-edit `review.json`, invoke or emulate the internal writer, or claim that approval persisted a change. The audit script normalizes more aggressively than production substring matching and does not hash or snapshot every session file, so document it as an approximate replay over an observed evidence window.

Skill-experience Review writes are create-only and limited to at most one entry per run for a current-turn successfully observed skill that remains visible to the tracked agent. Only `skill-candidate`, `process-gap`, `successful-pattern`, and `behavior-fix` can create one; the reviewer stages `experiences/<skill>/<entry-id>.md`, declares one `skill-experience` finding, and the host validates identity, current visibility, complete experience schema, no overwrite, and concurrent creation before applying it. Never let the reviewer update/delete experiences or write a skill that was not observed in the current turn.

Do not edit `reviewLogPath(dataRoot)` manually for normal work. It stores strict current-only schema v7 `processedEvents`, `reviewedSkillEpochs`, and `historicalKeywordAudits`; trigger keywords live only in `keywordCoverageLogPath(dataRoot)`. Schema-v6 and older malformed current records are rejected without rewrite, migration, or recovery.

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
- Tool-free classifier runs may use `modelRun=false`, `promptMode="none"`, and `toolsAllow: []`. When an embedded workflow needs tools, use `modelRun=false`, `promptMode="minimal"`, `disableTools=false`, and an exact allowlist: Intent Review uses `read`, `write`, and `apply_patch`, adding `skill_view` only for skill-candidate reviews. Skill-placement receives its host-selected skill as bounded snapshot evidence. Do not use `promptMode="none"` for a run that needs tools because it skips tool construction.
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
