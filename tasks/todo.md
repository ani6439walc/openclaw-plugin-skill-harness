# QMD Incremental Index Refresh

## Phase 1: Refresh Policy

- [ ] Add periodic index refresh configuration.
- [ ] Narrow index invalidation fingerprints.
- [ ] Replace immediate scheduling with polling.

## Checkpoint: Refresh Policy

- [ ] Focused configuration and timer tests pass.

## Phase 2: Intent Incremental Updates

- [ ] Add deterministic snapshot document diff.
- [ ] Apply locked persistent intent updates.
- [ ] Cover intent no-op and delta updates.

## Checkpoint: Intent Index

- [ ] Intent QMD focused tests pass.

## Phase 3: Skill Generation Incremental Updates

- [ ] Add consistent SQLite generation backup.
- [ ] Clone generation snapshots before diffing.
- [ ] Publish completed incremental skill generation.
- [ ] Cover clone, reuse, failure, and locking.

## Checkpoint: Skill Index

- [ ] Skill QMD focused tests pass.

## Phase 4: Complete Verification

- [ ] Run typecheck, full tests, and build.
- [ ] Run plugin loader and package dry run.
