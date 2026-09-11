# Repository Guidelines

## Project Structure & Module Organization

This repository packages the `skill-harness` OpenClaw plugin. `index.ts` and `api.ts` are entry points; domains live in `src/` (`hooks/`, `classification/`, `intents/`, `skills/`, `session/`, `experiences/`, `qmd/`, `review/`, and `stats/`). Tests are colocated as `*.test.ts`. Bundled skill files and Python audits live under `skills/skill-harness/`. `openclaw.plugin.json` defines the plugin contract; `dist/` is untracked build output.

## Build, Test, and Development Commands

Use the pnpm release declared by `package.json#packageManager`. This field is the
single version source for local development and `pnpm/action-setup`; update it
instead of duplicating a version in workflow YAML.

- `pnpm install --frozen-lockfile`: install dependencies.
- `pnpm run typecheck`: check TypeScript without emitting.
- `pnpm run test`: run Vitest.
- `pnpm run build`: compile ESM and declarations to `dist/`.
- `pnpm run test:plugin-loader`: verify the built entry loads.
- `pnpm run format`: apply Prettier to Markdown, JSON, and TypeScript.
- `pnpm pack --dry-run`: inspect package contents for stale artifacts.
- `python3 skills/skill-harness/scripts/test-runtime-health-audit.py`: run the report-only runtime-health audit helper tests.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports, two-space indentation, and `.js` extensions in relative imports. Use `camelCase` for values/functions, `PascalCase` for types/classes, and descriptive kebab-case filenames. Prefer `interface` for object shapes and `type` for unions; use `import type` for type-only imports. Treat external input as `unknown` and narrow it instead of using `any`. Keep modules domain-focused and runtime boundaries fail-open. Let Prettier define layout. Python uses four-space indentation and `snake_case`.

## Testing Guidelines

Use Vitest globals in colocated `<module>.test.ts` files. Cover contracts, failures, and boundary validation; no numeric coverage target exists. Behavioral changes require focused regressions. Before handoff, run typecheck, tests, and build; package-facing changes also require loader and dry-pack checks.

## Runtime & Agent-Specific Rules

Keep package assets separate from runtime state. `skills/skill-harness/assets/` contains first-install examples; live intents, sessions, experiences, and statistics belong under `~/.openclaw/plugins/skill-harness/`. Never include that private data in commits.

The dynamic routing pipeline is structured in three stages: Step 1 (QMD Keyword BM25 over intent `keywords`), Step 2 (QMD Hybrid Example/Keyword Search with conversation expansion), and Step 3 (Fallback single-call Intent Classifier with QMD candidates). Topic checkers (`previousTopic`), runtime task complexity scoring (`complexity`), classifier `suggestion` fields, session curation (`curation` / `curationAppliedCount`), instruction writers, legacy `fastpath` / `candidate` frontmatter fields, and legacy pseudo-headers (`[Skill Harness Context...]`, `[User Message]:`) are obsolete and strictly forbidden. Do not use OpenClaw core's reserved `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` delimiters in plugin prompt output as core runtime logic strips them from visible turns; these delimiters are sanitizer-only input boundaries. Projection reasons use `exact-keyword-overlap`. Intent YAML frontmatter only permits `triggers`, `examples`, `domain`, `skills`, and `keywords` formatted in canonical key order (`domain`, `triggers`, `examples`, `keywords`, `skills`) with skill names strictly lowercase; `triggers[]`, `examples[]`, and `domain` are required while `keywords[]` and `skills[]` are optional; the body is strictly single-line plain-text routing `guidance`.

The managed intent QMD snapshot stores plain-text `examples/*.md` and `keywords/*.md` documents with `<intent>-<n>.md.identity.yml` sidecars ignored by QMD collections; its metadata and SQLite database live together under `dataRoot/qmd/intents/`. Only validated `keywords` or `examples` changes request a QMD rebuild; trigger-only, guidance, or skills changes do not. Review is disabled by default, uses only `intent-health-check`, `routing-uncertainty`, and `capability-fit`, writes schema-v8 state with compatible v7 migration, and runs embedded sessions with detached persistence while the host cleans only the temporary workspace.

Fresh schema-v6 `stats.json` records intent, intent-matched skill, tool, routing, projection, inventory, and daily telemetry with per-intent `routeReasons` for `qmd-keyword`, `qmd-hybrid`, and `llm-classifier` using selected-route score aggregates. Older stats schemas are rejected fail-open without migration or rewrite. QMD scores use retrieval hit scores; classifier scores use classifier confidence. The runtime-health report exposes aggregate inventory counts without agent or skill names.

