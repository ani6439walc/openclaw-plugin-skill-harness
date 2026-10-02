# Repository Guidelines

## Project Structure & Module Organization

This repository packages the `skill-harness` OpenClaw plugin. `index.ts` and `api.ts` are entry points; domains live in `src/` (`hooks/`, `classification/`, `skills/`, `session/`, `experiences/`, `qmd/`, `review/`, and `stats/`). Tests are colocated as `*.test.ts`. Bundled skill files and Python audits live under `skills/skill-harness/`. `src/config.ts` and `src/types.ts` define runtime defaults/types; `openclaw.plugin.json` defines the strict public plugin contract; `dist/` is untracked build output.

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
- `pnpm exec prettier --check README.md AGENTS.md`: check formatting for these documents without formatting unrelated files.
- `python3 skills/skill-harness/scripts/test-runtime-health-audit.py`: run the report-only runtime-health audit helper tests.
- `python3 skills/skill-harness/scripts/test-validate-experiences.py`: test the experience validator after building its production imports in `dist/`.
- `python3 .github/scripts/test_jules_pr_review.py`: test the CI review helper.

CI uses Node.js 24 and 26 and runs formatting, typecheck, Vitest, all three Python suites, build, loader, and dry-pack checks. `tsc` does not prune stale `dist/` files; inspect package contents before handoff of package changes.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports, two-space indentation, and `.js` extensions in relative imports. Use `camelCase` for values/functions, `PascalCase` for types/classes, and descriptive kebab-case filenames. Prefer `interface` for object shapes and `type` for unions; use `import type` for type-only imports. Treat external input as `unknown` and narrow it instead of using `any`. Keep modules domain-focused and runtime boundaries fail-open. Let Prettier define layout. Python uses four-space indentation and `snake_case`.

## Testing Guidelines

Use Vitest globals in colocated `<module>.test.ts` files. Cover contracts, failures, and boundary validation; no numeric coverage target exists. Behavioral changes require focused regressions. Before handoff, run typecheck, tests, and build; package-facing changes also require loader and dry-pack checks.

## Runtime & Agent-Specific Rules

Keep package assets separate from runtime state. There are zero pre-seeded experiences; live sessions, experiences, and statistics belong under `~/.openclaw/plugins/skill-harness/`. Never include that private data in commits.

The public manifest requires `qmd.embedding.model`, `qmd.expansion.model`, and top-level `jev.model`. Keep examples valid against the manifest, not just the more permissive compatibility parser in `resolveConfig()`. Jev uses `routing.timeoutMs`; candidate searches use their separate search budgets, defaulting to `qmd.timeoutMs`. Invalid manifest configuration can prevent loading; runtime fail-open behavior does not bypass host validation.

The dynamic pipeline runs input skill discovery and experience retrieval in parallel. Direct skill evidence combines bounded typo-aware name matching (strip URLs before tokenization) and managed `SkillQmdIndex` retrieval over meta/body/references (`minCandidateScore` default 0.6). Experience evidence uses managed `SkillExperienceQmdIndex` multi-collection retrieval over keywords, summary, and body (`minCandidateScore` default 0.4). Unified selection runs one constrained call (TypeSafe Jev) only when the pool of visible skill candidates and/or shared experience candidates is non-empty; an empty candidate pool short-circuits without a model call; `maxInjectedSkills: 0` short-circuits skill discovery; model, parsing, or validation failure injects no heuristic fallback skills. Final injected skills are the visible union of selector-selected skills and skills associated with selector-selected experiences, capped by `maxInjectedSkills`; zero permits experiences-only injection. The final renderer emits decoupled optional `<matched_experiences>` and `<matched_skills>` blocks only (no `<intent>` block is emitted). Topic checkers (`previousTopic`), runtime task complexity scoring (`complexity`), classifier `suggestion` fields, session curation (`curation` / `curationAppliedCount`), instruction writers, legacy `routing.intents` configuration, legacy `routing.model`, `routing.modelFallback`, `routing.thinking`, routing subagent fallback, legacy `fastpath` / `candidate` frontmatter fields, and legacy pseudo-headers (`[Skill Harness Context...]`, `[User Message]:`) are obsolete and strictly forbidden. Do not use OpenClaw core's reserved `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` delimiters in plugin prompt output as core runtime logic strips them from visible turns; these delimiters are sanitizer-only input boundaries.

Runtime experiences live in decoupled multi-to-multi folders under `dataRoot/experiences/<id>/` containing required `summary.md`, `keywords.md`, and `body.md`, plus optional `skills.md`. Experiences and their QMD index are shared across agents: dynamic retrieval and query-only `skill_experience` are not filtered by agent skill visibility. Explicit `skills` filters on the tool validate visible names, and final injected skills are visibility-filtered; do not describe experiences as agent-private. Managed QMD indexes for skills and experiences reside respectively under `dataRoot/qmd/skills/` and `dataRoot/qmd/experiences/`. Review is disabled by default, uses only `experience-health-check` (with `intent-health-check` as configuration alias), `routing-uncertainty`, and `capability-fit`, writes schema-v8 state with compatible v7 migration, and runs embedded sessions with detached persistence while the host cleans only the temporary workspace.

Fresh schema-v7 `stats.json` records skill, tool, routing, projection, inventory, and daily telemetry. Current top-level selections do not create intents; per-intent route-reason aggregates are populated only when historical `state.intent.result` exists. Older stats schemas are rejected fail-open without migration or rewrite. QMD scores use retrieval hit scores; classifier scores use classifier confidence. The runtime-health report exposes aggregate inventory counts without agent or skill names.

