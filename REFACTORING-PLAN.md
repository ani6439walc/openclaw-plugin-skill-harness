# Refactoring Plan

**Source:** ponytail-audit findings
**Target:** -450 lines, 0 deps removed
**Strategy:** Low-risk → high-risk, verify each phase

---

## Phase 1: Shared Utilities Consolidation

**Goal:** Eliminate 20+ duplicate normalize/guard/xml helpers across 10+ files
**Estimated cut:** ~130 lines

### Tasks
1. Create `src/normalize.ts` with 2-3 canonical variants:
   - `normalizeForMatching(s)` → `NFKC + trim + lowercase` (no whitespace collapse)
   - `normalizeForDisplay(s)` → `NFKC + trim + lowercase + collapse whitespace`
   - `normalizeForKeyword(s)` → `NFKC + remove all whitespace + lowercase`
2. Create `src/guards.ts` with unified `isRecord` (use the stricter variant: `!Array.isArray`)
3. Create `src/xml-utils.ts` merging `indentXmlLines` + `xmlBlock`
4. Migrate all callers to shared modules
5. Delete local duplicates in:
   - `src/subagent-runtime.ts`
   - `src/curation/selector.ts`
   - `src/curation/subagent.ts`
   - `src/intents/routing-validation.ts`
   - `src/stats/aggregator.ts`
   - `src/experiences/catalog.ts`
   - `src/classification/prompts.ts`
   - `src/review/snapshot-formatter.ts`
   - `src/review/catalog-projection.ts`
   - `src/skills/search.ts`
   - `src/skills/tools.ts`
   - `src/hooks/index.ts`
6. **Verify:** `pnpm run typecheck && pnpm run test`

---

## Phase 2: Singleton Cache Pattern Extraction

**Goal:** Consolidate 3 identical cache-by-resolved-path patterns
**Estimated cut:** ~30 lines

### Tasks
1. Design `cachedSingleton<T>(cache: Map<string, T>, key: string, factory: () => T): T` helper in `src/file-utils.ts` or new `src/singleton.ts`
2. Refactor `IntentCatalog` (`src/intents/catalog.ts`) to use helper
3. Refactor `SessionTracker` (`src/session/tracker.ts`) to use helper
4. Refactor `StatsAggregator` (`src/stats/aggregator.ts`) to use helper
5. **Verify:** `pnpm run typecheck && pnpm run test`

---

## Phase 3: Thin Wrapper Removal

**Goal:** Inline pure-delegation modules at their call sites
**Estimated cut:** ~80 lines + corresponding tests

### Tasks
1. Delete `src/intents/skill-references.ts` (3 re-exports, only used by its test)
   - Update callers to import from `../skills/indexer.js` or `../intents/index.js`
   - Delete `src/intents/skill-references.test.ts`
2. Inline `src/intents/validation.ts` (22-line wrapper) into `src/review/subagent.ts`
   - Delete `src/intents/validation.ts` and `src/intents/validation.test.ts`
   - Update `src/intents/index.ts` exports
3. Inline `src/review/queue.ts` (17-line promise chain) into `src/hooks/index.ts`
   - Delete `src/review/queue.ts` and `src/review/queue.test.ts`
   - Update `src/review/index.ts` exports
4. Inline `src/curation/queue.ts` (28-line keyed queue) into `src/plugin.ts`
   - Delete `src/curation/queue.ts` and `src/curation/queue.test.ts`
   - Update `src/curation/index.ts` exports
5. Inline `domainsForSkill()` from `src/skills/domains.ts` at its 2 call sites in `src/skills/indexer.ts`
6. **Verify:** `pnpm run typecheck && pnpm run test`

---

## Phase 4: Minor Cleanup

**Goal:** Remove unused defaults and backward-compat aliases
**Estimated cut:** ~2 lines

### Tasks
1. Remove `dataRoot = pluginRoot` default parameter from `sessionsPath()` in `src/file-utils.ts`
   - All production callers pass explicit `dataRoot`
   - Update tests that relied on the default
2. Migrate all `pluginRoot` imports to `packageRoot`
   - Affected: `src/intents/catalog.ts`, `src/stats/aggregator.ts`, `src/session/tracker.ts`, `src/review/log-writer.ts`
   - Delete `export const pluginRoot = packageRoot` alias in `src/file-utils.ts`
3. **Verify:** `pnpm run typecheck && pnpm run test`

---

## Phase 5: Stats Migration Dead Code (Requires Confirmation)

**Goal:** Remove v1/v2/v3 migration validators if migration is complete
**Estimated cut:** ~200+ lines (if safe)

### Pre-check
AGENTS.md states: "A valid v1/v2/v3 migration must retain historical aggregates... New v4 daily attribution maps...". The code contains `isDailyBucketV1`, `isDailyBucketV3`, and migration switch logic in `loadStats()`.

**Question for Baby:** Has the v1/v2/v3 → v4 migration completed for all production deployments? 
- **If yes:** Remove dead migration branches and validators
- **If no/unsure:** Keep but add clarifying comments

### Tasks (if migration complete)
1. Remove `isDailyBucketV1()`, `isDailyBucketV3()` from `src/stats/aggregator.ts`
2. Remove migration switch in `loadStats()`
3. Remove `migrateStats()` if it exists
4. Keep only current-schema validation
5. **Verify:** `pnpm run typecheck && pnpm run test`

### Tasks (if migration incomplete)
1. Add comments explaining migration state
2. No code removal
3. **Verify:** `pnpm run typecheck && pnpm run test`

---

## Execution Order

```
Phase 1 (low risk, high reward)
  ↓
Phase 2 (low risk, medium reward)
  ↓
Phase 3 (medium risk, medium reward)
  ↓
Phase 4 (low risk, low reward)
  ↓
Phase 5 (high risk, high reward — requires decision)
```

## Verification Strategy

Each phase ends with:
```bash
pnpm run typecheck
pnpm run test
```

After all phases:
```bash
pnpm run build
git diff --stat
```

## Risk Assessment

- **Phase 1-2:** Pure refactoring, tests verify correctness
- **Phase 3:** Need to confirm all callers migrated
- **Phase 4:** Breaking change for any external `pluginRoot` consumers (unlikely)
- **Phase 5:** Risk of breaking production if migration incomplete

---

**Created:** 2026-08-18

---

**Completed:** 2026-08-18
**Status:** ✅ All 5 phases complete
**Final diff:** 34 files, +177 -393 lines (net -216 lines)
**Verification:** typecheck ✓ | 1035 tests pass | build ✓
**Status:** ✅ All 5 phases complete
