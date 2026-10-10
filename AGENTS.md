# Repository Guidelines

## Project Structure & Module Organization

This repository packages the `skill-harness` OpenClaw plugin. `index.ts` and `api.ts` are entry points; domains live in `src/` (`hooks/`, `classification/`, `skills/`, `session/`, `experiences/`, `qmd/`, `review/`, and `stats/`). Tests are colocated as `*.test.ts`. Bundled skill files and Python audits live under `skills/skill-harness/`. `src/config.ts` and `src/types.ts` define runtime defaults/types; `openclaw.plugin.json` defines the strict public plugin contract; `dist/` is untracked build output.

### Implementation map

Start with these implementation boundaries, then trace callers and colocated `*.test.ts` files with `rg`:

| Source                                                             | Responsibility                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `src/plugin.ts`, `index.ts`, `api.ts`                              | Registration, live configuration, lifecycle ownership, and SDK boundary.                              |
| `src/config.ts`, `src/types.ts`, `openclaw.plugin.json`            | Runtime defaults/types and the strict public configuration contract.                                  |
| `src/hooks/`                                                       | Turn eligibility, candidate discovery, prompt assembly, lifecycle events, and tool tracking.          |
| `src/classification/`                                              | Conversation sanitization, prompt rendering, and constrained Jev selection.                           |
| `src/skills/`, `src/experiences/`, `src/qmd/`                      | Visible skill roots/tools, experience validation/catalog, and managed search indexes.                 |
| `src/skills/relation-graph.ts`, `relation-import.ts`, `related.ts` | Graph replay/identity and publication, staged import/classification, and bounded candidate expansion. |
| `src/session/`, `src/stats/`                                       | Persisted turn state, retention, usage, and aggregate telemetry.                                      |
| `src/review/`, `src/subagent-runtime.ts`                           | Post-turn scheduling, isolated review execution, validation, and writeback.                           |
| `skills/skill-harness/`                                            | User-triggered maintenance procedures and report/validation helpers.                                  |

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

Runtime experiences live in decoupled multi-to-multi folders under `dataRoot/experiences/<id>/` containing required `summary.md`, `keywords.md`, and `body.md`, plus optional `skills.md`. Experiences and their QMD index are shared across agents: dynamic retrieval and `skill_experience` searches are not filtered by agent skill visibility. The tool accepts no `skills` filter; `show_skills` only filters displayed associations to visible names, and final injected skills are visibility-filtered; do not describe experiences as agent-private. Managed QMD indexes for skills and experiences reside respectively under `dataRoot/qmd/skills/` and `dataRoot/qmd/experiences/`. Review is disabled by default, uses only `experience-health-check` (with `intent-health-check` as configuration alias), `routing-uncertainty`, and `capability-fit`, writes schema-v8 state with compatible v7 migration, and runs embedded sessions with detached persistence while the host cleans only the temporary workspace.

Fresh schema-v7 `stats.json` records skill, tool, routing, projection, inventory, and daily telemetry. Current top-level selections do not create intents; per-intent route-reason aggregates are populated only when historical `state.intent.result` exists. Older stats schemas are rejected fail-open without migration or rewrite. QMD scores use retrieval hit scores; classifier scores use classifier confidence. The runtime-health report exposes aggregate inventory counts without agent or skill names.

The bundled `skills/skill-harness/SKILL.md` documents explicit user-triggered `experience` and `runtime-health` workflows. The reviewer subagent curates skill experiences autonomously on configured triggers. Capability-fit uses tool-call/tool-failure thresholds or inventory-selected skill epochs; a failed call is not evidence of verified recovery. The scheduler replaces pending candidates by agent/session, debounces for 30 seconds, bounds pending entries to 32, and serializes execution. Disposal cancels pending work. The bundled `references/` procedures and `scripts/runtime-health-audit.py` are user-invoked support resources; they must not recreate production routing or Review persistence.

Prompt injection follows a compact attribute layout to minimize prompt tokens:

