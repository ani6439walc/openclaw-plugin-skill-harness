# Skill Placement Review Design

## Objective

Extend Intent Review with a dedicated `skill-placement` trigger that uses skill stats to improve runtime intent routing. The reviewer may add one eligible skill to the most appropriate runtime intent's direct `skills[]` frontmatter. It must not create, edit, merge, rename, or delete skill files.

Success means an under-adopted or fully observed but never-recommended/never-used skill gets one evidence-grounded placement review per inventory epoch without repeatedly consuming review capacity or weakening existing Intent Review safety checks.

## Scope

### In scope

- Add `skill-placement` to the Review trigger contract.
- Select at most one eligible skill after an accepted stats event.
- Prefer low-adoption candidates over zero-recommendation/zero-usage candidates.
- Provide targeted skill evidence and the complete intent catalog to the reviewer.
- Permit validated routing-only intent edits that place the skill in an appropriate `skills:` list and, only when necessary, refine the single plain-text body guidance sentence.
- Persist completed per-agent/per-skill/per-epoch review state.
- Keep technical and validation failures retryable.
- Replace legacy `review.json` compatibility paths with one current schema.

### Out of scope

- Any `SKILL.md` mutation.
- Skill creation, merge, split, rename, deletion, or related-skill metadata changes.
- Candidate rollout modes or a separate periodic auditor.
- Historical observation synthesis.
- A configurable zero-usage threshold.
- More than one targeted skill per Review run.

## Commands

- Focused tests: `pnpm test src/review src/hooks/index.test.ts src/stats/aggregator.test.ts`
- Typecheck: `pnpm run typecheck`
- Full tests: `pnpm run test`
- Build: `pnpm run build`
- Format: `pnpm run format`

## Eligibility Contract

Eligibility is evaluated only after the existing stats event is accepted. The selector uses the agent ID persisted by the session tracker and only considers skills in that agent's current trustworthy resolved inventory.

A candidate must have a complete current inventory epoch and must not be pending or completed for that epoch.

Candidate priority is deterministic:

1. `low-adoption`
   - The existing top-level skill aggregate has `needsReview === true`.
   - The skill is visible in the current agent inventory.
2. `zero-recommendation-usage`
   - The current continuous epoch has `observedTurns >= 20`.
   - `recommendedTurns === 0`.
   - `usageTurns === 0`.

Within one priority, normalized skill name order breaks ties. A turn selects at most one candidate. Recommendation and usage aggregates use a trimmed lowercase canonical key for the `needsReview` join; the inventory retains the resolved display name.

## Epoch Identity and Completion

The host derives an internal epoch identity from:

- the inventory telemetry `startedAt` value;
- canonical agent ID;
- canonical skill name;
- source;
- winner fingerprint;
- content fingerprint;
- `firstSeenTurn`.

The inventory `startedAt` value prevents a rebuilt `stats.json` observation era from colliding with an older completion ledger. `firstSeenTurn` distinguishes visibility epochs when the same source and content disappear and later return.

The identity remains internal. Public skill list/search/view results must not expose inventory fingerprints or the epoch key.

Only `applied` and `nofinding` outcomes complete an epoch. `subagent-error`, `parse-failed`, `schema-rejected`, and `validation-failed` remain retryable on a later accepted turn. The host reserves an epoch immediately after selection and before any asynchronous snapshot, skill-resolution, or model work. It releases that reservation on preparation, enqueue, reviewer, validation, and log-write failure.

## Review Snapshot Contract

A selected candidate adds a single host-owned `skillPlacementCandidate` to the Review snapshot with:

- skill name;
- source;
- reason (`low-adoption` or `zero-recommendation-usage`);
- observed, recommended, and usage turn counts;
- adoption rate when available;
- currently referencing intent IDs.

The prompt serialization adds a required candidate block only for `skill-placement`. Fingerprints and epoch keys are not serialized to the model. Placement runs omit `<available_skills>` entirely; the bounded `<selected_placement_skill>` block is their only skill-content evidence.

Intent catalog metadata includes each intent's declared `skills[]` so the reviewer can detect existing placement. `skill-placement` always receives the complete catalog; it does not use candidate projection.

## Reviewer Workflow

For the one targeted skill, the reviewer must:

1. Use only the host-provided `<selected_placement_skill>` evidence for its resolved description and bounded `SKILL.md` content.
2. Compare that evidence against complete intent catalog domains, triggers, examples, and existing `skills[]`.
3. Return no finding when there is no durable, evidence-backed placement or the skill is already appropriately covered.
4. Before editing, read the authoritative current Markdown for the selected intent in the isolated review workspace.
5. Add the skill to the intent's frontmatter `skills:` without duplicates and while preserving unrelated entries.
6. Add only the minimum durable body-guidance refinement needed to explain when the selected skill applies. Keep the complete body as one plain-text routing sentence; workflows and pitfalls belong in the selected skill.
7. Return an `intent-markdown` finding with exactly one target intent whose staged edit matches the finding.