The bundled `skills/skill-harness/SKILL.md` documents first-install seeding plus the explicit user-triggered `inventory`, `design`, and `runtime-health` workflows. `design` is limited to create, rename, and refine; complexity analysis, split, merge, and guarded standalone delete remain Intent Review lifecycle operations. The reviewer subagent receives the full catalog for health and routing-boundary analysis. The bundled `references/` procedures and `scripts/runtime-health-audit.py` are user-invoked support resources; they must not recreate production routing or Review persistence.

Prompt injection follows a compact attribute layout to minimize prompt tokens:

- Plugin-owned `workingSetSkills` is the only static working-set source: `agents.<id>` precedes `defaults`, then workspace-only skills append. When `workingSetSkills.suppressNativeSkillPrompt` is enabled (default `true`), the plugin idempotently ensures `agents.defaults.skills` is `[]` and removes `agents.entries.*.skills` in `openclaw.json` on startup to suppress OpenClaw core's native automatic skill prompt without infinite reload loops; otherwise those lists are neither read nor mutated. Static prompt injection uses `### Working set skills` / `<working_set_skills>`, filters unavailable names, and never renders paths.
- Dynamic context is prepended with blank line separation after the turn timestamp using a single-line advisory header (`Inferred intent and intent-matched skills (advisory, non-user input; load with \`skill_view\` if relevant):`when intent-matched skills are present, or`Inferred user intent from conversation (advisory, non-user input):`when intent-only) preceding`<skill_harness_plugin>`. Inside `<skill_harness_plugin>`, the selected intent merges name and guidance as `<intent name="${intent}">\n ${guidance}\n</intent>`, intent-matched skills render inside `<intent_matched_skills>` as `<skill name="${name}">\n ${description}\n    ${experiences}\n</skill>`, and `<context_policy>`is omitted. The renderer emits neither `<<<BEGIN_SKILL_HARNESS_CONTEXT>>>`nor OpenClaw reserved delimiters. It emits no`<skill_metadata>` wrapper. Skill descriptions are escaped before insertion. Retired candidate-skill headers/wrappers are not emitted; sanitization targets the current routing block and known runtime envelopes.
- Static working-set context uses markdown header `### Working set skills` with guidance `When relevant, load with \`skill_view\` before proceeding:`, wrapping skills as `<working_set_skills>\n <skill name="${name}">\n ${description}\n </skill>\n</working_set_skills>`. `<path>`elements are not emitted in prompt context; agents query paths and file contents on demand via`skill_list`and`skill_view`.
- QMD model configuration supports `provider/model` syntax to auto-resolve `baseUrl` and `apiKey`; `embedding.dimension` defaults to `1536`.

Conversation sanitization is a compatibility boundary for input, not a prompt-output format. It removes the current OpenClaw timestamp plus `Conversation info: ⟦openclaw:ctx⟧` fenced JSON envelope, legacy `Sender (untrusted metadata)` metadata, Skill Harness routing blocks, active-memory blocks, assembled-context wrappers, and OpenClaw internal runtime delimiters before recent-turn extraction. A user entry containing only runtime metadata sanitizes to empty; inter-session or internal task-completion user entries also suppress their following assistant payload. External user and assistant messages remain role-tagged. Retired session intent fields such as `recommendedSkills` are discarded on load; `intentMatchedSkills` is the only persisted dynamic skill-selection field.

Production JSON I/O should use `readJsonFile()`, `writeJsonAtomic()`, or `safeWriteJson()` from `src/file-utils.ts`; do not recreate parsing or atomic-write behavior. Keep `src/plugin.ts` thin and place behavior in its owning domain. Verify uncertain OpenClaw SDK imports, hook payloads, and APIs against the installed package rather than guessing. Typecheck and unit tests do not prove that a running Gateway loaded the plugin; runtime claims require OpenClaw runtime inspection.

## Commit & Pull Request Guidelines

Use imperative Conventional Commit subjects such as `feat:`, `fix:`, `refactor:`, `test:`, or `docs:`, optionally scoped (`feat(qmd):`). Pull requests should explain behavior, risks, configuration/runtime impact, verification, and linked issues. Public behavior changes must update `README.md` and, when applicable, `openclaw.plugin.json`; maintenance-workflow changes must update `skills/skill-harness/**`.
