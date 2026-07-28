# Metrics and Runtime Files

## Runtime files

Skill Harness keeps package files and runtime state separate. The paths below use the default local state directory.

| Path                                                   | Purpose                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `~/.openclaw/plugins/skill-harness/intents/`           | Editable runtime intent catalog.                                                |
| `~/.openclaw/plugins/skill-harness/sessions/`          | Per-session JSON snapshots for audit and review context.                        |
| `~/.openclaw/plugins/skill-harness/agents/*/sessions/` | Embedded-agent session transcripts.                                             |
| `~/.openclaw/plugins/skill-harness/stats.json`         | Schema-v2 intent, skill, tool, routing, projection, and daily usage statistics. |
| `~/.openclaw/plugins/skill-harness/review.json`        | Intent Review trigger keywords and processed event outcomes.                    |

Session cleanup preserves the ended main session and removes only expired `sessions/*.json` and embedded-agent session artifacts: `*.session.jsonl`, `*.session.trajectory.jsonl`, and `*.session.trajectory-path.json`. It does not delete root-level statistics, review data, intents, skills, transcripts outside the embedded-agent session directories, or package files.

## Interpreting local observations

The README reports one deployment's observed routed turns, confidence, recommendation adoption, candidate reduction, rendered catalog size, and local projection time. These are operational measurements, not a synthetic benchmark.

- A recommendation opportunity is each top-level skill entry actually injected into the final `<domain_skill_candidates>` block after domain and verified additional candidates are resolved and deduplicated. Related-skill metadata nested under a candidate is not counted as a separate opportunity.
- A recommendation is adopted when that injected candidate is used during the same turn. Instruction-hint prose is not parsed for skill names.
- Recommendation adoption is measured separately from skill usage outside the injected candidate set.
- Rendered catalog size is measured in Unicode code points, not provider-billed tokens.
- Provider tokenization and context injected by OpenClaw or other plugins are outside Skill Harness's measurement scope.
- A projection can be eligible even when classifier execution or parsing later fails; those attempts do not increment successful intent-turn summaries.

## Schema v2 projection statistics

`stats.json` schema v2 includes bounded classifier-projection aggregates:

- eligible, projected, and full-fallback counts and rates
- average original and candidate intent counts
- average rendered catalog code points and projection duration
- selection-reason counts and daily projection counters

Complexity buckets count only turns with known complexity, so `low + medium + high` can be lower than an intent's total turns. Valid v1 files migrate on the next recorded turn without losing existing intent, skill, tool, routing, daily, or processed-event data. Invalid files remain untouched and fail open. Skill-usage readers accept both schemas.
