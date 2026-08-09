# Review Keyword Audit Workflow

Use this workflow to analyze **Intent Review trigger keywords** and produce a bounded proposal from retained Skill Harness runtime evidence.

This mode reads current trigger keywords from schema-v1 `keyword-coverage.json`:

- `triggerKeywords.successfulPattern`
- `triggerKeywords.behaviorFix`
- `triggerKeywords.entityContext`

It reads ordinary Review outcome counts from schema-v6 `review.json.processedEvents`, historical keyword-triggered audit counts from `review.json.historicalKeywordAudits`, and keyword mutation / coverage epoch history from `keyword-coverage.json`.

It does **not** analyze intent `fastpath.keywords` or `candidate.keywords`. For those, use design or inventory mode and require labeled positive and collision fixtures under `references/format.md`.

## Safety boundary

Runtime sessions can contain private user and assistant text. Keep reports local, do not paste raw snippets into chat or external artifacts, and never read credential files. The bundled audit script is report-only and omits snippets unless `--include-snippets` is explicitly supplied. It requires either `--output` or an explicit `--stdout`; `--output` is the safe default and atomically creates a mode-`0600` local report. Snippets are refused on stdout.

This workflow is report and proposal only. Keyword persistence belongs to production Intent Review; do not invoke, emulate, or bypass its host-owned writer, and never hand-edit `review.json` or `keyword-coverage.json`.

## Step 1 — Generate and inspect the retained evidence window

The audit script automatically resolves the default OpenClaw state/config paths, loads current schema-v6 `review.json` and schema-v1 `keyword-coverage.json`, reads retained sessions, and records the effective successful-pattern threshold and input provenance. Do not reconstruct those defaults in a shell wrapper.

Use `--data-root` or `--config` only for an intentionally nonstandard layout. The generated report records these inputs:

- schema-v6 `review.json` ordinary and historical Review audit outcomes
- schema-v1 `keyword-coverage.json` trigger keywords, mutation events, target cursors/watermarks, and coverage epochs
- retained `sessions/*.json` snapshots and `stats.json` as a retention/coverage cross-check
- effective `plugins.entries["skill-harness"].config.review.triggers.successfulPattern.toolCalls` threshold
- both runtime JSON hashes, script hash, source commit when available, and observed retained-state analysis window

The script does not snapshot or hash session files. It reads each retained state once and reports the timestamps it observed, so an active runtime can change the session set during analysis. Use a quiescent copied data root when an immutable cross-file snapshot is required, and do not describe `analysisWindow` as a pinned session snapshot.

Historical keyword audits do **not** preserve the keyword that matched or the keyword-set version. They can support outcome counts, but cannot be replayed against the current keyword list for keyword attribution. `processedKeywordEvents` records bounded mutation outcomes, not matched-turn attribution.

The script reads the threshold from `CONFIG_PATH`; `--successful-tool-calls` is an explicit override. The report's `configuration.thresholdSource` must say `openclaw-config`, `cli-override`, `default`, or `default-invalid-config`. The effective range is `1`–`100`, with source default `5`.

The report records bounded provenance:

- `provenance.reviewSha256` and `provenance.keywordCoverageSha256` — SHA-256 values of both exact runtime JSON inputs; the script stops if either changes during loading
- `provenance.scriptSha256` — SHA-256 of the exact audit script bytes
- `provenance.sourceCommit` — repository `HEAD` when Git metadata is available; `null` in packaged/non-Git installs
- `analysisWindow` — earliest retained state start, latest retained state end, timestamped-state count, and total analyzed-state count

Treat `scriptSha256` as the portable source identity when `sourceCommit` is `null`. A partial timestamp window is allowed, but disclose `statesWithTimestamps < statesAnalyzed`; do not infer missing timestamps.

Completion criterion: the source paths, schema versions, available hashes, observed retained analysis window, threshold value, threshold source, and session-snapshot limitation are disclosed. If either runtime JSON input is absent or not its current schema, stop instead of inventing defaults or migrating it.

## Step 2 — Generate the read-only report

From the repository root:

```bash
python3 skills/skill-harness/scripts/review-keyword-audit.py \
  --output /tmp/skill-harness-keyword-audit.json
```

Useful narrow runs:

```bash
python3 skills/skill-harness/scripts/review-keyword-audit.py \
  --target behavior-fix \
  --min-docs 2 \
  --top 30 \
  --output /tmp/behavior-fix-keyword-audit.json
```

For an intentional one-run threshold override:

```bash
python3 skills/skill-harness/scripts/review-keyword-audit.py \
  --successful-tool-calls <configured-count> \
  --output /tmp/skill-harness-keyword-audit.json
```

The script provides an **approximate structural replay** of the deterministic trigger gates that matter to keyword matching:

- `successful-pattern` — no agent error and either enough tool calls or at least one used skill; searches user input plus assistant result
- `behavior-fix` — searches user input only and excludes known quoted/ingest prompt markers
- `entity-context` — requires a memory/tools source signal in text or a matching read/search tool parameter; searches user input plus assistant result

It intentionally normalizes text with NFKC, lowercase, and collapsed whitespace for audit grouping, while production matching lowercases and performs substring checks without the same compatibility/whitespace normalization. Treat edge cases involving compatibility characters or repeated whitespace as candidates for focused production tests, not as exact replay proof.

The unlabeled report includes:

- structurally eligible, current-keyword-matched, and current-keyword-unmatched retained documents
- current substring-match counts for every keyword
- ranked CJK substrings and Latin token n-grams found in unmatched eligible documents
- local session/turn references for manual labeling
- overlap with other structurally eligible trigger targets
- ordinary/historical Review outcome counts plus prior keyword mutation and coverage-epoch counts
- aggregate `stats.json` turns versus retained session states