The bundled `skills/skill-harness/SKILL.md` documents explicit user-triggered `experience` and `runtime-health` workflows. The reviewer subagent curates skill experiences autonomously on configured triggers. Capability-fit uses tool-call/tool-failure thresholds or inventory-selected skill epochs; a failed call is not evidence of verified recovery. The scheduler replaces pending candidates by agent/session, debounces for 30 seconds, bounds pending entries to 32, and serializes execution. Disposal cancels pending work. The bundled `references/` procedures and `scripts/runtime-health-audit.py` are user-invoked support resources; they must not recreate production routing or Review persistence.

Prompt injection follows a compact attribute layout to minimize prompt tokens:

- Plugin-owned `skills.workingSet` is the only static working-set source: `agents.<id>` precedes `defaults`, then workspace-only and workshop-only skills append in that order, controlled independently by `includeWorkspaceSkills` and `includeWorkshopSkills` (both default `true`). These flags affect automatic prompt additions, not discovery or explicitly named skills. When `skills.suppressNativeSkillPrompt` is enabled (default `true`), the plugin idempotently ensures `agents.defaults.skills` is `[]` and removes `agents.entries.*.skills` in `openclaw.json` on startup to suppress OpenClaw core's native automatic skill prompt without infinite reload loops; otherwise those lists are not a static source and are not normalized. Independently, `skills.suppressNativeExtraDirs` defaults to `true` and clears `skills.load.extraDirs`; use `skills.sharedRoots` for intentionally shared directories. Startup normalization belongs only to full registration and must stay idempotent. Static prompt injection uses `### Working set skills` / `<working_set_skills>`, filters unavailable names, and never renders paths.
- Dynamic context follows the turn timestamp with blank-line separation and one advisory header before `<skill_harness_plugin>`. The header starts with `Inferred relevant skills and experiences from conversation`, `Inferred relevant skills from conversation`, or `Inferred relevant experiences from conversation`, according to the non-empty blocks; it labels the content advisory/non-user input and names the relevant loading tools. Keep the exact strings in `src/constants.ts` aligned with renderer tests.
- Inside `<skill_harness_plugin>`, experiences use `<matched_experiences>` with `<experience id="${id}" [skills="${skills}"]>`, containing only the summary; skills use `<matched_skills>` with `<skill name="${name}">`, containing the description. Escape interpolated values. Do not emit `<context_policy>`, `<skill_metadata>`, retired candidate wrappers, or runtime boundary delimiters.
- Static context uses `### Working set skills`, followed by ``When relevant, load with `skill_view` before proceeding:`` and `<working_set_skills>` containing the same compact skill elements. Never emit `<path>` elements; agents query paths and contents through `skill_list` and `skill_view`.
- QMD model configuration supports `provider/model` syntax to auto-resolve `baseUrl` and `apiKey`; `embedding.dimension` defaults to `1536`.

Skill root precedence is workshop → workspace → project `.agents/skills` → personal `.agents/skills` → managed → configured shared roots → plugin links → native bundled → package fallback. Duplicate names resolve to the first root. Never use another agent's workspace/workshop as a shared root implicitly.

Keep tool documentation aligned with `src/skills/tools.ts` and `src/skills/files.ts`: `skill_list` is paginated (150 default, 500 maximum); `skill_search` returns `skills`, not `results`, omits paths, and caps results at 100 (20 default); `skill_view` takes `file_path`, not `path`. `skill_experience` returns at most three bounded entries and uses catalog fallback without Jev.

Full registration owns background QMD refreshes and native-config normalization; discovery instances must not rebuild experience indexes. Preserve stable index identity across captured plugin generations. Lifecycle disposal stops refresh timers, disposes Review scheduling, and closes both indexes after active work finishes.

Conversation sanitization is a compatibility boundary for input, not a prompt-output format. It removes the current OpenClaw timestamp plus `Conversation info: ⟦openclaw:ctx⟧` fenced JSON envelope, legacy `Sender (untrusted metadata)` metadata, Skill Harness routing blocks, active-memory blocks, assembled-context wrappers, and OpenClaw internal runtime delimiters before recent-turn extraction. A user entry containing only runtime metadata sanitizes to empty; inter-session or internal task-completion user entries also suppress their following assistant payload. External user and assistant messages remain role-tagged. Retired session intent fields such as `recommendedSkills` are discarded on load; new turns persist top-level `matchedSkills`, `matchedExperiences`, `confidence`, and `inputSkillDiscovery`; `intentMatchedSkills` is retained only for reading historical intent state. Empty selections still represent routed turns for statistics and Review.

Production JSON I/O should use `readJsonFile()`, `writeJsonAtomic()`, or `safeWriteJson()` from `src/file-utils.ts`; do not recreate parsing or atomic-write behavior. Keep `src/plugin.ts` thin and place behavior in its owning domain. Verify uncertain OpenClaw SDK imports, hook payloads, and APIs against the installed package rather than guessing. Typecheck and unit tests do not prove that a running Gateway loaded the plugin; runtime claims require OpenClaw runtime inspection.

## Commit & Pull Request Guidelines

Use imperative Conventional Commit subjects such as `feat:`, `fix:`, `refactor:`, `test:`, or `docs:`, optionally scoped (`feat(qmd):`). Pull requests should explain behavior, risks, configuration/runtime impact, verification, and linked issues. Public behavior changes must update `README.md` and, when applicable, `openclaw.plugin.json`; maintenance-workflow changes must update `skills/skill-harness/**`.