- Plugin-owned `skills.workingSet` is the only static working-set source: `agents.<id>` precedes `defaults`, then workspace-only and workshop-only skills append in that order, controlled independently by `includeWorkspaceSkills` and `includeWorkshopSkills` (both default `true`). These flags affect automatic prompt additions, not discovery or explicitly named skills. When `skills.suppressNativeSkillPrompt` is enabled (default `true`), the plugin idempotently ensures `agents.defaults.skills` is `[]` and removes `agents.entries.*.skills` in `openclaw.json` on startup to suppress OpenClaw core's native automatic skill prompt without infinite reload loops; otherwise those lists are not a static source and are not normalized. Independently, `skills.suppressNativeExtraDirs` defaults to `true` and clears `skills.load.extraDirs`; use `skills.sharedRoots` for intentionally shared directories. Startup normalization belongs only to full registration and must stay idempotent. Static prompt injection uses `### Working set skills` / `<working_set_skills>`, filters unavailable names, and never renders paths.
- Dynamic context follows the turn timestamp with blank-line separation and one advisory header inside `<skill_harness_plugin>`. The header starts with `Inferred relevant skills and experiences from conversation`, `Inferred relevant skills from conversation`, or `Inferred relevant experiences from conversation`, according to the non-empty blocks; it labels the content advisory/non-user input and names the relevant loading tools. Keep the exact strings in `src/constants.ts` aligned with renderer tests.
- Inside `<skill_harness_plugin>`, experiences use `<matched_experiences>` with `<experience id="${id}" [skills="${skills}"]>`, containing only the summary; skills use `<matched_skills>` with `<skill name="${name}">`, containing the description. Escape interpolated values. Do not emit `<context_policy>`, `<skill_metadata>`, retired candidate wrappers, or runtime boundary delimiters.
- Static context uses `### Working set skills`, followed by ``When relevant, load with `skill_view` before proceeding:`` and `<working_set_skills>` containing the same compact skill elements. Never emit `<path>` elements; agents query paths and contents through `skill_list` and `skill_view`.
- QMD model configuration supports `provider/model` syntax to auto-resolve `baseUrl` and `apiKey`; `embedding.dimension` defaults to `1536`.

Skill root precedence is workshop → workspace → project `.agents/skills` → personal `.agents/skills` → managed → configured shared roots → plugin links → native bundled → package fallback. Resolve each name to its winning root before filtering automatic workspace/workshop additions. A disabled workshop winner must not fall back to a same-name workspace skill; explicit working sets still select the winner. Preserve explicit → workspace → workshop display order. Never use another agent's workspace/workshop as a shared root implicitly.

Keep tool documentation aligned with `src/skills/tools.ts` and `src/skills/files.ts`: `skill_list` is paginated (150 default, 500 maximum); `skill_search` returns `skills`, not `results`, omits paths, and caps results at 100 (20 default); `skill_view` takes `file_path`, not `path`. `skill_experience` requires `query`, accepts `limit` (5 default, clamped to 1–20) and `show_skills` (true default), and uses catalog fallback without Jev. Displayed associations are visibility-filtered without excluding experiences; false omits the skills field. Bodies are bounded to 2,000 code points each and 5,000 total; exhausted body budgets preserve entry metadata.

Full registration owns background QMD refreshes and native-config normalization; discovery instances must not rebuild experience indexes. Preserve stable index identity across captured plugin generations. Lifecycle disposal stops refresh timers, disposes Review scheduling, and closes both indexes after active work finishes.

Conversation sanitization is a compatibility boundary for input, not a prompt-output format. It removes the current OpenClaw timestamp plus `Conversation info: ⟦openclaw:ctx⟧` fenced JSON envelope, legacy `Sender (untrusted metadata)` metadata, Skill Harness routing blocks, active-memory blocks, assembled-context wrappers, and OpenClaw internal runtime delimiters before recent-turn extraction. A user entry containing only runtime metadata sanitizes to empty; inter-session or internal task-completion user entries also suppress their following assistant payload. External user and assistant messages remain role-tagged. Sessions containing retired intent fields such as `recommendedSkills` are rejected entirely on load, without migration; other unknown intent fields that pass validation are not automatically removed; new turns persist top-level `matchedSkills`, `matchedExperiences`, `confidence`, and `inputSkillDiscovery`; `intentMatchedSkills` is retained only for reading historical intent state. Empty selections still represent routed turns for statistics and Review.

