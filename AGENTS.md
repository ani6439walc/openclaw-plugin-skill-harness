# Repository Guidelines

## Project Structure & Module Organization

This repository packages the `skill-harness` OpenClaw plugin. `index.ts` and `api.ts` are entry points; domains live in `src/` (`hooks/`, `classification/`, `skills/`, `session/`, `qmd/`, `review/`, and `stats/`). Tests are colocated as `*.test.ts`. Developer maintenance CLIs and their Node.js regression suites live under `scripts/`; this package ships no maintenance skill. `src/config.ts` and `src/types.ts` define runtime defaults/types; `openclaw.plugin.json` defines the strict public plugin contract; `dist/` is untracked build output.

### Implementation map

Start with these implementation boundaries, then trace callers and colocated `*.test.ts` files with `rg`:

| Source                                                             | Responsibility                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `src/plugin.ts`, `index.ts`, `api.ts`                              | Registration, live configuration, lifecycle ownership, and SDK boundary.                              |
| `src/config.ts`, `src/types.ts`, `openclaw.plugin.json`            | Runtime defaults/types and the strict public configuration contract.                                  |
| `src/hooks/`                                                       | Turn eligibility, candidate discovery, prompt assembly, lifecycle events, and tool tracking.          |
| `src/classification/`                                              | Conversation sanitization, prompt rendering, and constrained Decision selection.                      |
| `src/skills/`, `src/qmd/`                                          | Visible skill roots, tools and managed skill search indexes.                                          |
| `src/skills/relation-graph.ts`, `relation-import.ts`, `related.ts` | Graph replay/identity and publication, staged import/classification, and bounded candidate expansion. |
| `src/session/`, `src/stats/`                                       | Persisted turn state, retention, usage, and aggregate telemetry.                                      |
| `src/review/`, `src/subagent-runtime.ts`                           | Post-turn scheduling, isolated review execution, validation, and writeback.                           |
| `scripts/`                                                         | Explicit maintenance, runtime-health reporting, and relation-import CLIs.                             |

## Build, Test, and Development Commands

Use the pnpm release declared by `package.json#packageManager`. This field is the
single version source for local development and `pnpm/action-setup`; update it
instead of duplicating a version in workflow YAML.

- `pnpm install --frozen-lockfile`: install dependencies.
- `pnpm run typecheck`: check TypeScript without emitting.
- `pnpm run test`: run Vitest.
- `pnpm run test:maintenance`: run the runtime-health audit regression suite after building.
- `pnpm run build`: compile ESM and declarations to `dist/`.
- `pnpm run test:plugin-loader`: verify the built entry loads.
- `pnpm run format`: apply Prettier to Markdown, JSON, TypeScript and the maintained CLI files.
- `pnpm pack --dry-run`: inspect package contents for stale artifacts.
- `pnpm exec prettier --check README.md AGENTS.md`: check formatting for these documents without formatting unrelated files.
- `node scripts/test-runtime-health-audit.mjs`: run the report-only runtime-health audit helper tests.

Use Node.js 26.12.1 or later; the pinned QMD release requires Node.js 26. CI uses Node.js 26 and runs formatting, typecheck, Vitest, the maintenance regression suite, build, loader, and dry-pack checks. `pnpm run build` prunes `dist/` before invoking `tsc`; inspect the actual tarball before handoff of package changes.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports, two-space indentation, and `.js` extensions in relative imports. Use `camelCase` for values/functions, `PascalCase` for types/classes, and descriptive kebab-case filenames. Prefer `interface` for object shapes and `type` for unions; use `import type` for type-only imports. Treat external input as `unknown` and narrow it instead of using `any`. Keep modules domain-focused and runtime boundaries fail-open. Let Prettier define layout. Python uses four-space indentation and `snake_case`.

## Testing Guidelines

Use Vitest globals in colocated `<module>.test.ts` files. Cover contracts, failures, and boundary validation; no numeric coverage target exists. Behavioral changes require focused regressions. Before handoff, run typecheck, tests, and build; package-facing changes also require loader and dry-pack checks.

Plugin fixtures must collect every instance's lifecycle disposal callback,
including callbacks observed through test-specific lifecycle spies. Await all
disposals before removing temporary roots or restoring mocks and clocks. Assert
zero fake timers before restoring real timers; do not use `clearAllTimers()` to
hide workers from earlier fixtures that can still schedule retries.

## Runtime & Agent-Specific Rules

Keep live sessions, skill indexes, relation graphs, Review logs and statistics under the private plugin data root. Exclude production data from commits and packages.

The public manifest requires `qmd.embedding.model` and `qmd.expansion.model`. The `qmd.jev` and plugin `decisionModel` endpoint objects are optional; each requires a nonempty `model` when present, with optional `baseUrl` and `apiKey`. Keep examples valid against the manifest, not just the more permissive compatibility parser in `resolveConfig()`. Selection uses `routing.timeoutMs` (default 5,000 ms; host capped at 30,000 ms); candidate searches use their separate search budgets, defaulting to `qmd.timeoutMs`. Invalid manifest configuration can prevent loading; runtime fail-open behavior does not bypass host validation.

Automatic selection resolves the agent's host `decisionModel` string, then `agents.defaults.decisionModel`, then plugin `decisionModel`. An explicit empty/whitespace agent string suppresses the global default; absent, null, or non-string values allow inheritance. All host requests carry owning `agentId`, including globally inherited selections. Once selected, host unavailable/timeout/error/invalid output never retries through the plugin endpoint. Do not substitute the conversational model. Host calls use public Decision V1 options without `model` or `thinking`. Plugin fallback uses the existing TypeSafe transport with Boolean/noul conversion and no automatic retries.

Skills and bounded relations share one full evaluation per eligible turn; hook rebuilds share that turn's in-flight/terminal result, including failures and cancellation. Empty candidate pools skip client creation and credential resolution. Validate the full batch (256 questions, 1 MiB JSON, 20,000 nodes, depth 32); reject unsupported input without truncating candidates or splitting requests. Deadlines and lifecycle shutdown abort selection and drain accepted work. Preserve hook/turn/generation checks before mutation; diagnostic strings expose only fixed routes/reasons/codes and aggregate counts/timing.

`qmd.jev` is QMD-only. Plugin `decisionModel` independently serves the selector and explicit manual relation importer; no copying or cross-fallback exists. Both preserve provider/model, provider-catalog, environment, and supported SecretRef resolution. Invalid present endpoint objects must fail open at the runtime caller; the strict manifest accepts only `qmd.jev` and `decisionModel`. `buildStoreModels()` consumes only resolved QMD configuration. Changing plugin `decisionModel` must not rotate stores or alter index identity. Changing `qmd.jev` preserves drain/reopen and embedding fingerprint behavior. Managed searches retain `rerank: false`; expansion uses `qmd.expansion`. Native QMD Jev expansion compatibility and `TYPESAFE_*` environment sources remain available when `qmd.jev` is omitted; omission is not a total disable.

Direct skill discovery combines bounded typo-aware name matching (strip URLs before tokenization) and `SkillQmdIndex` retrieval over metadata, bodies and references (`minCandidateScore` defaults to 0.6). Expand the visible candidates from those original hits using bounded graph relations. Score the candidates once through the selected adapter, retain visible names that meet the relevance threshold, sort by score with UTF-16 name order for ties, and cap the result at `maxInjectedSkills`. A zero limit skips dynamic discovery. Failed selection leaves static working-set guidance available.

