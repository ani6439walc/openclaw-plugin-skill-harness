# Runtime Health Audit Workflow

Use this workflow to inspect current Skill Harness runtime health and summarize **ordinary Intent Review changes** without exposing retained conversation text or mutating runtime state.

## Safety boundary

The bundled script is report-only. It reads `review.json`, `keyword-coverage.json`, `stats.json`, QMD SQLite metadata and snapshot file counts, session metadata, agent-artifact metadata, and intent filenames. It never writes runtime state and never emits:

- user / assistant session text;
- tool parameters or tool results;
- Review `suggestedChange`, `summary`, or evidence text;
- agent source metadata.

Keep reports local. The script requires `--output` or explicit `--stdout`; `--output` atomically writes mode-`0600` JSON and is the safe default.

Do not hand-edit `review.json`, `keyword-coverage.json`, or `stats.json` in response to a health finding.

## Step 1 — Generate one pinned report

From the plugin repository root:

```bash
python3 skills/skill-harness/scripts/runtime-health-audit.py \
  --output /tmp/skill-harness-runtime-health.json
```

The script resolves the standard data root automatically. Use `--data-root` only for an intentionally nonstandard layout.

It reads and validates current schema-v7 `review.json`, schema-v1 `keyword-coverage.json`, and schema-v3 or schema-v4 `stats.json`. It records SHA-256 values for all three before loading, rereads them afterward, and refuses to produce a mixed-state report if any changed. QMD is read once through a read-only SQLite connection and is reported as an observed point-in-time state; its active background build is not pinned or hashed. Session files are intentionally not hashed or snapshotted; treat the report as an observed window, not an immutable whole-runtime snapshot.

Completion criterion: report `reportOnly` is true, all privacy flags are false, `provenance.stateSha256` contains all three runtime logs, and `runtime.qmd` reports the database state without exposing indexed document text.

## Step 2 — Check structural health before interpreting trends

Read `runtime` in this order:

1. `review` and `keywordCoverage` schema versions must be 7 and 1. `stats` must be schema-v3 or schema-v4. Stop on another version; do not migrate or invent defaults.
2. `sessions.invalidSessionFiles`, `sessions.sessionsMissingCurrent`, and `sessions.sessionsWithInvalidHistory` must be zero. A nonzero value is a persistence/shape issue, not a routing-quality signal.
3. `intents.markdownFiles` is only a file count. It is not proof that intent frontmatter is valid. When the repository build output is available, run the compiled validator separately against the active runtime catalog.
4. `qmd.databaseStatus` should be `ready`, `integrityCheck` should be `ok`, and `leaseActive` should be false before treating QMD direct routes or candidate projection as healthy. `indexedDocuments` and `indexedVectors` should match. `snapshotMatchesIndexedDocuments` can be transiently false while the background snapshot is rebuilt; retry after the build rather than declaring corruption. `unavailable` is fail-open to classifier, so inspect configuration and plugin warnings before treating it as a routing outage.
5. Compare `sessions.agentArtifactFiles` and `sessions.agentArtifactBytes` over time. Artifacts older than `sessions.retentionDays` are a cleanup signal only after a retention sweep opportunity; do not delete them manually during an audit.

For `stats` interpretation, read `runtime.stats.attribution` before any per-intent, per-skill, or per-tool trend:

- schema-v3 reports `insufficient-historical-attribution`; only its pre-v4 aggregate routing, projection, portfolio, lifecycle, reliability, freshness, and cardinality signals are usable;
- schema-v4 reports `post-v4-window-only` and its exact `startedAt`; daily attribution before that boundary is unavailable, and the start UTC date can be partial;
- schema-v4 daily `intentOutcomes`, `intentRouting`, `skillRouting`, and `toolErrors` have host-bounded cardinality. Named entries use `value:<trimmed-name>` so a visible `__other__` bucket means the date exceeded its named-key budget, not that an actual intent, skill, or tool was called `__other__`.
- `toolReliability.latencyHistogram` is `unavailable` for v3 and post-boundary only for v4. Its fixed buckets include `unknown` for missing or invalid duration measurements; do not read that bucket as zero latency.
- `curation` reports aggregate session-local curation activity: `appliedRevisions`, `candidatesKept`, `candidatesAdded`, and `recommendedExperiencesSelected` along with `summary.curationAppliedCount`.

