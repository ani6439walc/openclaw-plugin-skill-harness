# Skill Placement Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated stats-driven `skill-placement` Intent Review trigger that places one under-adopted or fully observed zero-use skill into the best supported runtime intent once per inventory epoch.

**Architecture:** Extend schema-v3 stats with a read-only deterministic candidate selector, carry one candidate through the existing Review snapshot and isolated intent-edit transaction, and persist only completed `applied`/`nofinding` epochs in a strict current-only review-log schema. Reuse the existing serial Review queue, validation, conflict detection, rollback, and catalog refresh; do not add skill mutation or a separate auditor.

**Tech Stack:** TypeScript ESM, Zod, Vitest, gray-matter, OpenClaw embedded-agent runtime, pnpm.

## Global Constraints

- Global `review.enabled` remains `false` by default.
- Add `review.triggers.skillPlacement.enabled`, default `true`.
- Zero-recommendation/zero-usage eligibility is fixed at 20 continuous observations in the current epoch.
- Select at most one skill per Review run; `low-adoption` wins over `zero-recommendation-usage`, then normalized skill name order breaks ties.
- Only `applied` and `nofinding` complete an epoch; technical, schema, parse, and validation failures remain retryable.
- Use only the tracker-persisted agent ID and that agent's trustworthy current resolved inventory.
- Never expose winner/content fingerprints or the epoch key through public skill tools or model-facing snapshot text.
- Never create, edit, merge, rename, or delete `SKILL.md` files.
- Remove v1-v4 `review.json` compatibility and migration code; accept only the new current schema.
- Do not commit, push, stage, or rewrite history without explicit user authorization.
- Keep local ESM imports suffixed with `.js`, use `interface` for object shapes, and avoid `any`.

---

## File Structure

- `src/stats/aggregator.ts`: own the trustworthy stats read and deterministic skill-placement candidate selection because it already validates schema-v3 inventory and computes `needsReview`.
- `src/review/types.ts`: define the candidate shape carried in a Review snapshot.
- `src/review/log.ts`: define the strict current review-log schema and completed skill-epoch ledger; remove legacy migration paths.
- `src/review/log-writer.ts`: read completed epoch keys and atomically persist successful epoch completion with the processed event.
- `src/review/triggers.ts`: add the trigger identity only; stats-based eligibility remains outside turn-text trigger detection.
- `src/review/snapshot-formatter.ts`: serialize safe candidate evidence and catalog `skills[]` while withholding internal identity fields.
- `src/review/catalog-projection.ts`: force full catalog for `skill-placement`.
- `src/review/subagent.ts`: add the dedicated review workflow, `skill_view` allowlist, and host validation that a positive placement edit targets an intent declaring the skill.
- `src/hooks/index.ts`: combine ordinary turn triggers with one stats-selected candidate, suppress pending duplicates, enqueue, log completion, and clear pending state.
- `src/hooks/types.ts`: expose the added dependency methods for focused hook tests.
- `src/types.ts`, `src/config.ts`, `openclaw.plugin.json`: public configuration surface.
- Matching colocated `*.test.ts`: lock every boundary with RED-GREEN tests.
- `README.md`, `docs/intent-review.md`, `docs/metrics.md`, `AGENTS.md`: synchronize behavior, storage schema, and agent guidance.

---

### Task 1: Deterministic stats candidate selector

**Files:**

- Modify: `src/stats/aggregator.ts:16-24,73-94,1094-1249`
- Modify: `src/stats/aggregator.test.ts`
- Modify if export surface requires it: `src/stats/index.ts`

**Interfaces:**

- Produces:

```ts
export const ZERO_USAGE_OBSERVATION_TURNS = 20;

export type SkillPlacementReason =
  | "low-adoption"
  | "zero-recommendation-usage";

export interface SkillPlacementCandidate {
  epochKey: string;
  agentId: string;
  name: string;
  source: SkillSource;
  reason: SkillPlacementReason;
  observedTurns: number;
  usageTurns: number;
  recommendedTurns: number;
  adoptionRate?: number;
}

StatsAggregator.selectSkillPlacementCandidate(
  agentId: string,
  excludedEpochKeys?: ReadonlySet<string>,
): SkillPlacementCandidate | undefined;
```

