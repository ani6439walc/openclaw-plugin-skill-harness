# Implementation Plan: Incremental QMD Index Refresh

## Overview

Replace destructive QMD rebuilds with periodic source polling and incremental updates. Intent routing will keep one persistent SQLite index and patch only changed snapshot files. Skill search will retain atomic generation publication while cloning the ready generation's SQLite database and snapshots, then applying a document diff before QMD updates and embeds only the new content hashes.

## Confirmed Decisions

- Both intent routing and `skill_search` are in scope.
- `qmd.indexRefreshIntervalSeconds` controls polling and defaults to `300` seconds.
- Plugin registration performs an immediate check/build or generation reuse; later checks are polling-only.
- Intent QMD retrieval may lag catalog changes by at most one refresh interval.
- Embedding `baseUrl` is transport-only and does not invalidate an index.
- Embedding `model` and `dimension` invalidate an index; the rest of QMD search configuration does not.
- Skill search preserves atomic publication by using a consistent SQLite backup of the active generation, never a raw copy of SQLite/WAL/SHM files.

## Architecture Decisions

- Use QMD's existing content-hash `update()` and pending-only `embed()` behavior; do not introduce an application-owned vector cache.
- Reuse the existing `withFileLock()` process lock around the entire read/clone/diff/update/embed/publish lifecycle.
- Replace `scheduleCooldownMs` with `indexRefreshIntervalSeconds`; polling is the sole normal rebuild cadence. Retry uses its own backoff timer and does not alter poll timing.
- Keep all active-store publication semantics fail-open: an incomplete or failed candidate never replaces the ready store.

## Task List

### Phase 1: Refresh policy

1. Add `qmd.indexRefreshIntervalSeconds` schema, defaults, manifest, and README documentation.
2. Narrow intent and skill index fingerprints to indexed documents plus embedding model and dimension.
3. Replace per-turn and per-search scheduling with initial plus periodic source polling; preserve independent retry timers.

### Phase 2: Incremental snapshots

4. Build a deterministic snapshot document map and atomic diff writer shared only if both index paths genuinely use identical behavior.
5. Convert intent snapshot refresh to a persistent diff under an intent build lock.
6. Add intent regressions for no-op polls, one-intent changes, deletions, model invalidation, and delayed catalog visibility.

### Phase 3: Incremental skill generations

7. Add a narrow typed SQLite backup adapter over QMD's exported internal database.
8. Clone the active skill generation's SQLite snapshot and document directory into the candidate generation.
9. Apply the skill snapshot diff, run QMD update/embed, verify completeness, and atomically publish.
10. Add skill regressions for vector reuse, single-file changes, WAL-safe backup, non-index config changes, failure isolation, and concurrent builds.

### Phase 4: Verification

11. Run focused QMD index tests, then typecheck, full tests, build, plugin-loader check, and dry package inspection.

## Risks and Mitigations

| Risk                                        | Impact                                | Mitigation                                                                               |
| ------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Different model with a compatible dimension | Retrieval quality degradation         | Embedding model remains part of the invalidation fingerprint.                            |
| SQLite WAL copied as ordinary files         | Corrupt or stale candidate generation | Use SQLite Online Backup API from the active QMD database.                               |
| Gateway reload overlaps a build             | SQLite/snapshot race                  | Hold `withFileLock()` across the complete candidate lifecycle.                           |
| Polling delays new content                  | Temporary stale QMD candidates        | Bounded by the configured 300-second interval; primary catalog reload remains immediate. |
| Partial embedding failure                   | Candidate is incomplete               | Keep active store, retain/retry candidate according to existing recovery policy.         |

## Verification Checkpoints

- After Phase 1: configuration parsing and timer behavior tests pass.
- After Phase 2: intent index incremental update tests pass.
- After Phase 3: skill generation clone/diff tests pass.
- Complete: typecheck, Vitest suite, build, plugin loader, and `pnpm pack --dry-run` pass.