Production JSON I/O should use `readJsonFile()`, `writeJsonAtomic()`, or `safeWriteJson()` from `src/file-utils.ts`; do not recreate parsing or atomic-write behavior. Keep `src/plugin.ts` thin and place behavior in its owning domain. Verify uncertain OpenClaw SDK imports, hook payloads, and APIs against the installed package rather than guessing. Typecheck and unit tests do not prove that a running Gateway loaded the plugin; runtime claims require OpenClaw runtime inspection.

## Commit & Pull Request Guidelines

Use imperative Conventional Commit subjects such as `feat:`, `fix:`, `refactor:`, `test:`, or `docs:`, optionally scoped (`feat(qmd):`). Pull requests should explain behavior, risks, configuration/runtime impact, verification, and linked issues. Public behavior changes must update `README.md` and, when applicable, `openclaw.plugin.json`; maintenance-workflow changes must update `skills/skill-harness/**`.

## Reliability boundaries

Entire skill directories may be symlinks outside the workspace. Use `src/skills/paths.ts` to confine main/support file reads, listings, and QMD snapshots to `realpath(skillDir)`. Allow internal links; reject external, broken, cyclic, and non-regular file targets. Keep existing relative-path and supported-directory rules; do not introduce external support allowlists.

Register the prompt hook with the schema maximum of 121,500 ms. Each turn uses the maximum enabled search budget plus Jev's `routing.timeoutMs` plus 1,500 ms (default 21,500 ms). Local timeout preserves completed static context. Check host `hookInvocation.assertActive()` and turn identity after asynchronous work and before mutations; stale work must not persist successful injection or duplicate terminal events.

Track QMD connection configuration separately from index fingerprints. Drain active search/update/embed operations before reopening the same database with current endpoints, credentials, expansion/Jev settings, or timeout. Block new operations during rotation and coalesce updates. Fail open if reopening fails, without reverting to old credentials; comparison information stays in memory. Preserve embedding model/dimension invalidation and discovery's no-rebuild boundary.

Count adoption only from successful complete `skill_view` responses or successful `read`/`exec` outputs with parseable frontmatter and a nonempty skill name. Exclude explicit errors, `success: false`, empty/unrecognizable output, and path-only inference; preserve same-turn deduplication at both hooks and session merge boundaries. Do not recalculate existing statistics; historical adoption can include old false positives.

QMD skill and experience snapshots must not generate identity sidecars. Full-registration refresh removes legacy `.identity.yml` and `.identity.json` files; both suffixes stay excluded from reference indexing. Preserve unchanged document mtimes, databases, index metadata, and agent mappings. Persist original skill names in the existing agent mapping; use their `safePathSegment()` values to resolve hashed names with fail-open rejection of unknown/ambiguous segments and agent visibility checks. Experience IDs come from paths and skills from the catalog. Experience fingerprints include the sidecar-free format so full registration refreshes once; discovery never migrates or rebuilds snapshots.

Skill-index GC is full-registration-only and shares the existing QMD refresh cadence. Catalog locking must cover mapping writes, lease registration, and reclamation; per-instance lifetime pins protect stores through close, including discovery, build, search, embedding, and rotation. Preserve all referenced indexes. Track unreferenced/retired-agent grace in `qmd/skills/gc.json` (24 hours each), reset orphan age on mapping publication or lease acquisition, and reread mappings before deletion. Invalid mappings, unknown lease ownership, symlinks, or busy builds must prevent deletion. Retire agent mappings only from a complete current runtime registry, not stale registration data or query inactivity. Shared active references preserve indexes; do not delete runtime experiences, sessions, stats, or Review state. Fully restart all old Gateway generations when deploying the lease protocol; pre-upgrade stores cannot be proven idle by the new protocol.

