# Runtime Health and Routing Decision Report

Use this workflow on explicit user request to inspect runtime health, skill discovery and usage, experience retrieval, and completed Review outcomes. It produces observations for maintenance decisions; it does not change routing or runtime state.

## Generate a private report

From the package root:

```bash
python3 skills/skill-harness/scripts/runtime-health-audit.py \
  --days 7 \
  --output /tmp/skill-harness-runtime-health.json
```

`--days` accepts 1–90, default 7. `--data-root` selects an intentionally nonstandard runtime layout. The script requires exactly one of `--output` or explicit `--stdout`; output files are atomically written with mode `0600`. Keep reports local and outside the repository.

Present logs must use schema-v8 Review and schema-v7 statistics. An absent log makes its report unavailable; an unsupported or malformed present log fails the audit. The script hashes present logs before loading and rereads their hashes afterward; changed logs or changed availability fail the audit rather than producing a mixed log snapshot. `provenance.stateSha256` identifies the present logs. Sessions and QMD are observed separately and are not pinned snapshots.

The script never outputs session text, tool parameters/results, Review suggestion or evidence text, agent IDs, inventory skill names, or fingerprints. Usage reports may contain skill names from usage statistics; Review change reports may contain experience IDs. Do not paste full runtime logs into the answer. Do not hand-edit `review.json`, `stats.json`, or raw sessions.

## Establish evidence quality first

- Check `reportOnly`, privacy flags, provenance, stats attribution start/update times, and session shape errors. Retention, disk size, and aggregate inventory counts remain under `runtime`.
- `runtime.qmd` retains the experience index observation, with legacy intent-index reading for historical layouts. `runtime.qmd.skills` summarizes all managed skill indexes under `qmd/skills/indexes/` without revealing their identities. Check availability, ready status, integrity, active leases, unknown document/vector counts, and mismatches. A building index is a transient observation; retry after the build before changing routing settings.
- `analysis.windows.recent` and `.previous` compare N complete UTC days ending at today's UTC midnight. The current partial day is excluded. Keep exact UTC bounds visible; present equivalent timestamps in the user's timezone (Taiwan by default). Dates in `stats.daily` remain UTC.
- Daily reports contain expected/observed bucket counts and a separate discovery bucket count. Missing buckets are **not** zero-traffic days. Buckets before the stats attribution cohort are excluded and counted; a cohort starting inside the window makes coverage partial. Missing metrics and zero-denominator rates are `null`; partially available score/collection aggregates include their observation coverage.
- `analysis.cumulative` uses the stats attribution cohort, while its Review summary uses retained completed events. These are different populations. Never combine cumulative counts with daily or retained-session denominators.
- Session summaries cover retained routing fields only, normally about 14 days. They can be partial even inside that period. Both session and Review period summaries flag windows extending beyond their respective 14-day and 90-day retention assumptions. They deduplicate session/turn identities, preferring completed turns and then current records. Report sample counts, invalid/unidentified timestamps, duplicates, and first/last observation times. Do not infer completeness from those dates.

A healthy report **does not prove Gateway loaded the plugin**. Review logs also cannot prove whether Review is enabled, queued, running, or stuck.

## Decision reports

| Report                      | Evidence                                                                                                                                                                             | Useful next decision                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill query                 | Name-match hit turns/candidates; QMD attempted and hit turns, score summaries, meta/body/references distributions; availability/timeout reasons and recorded discovery duration      | Inspect names and descriptions, improve body/references, or investigate index/service availability before thresholds                           |
| Selection and injection     | Session candidate-pool coverage, empty pool, nonempty pool without either skill or experience injection, injected quantities, recorded confidence                                    | Investigate missing candidates versus selection-stage non-adoption; examine relevance thresholds and injection limits with a controlled sample |
| Skill usage                 | Injection, same-turn adoption, usage, unadopted counts, adoption rate and lifecycle; top 10 used and unadopted skills; retained-session top 10 used without dynamic injection        | Prioritize descriptions/body for review; examine working-set placement or missing discovery patterns                                           |
| Experience retrieval        | Completed/disabled/unavailable/timeout/error counts, candidate-observed turns, candidate hit rate, score summary, observed candidate thresholds, selection among nonempty candidates | Separate availability issues, candidate scarcity and selection non-adoption                                                                    |
| Review execution            | Last completion, outcome counts/rates, trigger distribution, no-finding/schema rejection reasons, applied-event count and actual create/refine/delete changes                        | Separate normal no-finding from contract or execution failures; inspect experience-maintenance yield                                           |
| Tool reliability and trends | Cumulative errors/latency buckets and daily calls/errors; recent versus previous query, injection, adoption, usage and Review observations                                           | Identify tool problems and changes requiring a fresh controlled observation window                                                             |

### Interpretation limits

- Adoption is same-turn recorded skill use, not task correctness or routing precision. Used-without-injection can reflect static working sets or manual discovery; it is not measured recall failure. Fewer than 20 injections is marked low sample, a reporting convention rather than a runtime rule. Never prune a skill solely because adoption is low.
- Name matching and QMD can overlap. Use the recorded unique pool rather than summing channel counts. Existing aggregate QMD injected-skill counts include experience-source skills; do not calculate pure skill-search conversion from them. Collection counts are retrieval evidence, not causal contributions or independent accuracy scores.
- Confidence is selector confidence, not retrieval similarity or calibrated accuracy. A nonempty pool with no injection does not identify selector failure versus an intentional rejection. Exact selector failure reasons, stage latency, model costs, and true precision/recall are unobserved.
- Session selection requires both matched-skill and matched-experience arrays. Usage comparisons require completed turns with usage records. Missing fields reduce coverage instead of counting as empty selections. Experience candidate statistics use completed retrievals with observed candidate counts.
- Daily usage names are raw; daily `skillRouting` and `toolErrors` keys are encoded and may overflow into `__other__`. Overflow makes per-skill injection/adoption comparison unavailable; aggregate rates remain usable. Do not subtract usage and injection totals from different populations.
- Review triggers overlap. Outcome rates use completed events as the denominator, not trigger counts. Actual changes are counted only from applied events. No events means no observed completions, not disabled Review or a stalled queue. No-finding may be a healthy result.
- Retained aggregates do not establish causality or record configuration changes. A previous-period difference is a prompt to investigate, not proof of an improvement or regression.

## Present the result and bounded next steps

1. Lead with data/index health and source coverage. If these fail, prioritize repairing observation or indexes and postpone threshold recommendations.
2. Summarize the query → candidate → selection → injection → recorded-use observations, experience retrieval and Review separately. Include counts, rate denominators and time bounds; omit unavailable claims.
3. List at most three useful next checks or experiments. For each, include the supporting metric and sample count, a plausible alternative explanation, and a verification criterion. Change one variable at a time in a separately authorized experiment and compare equivalent periods and task samples.
4. Use concrete conditional suggestions: low candidate hit rate with healthy indexes → inspect skill metadata/body and representative requests before testing a lower candidate threshold; many unadopted injections → inspect relevance and descriptions before testing a stricter relevance threshold or smaller injection limit; schema rejection → inspect Review output contracts; timeout/unavailable → investigate service/index health first. Do not invent an optimal numeric threshold from aggregate scores.
5. Finish with unobserved signals that limit the decision. Reporting does not authorize config edits, telemetry resets, experience deletion, or Gateway restart.