The reviewer must not inspect or modify unrelated skills, force a placement solely because usage is low, create an otherwise unjustified intent, or place the skill into every similar intent. Host validation aggregates all positive placement findings: the complete run must contain exactly one positive finding and one target intent. Before applying a placement edit, the host acquires the intent-directory transaction lock, compares the original and staged frontmatter, and rechecks the live target: every frontmatter field except `skills[]` must be semantically identical, while the plain-text body guidance may be refined; existing skill entries stay in order and the selected skill may only be appended when absent. Lock contention or live drift rejects the placement without applying it.

## Tool and Mutation Boundaries

A `skill-placement` run receives only the established intent editing tools:

- `read`
- `write`
- `apply_patch`

The host resolves exactly one selected skill, bounds its `SKILL.md` content, and includes it in the untrusted review snapshot. The reviewer does not receive `skill_view`, `skill_list`, `skill_search`, `skill_manage`, shell access, config write access, or arbitrary filesystem access.

Intent edits continue through the existing isolated workspace, workspace-only filesystem policy, finding/edit symmetry checks, intent validation, concurrent-edit detection, staged writes, backups, rollback, and catalog refresh.

## Review Log Contract

`review.json` moves to one current schema containing:

- runtime trigger keywords;
- processed Review events;
- completed skill epoch records.

The completed skill epoch record includes enough host metadata to suppress another completed review for the same agent, skill, and epoch and to audit the completion reason and outcome.

There is no v1-v4 compatibility or migration path. Legacy trigger aliases, string processed events, legacy outcomes, unknown fields, and legacy review-log migration code are rejected. Keyword list trimming and deduplication remain current host-data normalization. The runtime file must be absent or conform to the current schema.

## Configuration

Add `review.triggers.skillPlacement.enabled`, defaulting to `true`. Global `review.enabled` remains `false` by default and remains the outer gate.

The zero-recommendation/zero-usage threshold is the product constant `20`, not a public config field.

## Error Handling

- Untrustworthy stats or inventory state skips candidate selection without blocking the accepted base stats event.
- Missing current skill resolution produces no placement run, releases its reservation, and preserves any ordinary Review triggers through their non-placement path.
- Queue and reviewer failures remain fail-open for the user turn.
- A technical or validation failure clears the in-memory pending reservation and does not persist completion.
- Review log write failure must not mutate stats or block the session lifecycle. The processed event and completed epoch must either both appear in the same atomic write or both remain absent.
- A conflicting live intent edit prevents reconciliation and leaves the candidate retryable.

## Testing Strategy

Use vertical RED-GREEN slices:

1. Trigger/config contract and selector eligibility.
2. Priority, deterministic one-candidate limit, agent visibility, and epoch completion suppression.
3. Snapshot serialization, complete catalog skill metadata, and prompt/tool contract.
4. Reviewer staging behavior and no-finding behavior.
5. Review-log current schema and completion persistence without legacy migration.
6. Hook integration, retryable failure, and pending suppression.

Required acceptance coverage:

- 19 zero-use observations do not trigger; 20 do.
- A restarted epoch does not inherit the old epoch's threshold.
- `needsReview` wins over a zero-use candidate.
- At most one skill is selected per run.
- Only the tracked agent's visible skills are eligible.
- `applied` and `nofinding` suppress the same epoch.
- Technical and validation failures permit retry.
- A new epoch permits review again.
- Existing placement is not duplicated.
- The reviewer can add a skill to the best supported intent.
- No supported intent yields no finding and no file edit.
- Skill, config, source, and state files remain outside subagent mutation scope.
- Existing Review triggers and Intent Review transaction checks remain green.
- Only the current `review.json` schema is accepted.

## Boundaries

### Always

- Use persisted tracker agent identity.
- Select only from trustworthy resolved inventory.
- Keep one targeted skill per run.
- Require direct skill-to-intent evidence.
- Reuse existing intent validation and reconciliation.

### Ask first

- Making the threshold configurable.
- Adding periodic or batch auditing.
- Allowing skill file mutation.
- Changing the once-per-epoch policy.

### Never

- Synthesize historical zero observations.
- Treat absence from old stats as zero use.
- Expose internal fingerprints publicly.
- Retry a completed epoch.
- Modify a skill merely to improve its adoption metric.