Use `runtime.stats.routingEffectiveness`, `projectionEfficiency`, `intentPortfolio`, `skillLifecycle`, `toolReliability`, `curation`, and `dataHealth` as aggregate decision inputs. They never include user/session text, tool parameters/results, or Review evidence. `review.json` remains the only source for ordinary Review outcomes and applied changes.

The script reports no raw state text, so inspect a specific record only after a separate explicit privacy and scope decision.

## Step 3 — Explain ordinary Review outcomes correctly

Use `runtime.review.processedEvents` for ordinary Intent Review only. `historicalKeywordAuditCount` is a separate legacy/historical audit count and must not be mixed into ordinary change rates.

Interpret these fields:

- `eventCount` — all ordinary Review events observed.
- `outcomes.applied` — events whose host-validated changes were reconciled to the runtime intent catalog.
- `changes.total` — actual applied changes, not model proposals.
- `changes.eventsByChangeCount` — distribution of conservative edit breadth per event.
- `changes.byTrigger` — which Review trigger produced applied changes. This is different from `triggerEvents`, which counts every requested trigger including nofindings and failures.
- `changes.byOperation` — `refine` versus `create`. A healthy mature catalog normally favors small `refine` changes; a rising `create` share requires human boundary review before expanding the catalog.
- `changes.topTargetIntents` — concentration only. Repeated changes to one intent are a signal to inspect its scope, triggers, and possible extraction boundary; they are not proof that the intent is wrong.
- `noFindingReasons` — especially `already-covered`, which is expected evidence that conservative review did not create duplicate intent work.
- `schemaRejectionReasons`, plus `parse-failed`, `validation-failed`, and `subagent-error` outcomes — host/model contract quality signals. Aggregate by a fresh observation window before changing prompts or models.

Do not calculate a success rate from model proposals. Use only host-recorded `applied` events and `changes.total` for mutation statistics.

## Step 4 — Interpret coverage state with scheduler context

`runtime.keywordCoverage` reports current keyword counts, completed keyword events, coverage epochs, and per-target state count. An empty event/epoch history is not automatically a defect:

- coverage is gated by `review.enabled`;
- it only evaluates after a new stats-recorded finalized turn, never by replaying historical turns at startup;
- the scheduler uses `review.keywordCoverage.everyAcceptedTurns`, default 50, then retries every five accepted turns after its milestone;
- it needs a usable Review model and a successful reservation before any epoch appears.

Before calling empty coverage a failure, verify the effective review config, gateway/plugin reload time, `stats.json.updatedAt`, and whether enough new finalized turns have occurred since the current runtime loaded. If an eligible boundary has passed with `review.enabled=true`, a usable model, and new stats writes but no reservation/event, inspect scheduler warnings and source behavior in a separate implementation task.

## Step 5 — Report bounded findings

Report only:

1. report timestamp/provenance hashes and observed runtime update timestamps;
2. schema/structural pass or failure;
3. ordinary Review outcome and applied-change distribution;
4. coverage epoch state with its scheduler caveat;
5. QMD state, integrity, lease, and document/vector consistency;
6. session/agent retention and disk-growth trend;
7. a concrete next observation threshold, such as 50 new Review events or the next coverage retry boundary.

Do not include raw retained conversations, Review suggestion text, or a claim that a historical aggregate proves a current regression.

## Failure modes

| Signal                                     | First interpretation                    | Correct response                                                                         |
| ------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| Runtime JSON schema mismatch               | State is unsupported or malformed       | Stop; do not migrate or hand-edit during audit                                           |
| JSON changes while read                    | Report would mix runtime moments        | Retry later or use a quiescent copied data root                                          |
| Invalid session shape                      | Persistence data issue                  | Record counts and investigate the writer/retention path separately                       |
| High `already-covered` nofinding count     | Conservative duplicate prevention       | Retain it; inspect only if user reports missed coverage                                  |
| Repeated parse/schema/validation failures  | Reviewer-output contract issue          | Compare a fresh bounded window and inspect reason counts before prompt/model changes     |
| Empty coverage state                       | Could be pre-eligibility or post-reload | Verify cadence, stats writes, model availability, and the next eligible boundary         |
| QMD `databaseStatus` is `unavailable`      | Cold, failed, or inaccessible index     | Verify QMD endpoint configuration and plugin warnings; classifier remains fail-open      |
| QMD lease is active or snapshot mismatches | Background refresh may be in progress   | Wait for the build to settle, rerun once, then investigate repeated lease contention     |
| Agent artifact disk growth                 | Retention window may not have swept yet | Track bytes/files through a full retention period; do not manually delete audit evidence |