Do not use OpenClaw core's reserved `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` delimiters in plugin prompt output as core runtime logic strips them from visible turns; these delimiters are sanitizer-only input boundaries.

The managed skill index lives under `dataRoot/qmd/skills/`. `review.enabled` controls automatic relation checks and defaults to false. `review.triggers.relationHealthCheck.everyTurns` is the only cadence setting (default 10). Count distinct completed turns per session with a final skill recommendation or successful load. A qualifying turn increments the count once even with multiple skills or repeated finalization. A turn without skills leaves the count unchanged.

Schema-v7 `stats.json` records skill, tool, routing, projection, inventory, and daily telemetry. Unsupported stats schemas are rejected fail-open without migration or rewrite. QMD scores use retrieval hit scores; classifier scores use classifier confidence. The runtime-health report exposes aggregate inventory counts without agent or skill names.

See [Relation Review execution](#relation-review-execution) for scheduling and disposal. The `scripts/` CLIs are explicitly invoked maintenance resources; they must not recreate production routing or Review persistence.

Prompt injection follows a compact attribute layout to minimize prompt tokens:

- Plugin-owned `skills.workingSet` is the only static working-set source: `agents.<id>` precedes `defaults`, then workspace-only and workshop-only skills append in that order, controlled independently by `includeWorkspaceSkills` and `includeWorkshopSkills` (both default `true`). These flags affect automatic prompt additions, not discovery or explicitly named skills. When `skills.suppressNativeSkillPrompt` is enabled (default `true`), the plugin idempotently ensures `agents.defaults.skills` is `[]` and removes `agents.entries.*.skills` in `openclaw.json` on startup to suppress OpenClaw core's native automatic skill prompt without infinite reload loops; otherwise those lists are not a static source and are not normalized. Independently, `skills.suppressNativeExtraDirs` defaults to `true` and clears `skills.load.extraDirs`; use `skills.sharedRoots` for intentionally shared directories. Startup normalization belongs only to full registration and must stay idempotent. Static prompt injection uses `### Working set skills` / `<working_set_skills>`, filters unavailable names, and never renders paths.
- Dynamic context follows the turn timestamp with blank-line separation. When skills qualify, emit the advisory header from `src/constants.ts` inside `<skill_harness_plugin>`. It identifies advisory content and names `skill_view`.
- Emit `<matched_skills>` containing `<skill name="${name}">`, the description and relevant scored relations. Escape all interpolated text and attributes. When no skills qualify, omit the dynamic block.
- Static context uses `### Working set skills`, followed by ``When relevant, load with `skill_view` before proceeding:`` and `<working_set_skills>` containing the same compact skill elements. Never emit `<path>` elements; agents query paths and contents through `skill_list` and `skill_view`.
- QMD model configuration supports `provider/model` syntax to auto-resolve `baseUrl` and `apiKey`; `embedding.dimension` defaults to `1536`.

Skill root precedence is workshop → workspace → project `.agents/skills` → personal `.agents/skills` → managed → configured shared roots → plugin links → native bundled. Low-level callers may explicitly supply a final package fallback root; this plugin registers none. Resolve each name to its winning root before filtering automatic workspace/workshop additions. A disabled workshop winner must not fall back to a same-name workspace skill; explicit working sets still select the winner. Preserve explicit → workspace → workshop display order. Never use another agent's workspace/workshop as a shared root implicitly.

Keep the [tool contracts](#detailed-tool-contracts) aligned with `src/skills/tools.ts` and `src/skills/files.ts`.

Full registration owns skill index refreshes and native-config normalization. Discovery opens published indexes read-only. Preserve stable index identity across captured plugin generations. On disposal, stop refresh timers, cancel Review scheduling, drain active work and close the index.

Capture the owning instance's public `api.lifecycle.runInBackgroundContext`
when installing background resources, and use it again for each timer callback.
Return the callback's asynchronous work to the host so it remains instance-owned;
never inspect private OpenClaw globals or manually exit host AsyncLocalStorage.
Stop background admission and cancel pending work on `gateway_stop` and lifecycle
disposal, propagate abort signals, and await active work before closing indexes.
Gateway admission remains authoritative during restart draining; handle its
rejection without probing private drain-state fields.

Conversation sanitization is a compatibility boundary for input, not a prompt-output format. It removes the current OpenClaw timestamp plus `Conversation info: ⟦openclaw:ctx⟧` fenced JSON envelope, `Sender (untrusted metadata)` metadata, Skill Harness routing blocks, active-memory blocks, assembled-context wrappers, and OpenClaw internal runtime delimiters before recent-turn extraction. A user entry containing only runtime metadata sanitizes to empty; inter-session or internal task-completion user entries also suppress their following assistant payload. External user and assistant messages remain role-tagged. Invalid session records are rejected on load without migration; turns persist top-level `matchedSkills`, `confidence`, and `inputSkillDiscovery`. Empty selections still represent routed turns for statistics. Review cadence counts completed turns with final recommended skills or successfully loaded skills.

Production JSON I/O should use `readJsonFile()`, `writeJsonAtomic()`, or `safeWriteJson()` from `src/file-utils.ts`; do not recreate parsing or atomic-write behavior. Keep `src/plugin.ts` thin and place behavior in its owning domain. Verify uncertain OpenClaw SDK imports, hook payloads, and APIs against the installed package rather than guessing. Typecheck and unit tests do not prove that a running Gateway loaded the plugin; runtime claims require OpenClaw runtime inspection.

## Commit & Pull Request Guidelines

Use imperative Conventional Commit subjects such as `feat:`, `fix:`, `refactor:`, `test:`, or `docs:`, optionally scoped (`feat(qmd):`). Pull requests should explain behavior, risks, configuration/runtime impact, verification, and linked issues. Public behavior changes must update `README.md` and, when applicable, `openclaw.plugin.json`; maintenance-workflow changes must update this guide and the affected `scripts/*.mjs` CLIs and tests.

## Reliability boundaries

For skill index format changes, preserve the database and WAL/SHM, agent mappings, metadata and leases in a consistent offline backup before rollout. Restore the compatible backup if rollback requires an older vector layout. Open skill stores with the complete snapshot collection definitions. Keep read-only discovery separate from full-registration writes.

Entire skill directories may be symlinks outside the workspace. Use `src/skills/paths.ts` to confine main/support file reads, listings, and QMD snapshots to `realpath(skillDir)`. Allow internal links; reject external, broken, cyclic, and non-regular file targets. Keep existing relative-path and supported-directory rules; do not introduce external support allowlists.

Register the prompt hook with the schema maximum of 121,500 ms. Each turn uses the enabled skill search budget plus the selector's `routing.timeoutMs` plus 1,500 ms (default 21,500 ms). Local timeout preserves completed static context. Check host `hookInvocation.assertActive()` and turn identity after asynchronous work and before mutations; stale work must not persist successful injection or duplicate terminal events.

Track QMD connection configuration separately from index fingerprints. Drain active search/update/embed operations before reopening the same database with current endpoints, credentials, expansion/Jev settings, or timeout. Block new operations during rotation and coalesce updates. Fail open if reopening fails, without reverting to old credentials; comparison information stays in memory. Preserve embedding model/dimension invalidation and discovery's no-rebuild boundary.

Count adoption only from successful complete `skill_view` responses or successful `read`/`exec` outputs with parseable frontmatter and a nonempty skill name. Exclude explicit errors, `success: false`, empty/unrecognizable output, and path-only inference; preserve same-turn deduplication at both hooks and session merge boundaries. Do not recalculate existing statistics; historical adoption can include old false positives.

QMD skill snapshots must not generate identity sidecars; `.identity.yml` and `.identity.json` stay excluded from reference indexing. Preserve unchanged document mtimes, databases, index metadata, and agent mappings. Persist original skill names in the existing agent mapping; use their `safePathSegment()` values to resolve hashed names with fail-open rejection of unknown/ambiguous segments and agent visibility checks. Discovery reads published snapshots without migrating or rebuilding them.

Skill-index GC is full-registration-only and shares the existing QMD refresh cadence. Catalog operations queue FIFO per coordinator before the one-second external lock wait. Zero-wait maintenance skips a busy queue. Catalog locking must cover mapping writes, lease registration, and reclamation; per-instance lifetime pins protect stores through close, including discovery, build, search, embedding, and rotation. Preserve all referenced indexes. Track unreferenced/retired-agent grace in `qmd/skills/gc.json` (24 hours each), reset orphan age on mapping publication or lease acquisition, and reread mappings before deletion. Invalid mappings, unknown lease ownership, symlinks, or busy builds must prevent deletion. Retire agent mappings only from a complete current runtime registry, not stale registration data or query inactivity. Shared active references preserve indexes; do not delete sessions, stats, or Review state.

Release a lifetime lease only after its store closes successfully. A retired store close failure must retain the store and lease, log the failure, and allow maintenance of unrelated indexes to continue. Grace periods start on the first maintenance observation, not filesystem age; collection occurs on a subsequent eligible pass. `qmd.indexRefreshIntervalSeconds: 0` disables recurring maintenance, while startup maintenance remains enabled. Treat agent mappings, leases, and `gc.json` as managed runtime state, not disposable caches; no configuration/schema migration or telemetry reset is required for GC. Keep machine-specific deployment observations in private project notes, not repository documentation.

Discovery freshness belongs in the managed index search entrypoints so hooks and tools share the same behavior. Reread skill agent mappings and visible names on subsequent searches. Missing or invalid published state must fail open without a known-stale fallback; a later publication must recover in the same instance. Explicitly open discovery stores with `readOnly: true`; do not build, embed, publish mappings, or collect. Snapshot identity and visible names per acquired search operation. Reuse existing build/catalog locks and lifetime leases without nested catalog acquisition or holding catalog locks across store opening/model requests; drain operations before closing stores. Disposal must await discovery refresh/acquisition and retirement work.

Review schema rejection warnings expose issue paths, codes, counts and a coarse reason. Expand nested union issues to identify failing fields. Omit rejected values, raw replies and evidence text. The parent stamps the fixed `relation-health-check` trigger on accepted findings.

## Skill relation graph

Review may automatically create, update and delete both imported author relations
and its own relations in the private graph. Preserve author reasons/provenance on
import; subsequent Review revisions must preserve the original operations in
history rather than treating their current reason/type as immutable. Relation
inspection seeds are final `matchedSkills` union successfully loaded skills,
filtered to current visible winning identities. Count adoption only on successful loads. Use the relation-health cadence, one-hop evidence preparation with at most eight extra visible
skills, and at most eight ordered-pair changes per run.

The parent stages confined full `SKILL.md` snapshots (256 KiB per file, 2 MiB
total). Relation proposals must cite exact line ranges/quotes from both endpoints,
touch an original seed and stay inside the parent-admitted manifest. Skill content can
justify changes without an execution trial; recommendation/search scores or
co-loading alone cannot. Prefer specific documented types (`depends_on`,
`composes_with`, `specializes`, `conflicts_with`, `similar_to`) over generic
`related`, treat `related` as a last resort, and upgrade overly broad existing
`related` edges when both endpoints support a narrower predicate. Require
explicit necessity for `depends_on` (do not stretch `composes_with` into
`depends_on`); deletion requires contradiction, duplication or supersession,
not lack of usage or search hits. Do not introduce confidence levels or restore
verification-status fields.

Prepare at most four existing-neighbor attempts, rotating a sorted neighbor list with a persisted cursor keyed by the captured seed-ID group. Keep at most 256 cursor entries in `review.json`; advance only in the same locked atomic write as a new event. This rotates preparation, not proven model attention, and does not guarantee coverage when groups or catalogs change. Do not derive cursors from unbounded event history.

Discovery belongs to the reviewer: at most four `skill_search` calls per run, then `skill_view` admits chosen visible registered endpoints under the shared eight-extra-attempt budget. Preserve failed-attempt accounting, repeated-read snapshot identity, and 256 KiB/file plus 2 MiB aggregate evidence limits. Admission must serialize, check cancellation around I/O, and capture new pair revisions without refreshing previously observed pairs. Support files and ineligible reads are not relation evidence; no automatic source registration occurs.

Use public run `toolBindings` with only a structured-cloneable descriptor (version, random token, and exact agent/session identity). The host clones and fingerprints these values: never transport callback functions. Keep callbacks in a registry owned by one plugin registration and inject that same registry through hooks/runner and registered tools. Validate descriptor ownership and registry membership; reject unknown, cross-registration or closed bindings without a normal-tool fallback. Keep lifetime authority in the origin closure and close the registry during plugin disposal. Close admission and drain accepted work before validation or workspace cleanup. Review `skill_view` bypasses usage writes and marks results `review_inspection`; adoption extraction rejects that marker. Normal tool behavior remains unchanged. Do not depend on tool hooks receiving `toolBindings`.

Eligible runs require independent existing/discovery assessments consistent with proposed operations. Persist those assessments separately from publication receipts. Store preparation status, reasons, counts and bounded search counts. The writer accepts only strict schema-v9 Review logs and preserves unsupported or malformed files. See [runtime configuration and acceptance](#runtime-configuration-and-acceptance) for deployment validation.

Keep formal Review writes in the graph domain. Under the graph lock, recheck
current source bindings, visible winners, exact evidence bytes/fingerprints and
each targeted pair's latest operation revision, including absent/deleted targets.
Reject the complete graph batch on a conflict, but allow unrelated graph edits.
Publish by atomic replacement of unchanged old JSONL plus all new operations:
create uses `relate`, update uses `unrelate` plus `relate`, delete uses `unrelate`.
Operation-level `review` metadata retains batch/event/agent IDs, time, rationale,
exact evidence/digests and the previous relation. Retain imported `sourceGraphDigest`
on updates. Never compact Review history implicitly. Normal incremental
imports protect all reviewed ordered pairs across types, including tombstones;
ontology full-import preflight rejects reviewed destination history. Explicit
snapshot maintenance remains a separate backed-up replacement path.

Validate the proposed batch against the staged manifest. Only the parent publishes to the graph. After a commit, retain the graph receipt through cancellation and persist the changed count and batch ID.

Author skill relations are imported once into private ontology-v1.0.4-compatible
JSONL; runtime metadata is not a second relationship source. Keep the original
reason, direction and provenance; author assertions remain advisory rather than
verified prerequisites. The importer must not edit
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

Relation expansion and relation scoring are always active when usable graph
evidence exists; there is no enable switch. Expand only outgoing declarations from the first
8 ranked original name/QMD candidates, one hop, round-robin, at most 2 new
skills per seed and 8 per turn. Count only newly added targets toward those limits.
Require current visible winning identities and a nonempty original reason.
Use canonicalIdentity() for graph/visibility lookups, expansion deduplication
and self comparisons; preserve original names in output.
Keep all original name and QMD hits. Pass at most 2 reasons of 500
code points per target to the existing single Decision call, described as
reference assertions.
Do not introduce hard dependency/conflict rules, fabricated retrieval scores,
new skill selection thresholds or fallback injection. `relatedCandidates` is optional
session/event diagnostics; `related-declared` injection contributes to pool
counts only, never QMD or collection attribution. Do not recalculate old stats.

Both expansion and relevance scoring prioritize `depends_on`, `composes_with`,
`specializes`, `conflicts_with`, `similar_to`, and `related` in that order.
Unrecognized types rank last. Within the same type,
Review provenance comes before author imports and unspecified sources. Break
remaining ties with locale comparison of the neighbor name, direction, then
relation type. Apply this order within each expansion seed or scoring candidate
before enforcing its limits.

Collect relation relevance evidence independently
from candidate expansion: at most two incoming/outgoing relations per candidate,
16 questions total, distributed round-robin across candidates. Preserve the
original `from`/`to` and anchor each relation to the candidate being described.
Both endpoints require current visible winning
identities and a nonempty relation reason. Include each endpoint's name and
bounded description (1,000 code points) even if the other endpoint is not a
candidate. That background endpoint does not become a candidate, receive its own
skill question, or consume an injection slot. Reasons are bounded to 500 code
points. All six predicates remain unverified advisory evidence.

The Decision state carries `skill_candidates` with name, description, discovery sources and relation IDs. `skill_relation_evidence` provides the corresponding question ID (`relation_0`, etc.), anchor, direction and bounded endpoint evidence. Questions reference their state entries. Noncandidate endpoints provide background. Each skill receives its own independent selection score.

Score relation reference value for the current task in the existing single Decision
call, separately from skill relevance. Use the relation reason and both endpoint
descriptions; relation declarations remain unverified reference data, not instructions.
Do not score a relation as a prerequisite-verification or unmet-necessity test.
Keep skill candidate guidance and its no-co-loading boundary unchanged.
Render only relations scoring at least routing.skills.related.relevanceThreshold
(default 0.8, finite inclusive range 0–1) whose anchor survives
final skill selection, as escaped `<relation>` children within that skill's XML.
Use the same per-turn resolved threshold for hook injected flags and renderer
filtering; subsequent turns honor live updates without changing expansion or skill
selection. Zero does not bypass selected-anchor requirements.
Keep runtime/Zod defaults and the strict public manifest aligned.
Preserve direction, type and original reason; do not generate
reasons or imply verified prerequisites/order. Relation scores never boost skill
scores, routing confidence or injection capacity. Optional `relationDecisions`
session/event diagnostics retain evidence, score and final `injected` status;
background names are not injected/adopted skills and must not contribute to QMD
scores or collection counts. Local tests are not Gateway verification.

Stable relation identity uses `source_id` plus an immutable `skill_key`; it must
not include the current filesystem path or content fingerprint. GitHub source
IDs use `github:owner/repository`; self-hosted Git includes its host. Standalone
local collections receive one persistent `local:<UUID>` source ID through
explicit registration, with mutable human labels kept separate. Placement
categories (`workshop`, `workspace`, `managed`, etc.) are not origin identity.
Known remote provenance survives local installation; unknown copies must not be
merged by name, matching contents or a guessed Git origin.

The private `skill-relations/sources.json` registry owns source-root bindings
and each immutable key's current name and relative `source_path` under that
registered root. Readers do
not create UUIDs, bindings or sidecars. Registration, explicit rebind/rename,
and graph publication share the graph lock; missing, invalid or ambiguous
bindings fail open without borrowing another source's relations. Only current
visible winning skills may resolve graph endpoints. Back up the registry with
graph/schema and preserve it during host moves; losing it does not authorize
regenerating local identities or guessing that matching names share lineage.
Removing a skill from a registration input does not delete its binding. Use
explicit `removeKeys` to retire deleted source entries before a complete catalog
rebuild, preserving the collection ID and every remaining immutable key.

Runtime graph format v2 stores source identity and relative paths, plus each
relation's endpoint evidence fingerprints. Compare these against current
resolved endpoints; updating a node must not rewrite other edges' evidence.
Keep the existing normalized `SKILL.md` fingerprint recipe distinct from CLI
folder hashes. A mismatch disables the affected hint; restoring exactly the
same fingerprint permits the original evidence again. Reimport must recheck
source graph content and current endpoint identities before publication. Preserve
source reasons, labels and direction, without carrying old classification scores
onto changed evidence. Keep the upstream ontology schema separate from these
private runtime bindings and evidence fields.

Stage and validate graph rebuilds before switching the formal graph, and retain a complete rollback backup. This does not reset sessions or statistics.

Keep graph implementation in `src/skills/relation-graph.ts`, import and fixed Jev
classification in `relation-import.ts`, and bounded routing expansion in
`related.ts`. Runtime tools never parse legacy declarations. Graph records use
five operations (create/update/delete/relate/unrelate), distinct from the six
relation labels. Preserve the pinned upstream fixture bytes and hash; its
path-specific whitespace exception is intentional. Compatibility tests check
validator error lists, not merely successful process exit, and use the existing
YAML parser without adding a Python runtime dependency.

Graph publication and plugin deployment are separate operations. Subsequent reads
refresh a changed graph; graph-backed tools and routing share the same graph.
Verify deployed behavior through the intended agent's actual Gateway tools:
`skill_view`, paginated `skill_list(show_related: true)`, and
`skill_search(show_related: true)`. Preserve original predicate direction for
incoming edges. Do not infer graph failure from an empty search result or infer
automatic expansion from tool success. Validate routing separately with an
eligible turn, optional related candidate diagnostics and final selections;
The selected Decision provider may reject any candidate. Do not modify live configuration for a read-only audit.

Graph node counts cover participating skills, not necessarily every visible
skill. Graphs, schemas, checkpoints and backups are private managed state outside
QMD GC/session cleanup; never delete them as disposable index caches. Keep
credentials in the execution environment or process memory and out of commands,
logs and artifacts. Record deployment-specific counts, paths, sample outcomes
and Gateway observations only in private project notes. Do not remove fork
metadata before verifying the formal graph through the invoking agent's tools.

## Detailed tool contracts

- **`skill_list`** lists visible skills with pagination. Optional inputs: `offset` (default `0`), `limit` (default `150`, capped at `500`), `show_stats` and `show_related` (both default `false`). Returns `{ success, total, count, offset, limit, has_more, next_offset?, skills }`. Each skill includes `name`, `description`, `source`, and `path`, with optional `usage_stats` and `related_skills`.
- **`skill_search`** searches metadata, bodies, and references. Requires a non-empty `query` (trimmed and truncated to 1,000 Unicode code points). Optional inputs: `limit` (default `20`, capped at `100`), `show_evidence` (default `true`), `show_stats` and `show_related` (default `false`). Returns `{ success, query, total, count, limit, skills }`; each skill contains `name`, `description`, `source`, `score`, and requested optional evidence/statistics/relations. Search results omit paths; use `skill_list` or `skill_view` for paths. An unavailable index returns `success: false`.
- **`skill_view`** requires `name`; optional `file_path` reads a relative support file under `references/`, `templates/`, `scripts/`, `assets/`, or `examples/`. A full skill response includes `success`, `name`, `description`, `content`, `path`, `skill_dir`, `linked_files`, usage statistics, relations, source, and readiness. A support-file response includes `success`, `name`, `file`, `content`, `file_type`, and relations.

## Relation Review execution

Require a valid finding or no-finding decision for the `relation-health-check` trigger. Positive findings have `targetKind: "skill-relation"` and a create, update or delete operation. Missing or malformed requested decisions reject the batch. For ready inspections require both existing and discovery assessments, consistent with the proposed operations. See [skill relation graph](#skill-relation-graph) for evidence admission, proposal validation and atomic publication.

Run in a temporary workspace with detached persistence and workspace-only file reads. The reviewer tool allowlist is `ls`, `read`, `skill_list`, `skill_search` and `skill_view`.

Review scheduling uses `IntentReviewScheduler` to debounce runs after a turn finishes (default 30-second idle delay). A new candidate for the same agent/session replaces the previous pending candidate and resets its timer, with pending entries capped by LRU eviction (default 32 sessions). Before executing, the scheduler checks if the system is actively processing embedded runs (`isSystemActive`); if busy or another Review is in flight, review is postponed by a 30-second retry delay. Each scheduler runs at most one Review at a time. Public lifecycle signals and `gateway_stop` cancel pending reviews and abort and await active Review work; Gateway admission remains authoritative during restart draining. Review runs execute through the owning instance's `runInBackgroundContext` with `sessionPersistence: "detached"`, and the host removes only the isolated temporary workspace in `finally` and does not explicitly call `deleteSession`.

## Telemetry interpretation and retention

Schema-v7 statistics track the telemetry cohort across versions, recording top-level selections, confidence, skill/tool usage, routing adoption, projection, inventory, and daily aggregates. QMD evidence uses retrieval hit scores; selector confidence comes from the selected Decision adapter. `skillDiscovery` separately records input skill matching: name-match and QMD search candidates, QMD semantic-score distribution, collection hit distribution (`meta`, `body`, `references`) for retrieved candidates and final injected skills, pre-injection candidate and injection counts, fallback reasons, and duration summaries. It does not retain user requests, snippets, QMD explanations, or per-hit score lists. Per-day maps include the same aggregate input skill-match telemetry alongside skill routing and tool errors; top-level tool latency uses fixed `unknown`, `0-99`, `100-499`, `500-999`, `1000-4999`, and `5000+` millisecond buckets. Each daily attribution map permits 64 encoded `value:<trimmed-name>` keys and then aggregates further names into the reserved `__other__` key.

The runtime-health projection keeps one canonical `routing` block, one canonical `projection` block, and names retained processed events as `retainedProcessedEventCount`.

Unsupported stats schemas are rejected fail-open without migration or rewrite. Inventory observations are agent-scoped: source, winning-path and content fingerprints, observation times and counts, and same-turn usage form an epoch. Source, winner, content, or visibility-continuity changes begin a new epoch; the fingerprints remain internal and are never exposed by skill tools.

Rendered catalog sizes are Unicode code points, not provider-billed tokens.
Adoption is same-turn use, not task success or routing accuracy. Related metadata
and prose do not count as adoption. Projection eligibility can precede selector
failure; Review outcomes belong to `review.json`, not synthesized stats.

Session cleanup preserves the ended main-session record and removes only expired
session JSON and embedded-agent `*.session.jsonl`, `*.session.trajectory.jsonl`,
and `*.session.trajectory-path.json` artifacts. Never delete unrelated transcripts
or root-level state during cleanup.

### Selection-to-use funnel analysis

Session history (`dataRoot/sessions/*.json`, subject to retention — analyses cover
only the retained window, not the full `stats.json` cohort) records everything
needed to join retrieval, selection, injection, and use per turn:

- Skill selection and injection: `matchedSkills` and
  `inputSkillDiscovery.injectedSkills`. Persisted records show the post-filter
  selection, so matched-to-injected typically reads 100% — the real filtering
  happens upstream in the candidate pool. Do not report it as a funnel stage.
- Same-turn use: `toolCalls[]`, from which `skillsUsed` derives. A skill used
  without being matched (explicit mention, working-set static use) is normal;
  `used` may exceed `matched` for such skills.

For each skill, compare matched turns with completed same-turn loads. Include the retained window and available observations. Explicit or static skill use may occur independently of selection.

## Runtime health audit procedure

Use this workflow on explicit user request to inspect runtime health, skill discovery and usage, and completed Review outcomes. It produces observations for maintenance decisions; it does not change routing or runtime state.

### Generate a private report

In a source checkout, run `pnpm install --frozen-lockfile` and `pnpm run build` first. Installed packages include the Review schema used by the audit.

```bash
node scripts/runtime-health-audit.mjs \
  --days 7 \
  --output /tmp/skill-harness-runtime-health.json
```

`--days` accepts 1–90, default 7. `--data-root` selects an intentionally nonstandard runtime layout. The script requires exactly one of `--output` or explicit `--stdout`; output files are atomically written with mode `0600`. Keep reports local and outside the repository.

Present logs must use schema-v9 Review and schema-v7 statistics. An absent log makes its report unavailable; an unsupported or malformed present log fails the audit. The script hashes present logs before loading and rereads their hashes afterward; changed logs or changed availability fail the audit rather than producing a mixed log snapshot. `provenance.stateSha256` identifies the present logs. Sessions and QMD are observed separately and are not pinned snapshots.

The script never outputs session text, tool parameters/results, Review suggestion or evidence text, agent IDs, inventory skill names, or fingerprints. Usage reports may contain skill names from usage statistics. Do not paste full runtime logs into the answer. Do not hand-edit `review.json`, `stats.json`, or raw sessions.

### Establish evidence quality first

- Check `reportOnly`, privacy flags, provenance, stats attribution start/update times, and session shape errors. Retention, disk size, and aggregate inventory counts remain under `runtime`.
- `runtime.qmd.skills` summarizes all managed skill indexes under `qmd/skills/indexes/` without revealing their identities. Check availability, ready status, integrity, active leases, unknown document/vector counts, and mismatches. A building index is a transient observation; retry after the build before changing routing settings.
- `analysis.windows.recent` and `.previous` compare N complete UTC days ending at today's UTC midnight. The current partial day is excluded. Keep exact UTC bounds visible; present equivalent timestamps in the user's timezone (Taiwan by default). Dates in `stats.daily` remain UTC.
- Daily reports contain expected/observed bucket counts and a separate discovery bucket count. Missing buckets are **not** zero-traffic days. Buckets before the stats attribution cohort are excluded and counted; a cohort starting inside the window makes coverage partial. Missing metrics and zero-denominator rates are `null`; partially available score/collection aggregates include their observation coverage.
- `analysis.cumulative` uses the stats attribution cohort, while its Review summary uses retained completed events. These are different populations. Never combine cumulative counts with daily or retained-session denominators.
- Session summaries cover retained routing fields only, normally about 14 days. They can be partial even inside that period. Both session and Review period summaries flag windows extending beyond their respective 14-day and 90-day retention assumptions. They deduplicate session/turn identities, preferring completed turns and then current records. Report sample counts, invalid/unidentified timestamps, duplicates, and first/last observation times. Do not infer completeness from those dates.

Skill-index reclamation uses separate lifetime file leases and 24-hour grace markers in `qmd/skills/gc.json`; this report does not expose those coordination records. An index without a current mapping may still be within its grace period or held open by another instance. Do not infer that it is safe to delete from report counts alone. Removed-agent mapping retirement depends on the complete live agent registry, followed by a separate index grace period.

A healthy report **does not prove Gateway loaded the plugin**. Review logs also cannot prove whether Review is enabled, queued, running, or stuck.

### Decision reports

| Report                      | Evidence                                                                                                                                                                        | Useful next decision                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill query                 | Name-match hit turns/candidates; QMD attempted and hit turns, score summaries, meta/body/references distributions; availability/timeout reasons and recorded discovery duration | Inspect names and descriptions, improve body/references, or investigate index/service availability before thresholds                           |
| Selection and injection     | Session candidate-pool coverage, empty pool, nonempty pool without skill injection, injected quantities, recorded confidence                                                    | Investigate missing candidates versus selection-stage non-adoption; examine relevance thresholds and injection limits with a controlled sample |
| Skill usage                 | Injection, same-turn adoption, usage, unadopted counts, adoption rate and lifecycle; top 10 used and unadopted skills; retained-session top 10 used without dynamic injection   | Prioritize descriptions/body for review; examine working-set placement or missing discovery patterns                                           |
| Review execution            | Last completion, outcome counts/rates, trigger distribution, no-finding/schema rejection reasons, applied-event count and committed relation create/update/delete findings      | Separate normal no-finding from contract or execution failures; inspect committed maintenance yield and publication failures                   |
| Tool reliability and trends | Cumulative errors/latency buckets and daily calls/errors; recent versus previous query, injection, adoption, usage and Review observations                                      | Identify tool problems and changes requiring a fresh controlled observation window                                                             |

#### Interpretation limits

- Adoption is same-turn recorded skill use, not task correctness or routing precision. Used-without-injection can reflect static working sets or manual discovery; it is not measured recall failure. Fewer than 20 injections is marked low sample, a reporting convention rather than a runtime rule. Never prune a skill solely because adoption is low.
- Current usage requires successful complete `skill_view` output or successful `read`/`exec` output with parseable skill frontmatter and a nonempty name. Failed calls, `ls`, empty/unrecognizable truncated output, and command paths alone are not adoption evidence. Historical aggregates can contain false positives from the earlier interpretation; existing statistics are not recalculated or rewritten. Treat periods spanning this change as mixed evidence.
- Name matching and QMD can overlap. Use the recorded unique pool and report collection counts as retrieval evidence. Historical aggregates can include sources retired before the observation window. Use homogeneous cohorts when interpreting retrieval-to-injection rates.
- Confidence is selector confidence, not retrieval similarity or calibrated accuracy. A nonempty pool with no injection does not identify selector failure versus an intentional rejection. Exact selector failure reasons, stage latency, model costs, and true precision/recall are unobserved.
- Session selection requires a recorded matched-skill array. Usage comparisons require completed turns with usage records. Missing fields reduce coverage.
- Daily usage names are raw; daily `skillRouting` and `toolErrors` keys are encoded and may overflow into `__other__`. Overflow makes per-skill injection/adoption comparison unavailable; aggregate rates remain usable. Do not subtract usage and injection totals from different populations.
- New schema warnings expose issue paths/codes/counts without content; alternative union branches may contribute additional paths. Detached Review transcripts are not retained.
- Review runs use the `relation-health-check` trigger. Calculate outcome rates over completed events. Count graph changes from committed findings in applied events. `changes.averagePerAppliedEvent` divides committed findings by `changes.appliedEvents`. An empty history establishes only that no completions were observed. A no-finding decision may be appropriate.
- Retained aggregates do not establish causality or record configuration changes. A previous-period difference is a prompt to investigate, not proof of an improvement or regression.

### Present the result and bounded next steps

1. Lead with data/index health and source coverage. If these fail, prioritize repairing observation or indexes and postpone threshold recommendations.
2. Summarize the query → candidate → selection → injection → recorded-use observations separately from Review. Include counts, rate denominators and time bounds; omit unavailable claims.
3. List at most three useful next checks or experiments. For each, include the supporting metric and sample count, a plausible alternative explanation, and a verification criterion. Change one variable at a time in a separately authorized experiment and compare equivalent periods and task samples.
4. Use concrete conditional suggestions: low candidate hit rate with healthy indexes → inspect skill metadata/body and representative requests before testing a lower candidate threshold; many unadopted injections → inspect relevance and descriptions before testing a stricter relevance threshold or smaller injection limit; schema rejection → inspect Review output contracts; timeout/unavailable → investigate service/index health first. Do not invent an optimal numeric threshold from aggregate scores.
5. Finish with unobserved signals that limit the decision. Reporting does not authorize config edits, telemetry resets, or Gateway restart.

### Skill relation observations

#### Verify a completed relation Review

The `relationInspection` summary separates preparation readiness/skip reasons, model-reported existing/discovery assessments, search attempts and committed graph operations. `changes-proposed` is not an applied change. Events without preparation fields are historical or unavailable observations, not proof that the graph was inspected. Capture counts describe prepared material, not demonstrated model attention. No-commit cancellation can leave no event.

When diagnosing an unchanged graph, inspect one existing completed event privately before expanding the investigation:

1. Confirm the turn was in scope and triggered Review. Absence of a completed event cannot distinguish a queued, running, canceled or never-scheduled run. Use live runtime evidence for those claims; do not infer them from this report.
2. Check `relationPreparation`. For `skipped`, report its fixed reason and counts. A successful ordinary `skill_view` does not prove a registered source or eligible relation seed. Do not automatically register sources to make an audit pass.
3. For `ready`, check both `relationReview.existing` and `.discovery`. Existing inspection may be `not-applicable` when the admitted manifest has no existing relations; discovery remains applicable. A discovery `no-change` result requires at least one nonempty search attempt. `relationSearchCount` includes failed attempts and does not prove successful retrieval.
4. Distinguish a valid `nofinding` result from `subagent-error`, `parse-failed`, `schema-rejected` or `validation-failed`. Ordinary tool success does not exercise the isolated Review boundary. Engineering details belong in [the relation graph contract](#skill-relation-graph).
5. Count actual relation changes from committed findings and graph receipts. Prepared snapshots document the evidence available before publication. A valid no-change run can leave graph bytes unchanged. It verifies that execution path, not positive create/update/delete publication or better task outcomes.

Today's post-upgrade event is excluded from the report's complete-day comparison windows. Use retained cumulative observations or the specific private event for immediate verification, keeping the population and timestamps explicit. Do not manufacture relationships, run new model calls, edit state or restart Gateway as part of this report-only workflow.

#### Interpret relation hints and selection

Treat ontology graph relations as unverified hints. Tool output identifies their
source as `author-import` or `review`; Review assertions are not author declarations. A
`depends_on` or `conflicts_with` label is not evidence of a necessary dependency,
a proven conflict or a successful skill combination. Tool relation output keeps
the original direction even for an incoming edge; the invoking agent must see
both matching winning skills. Missing/invalid graph state should leave ordinary
routing available without relation candidates.

When comparing observation periods, record graph import and plugin deployment
times, plus relation threshold changes. Expansion and scoring are always active
with usable graph evidence; importing a graph does not deploy the plugin. Count relation-derived candidates
separately from QMD hits and collection contributions; a relation assertion or Jev
selection does not prove adoption or task benefit. Compare actual loading,
execution outcomes, retries and user corrections. Keep graph/checkpoint contents,
source paths and relation evidence out of public reports. This audit does not run
the importer, modify the graph, classify relationships or clear source metadata.

Relation reference-value scores and XML hints are distinct from candidate expansion.
The question asks whether the relation, relation reason and endpoint descriptions
offer useful reference value for the current task, not whether an unmet or verified
prerequisite exists. Relation assertions remain unverified data, not instructions.
A prompt change can shift scores. The rendering threshold is
`routing.skills.related.relevanceThreshold` (default 0.8, range 0–1), live-updatable
and separate from skill selection. Record threshold and prompt-version changes
when comparing observations; historical sessions do not store the threshold, so
do not infer its past value from current configuration.
Optional `relationDecisions` record scores and whether the anchor survived final
selection; a high relation score does not select either endpoint or validate a
dependency. Background endpoint names remain outside injection and adoption counts. Compare periods across routing changes separately and preserve historical aggregates.

### Bounded manual follow-up

For a bounded check of relation benefit, inspect up to four existing turns with relation-only skill selections in chronological order. Prefer retained tool evidence and record the available sample size. Use temporary private analysis.

Record private turn pointers, the observed outcome, and one assessment: concrete help, no clear effect, interference, or insufficient evidence. An off-topic result can be observed without proving that injected guidance caused it. Do not infer historical skill text from current files, equate selection with adoption, or count missing usage fields as non-use. Missing versions/context remain unknown; no qualifying relation case is a conditional verification gap, not a reason to change thresholds or keep expanding the task.

Inventory warnings expose fixed phase and reason fields. Settled lifecycle slow warnings identify the active phase after 25 seconds and log the outcome when work settles. Check actual host timeout evidence independently.

## Advanced relation import procedure

For ontology-backed rebuilds, use the source `graph.jsonl` and schema as the
authoritative relationship input. Preserve its stable skill keys and original
labels/reasons, explicitly bind source roots, and validate the replayed graph,
relative paths, endpoint revisions and source graph digest before publication.
No model classification is required merely to import existing ontology labels.
Keep staged artifacts private, and inspect source counts, unresolved bindings
and the complete backup/rollback pair before formal publication. The legacy
metadata importer below remains available for older source declarations.

Build first. Explicitly register complete source bindings through
`registerRelationSource()` from `dist/src/skills/relation-sources.js`; its input
contains `root`, `skills: { [skillKey]: { name, source_path } }`, optional `id`
and `label`. Omit `id` only when deliberately creating a local collection;
subsequent registration of that same root reuses its persisted UUID. Existing
origin root/name/path changes require `rebind: true` / `rename: true`, while
retirement requires an explicit `removeKeys` list. Registration uses the same
graph lock and rejects invalid state rather than replacing it. Back up the
registry before changing existing bindings. No source identity sidecars are
written into skills or QMD snapshots.

With the source registered in a private staged data root, run:

```bash
node scripts/rebuild-skill-relations.mjs preflight --data-root /private/staged-data --graph /path/to/repo/ontology/graph.jsonl --schema /path/to/repo/ontology/schema.yaml --source-id github:owner/repository --output /private/rebuild/plan.json
node scripts/rebuild-skill-relations.mjs apply --data-root /private/staged-data --graph /path/to/repo/ontology/graph.jsonl --schema /path/to/repo/ontology/schema.yaml --source-id github:owner/repository --plan /private/rebuild/plan.json
```

The plan output directory must be private (mode `0700`); plans cannot overwrite
source trees or managed graph/schema/registry files. Include other registered
collections as isolated nodes with the same `--additional-source-ids id1,id2`
argument in both stages. This does not infer local relations. Existing unrelated
relations or changed supplemental nodes block replacement rather than being
silently discarded. Preflight/apply make no model calls. Apply reconstructs the
plan from the authoritative source and compares source graph/schema, registry,
destination and endpoint identities inside the publication lock; any mismatch
rejects the operation. Rebuild plans are tied to their target data root's current
graph and registry: make a fresh preflight for a different target rather than
copying a plan from staging. Existing graph/schema/registry files are backed up
together before graph-last atomic publication. Keep deployment and runtime
acceptance separate from this offline procedure.

The one-time importer accepts YAML objects/arrays and JSON strings in
`metadata.related-skills`. It does not edit skill files. Build first, then run
these stages separately from the package root, substituting your own paths:

```bash
pnpm run build
node scripts/import-skill-relations.mjs preflight --source /path/to/skills --data-root /path/to/plugin-data --output /private/import-plan.json
node scripts/import-skill-relations.mjs sample --source /path/to/skills --data-root /path/to/plugin-data --config /path/to/openclaw.json --checkpoint /private/import-checkpoint.json
node scripts/import-skill-relations.mjs classify --source /path/to/skills --data-root /path/to/plugin-data --config /path/to/openclaw.json --checkpoint /private/import-checkpoint.json
node scripts/import-skill-relations.mjs apply --source /path/to/skills --checkpoint /private/import-checkpoint.json --data-root /path/to/plugin-data
```

Use the same data root and source registry in every stage; do not spend classification requests before the target source registration is final.

Preflight makes no model requests and reports unresolved targets and estimated
request count. Sample classifies the first at most 20 relations in the importer's stable order; it is not a random or representative sample. Classify explicitly runs
the full catalog, reusing successful matching checkpoint entries and retrying
failed batches. Sample/classify use only plugin `decisionModel` (not `qmd.jev` or a
host model) and fail before model I/O when it is missing or invalid. They retain
the existing TypeSafe batching and checkpoint metadata and can
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
body content or winning source disable affected edges while their recorded
evidence no longer matches. Restore the original contents or explicitly review
and reimport current source evidence before using those hints again. The graph is not periodically synchronized with source metadata.

A missing or invalid graph leaves ordinary routing working without relations;
runtime tools do not fall back to legacy metadata relationships. Do not edit the
formal graph with the upstream ontology CLI while the plugin/importer may be
writing: its writer does not participate in plugin locks. Keep graph backups and
checkpoints outside the package. Importing a graph does not deploy the plugin. With a usable graph, bounded
automatic expansion and relation scoring are always active. Record graph and plugin publication times separately.

Relation labels are `related`, `depends_on`, `composes_with`,
`similar_to`, `conflicts_with`, and `specializes`; an empty reason is visible in
tools but cannot seed expansion. Incoming `depends_on` means the other skill
points to the current skill; never reverse its predicate.

## Runtime configuration and acceptance

Keep lesser-used configuration aligned with `src/config.ts` and the manifest:
name matching defaults to `maxEditDistance: 2`, `minJaccardScore: 0.5`, and an
empty `genericTokens` list; generic tokens suppress only single-token automatic
matches. Recent context defaults to five turns and 1,000 characters per role.
Review model resolution is configured model → session model → agent primary →
configured fallback. Selection has no fallback retries. Audit `--days` accepts
1–90 and compares the last seven complete UTC days with the preceding seven;
retained sessions normally cover about 14 days. Unsupported present schemas fail
the audit. Absent sections are unavailable. Review reports separate skipped preparations from completed events. Only completed events contribute to outcome rates and last completion time.

Required `qmd.embedding` and `qmd.expansion` fields are enforced by the strict manifest, alongside independent optional `qmd.jev` and plugin `decisionModel` endpoints (with a configured host Decision model taking precedence over plugin `decisionModel`). Validate configuration changes in an isolated profile before applying them; do not change live settings during tests. Keep native static selections in `skills.workingSet` and intentionally shared directories in `skills.sharedRoots` when default startup normalization is enabled. Prepare configuration changes, preconditions, Gateway restart impact and rollback together; apply only within the user's authorized scope. Do not reset telemetry or delete indexes as a routine maintenance step.

Use `openclaw plugins inspect skill-harness --runtime --json` and
`openclaw plugins doctor` for local registration/configuration diagnostics.
Runtime inspection loads the plugin in the inspecting CLI process, not the
running Gateway. Use `openclaw gateway status --deep --require-rpc` for Gateway
availability, then verify actual tools and an eligible routed turn through the
intended agent and inspect Gateway observations. Cold plugin inventory, local
runtime inspection, and build/test results do not establish that the Gateway
loaded the changed build. Keep deployment observations and reports in private
notes rather than README or AGENTS.

External plugin installations must explicitly grant
`plugins.entries.skill-harness.hooks.allowConversationAccess: true`; this is
host hook policy beside the plugin's `config`, not part of its manifest schema.
An explicit `allowPromptModification: false` still blocks prompt hooks. Never
normalize these permission grants automatically.

Prefer the SDK's explicit `before_prompt_build.currentUserMessage` for routing
input when present, including an empty string. Only an absent field permits
legacy prompt/history extraction. Do not parse projected envelope markers in
the explicit request; retain them as user text. Empty explicit text keeps static
guidance without routing historical input.

Treat native `currentUserMessageId` strings as opaque admission identities,
including empty or whitespace-only strings. Scope them by the raw agent/session
ID pair, never by run ID or input text. Claim ownership before the first await.
One admission shares turn preparation and its pending or terminal selection
Promise across rebuilds, including failure and cancellation. A new admission
gets its own tracker UUID. Store a digest of the raw agent/session/admission tuple with that UUID. Check it under the session lock before allocating another row. A replay can rebind a pending row to its terminal hook, while a completed row stays terminal across registration reloads. Superseded
or finalized admissions must never reserve another turn or repeat selection.
A still-current finalized admission keeps available static guidance; a stale
invocation may return no context. Omitted admission IDs preserve the
legacy run/text matching and its weaker identity guarantees.

For missing canonical keys, use only
`runtime.agent.session.getSessionEntryByIdAsync({ agentId, sessionId })` with the
raw requested ID and ambient SDK store scope. Omit ordering/store overrides and
require the returned entry's session ID to equal the raw requested ID exactly;
the SDK's trimmed legacy alias fallback must not broaden this lookup. A supplied
nonblank key skips the SDK read. Do not replace a failed lookup with a store
scan. After every asynchronous boundary, recheck the original hook invocation,
plugin generation and current request before reserving a turn or publishing
effects. SDK owner-retirement rejection alone is insufficient. Disposal drains
pending lookups along with prompt work.

Run IDs remain correlation data. Register native aliases as known pending fences
before lookup; a collision between admission owners becomes ambiguous and cannot
block either request's independent selection. Superseding a request cancels its
prompt work but preserves an already active old alias for that old turn's late
events. With an explicit unknown run ID, ignore the event rather than attaching
it to another known run in the same session. A previously unseen run ID may
resolve a unique anonymous turn for sparse host contexts; pending, reserved,
terminal, or ambiguous known run IDs never use that fallback.

Native admission tombstones and native run aliases have separate generation-local
budgets of 16,384 entries; the existing legacy alias budget remains 1,024.
Native fences are not forgotten by TTL or LRU. Admission overflow keeps static
guidance without admitting new dynamic work. Native alias overflow permanently
disables unknown-run fallback for that generation. Converting a legacy alias to
a native fence retains its original budget allocation. Session cleanup reclaims
owned entries; cross-session ambiguous aliases remain fenced until disposal.
Disposal clears the request/admission ledgers; alias fences remain owned by the
retired handler generation. Persist only the digest on the session row. Pending
native runs stage up to 8 attempts and 8 settlements per run ID while lookup or
working-set preparation is in flight, protecting the keyless slot and verified
effective key from speculative eviction. Keep non-host SDK/persisted keys
alias-local through binding for independent replay lookups, while publishing
verified host-key overrides synchronously to the shared admission owner before
the first await. Use `hasActiveSession()` in Review's `isSystemActive` check so
concurrent active turns keep Review deferred cleanly.

## Documentation boundaries

The private project note is `/home/wei/.openclaw/workspace/darling/projects/ai/skill-harness.md`
(`/mnt/gdrive/Productivity/projects/ai/skill-harness.md`, also aliased at
`~/productivity/projects/ai/skill-harness.md`). Write it for human
readers: retain the design background, architecture diagrams, key trade-offs,
research context, user-facing behavior and configuration, current status,
completed milestones, and explicitly agreed next actions. Organize and explain
these clearly rather than reducing the page to a status summary. Keep
contributor-only source inventories, command transcripts, process IDs, detailed
audit evidence, and long deployment histories out of it.

Keep coding-agent contracts here. Preserve detailed private deployment/audit
records and historical engineering handoffs in Hindsight with their source,
date, version, and evidence locations. Confirm preservation before removing
unique details from the project page. Historical records describe their own
cutoff, not current runtime state. Keep private runtime data out of repository
documentation and preserve the project page's agreed follow-up scope.

README introduces the project, research context, architecture, behavior and user
setup. Keep coding-agent contracts, schema migrations, concurrency, persistence,
source maps and contributor checks here. Developer maintenance procedures belong here, alongside the `scripts/*.mjs` commands that implement them. Research references explain design context;
do not claim paper benchmark results as this plugin's measurements or imply that
related-work algorithms are implemented without source evidence.

The shared logger and host adapter accept one message string. Build diagnostics
at each call site from fixed labels and explicitly selected safe fields; use
`formatErrorDiagnostic()` for ordinary failure reasons and allowlisted codes.
Review returned errors use only supported SDK error kinds or a fixed fallback;
keep raw error extraction separate for control flow. Parse-failure logs retain
only a fixed reason, reply length, and parseable-object flag. Schema rejections
retain schema field/index paths, codes, and counts, without rejected values or
messages. Never generically serialize metadata to satisfy the logger signature.

qmd skill refresh diagnostics must survive the host PluginLogger's single-string
contract. Encode fingerprint, phase, fixed reason, searchable, failure count,
retry delay, and a redacted error diagnostic (`errorName`, string `errorCode`,
truncated `errorMessage`). Log recovery only after update/publication/embedding
verification succeeds. Redact credential assignments and `sk-` tokens before
logging. Do not serialize stacks, causes, raw provider bodies, queries, or
credentials. Unknown error codes still map to `operation-failed`. Preserve retry,
lock, discovery and lease behavior.

Inventory and settled lifecycle diagnostics use safeErrorClassification() from src/error-diagnostics.ts: fixed reasons and allowlisted codes only. Encode explicit fields into one logger string; do not include arbitrary error messages/names, paths, queries, evidence, stack/cause or credentials. Keep this stricter contract distinct from existing skill-index redacted diagnostics. Inventory failures retain unavailable semantics and report the failing root category/operation, never a partial complete inventory. Settled lifecycle slow warnings fire once at 25 seconds, report the active phase, clear/unref their timer and never cancel work, extend host timeouts or change finalization deduplication.

## Remote-only QMD and loader validation

QMD uses configured remote providers only; preserve BM25, CJK, AST, CLI and MCP and remote provider ordering. The attempt-scoped `agent_end` hook captures durable metadata and flushes staged tool results. Only the execution owner’s settled lifecycle event (`api.agent.events.registerAgentEventSubscription`, `executionSettled === true` and not yielded-waiting) closes the turn and starts statistics and Review preparation. Review execution loads after enabled/trigger checks and must recheck lifecycle cancellation, disposal and the originating turn after asynchronous preparation. Pipeline events stay synchronous. Keep operation diagnostics name-free.

Use `.github/scripts/measure-plugin-loader.mjs` only with independently installed tarballs and a private output directory. It creates isolated profiles for five timed fresh processes and one separate capacity process per build using the same Node/OpenClaw. Keep machine-specific timing and snapshot metrics outside the repository; CLI loader improvements do not establish whole-Gateway startup improvements. Never operate the live Gateway as part of this benchmark.