Release a lifetime lease only after its store closes successfully. A retired store close failure must retain the store and lease, log the failure, and allow maintenance of unrelated indexes to continue. Grace periods start on the first maintenance observation, not filesystem age; collection occurs on a subsequent eligible pass. `qmd.indexRefreshIntervalSeconds: 0` disables recurring maintenance, while startup maintenance remains enabled. Treat agent mappings, leases, and `gc.json` as managed runtime state, not disposable caches; no configuration/schema migration or telemetry reset is required for GC. Keep machine-specific deployment observations in private project notes, not repository documentation.

Discovery freshness belongs in the managed index search entrypoints so hooks and tools share the same behavior. Revalidate experience metadata against the latest catalog and embedding identity, and reread skill agent mappings/visible names on subsequent searches. Missing or invalid published state must fail open without a known-stale fallback; a later publication must recover in the same instance. Explicitly open discovery stores with `readOnly: true`; do not build, embed, publish mappings, or collect. Snapshot identity and visible names per acquired search operation. Reuse existing build/catalog locks and lifetime leases without nested catalog acquisition or holding catalog locks across store opening/model requests; drain operations before closing stores. Disposal must await discovery refresh/acquisition and retirement work.

Review output contracts require `operation` (create/refine/merge/delete) on new positive findings and keep the refine/merge/delete JSON examples and field types/limits aligned with the validator. Merge findings require distinct `sourceExperienceIds` (1–9 deleted existing entries) and `retainedExperienceId` (an existing survivor); targetExperienceIds includes all sources and only a changed survivor. Validate operation/file correspondence, full directory removal, and one finding per changed ID before writeback. Merge conflict checks include unchanged survivors. Persist operation/merge metadata in schema-v8 logs while accepting historical records without it; do not infer historical operation types. Schema rejection warnings expose only issue paths/codes/counts and the coarse reason, never rejected values, raw replies, or evidence. Expand nested union issues so diagnostics identify failing fields; union branches can also report alternative-shape failures. `missing-trigger-decision` means no valid decision survived for a requested trigger, not necessarily an absent `trigger` field. Preserve strict validation and detached persistence.

Experience skill associations are not required dependencies. Preserve eligibility for experiences with no associated skills or with all associated skills invisible to the invoking agent; only final injected skills are visibility-filtered. Do not add an experience filter based on these associations without revisiting this explicit tradeoff. Observe unusable-guidance cases before introducing dependency semantics; skill visibility alone does not establish tool availability or knowledge access isolation.

## Skill relation graph

Author skill relations are imported once into private ontology-v1.0.4-compatible
JSONL; runtime metadata is not a second relationship source. Keep the original
reason, direction, provenance and unverified status. The importer must not edit
fork skills, infer missing reasons, promote model scores to verified dependencies,
or treat removed metadata as a deletion request. Use explicit preflight,
limited-sample, full-classification and apply stages; paid model requests and
formal graph writes must remain separate. Checkpoint reuse requires matching
content identities, author evidence, model and classification version; invalid
scores fail validation. Apply rechecks current identities and delegates locked,
backed-up atomic graph publication to the graph domain. Do not log raw provider
errors, credentials or evidence. Private graph, backup, preflight and checkpoint
artifacts must never enter the package or repository. Removing only
`related-skills` must preserve imported identities; other metadata/body/source
changes disable affected edges. Upstream CLI file compatibility does not imply
its writer participates in plugin locking or enforces plugin validation.

Relation expansion is opt-in via `routing.skills.related.enabled` (default false,
live configuration). Expand only outgoing author declarations from the first
8 ranked original name/QMD candidates, one hop, round-robin, at most 2 new
skills per seed and 8 per turn; alphabetize targets and do not charge duplicates.
Require current visible winning identities and a nonempty original reason.
Keep all originals; never seed from experiences. Pass at most 2 reasons of 500
code points per target to the existing single Jev call, labeled unverified.
Do not introduce hard dependency/conflict rules, fabricated retrieval scores,
new selection thresholds or fallback injection. `relatedCandidates` is optional
session/event diagnostics; `related-declared` injection contributes to pool
counts only, never QMD or collection attribution. Do not recalculate old stats.

