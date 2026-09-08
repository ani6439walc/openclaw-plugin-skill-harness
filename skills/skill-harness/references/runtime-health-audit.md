# Runtime Health Audit Workflow

Use this workflow to inspect current Skill Harness runtime health and summarize **ordinary Intent Review changes** without exposing retained conversation text or mutating runtime state.

## Safety boundary

The bundled script is report-only. It reads `review.json`, `stats.json`, QMD SQLite metadata and snapshot file counts, session metadata, agent-artifact metadata, and intent filenames. It never writes runtime state and never emits:

- user / assistant session text;
- tool parameters or tool results;
- Review `suggestedChange`, `summary`, or evidence text;
- agent source metadata.

Keep reports local. The script requires `--output` or explicit `--stdout`; `--output` atomically writes mode-`0600` JSON and is the safe default. Do not hand-edit `review.json` or `stats.json` in response to a health finding.

## Generate one pinned report

From the plugin repository root:

```bash
python3 skills/skill-harness/scripts/runtime-health-audit.py \
  --output /tmp/skill-harness-runtime-health.json
```

The script resolves the standard data root automatically. Use `--data-root` only for an intentionally nonstandard layout.

It reads and validates schema-v8 `review.json` and schema-v3 or schema-v4 `stats.json`. It records SHA-256 values for both before loading, rereads them afterward, and refuses to produce a mixed-state report if either changed. QMD is read once through a read-only SQLite connection and is reported as an observed point-in-time state; its active background build is not pinned or hashed. Session files are intentionally not hashed or snapshotted; treat the report as an observed window, not an immutable whole-runtime snapshot.

The managed intent snapshot lives under `<dataRoot>/qmd/intents/`: searchable plain-text documents are in `examples/` and `keywords/`, identity sidecars end in `.md.identity.yml` and are ignored by QMD collections, and `intent-routing.sqlite` plus `intent-routing.json` are colocated with the snapshot.

Completion criterion: report `reportOnly` is true, all privacy flags are false, `provenance.stateSha256` contains both runtime logs, and `runtime.qmd` reports the database state without exposing indexed document text.

## Check structural health before interpreting trends

1. `review` must have schema version 8; `stats` must be schema-v3 or schema-v4. Stop on another version; do not migrate or hand-edit it during an audit.
2. `sessions.invalidSessionFiles`, `sessions.sessionsMissingCurrent`, and `sessions.sessionsWithInvalidHistory` must be zero. A nonzero value is a persistence/shape issue, not a routing-quality signal.
3. `qmd.databaseStatus` should be `ready`, `integrityCheck` should be `ok`, and `leaseActive` should be false before treating QMD direct routes as healthy. `indexedDocuments` and `indexedVectors` should match.
4. `review.json` records only the post-turn triggers `intent-health-check`, `routing-uncertainty`, and `capability-fit`. Live routing remains `qmd-keyword → qmd-hybrid → llm-classifier` and is independent of review.

Use `runtime.review.processedEvents` to assess ordinary review outcomes and applied changes. `changes.byTrigger` counts host-applied changes; it is distinct from requested trigger counts. A healthy mature catalog normally favors small `refine` changes. Review failures (`parse-failed`, `validation-failed`, `subagent-error`) are contract-quality signals; aggregate a fresh observation window before changing prompts or models.

Report only the timestamp/provenance hashes, schema/structural pass or failure, ordinary review outcome and applied-change distribution, QMD state, and session/agent retention trend. Do not include retained conversations, review suggestion text, or a claim that historical aggregates prove a current regression.