- Consumes: strict `loadStats()`, canonical `ownRecordValue()`, schema-v3 `skillInventory`, and top-level `stats.skills[canonicalName].needsReview`. Canonical skill identity is `trim().toLowerCase()` for both recommendation/usage aggregate writes and selector joins; resolved inventory display casing is preserved. At the load boundary, merge valid existing mixed-case aggregate and daily-count collisions into one canonical key and recompute derived fields.

- [ ] **Step 1: Write a failing 19/20-turn boundary test**

Add a helper that records a visible skill repeatedly with no recommendation or use, then assert:

```ts
expect(aggregator.selectSkillPlacementCandidate("main")).toBeUndefined();
recordVisibleInventoryTurn(aggregator, 20);
expect(aggregator.selectSkillPlacementCandidate("main")).toMatchObject({
  agentId: "main",
  name: "unused-skill",
  reason: "zero-recommendation-usage",
  observedTurns: 20,
  usageTurns: 0,
  recommendedTurns: 0,
});
```

- [ ] **Step 2: Run the focused RED test**

Run:

```bash
pnpm test src/stats/aggregator.test.ts -t "selects zero-use skill only after 20 continuous observations"
```

Expected: FAIL because `selectSkillPlacementCandidate` does not exist.

- [ ] **Step 3: Implement the minimal current-epoch selector**

Use only observations whose `lastSeenTurn === agent.observedTurns`; stale retained observations are not currently visible. Build the epoch key as a SHA-256 of a length-safe JSON tuple:

```ts
const epochKey = crypto
  .createHash("sha256")
  .update(
    JSON.stringify([
      stats.skillInventory.startedAt,
      agentId,
      canonicalSkillName(skill.name),
      skill.source,
      skill.winnerFingerprint,
      skill.fingerprint,
      skill.firstSeenTurn,
    ]),
  )
  .digest("hex");
```

Catch invalid/missing stats and return `undefined` after a warning; do not synthesize candidates.

- [ ] **Step 4: Verify the first GREEN slice**

Run the test from Step 2. Expected: PASS.

- [ ] **Step 5: Add RED tests for priority, deterministic order, visibility, epoch reset, and exclusion**

Cover these exact outcomes:

```ts
expect(selected.reason).toBe("low-adoption");
expect(selected.name).toBe("alpha-skill");
expect(staleInvisibleSelection).toBeUndefined();
expect(newEpoch.observedTurns).toBe(1);
expect(
  aggregator.selectSkillPlacementCandidate(
    "main",
    new Set([selected.epochKey]),
  ),
).toBeUndefined();
expect(aggregator.selectSkillPlacementCandidate("other-agent")).toBeUndefined();
```

Arrange low adoption through the existing five-recommendation, below-0.7 aggregate path rather than hand-editing private state.

- [ ] **Step 6: Run the expanded selector tests and verify RED**

Run:

```bash
pnpm test src/stats/aggregator.test.ts -t "skill placement"
```

Expected: at least priority/exclusion/current-visibility tests fail until sorting and filtering are implemented.

- [ ] **Step 7: Complete the selector and verify GREEN**

Create candidate arrays in two buckets, exclude completed/pending epoch keys before sorting, sort by canonical skill name, and return the first low-adoption candidate or first zero-use candidate. Run:

```bash
pnpm test src/stats/aggregator.test.ts
pnpm run typecheck
```

Expected: PASS.

---

### Task 2: Strict current-only review log with completed epoch ledger

**Files:**

- Modify: `src/review/log.ts:22-356`
- Modify: `src/review/log.test.ts`
- Modify: `src/review/log-writer.ts:72-214`
- Modify: `src/review/log-writer.test.ts`

**Interfaces:**

- Produces:

```ts
export interface CompletedSkillEpochReview {
  agentId: string;
  skillName: string;
  reason: SkillPlacementReason;
  completedAt: string;
  outcome: "applied" | "nofinding";
  eventId: string;
}

export interface ReviewLog {
  schemaVersion: 5;
  createdAt: string;
  updatedAt: string;
  triggerKeywords: ReviewTriggerKeywords;
  processedEvents: Record<string, ProcessedEventRecord>;
  reviewedSkillEpochs: Record<string, CompletedSkillEpochReview>;
}

ReviewLogWriter.completedSkillEpochKeys(): ReadonlySet<string> | undefined;
```

Extend `ReviewLogWriter.record()` options with:

```ts
skillPlacementCandidate?: SkillPlacementCandidate;
```

- Consumes: Task 1 `SkillPlacementCandidate` and `SkillPlacementReason`.

- [ ] **Step 1: Replace migration expectations with failing strict-schema tests**

Delete tests that expect v1-v4 migration, snake_case trigger aliases, string processed-event records, `wrote-items`, or legacy item recovery. Add assertions that:

```ts
expect(() => parseReviewLog({ schemaVersion: 4 })).toThrow();
expect(createReviewLog(now)).toMatchObject({
  schemaVersion: 5,
  reviewedSkillEpochs: {},
});
```

Also assert malformed current records fail rather than silently normalizing legacy shapes. The matrix must include a wrong-typed keyword map, unknown processed-event fields, legacy string events, `wrote-items`, and the legacy-only `unknown` outcome.

- [ ] **Step 2: Run strict schema RED tests**

Run:

```bash
pnpm test src/review/log.test.ts -t "schema version 5|rejects legacy"
```

Expected: FAIL because current code emits v4 and migrates old versions.

- [ ] **Step 3: Implement one strict v5 schema**

Remove `LEGACY_TRIGGER_TYPE_MAP`, `normalizeTrigger()`, the string/record union, `wrote-items`, legacy-only `unknown` outcome, and the version migration branch. Define `ReviewLogSchema` directly with `schemaVersion: z.literal(5)` and strict current record shapes. Keep current keyword normalization only where it serves current host-written data, not legacy aliases.

- [ ] **Step 4: Verify strict log GREEN**

Run:

```bash
pnpm test src/review/log.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failing writer tests for completion semantics**

Test all of:

```ts
await writer.record(eventId, source, findings, {
  triggers: ["skill-placement"],
  outcome: "applied",
  skillPlacementCandidate: candidate,
});
expect(writer.completedSkillEpochKeys()).toEqual(new Set([candidate.epochKey]));
```

Repeat with `nofinding`. Parameterize `subagent-error`, `parse-failed`, `schema-rejected`, and `validation-failed` and assert the epoch key is absent. Assert an invalid/unreadable current review log returns `undefined`, not an empty set, so eligibility fails closed.

- [ ] **Step 6: Run writer RED tests**

Run:

```bash
pnpm test src/review/log-writer.test.ts -t "skill epoch"
```

Expected: FAIL because no completion ledger API exists.

- [ ] **Step 7: Persist completion atomically with the processed event**

Within the existing file lock, add the completion record only when:

```ts
options.skillPlacementCandidate &&
  (outcome === "applied" || outcome === "nofinding");