Keep graph implementation in `src/skills/relation-graph.ts`, import and fixed Jev
classification in `relation-import.ts`, and bounded routing expansion in
`related.ts`. Runtime tools never parse legacy declarations. Graph records use
five operations (create/update/delete/relate/unrelate), distinct from the six
relation labels. Preserve the pinned upstream fixture bytes and hash; its
path-specific whitespace exception is intentional. Compatibility tests check
validator error lists, not merely successful process exit, and use the existing
YAML parser without adding a Python runtime dependency.

Graph publication and plugin deployment are separate operations. Subsequent reads
refresh a changed graph; graph-backed tools work with automatic expansion off.
Verify deployed behavior through the intended agent's actual Gateway tools:
`skill_view`, paginated `skill_list(show_related: true)`, and
`skill_search(show_related: true)`. Preserve original predicate direction for
incoming edges. Do not infer graph failure from an empty search result or infer
automatic expansion from tool success. Validate routing separately with an
eligible turn, optional related candidate diagnostics and final selections;
Jev may reject any candidate. Do not enable the live switch for a read-only audit.

Graph node counts cover participating skills, not necessarily every visible
skill. Graphs, schemas, checkpoints and backups are private managed state outside
QMD GC/session cleanup; never delete them as disposable index caches. Keep
credentials in the execution environment or process memory and out of commands,
logs and artifacts. Record deployment-specific counts, paths, sample outcomes
and Gateway observations only in private project notes. Do not remove fork
metadata before verifying the formal graph through the invoking agent's tools.

## Experience validation helpers

For staged manual changes, build first, then run:

```bash
node skills/skill-harness/scripts/validate-experiences.mjs --experiences-dir /path/to/staged/experiences --visible-skills-file /path/to/private/visible-skills.json
```

The visibility JSON maps all configured agent IDs to complete visible skill-name
arrays. Validate in each agent context rather than extrapolating one agent's
inventory. Exit 0 means valid against the supplied map; exit 1 reports input or
experience errors without emitting bodies. This helper is read-only and imports
production validation from `dist/`. Summary/body limits are 240/12,000 Unicode
code points; keywords allow 12 entries of 64 code points each.

## Detailed tool contracts

- **`skill_list`** lists visible skills with pagination. Optional inputs: `offset` (default `0`), `limit` (default `150`, capped at `500`), `show_stats` and `show_related` (both default `false`). Returns `{ success, total, count, offset, limit, has_more, next_offset?, skills }`. Each skill includes `name`, `description`, `source`, and `path`, with optional `usage_stats` and `related_skills`.
- **`skill_search`** searches metadata, bodies, and references. Requires a non-empty `query` (trimmed and truncated to 1,000 Unicode code points). Optional inputs: `limit` (default `20`, capped at `100`), `show_evidence` (default `true`), `show_stats` and `show_related` (default `false`). Returns `{ success, query, total, count, limit, skills }`; each skill contains `name`, `description`, `source`, `score`, and requested optional evidence/statistics/relations. Search results omit paths; use `skill_list` or `skill_view` for paths. An unavailable index returns `success: false`.
- **`skill_view`** requires `name`; optional `file_path` reads a relative support file under `references/`, `templates/`, `scripts/`, `assets/`, or `examples/`. A full skill response includes `success`, `name`, `description`, `content`, `path`, `skill_dir`, `linked_files`, usage statistics, relations, source, and readiness. A support-file response includes `success`, `name`, `file`, `content`, `file_type`, and relations.
- **`skill_experience`** requires a non-empty `query` (at most 500 Unicode code points). Optional inputs: `limit` (default `5`, clamped to `1–20`) and `show_skills` (default `true`). Returns `{ success, entries }`; each entry includes `id`, `summary`, `keywords`, and `body`. When `show_skills` is true, `skills` contains only associations visible to the invoking agent, including an empty array when none are visible; when false, the field is omitted. The former `skills` input and `requested_skills` / `unavailable_skills` output fields have been removed. Bodies remain bounded to 2,000 code points each and 5,000 total; later entries retain their metadata with an empty body after the total budget is exhausted. Search tries QMD, then falls back to catalog search if no matches remain; it does not invoke Jev.

## Reviewer execution and curation

