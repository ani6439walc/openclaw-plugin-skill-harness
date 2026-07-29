# Metrics and Runtime Files

## Runtime files

Skill Harness keeps package files and runtime state separate. The paths below use the default local state directory.

| Path                                                   | Purpose                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `~/.openclaw/plugins/skill-harness/intents/`           | Editable runtime intent catalog.                                                                       |
| `~/.openclaw/plugins/skill-harness/sessions/`          | Per-session JSON snapshots for audit and review context.                                               |
| `~/.openclaw/plugins/skill-harness/agents/*/sessions/` | Embedded-agent session transcripts.                                                                    |
| `~/.openclaw/plugins/skill-harness/stats.json`         | Schema-v3 intent, skill, tool, routing, projection, inventory-observation, and daily usage statistics. |
| `~/.openclaw/plugins/skill-harness/review.json`        | Schema-v5 Intent Review trigger keywords, processed outcomes, and completed skill-placement epochs.    |

Session cleanup preserves the ended main session and removes only expired `sessions/*.json` and embedded-agent session artifacts: `*.session.jsonl`, `*.session.trajectory.jsonl`, and `*.session.trajectory-path.json`. It does not delete root-level statistics, review data, intents, skills, transcripts outside the embedded-agent session directories, or package files.

## Interpreting local observations

The README reports one deployment's observed routed turns, confidence, recommendation adoption, candidate reduction, rendered catalog size, and local projection time. These are operational measurements, not a synthetic benchmark.

- A recommendation opportunity is each top-level skill entry actually injected into the final `<domain_skill_candidates>` block after domain and verified additional candidates are resolved and deduplicated. Related-skill metadata nested under a candidate is not counted as a separate opportunity.
- A recommendation is adopted when that injected candidate is used during the same turn. Instruction-hint prose is not parsed for skill names.
- Recommendation adoption is measured separately from skill usage outside the injected candidate set.
- Rendered catalog size is measured in Unicode code points, not provider-billed tokens.
- Provider tokenization and context injected by OpenClaw or other plugins are outside Skill Harness's measurement scope.
- A projection can be eligible even when classifier execution or parsing later fails; those attempts do not increment successful intent-turn summaries.

## Schema v3 statistics

`stats.json` schema v3 retains the bounded classifier-projection aggregates introduced in v2:

- eligible, projected, and full-fallback counts and rates
- average original and candidate intent counts
- average rendered catalog code points and projection duration
- selection-reason counts and daily projection counters

It also records agent-scoped resolved skill inventory observations on accepted stats events:

- each agent has an independent observation-turn counter and visible-skill map
- each visible skill records source, hashed precedence-winner identity, raw-content SHA-256, first/last observation time and turn, observed turns, same-turn usage, and same-turn recommendation counts
- a source, winner, content, or visibility-continuity change starts a new observation epoch for that skill
- missing skills retain their last epoch as historical state but do not gain observation turns
- inventory resolution uses the invoking tracked agent's current roots, source precedence, and disabled bundled-skill policy; unresolved policy or inventory errors skip only the observation update
- fingerprints are internal statistics fields and are not exposed through skill tool results

These observations feed the optional `skill-placement` Review trigger after an accepted stats event. Selection uses only the persisted tracked agent's currently visible resolved inventory. Existing top-level `needsReview` skill aggregates have priority; otherwise a continuous epoch becomes eligible after 20 observed turns only when recommendation and usage counts are both zero. At most one candidate is selected per turn, and completed or in-memory pending epoch keys are excluded. The selector does not modify skill files and does not synthesize historical zero observations.

Valid stats v1 and v2 files migrate on the next recorded turn by adding an empty observation section; existing intent, skill, tool, routing, projection, daily, and processed-event data are preserved. Invalid files remain untouched and fail open. Skill recommendation and usage names are canonicalized with trimmed lowercase identity for aggregate joins, while inventory observations retain the resolved display name. When valid existing stats contain mixed-case keys for the same skill, the load boundary merges their raw counters and daily counts into one canonical key before recomputing derived fields.

Complexity buckets count only turns with known complexity, so `low + medium + high` can be lower than an intent's total turns. Skill-usage readers continue to read the existing top-level skill aggregates independently of inventory observations.
