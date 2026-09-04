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

For Python audit helpers, run their adjacent unittest files directly, for example `python3 skills/skill-harness/scripts/test-runtime-health-audit.py`.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports, two-space indentation, and `.js` extensions in relative imports. Use `camelCase` for values/functions, `PascalCase` for types/classes, and descriptive kebab-case filenames. Prefer `interface` for object shapes and `type` for unions; use `import type` for type-only imports. Treat external input as `unknown` and narrow it instead of using `any`. Keep modules domain-focused and runtime boundaries fail-open. Let Prettier define layout. Python uses four-space indentation and `snake_case`.

## Testing Guidelines

Use Vitest globals in colocated `<module>.test.ts` files. Cover contracts, failures, and boundary validation; no numeric coverage target exists. Behavioral changes require focused regressions. Before handoff, run typecheck, tests, and build; package-facing changes also require loader and dry-pack checks.

## Runtime & Agent-Specific Rules

Keep package assets separate from runtime state. `skills/skill-harness/assets/` contains first-install examples; live intents, sessions, experiences, and statistics belong under `~/.openclaw/plugins/skill-harness/`. Never include that private data in commits.

The dynamic routing pipeline is structured in three stages: Step 1 (QMD Keyword BM25 over intent `keywords`), Step 2 (QMD Hybrid Trigger/Example Search with conversation expansion), and Step 3 (Fallback single-call Intent Classifier with QMD candidates). Topic checkers (`previousTopic`), runtime task complexity scoring (`complexity`), classifier `suggestion` fields, session curation (`curation` / `curationAppliedCount`), instruction writers, and legacy `fastpath` / `candidate` frontmatter fields are obsolete and strictly forbidden. Projection reasons use `exact-keyword-overlap`. Intent YAML frontmatter only permits `triggers`, `examples`, `domain`, `skills`, and `keywords` formatted in canonical key order (`domain`, `triggers`, `examples`, `keywords`, `skills`) with skill names strictly lowercase; the body is strictly single-line plain-text routing `guidance`.

Prompt injection follows a compact attribute layout to minimize prompt tokens:

- Dynamic context uses the `[Skill Harness Context (advisory, non-user input)]:` header and `[User Message]:` boundary. Inside `<skill_harness_plugin>`, the selected intent merges name and guidance as `<intent name="${intent}">\n  ${guidance}\n</intent>`, candidate skills render as `<skill name="${name}">\n  ${description}\n  ${experiences}\n</skill>`, and `<context_policy>` is omitted.
- Static configured skills context uses markdown header `### Configured skills` with guidance `Review and apply when relevant:`, wrapping skills as `<configured_skills>\n  <skill name="${name}">\n  ${description}\n</skill>\n</configured_skills>`. `<path>` elements are not emitted in prompt context; agents query paths and file contents on demand via `skill_list` and `skill_view`.
- QMD model configuration supports `provider/model` syntax to auto-resolve `baseUrl` and `apiKey`; `embedding.dimension` defaults to `1536`.

Production JSON I/O should use `readJsonFile()`, `writeJsonAtomic()`, or `safeWriteJson()` from `src/file-utils.ts`; do not recreate parsing or atomic-write behavior. Keep `src/plugin.ts` thin and place behavior in its owning domain. Verify uncertain OpenClaw SDK imports, hook payloads, and APIs against the installed package rather than guessing. Typecheck and unit tests do not prove that a running Gateway loaded the plugin; runtime claims require OpenClaw runtime inspection.

## Commit & Pull Request Guidelines

Use imperative Conventional Commit subjects such as `feat:`, `fix:`, `refactor:`, `test:`, or `docs:`, optionally scoped (`feat(qmd):`). Pull requests should explain behavior, risks, configuration/runtime impact, verification, and linked issues. Public behavior changes must update `README.md` and, when applicable, `openclaw.plugin.json`; maintenance-workflow changes must update `skills/skill-harness/**`.