A trigger starts an investigation; it is not evidence by itself. The reviewer evaluates trigger-specific evidence, durability, scope, and existing coverage, then makes the smallest valid change or records a no-finding result. Review findings produce `targetKind: "skill-experience"` updates to create, refine, merge, or delete skill experiences.

Every requested trigger needs a valid positive or no-finding decision. Missing or malformed decisions are recorded as `schema-rejected`. The reviewer operates within a temporary workspace with enforced workspace-only access for filesystem tools. `exec` follows the host execution policy; this plugin does not add sandbox isolation. Every changed experience must have exactly one positive finding, and every declared target must change. New positive findings require `operation: "create" | "refine" | "merge" | "delete"`, checked against actual before/after files before writeback. Only changed entries are validated against eligible skills, so unrelated existing entries do not block updates. Writeback rejects concurrent changes to the same experience or a merge survivor, including an unchanged survivor and applies file removals as well as additions and edits.

Reviewer tools are `ls`, `read`, `write`, `edit`, `exec`, `skill_experience`, and `skill_search`. For every trigger, check existing experience coverage before creating an entry, prefer refining the existing ID for the same workflow, and return no finding when no concrete improvement is supported. Use `skill_experience` with `limit: 5` and read complete workspace files for likely matches; empty or bounded results do not prove coverage is absent. When skill applicability or terminology is unclear, use focused `skill_search` with `limit: 5`, evidence enabled, and statistics/relations disabled. Search snippets and scores are reference material, not execution evidence or complete workflows; an unavailable index does not prevent evidence-based review. Searches do not expand the eligible observed skills allowed in `skills.md`; if that list is empty, omit `skills.md` on created or modified entries. Filesystem tools retain workspace-only guards; the prompt restricts `exec` commands to experience maintenance in the temporary workspace.

The reviewer may merge substantially overlapping experiences after reading their full contents, preserving useful verified guidance in one existing ID and deleting redundant entries. Different applicability or prerequisites require separate entries. It may also delete experiences proven useless, obsolete, or wholly superseded, preferring correction when useful guidance remains; age, low usage, missing search hits, or invisible associations alone do not justify deletion. Merge findings require `sourceExperienceIds` (1–9 distinct existing IDs fully removed) and `retainedExperienceId` (one distinct existing ID that remains). `targetExperienceIds` contains all sources and the retained ID only when its files changed; no other targets are allowed. Other operations omit merge fields. Deletion requires removal of the full directory; merely emptying or editing its files is rejected. `exec` supports workspace maintenance and directory removal; the prompt prohibits external paths, skill source changes, and background processes.

The Review prompt includes refine, merge, and delete JSON examples with aligned field types/limits. Operation and merge metadata persist in schema-v8 `review.json`; existing v8 changes without operation metadata remain readable and are not reclassified. The runtime-health report counts new operations through its existing `byOperation` aggregate. Invalid findings emit warning-level schema issue paths and codes without rejected values or evidence text. `missing-trigger-decision` means no valid decision remained for a requested trigger; it can follow rejection of a finding that did contain `trigger`. Detached Review transcripts are not retained, so historical reason counts alone cannot identify the original invalid field. These diagnostics do not relax validation or guarantee successful experience learning.

Review scheduling uses `IntentReviewScheduler` to debounce runs after a turn finishes (default 30-second idle delay). A new candidate for the same agent/session replaces the previous pending candidate and resets its timer, with pending entries capped by LRU eviction (default 32 sessions). Before executing, the scheduler checks if the system is actively processing embedded runs (`isSystemActive`); if busy or another Review is in flight, review is postponed by a 30-second retry delay. Each scheduler runs at most one Review at a time. If OpenClaw Gateway is shutting down (`isDraining`), pending reviews abort immediately without executing. Review runs execute in the background detached from the hook scope (`runDetachedFromWorkScope`) with `sessionPersistence: "detached"`, and the host removes only the isolated temporary workspace in `finally` and does not explicitly call `deleteSession`.

## Telemetry interpretation and retention