These are **structural match proxies**, not semantic hits or misses. An unmatched eligible document is not a false negative until a human label says that target should have triggered. Candidate phrases are discovery leads, not recommendations; phrase frequency does not prove semantic correctness.

Completion criterion: the report parses as JSON, its mode is `0600`, `reportOnly` is `true`, `snippetsIncluded` is `false`, and every requested target has a summary.

## Step 3 — Build a labeled fixture

Copy `templates/review-keyword-labels.json` to a private local path and add report refs without copying conversation text:

```json
{
  "schemaVersion": 1,
  "observations": [
    {
      "ref": "session-file.json#history:0",
      "expectedTriggers": ["behavior-fix"]
    },
    {
      "ref": "session-file.json#current:0",
      "expectedTriggers": []
    }
  ]
}
```

Allowed expected triggers are `successful-pattern`, `behavior-fix`, and `entity-context`. An empty list is an explicit negative observation. Keep one observation per unique ref.

Run the semantic replay:

```bash
python3 skills/skill-harness/scripts/review-keyword-audit.py \
  --labels /tmp/review-keyword-labels.json \
  --output /tmp/skill-harness-keyword-audit-labeled.json
```

`labeledMetrics` reports TP, FP, FN, TN, precision, recall, multi-trigger predictions, unknown refs, and positives blocked by structural gates. Treat any unknown ref as stale fixture evidence and resolve it before proposing a change.

Definitions:

- **TP:** label expects the trigger; its structural gate passes; a current keyword matches.
- **FP:** label does not expect the trigger; its structural gate passes; a current keyword matches.
- **FN:** label expects the trigger, but the full structural-gate-plus-keyword prediction does not fire.
- **Structural blocked positive:** an FN where the keyword surface was never reached because the trigger's structural gate failed.
- **Collision:** an FP caused by broad substring matching, the same phrase serving multiple trigger targets, or one labeled observation predicting multiple targets unexpectedly.

## Step 4 — Label proposed phrases and collisions

For each proposed addition, inspect the referenced retained turns locally with structured file reads. Build a compact evidence record:

```text
target: behavior-fix
phrase: "不要再"
positive refs: <two or more distinct session files>
collision refs: <checked non-target uses>
why existing keywords do not match: <observable exact-match gap>
expected effect: <which eligible turns become matched>
```

Apply these gates:

1. **Durability:** require positive evidence from at least two distinct retained sessions. One session is anecdotal; keep it as a candidate only.
2. **Literal semantics:** the exact phrase must express the target signal, not merely co-occur with it.
3. **Collision review:** search all retained inputs/results for the phrase, including documents outside the target's structural gate. Label quoted text, negation, examples, copied prompts, and unrelated meanings.
4. **Shortest safe phrase:** prefer the shortest phrase that preserves meaning without increasing collisions. CJK matching is substring-based, so one overly broad character can fan out badly.
5. **No duplicate identity:** compare trimmed case-insensitively with current keywords before proposing an addition.

For removals, require repeated false-positive evidence from at least two distinct sessions and verify the keyword has no retained true-positive role. **Zero retained hits is not removal evidence** because session retention may have discarded the turns that justified the keyword.

Completion criterion: every addition/removal has labeled positive and collision evidence, `unknownRefs` is empty, and the labeled metrics distinguish keyword misses from structural-gate misses. Otherwise recommend no change.

## Step 5 — Present a bounded proposal

Present per target:

- structural proxy: eligible / current-keyword-matched / current-keyword-unmatched
- labeled TP / FP / FN / precision / recall
- proposed additions, maximum 3
- proposed removals, maximum 3
- positive refs and collision result for each phrase
- expected newly matched retained documents
- uncertainty caused by session retention or incomplete data
- recommendation: propose exact delta / retain current set / gather more evidence

Do not combine `successful-pattern`, `behavior-fix`, and `entity-context` evidence. A trigger-keyword finding may update only its own target.

Wait for explicit confirmation naming the target and exact add/remove phrases before marking a proposal approved. Approval does not authorize a manual runtime write.

Do not claim a false-negative rate, precision, or recall when `labeledMetrics` is absent. Do not attribute historical processed events to current keywords.

## Step 6 — Close with an approved or rejected proposal

Record the exact target, additions, removals, evidence refs, collision result, and approval status. Do not claim the delta was persisted. Run the audit script's focused regression tests:

```bash
python3 skills/skill-harness/scripts/test-review-keyword-audit.py
```

If production trigger matching or persistence code is changed in a separate implementation task, that code change owns its focused TypeScript tests and full repository gates; do not perform it as part of this audit workflow.

Completion criterion: the report is reproducible, the bounded proposal is explicitly approved or rejected, script tests pass, no runtime file changed, and residual collision risk is disclosed.

## Common mistakes

| Mistake                                      | Why it fails                                           | Correct action                                             |
| -------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| Add the top phrase automatically             | Frequency is not semantic evidence                     | Label positives and collisions first                       |
| Call unmatched eligible turns "misses"       | Structural eligibility is not an expected label        | Use `--labels` before reporting TP/FP/FN                   |
| Replay old events against current keywords   | Events lack matched-keyword and keyword-set provenance | Use them only for outcome/history counts                   |
| Include snippets by default                  | Runtime sessions may contain private content           | Keep snippets off; inspect locally only as needed          |
| Remove a zero-hit keyword                    | Retention creates false absence                        | Require repeated labeled false positives                   |
| Treat all session turns as eligible          | Production uses trigger-specific structural gates      | Use the bundled audit script and matching config threshold |
| Update `candidate.keywords` from this report | It is a different routing surface                      | Use design/inventory labeled fixtures                      |
| Hand-edit `review.json` after approval       | Approval does not provide the missing host lock        | Stop with an approved delta when no host writer is exposed |
