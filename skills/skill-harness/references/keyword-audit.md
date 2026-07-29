# Review Keyword Audit Workflow

Use this workflow to analyze and refine **Intent Review trigger keywords** from retained Skill Harness runtime evidence.

This mode covers only these schema-v5 `review.json` fields:

- `triggerKeywords.successfulPattern`
- `triggerKeywords.behaviorFix`
- `triggerKeywords.entityContext`

It does **not** analyze intent `fastpath.keywords` or `candidate.keywords`. For those, use design or inventory mode and require labeled positive and collision fixtures under `references/format.md`.

## Safety boundary

Runtime sessions can contain private user and assistant text. Keep reports local, do not paste raw snippets into chat or external artifacts, and never read credential files. The bundled audit script is report-only and omits snippets unless `--include-snippets` is explicitly supplied. It requires either `--output` or an explicit `--stdout`; `--output` is the safe default and atomically creates a mode-`0600` local report. Snippets are refused on stdout.

Do not edit `review.json` while analysis is still exploratory. Keyword changes alter future Review routing and require an evidence summary plus explicit user confirmation before any write.

## Step 1 — Pin the evidence window

Resolve the active Skill Harness data root. The default is:

```text
~/.openclaw/plugins/skill-harness/
```

Record these inputs before analysis:

- `review.json` — current schema-v5 keyword source and processed Review outcomes
- `sessions/*.json` — retained current/history turn snapshots
- `stats.json` — aggregate accepted-turn count used only as a retention/coverage cross-check
- configured `review.triggers.successfulPattern.toolCalls` threshold; pass it to the script when it differs from `5`

Completion criterion: the source paths, schema version, retained session count, and configured successful-pattern threshold are known. If `review.json` is absent or not schema v5, stop instead of inventing defaults or migrating it.

## Step 2 — Generate the read-only report

From the repository root:

```bash
python3 skills/skill-harness/scripts/review-keyword-audit.py \
  --data-root ~/.openclaw/plugins/skill-harness \
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

If the runtime successful-pattern threshold is not `5`:

```bash
python3 skills/skill-harness/scripts/review-keyword-audit.py \
  --successful-tool-calls <configured-count> \
  --output /tmp/skill-harness-keyword-audit.json
```

The script mirrors the deterministic trigger gates that matter to keyword matching:

- `successful-pattern` — no agent error and either enough tool calls or at least one used skill; searches user input plus assistant result
- `behavior-fix` — searches user input only and excludes known quoted/ingest prompt markers
- `entity-context` — requires a memory/tools source signal in text or a matching read/search tool parameter; searches user input plus assistant result

The report includes:

- eligible, matched, and unmatched retained documents
- hit counts for every current keyword
- ranked CJK substrings and Latin token n-grams found in unmatched eligible documents
- local session/turn references for manual labeling
- overlap with other structurally eligible trigger targets
- processed Review outcome and prior keyword-change counts
- aggregate `stats.json` turns versus retained session states

Candidate phrases are discovery leads, not recommendations. Phrase frequency does not prove semantic correctness.

Completion criterion: the report parses as JSON, its mode is `0600`, `reportOnly` is `true`, `snippetsIncluded` is `false`, and every requested target has a summary.

## Step 3 — Label positives and collisions

For each proposed addition, inspect the referenced retained turns locally with structured file reads. Build a compact evidence record:

```text
target: behavior-fix
phrase: "不要再"
positive refs: <two or more distinct session files>
collision refs: <checked non-target uses>
why existing keywords miss: <observable exact-match gap>
expected effect: <which eligible turns become matched>
```

Apply these gates:

1. **Durability:** require positive evidence from at least two distinct retained sessions. One session is anecdotal; keep it as a candidate only.
2. **Literal semantics:** the exact phrase must express the target signal, not merely co-occur with it.
3. **Collision review:** search all retained inputs/results for the phrase, including documents outside the target's structural gate. Label quoted text, negation, examples, copied prompts, and unrelated meanings.
4. **Shortest safe phrase:** prefer the shortest phrase that preserves meaning without increasing collisions. CJK matching is substring-based, so one overly broad character can fan out badly.
5. **No duplicate identity:** compare trimmed case-insensitively with current keywords before proposing an addition.

For removals, require repeated false-positive evidence from at least two distinct sessions and verify the keyword has no retained true-positive role. **Zero retained hits is not removal evidence** because session retention may have discarded the turns that justified the keyword.

Completion criterion: every addition/removal has labeled positive and collision evidence. Otherwise recommend no change.

## Step 4 — Present a bounded proposal

Present per target:

- current retained coverage: eligible / matched / unmatched
- proposed additions, maximum 3
- proposed removals, maximum 3
- positive refs and collision result for each phrase
- expected newly matched retained documents
- uncertainty caused by session retention or incomplete data
- recommendation: apply / retain current set / gather more evidence

Do not combine `successful-pattern`, `behavior-fix`, and `entity-context` evidence. A trigger-keyword finding may update only its own target.

Wait for explicit confirmation naming the target and exact add/remove phrases before changing runtime state.

## Step 5 — Apply through the host-owned path

Preferred path: let enabled Intent Review emit a trigger-specific `targetKind="trigger-keywords"` finding. The host validates a maximum of three additions/removals, normalizes/deduplicates the lists, acquires the Review log lock, and atomically writes `review.json` with the processed event.

Do not hand-edit `review.json` during normal work. If a manual maintenance write is explicitly requested, treat it as an exceptional runtime-state mutation: pin the current file hash, preserve strict schema v5, stage the complete proposed JSON outside the data root, show the exact target/add/remove delta, confirm again, then replace atomically under the same Review-log locking discipline. If that host locking path is unavailable, stop rather than risk racing Intent Review.

Completion criterion: the persisted target list contains exactly the approved normalized change, unrelated targets and processed records are unchanged, and the runtime file still passes current schema-v5 parsing.

## Step 6 — Verify behavior, not just JSON

After a confirmed host-owned update:

1. Re-run the audit and confirm the intended retained references move from unmatched to matched.
2. Add or update focused trigger tests for each accepted phrase and at least one collision/non-trigger fixture.
3. Run:

```bash
python3 skills/skill-harness/scripts/test-review-keyword-audit.py
pnpm test src/review/triggers.test.ts src/review/trigger-keywords.test.ts src/review/log-writer.test.ts
pnpm run typecheck
pnpm run build
```

4. Report the before/after counts, exact keyword delta, tests, and any remaining collision risk.

Completion criterion: evidence, persisted state, production trigger behavior, and regression tests agree.

## Common mistakes

| Mistake                                      | Why it fails                                      | Correct action                                             |
| -------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| Add the top phrase automatically             | Frequency is not semantic evidence                | Label positives and collisions first                       |
| Include snippets by default                  | Runtime sessions may contain private content      | Keep snippets off; inspect locally only as needed          |
| Remove a zero-hit keyword                    | Retention creates false absence                   | Require repeated labeled false positives                   |
| Treat all session turns as eligible          | Production uses trigger-specific structural gates | Use the bundled audit script and matching config threshold |
| Update `candidate.keywords` from this report | It is a different routing surface                 | Use design/inventory labeled fixtures                      |
| Hand-edit `review.json` during normal work   | Can race host writes or violate schema            | Use the host-owned locked atomic path                      |