Schema v7 starts a fresh telemetry cohort. Current turns record top-level selections, confidence, skill/tool usage, routing adoption, projection, inventory, and daily aggregates without creating an intent. Historical `state.intent.result` can still populate per-intent route reasons (`qmd-keyword`, `qmd-hybrid`, and `llm-classifier`) with count, average score, minimum score, and maximum score; those compatibility fields do not imply current intent classification. QMD evidence uses retrieval hit scores; selector confidence comes from Jev. `skillDiscovery` separately records input skill matching: name-match and QMD search candidates, QMD semantic-score distribution, collection hit distribution (`meta`, `body`, `references`) for retrieved candidates and final injected skills, pre-injection candidate and injection counts, fallback reasons, and duration summaries. It does not retain user requests, snippets, QMD explanations, or per-hit score lists. Per-day maps include the same aggregate input skill-match telemetry alongside intent outcomes, intent routing, intent-matched skill routing, and tool errors; top-level tool latency uses fixed `unknown`, `0-99`, `100-499`, `500-999`, `1000-4999`, and `5000+` millisecond buckets. Each daily attribution map permits 64 encoded `value:<trimmed-name>` keys and then aggregates further names into the reserved `__other__` key.

The runtime-health projection keeps one canonical `routing` block, one canonical `projection` block, and names retained processed events as `retainedProcessedEventCount`. It omits the duplicate `routingEffectiveness` / `projectionEfficiency` aliases and the internal `dailyDynamicKeyCardinality` diagnostic.

Schema v7 does not migrate or rewrite schema-v1 through schema-v6 files: older telemetry is rejected fail-open and remains untouched. Inventory observations are agent-scoped: source, winning-path and content fingerprints, observation times and counts, same-turn usage, and intent-matched skill opportunities form an epoch. Source, winner, content, or visibility-continuity changes begin a new epoch; the fingerprints remain internal and are never exposed by skill tools.

Rendered catalog sizes are Unicode code points, not provider-billed tokens.
Adoption is same-turn use, not task success or routing accuracy. Related metadata
and prose do not count as adoption. Projection eligibility can precede selector
failure; Review outcomes belong to `review.json`, not synthesized stats.
`inputSkillDiscovery.experienceRetrieval` records completion/unavailability/
timeout/failure, thresholds, returned IDs and semantic scores; compare it with
`matchedExperiences` to distinguish retrieval from selection.
Session cleanup preserves the ended main-session record and removes only expired
session JSON and embedded-agent `*.session.jsonl`, `*.session.trajectory.jsonl`,
and `*.session.trajectory-path.json` artifacts. Never delete unrelated transcripts
or root-level state during cleanup. Compatible Review v7 migration retains ordinary
processed events and placement epochs, discarding retired keyword-learning fields;
malformed/older logs fail open.

## Advanced relation import procedure

The one-time importer accepts YAML objects/arrays and JSON strings in
`metadata.related-skills`. It does not edit skill files. Build first, then run
these stages separately from the package root, substituting your own paths:

```bash
pnpm run build
node skills/skill-harness/scripts/import-skill-relations.mjs preflight --source /path/to/skills --output /private/import-plan.json
node skills/skill-harness/scripts/import-skill-relations.mjs sample --source /path/to/skills --config /path/to/openclaw.json --checkpoint /private/import-checkpoint.json
node skills/skill-harness/scripts/import-skill-relations.mjs classify --source /path/to/skills --config /path/to/openclaw.json --checkpoint /private/import-checkpoint.json
node skills/skill-harness/scripts/import-skill-relations.mjs apply --source /path/to/skills --checkpoint /private/import-checkpoint.json --data-root /path/to/plugin-data
```

Preflight makes no model requests and reports unresolved targets and estimated
request count. Sample classifies the first at most 20 relations in the importer's stable order; it is not a random or representative sample. Classify explicitly runs
the full catalog, reusing successful matching checkpoint entries and retrying
failed batches. Sample/classify use the configured plugin Jev model and can
incur provider charges. The CLI must receive the same provider environment
variables as the Gateway; reading its config file does not hydrate service-only
secrets. No credentials are written to checkpoints. Each request
contains at most five relations, with at most two concurrent requests. Missing
author reasons bypass the model and remain `related`; other classifications
require a top score of at least 0.8 and a lead of at least 0.15. Failed model
batches remain `related` and are reported in the checkpoint. These thresholds
select a label, not a verified dependency.