```

Use the same `nowIso` and `eventId` as the processed event. Implement `completedSkillEpochKeys()` as a strict read of the current log; return `new Set()` when the file is absent and `undefined` when present but invalid/unreadable. Add a fault-injection test proving the processed event and `reviewedSkillEpochs` entry either both persist in one atomic write or both remain absent, and that a later retry can complete them.

- [ ] **Step 8: Verify writer and typecheck GREEN**

Run:

```bash
pnpm test src/review/log.test.ts src/review/log-writer.test.ts
pnpm run typecheck
```

Expected: PASS.

---

### Task 3: Trigger, config, snapshot, catalog, and prompt contract

**Files:**

- Modify: `src/types.ts:11-55`
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Modify: `openclaw.plugin.json:197-340`
- Modify: `manifest.test.ts`
- Modify: `src/review/triggers.ts:8-19`
- Modify: `src/review/triggers.test.ts`
- Modify: `src/review/types.ts:31-45`
- Modify: `src/review/snapshot-formatter.ts`
- Modify: `src/review/snapshot-formatter.test.ts`
- Modify: `src/review/catalog-projection.ts`
- Modify: `src/review/catalog-projection.test.ts`
- Modify: `src/review/subagent.ts:80-132,521-674`
- Modify: `src/review/subagent.test.ts`

**Interfaces:**

- Produces config:

```ts
skillPlacement?: { enabled?: boolean };
// resolved as
skillPlacement: { enabled: boolean };
```

- Produces snapshot addition:

```ts
skillPlacementCandidate?: SkillPlacementCandidate & {
  currentlyReferencedIntentIds: string[];
};
```

- Consumes Task 1 candidate type.

- [ ] **Step 1: Add failing config and manifest tests**

Assert omitted config resolves to `{ enabled: true }`, explicit false is preserved, and the manifest exposes only an `enabled` boolean without a threshold field.

Run:

```bash
pnpm test src/config.test.ts manifest.test.ts -t "skillPlacement|skill placement"
```

Expected: FAIL because the field is absent.

- [ ] **Step 2: Implement config and trigger identity**

Add `skillPlacement` to `ReviewTriggersConfig`, `ResolvedReviewConfig`, the Zod/default resolver, manifest schema, and `REVIEW_TRIGGER_TYPES` as `"skill-placement"`. Do not make `checkReviewTriggers()` infer it from turn text; hooks append it only when Task 1 selects a candidate.

- [ ] **Step 3: Verify config GREEN**

Run the command from Step 1. Expected: PASS.

- [ ] **Step 4: Add failing snapshot and full-catalog tests**

Build a snapshot with a candidate whose `epochKey`, winner fingerprint, and content fingerprint are recognizable sentinels. Assert formatted output:

```ts
expect(output).toContain("<skill_placement_candidate>");
expect(output).toContain('"name":"unused-skill"');
expect(output).toContain('"reason":"zero-recommendation-usage"');
expect(output).not.toContain(candidate.epochKey);
expect(output).not.toContain("winner-sentinel");
expect(output).not.toContain("content-sentinel");
expect(output).toContain('"skills":["unused-skill"]');
```

Assert `projectIntentCatalog(snapshot, ["skill-placement"]).mode === "full"` regardless of projection reduction opportunities.

- [ ] **Step 5: Run snapshot/catalog RED tests**

Run:

```bash
pnpm test src/review/snapshot-formatter.test.ts src/review/catalog-projection.test.ts -t "skill placement"
```

Expected: FAIL because candidate formatting, catalog `skills[]`, and full-catalog policy are absent.

- [ ] **Step 6: Implement safe snapshot formatting**

Add a dedicated formatter that selects only model-safe fields:

```ts
const {
  name,
  source,
  reason,
  observedTurns,
  usageTurns,
  recommendedTurns,
  adoptionRate,
  currentlyReferencedIntentIds,
} = snapshot.skillPlacementCandidate;
```

Never stringify the candidate object wholesale. Include `skills: [...definition.skills]` in catalog metadata. Mark `skill-placement` as a full-catalog trigger.

- [ ] **Step 7: Verify snapshot/catalog GREEN**

Run the command from Step 5. Expected: PASS.

- [ ] **Step 8: Add failing prompt and tool-allowlist tests**

Assert the prompt requires `skill_view` of the exact target, directs the reviewer to choose one evidence-backed runtime intent, forbids skill mutation, allows no finding, and contains `skill_view` in the embedded allowlist when only `skill-placement` is requested.

- [ ] **Step 9: Implement the dedicated prompt lens and verify GREEN**

Add `skill-placement` to `REVIEW_INSTRUCTIONS`, catalog-context triggers, and `buildReviewToolsAllow()`. Keep the output target as `intent-markdown`; no new finding target kind is needed. Run:

```bash
pnpm test src/review/subagent.test.ts -t "skill placement"
pnpm run typecheck
```

Expected: PASS.

---

### Task 4: Enforce positive placement edits in the isolated reviewer transaction

**Files:**

- Modify: `src/review/subagent.ts:1138-1237`
- Modify: `src/review/subagent.test.ts`

**Interfaces:**

- Consumes: `ReviewSnapshot.skillPlacementCandidate` and parsed `ReviewFinding[]`.
- Produces: existing `ReviewSubagentResult`; no new outcome type.

- [ ] **Step 1: Add failing transaction tests**

Create reviewer fixtures for these cases:

1. `skill-placement` positive finding edits `coding.md` and leaves `skills:` without the target skill → `validation-failed` and live intent unchanged.
2. Positive finding adds target skill once → `applied`.
3. Target skill already exists and reviewer adds only minimal usage guidance → `applied`, no duplicate frontmatter entry.
4. `hasFinding=false` makes no edit → `nofinding`.
5. Reviewer attempts to edit an undeclared second intent → existing undeclared-target validation still rejects it.
6. A `skill-placement` finding declares two target intents → schema rejection or validation failure with no live edit.
7. Two positive `skill-placement` findings each declare a different single target → validation failure with no live edit.

- [ ] **Step 2: Run transaction RED tests**

Run:

```bash
pnpm test src/review/subagent.test.ts -t "validates skill placement edits"
```

Expected: the missing-target-skill case incorrectly applies before the host guard exists.

- [ ] **Step 3: Implement the smallest host-side placement guard**

Across the complete result, require exactly one positive `skill-placement` finding with exactly one `targetIntentId`; do not validate only one finding at a time. Then inspect only that changed target in the staged `afterIntentFiles`. Parse frontmatter with the repository's existing `gray-matter` dependency and compare canonical skill names. Require the changed target to declare the selected skill after the edit. If not, return:

```ts
{
  findings: [],
  outcome: "validation-failed",
  validationErrors: [
    `skill-placement review did not place ${candidate.name} in a changed target intent`,
  ],
}
```

Do not require a new frontmatter insertion when the skill was already present; a guidance-only refinement is valid.

- [ ] **Step 4: Verify transaction GREEN and regression safety**

Run:

```bash
pnpm test src/review/subagent.test.ts
pnpm run typecheck
```

Expected: PASS.

---

### Task 5: Hook integration, one-at-a-time queueing, pending suppression, and retry

**Files:**

- Modify: `src/hooks/types.ts:25-45`
- Modify: `src/hooks/index.ts:471-488,1518-1690`
- Modify: `src/hooks/index.test.ts`

**Interfaces:**

- Consumes:
  - `StatsAggregator.selectSkillPlacementCandidate(agentId, excludedEpochKeys)`
  - `ReviewLogWriter.completedSkillEpochKeys()`
  - `ReviewLogWriter.record(..., { skillPlacementCandidate })`
- Produces no public API; it extends existing hook behavior.

- [ ] **Step 1: Add an end-to-end failing hook test for zero-use placement**

Arrange an accepted twentieth inventory observation, enabled Review with `skillPlacement.enabled`, no ordinary turn triggers, and an injected reviewer. Assert exactly one queued run receives:

```ts
expect(run.triggers).toEqual(["skill-placement"]);
expect(run.snapshot.skillPlacementCandidate).toMatchObject({
  name: "unused-skill",
  reason: "zero-recommendation-usage",
});
```

- [ ] **Step 2: Run hook RED test**

Run:

```bash
pnpm test src/hooks/index.test.ts -t "queues zero-use skill placement review"
```

Expected: FAIL because hooks never read stats candidates.

- [ ] **Step 3: Integrate selection after accepted stats**

Use only the persisted tracker agent ID returned by accepted stats recording for candidate selection, skill resolution, model resolution, snapshot identity, and reviewer invocation. Never fall back to finalize context for a placement run. Require a trustworthy inventory observation from the current accepted event; if current inventory resolution failed, do not select from the previous observation even though the base stats event remains fail-open. If `completedSkillEpochKeys()` returns `undefined`, skip placement selection while preserving ordinary triggers. Combine triggers without duplicates:

After the asynchronous snapshot lookup, require `availableSkills` to contain the selected skill by canonical name. If it no longer resolves, do not enqueue the placement run; release the pending reservation so a later accepted turn can retry. If ordinary triggers remain, remove only `skill-placement` and rebuild the ordinary agent, model, and snapshot path without placement data before enqueueing them.

```ts
const triggers = checkReviewTriggers(...);
if (candidate) triggers.push("skill-placement");
```

Build `currentlyReferencedIntentIds` from current catalog definitions whose canonical `skills[]` contain the candidate name. Add `skills[]` to snapshot catalog entries.

- [ ] **Step 4: Verify first hook GREEN slice**

Run the test from Step 2. Expected: PASS.

- [ ] **Step 5: Add failing tests for priority, one-per-run, pending, completion, and retry**

Cover:

- low-adoption selected before zero-use;
- only one candidate attached when multiple are eligible;
- two interleaved accepted turns cannot select or enqueue the same pending epoch;
- `applied` and `nofinding` pass candidate metadata to `record()` and suppress subsequent runs;
- reviewer throw, `validation-failed`, and failed review-log write clear pending and permit a later run;
- disabled `skillPlacement` does not select a candidate;
- candidate can join existing ordinary triggers in one Review run;
- invalid review ledger state skips placement but preserves ordinary triggers;
- tracker agent ID wins over a conflicting finalize-context agent ID.

- [ ] **Step 6: Run expanded hook tests and verify RED**

Run:

```bash
pnpm test src/hooks/index.test.ts -t "skill placement"
```

Expected: pending/completion/retry tests fail before queue lifecycle integration.

- [ ] **Step 7: Implement pending lifecycle and completion logging**

Create one closure-local `Set<string>` in `createHookHandlers()`. Reserve the selected epoch synchronously immediately after selection and before the first asynchronous snapshot, skill-resolution, model, or queue preparation boundary. Include pending keys in the selector exclusion set. If preparation or enqueue fails, release the reservation. Transfer reservation ownership to the queued body only after successful enqueue, wrap that body in `try/finally`, and always clear pending. Pass `skillPlacementCandidate` to the log writer only for that run. A failed log write must leave the epoch uncompleted and therefore retryable.

- [ ] **Step 8: Verify complete hook GREEN slice**

Run:

```bash
pnpm test src/hooks/index.test.ts
pnpm run typecheck
```

Expected: PASS.

---

### Task 6: Synchronize docs and public contract

**Files:**

- Modify: `README.md`
- Modify: `docs/intent-review.md`
- Modify: `docs/metrics.md`
- Modify: `AGENTS.md`
- Modify: `docs/skill-placement-review.md` only if implementation decisions changed

**Interfaces:**

- Consumes the completed runtime behavior from Tasks 1-5.
- Produces the user and coding-agent contract.

- [ ] **Step 1: Update documentation with exact current behavior**

Document:

- `skill-placement` trigger and config default;
- low-adoption priority and fixed 20-turn zero-use threshold;
- one candidate per run and once-per-epoch completion;
- failure retry behavior;
- full catalog and `skill_view` evidence;
- intent-only mutation boundary;
- current-only review-log schema and explicit absence of v1-v4 migration;
- inventory observations are now consumed by placement Review rather than merely future evidence.

- [ ] **Step 2: Search for stale claims and removed compatibility names**

Use repository search tools for:

```text
schemaVersion: 4
skill_candidate
process_gap
wrote-items
legacy items
migration
future Skill Review
```

Remaining migration prose is allowed only for stats v1/v2→v3; Review log must describe current-only v5 behavior.

- [ ] **Step 3: Format and verify docs-backed behavior**

Run:

```bash
pnpm run format
pnpm test src/config.test.ts manifest.test.ts src/review/log.test.ts
```

Expected: PASS and no formatting changes left after the formatter.

---

### Task 7: Final verification and adversarial review

**Files:**

- Inspect all changed files; make no unrelated changes.

**Interfaces:**

- Consumes all prior tasks.
- Produces verified handoff evidence.

- [ ] **Step 1: Run focused verification**

```bash
pnpm test src/stats/aggregator.test.ts src/review/triggers.test.ts src/review/log.test.ts src/review/log-writer.test.ts src/review/catalog-projection.test.ts src/review/snapshot-formatter.test.ts src/review/subagent.test.ts src/hooks/index.test.ts src/config.test.ts manifest.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository gates**

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run format
git diff --check
```

Expected: all PASS.

- [ ] **Step 3: Inspect scope and removed compatibility paths**

```bash
git status --short
git diff --stat HEAD
git diff HEAD -- src/review/log.ts src/review/log-writer.ts
```

Confirm no `tasks/`, root `stats.json`, runtime `review.json`, generated session artifact, skill file, or unrelated source change exists.

- [ ] **Step 4: Pin hashes and request fresh-context review**

Record SHA-256 for every changed file, dispatch a read-only reviewer with the approved design and expected hash manifest, and require `STALE` on any drift. The reviewer must verify:

- trustworthy per-agent eligibility;
- current visibility and 20-turn epoch boundary;
- low-adoption priority and deterministic one-candidate limit;
- completed/pending/retry lifecycle;
- current-only v5 log behavior;
- full catalog and model-safe snapshot evidence;
- positive intent edit enforcement;
- no skill mutation capability;
- no regression in ordinary Intent Review triggers or transaction safety.

- [ ] **Step 5: Resolve substantive findings with RED-GREEN tests**

For each correctness, security, performance, or contract finding, add a failing test first, verify RED, implement the root-cause fix, rerun focused and full gates, then obtain a non-STALE approval. Do not act on style-only or optional enhancement findings.