Inspect the private plan/checkpoint before apply. They contain skill paths,
author reasons and bounded evidence and must not be committed or shared as
public artifacts. Apply verifies the current skill identities, backs up an
existing graph, and publishes the operation batch atomically under a lock.
Identical reapplication does not duplicate edges. Other owners' relations are
not overwritten; reported conflicts require separate resolution. No model
requests are made by apply. Keep the source metadata until graph import and
agent-visible tool output have been verified; removing only `related-skills`
thereafter does not invalidate imported identities. Changes to other metadata,
body content or winning source disable affected edges until explicitly reviewed
and reimported. The graph is not periodically synchronized with source metadata.

A missing or invalid graph leaves ordinary routing working without relations;
runtime tools do not fall back to legacy metadata relationships. Do not edit the
formal graph with the upstream ontology CLI while the plugin/importer may be
writing: its writer does not participate in plugin locks. Keep graph backups and
checkpoints outside the package. Importing a graph does not enable automatic
relation expansion or deploy the plugin; `routing.skills.related.enabled`
defaults to `false` so relation experiments can be observed separately from
experience-quality changes.

Relation labels are `related`, `depends_on`, `composes_with`,
`similar_to`, `conflicts_with`, and `specializes`; an empty reason is visible in
tools but cannot seed expansion. Incoming `depends_on` means the other skill
points to the current skill; never reverse its predicate.

## Configuration migration and runtime acceptance

Keep lesser-used configuration aligned with `src/config.ts` and the manifest:
name matching defaults to `maxEditDistance: 2`, `minJaccardScore: 0.5`, and an
empty `genericTokens` list; generic tokens suppress only single-token automatic
matches. Recent context defaults to five turns and 1,000 characters per role.
Review model resolution is configured model → session model → agent primary →
configured fallback. Selection has no fallback retries. Audit `--days` accepts
1–90 and compares the last seven complete UTC days with the preceding seven;
retained sessions normally cover about 14 days. Unsupported present schemas fail
the audit; absent sections are unavailable. Review reports cover completed events,
not queue/running state; QMD injected-skill aggregates include experience-source
skills and do not measure pure skill-search conversion.

Remove the entire legacy `instruction: { ... }` block from plugin configuration;
there is no automatic migration or compatibility parser for this retired setting.

Older deployments must add mandatory `qmd.embedding`, `qmd.expansion`, and
`jev.model` before loading this version. Remove retired `instruction`, `rerank`,
and legacy routing fields; the compatibility parser does not override strict
manifest rejection. Migrate native static selections into `skills.workingSet`
and intentionally shared `skills.load.extraDirs` into `skills.sharedRoots`
before enabling default startup normalization. Prepare configuration changes,
preconditions, Gateway restart impact and rollback together; apply only within
the user's authorized scope. Do not reset telemetry or delete indexes as a
routine upgrade step.

Use `openclaw gateway status --deep --require-rpc`,
`openclaw plugins inspect skill-harness --runtime --json`, and
`openclaw plugins doctor` for runtime acceptance. Cold plugin inventory and local
build/test results do not establish that the Gateway loaded the changed build.
Verify actual tools through the intended agent. Keep deployment observations
and reports in private notes rather than README or AGENTS.

## Documentation boundaries

The private project note is `~/productivity/projects/ai/skill-harness.md`
(`/home/wei/productivity/projects/ai/skill-harness.md`). Keep project status,
deployment observations, runtime audit results, and research follow-ups there;
keep private runtime data out of repository documentation.

README introduces the project, research context, architecture, behavior and user
setup. Keep coding-agent contracts, schema migrations, concurrency, persistence,
source maps and contributor checks here. User-triggered maintenance procedures
belong in `skills/skill-harness/`. Research references explain design context;
do not claim paper benchmark results as this plugin's measurements or imply that
related-work algorithms are implemented without source evidence.
