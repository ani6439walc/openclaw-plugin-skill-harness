# Metrics and Runtime Files

## Runtime files

Skill Harness keeps package files and runtime state separate. The paths below use the default local state directory.

| Path                                                      | Purpose                                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `~/.openclaw/plugins/skill-harness/intents/`              | Editable runtime intent catalog.                                                                                |
| `~/.openclaw/plugins/skill-harness/experiences/`          | Skill-scoped runtime experience catalog; current candidate skills immediately expose identity/keyword metadata. |
| `~/.openclaw/plugins/skill-harness/sessions/`             | Per-session JSON snapshots for audit and review context.                                                        |
| `~/.openclaw/plugins/skill-harness/agents/*/sessions/`    | Embedded-agent session transcripts.                                                                             |
| `~/.openclaw/plugins/skill-harness/stats.json`            | Schema-v4 intent, skill, tool, routing, projection, inventory-observation, and daily telemetry.                 |
| `~/.openclaw/plugins/skill-harness/review.json`           | Schema-v7 current-only Intent Review outcomes, experience writes, and completed skill-placement epochs.         |
| `~/.openclaw/plugins/skill-harness/keyword-coverage.json` | Schema-v1 trigger-keyword coverage state and epochs.                                                            |

Session cleanup preserves the ended main session and removes only expired `sessions/*.json` and embedded-agent session artifacts: `*.session.jsonl`, `*.session.trajectory.jsonl`, and `*.session.trajectory-path.json`. It does not delete root-level statistics, review data, intents, skills, transcripts outside the embedded-agent session directories, or package files.

When retained session files are loaded, the tracker strips retired intent-state fields such as `instructionText` before using or rewriting migrated state. This is a compatibility cleanup, not a source of routing behavior; normal retention still controls when expired session files are removed.

## Interpreting local observations

The README reports one deployment's observed routed turns, confidence, recommendation adoption, candidate reduction, rendered catalog size, and local projection time. These are operational measurements, not a synthetic benchmark.

Those observations predate the session-curation deployment boundary. They must not be presented as a causal curation comparison until a post-cutover measurement window is collected with the same definitions.

- A recommendation opportunity is each top-level skill entry actually injected into the final direct `<skill_candidates>` block for the selected intent. Related-skill metadata nested under a candidate is not counted as a separate opportunity.
- A recommendation is adopted when that injected candidate is used during the same turn. Routing-guidance prose is not parsed for skill names.
- Recommendation adoption is measured separately from skill usage outside the injected candidate set.
- Rendered catalog size is measured in Unicode code points, not provider-billed tokens.
- Provider tokenization and context injected by OpenClaw or other plugins are outside Skill Harness's measurement scope.
- A projection can be eligible even when classifier execution or parsing later fails; those attempts do not increment successful intent-turn summaries.
- `review.json` is the sole owner of ordinary Review outcomes and mutations. `stats.json` never synthesizes or mirrors those outcomes.

## Schema v4 statistics

`stats.json` schema v4 retains the schema-v3 aggregate usage, routing, projection, and agent-scoped inventory observations, and adds attribution that can only be measured from newly accepted turns:

- root `attribution.startedAt` records the exact UTC instant at which v4 attribution began;
- `daily.intentOutcomes` records completed/errored, skill-assisted, and tool-assisted turns per resolved intent;
- `daily.intentRouting` records injected recommendation and adoption counts per resolved intent;
- `daily.skillRouting` records same-turn recommendation and adoption counts per injected skill;
- `daily.toolErrors` records error calls per tool;
- every top-level `tools[toolName].latencyHistogram` uses fixed `unknown`, `0-99`, `100-499`, `500-999`, `1000-4999`, and `5000+` millisecond buckets. Missing, invalid, or negative durations count as `unknown`; they are never represented as zero milliseconds.

The four v4 daily attribution maps are bounded to 64 keys per UTC date. Named keys use the deterministic `value:<trimmed-name>` encoding, reserving the host-owned `__other__` entry before the cap; later distinct keys aggregate into that entry. This limits unbounded per-day cardinality without changing all-time aggregate identity. Existing v3 daily `intents`, `skills`, and `tools` maps retain their previous behavior and are not retroactively compacted.

### Migration and attribution boundary

Valid v1, v2, and v3 files migrate atomically on the next recorded turn. Existing aggregate, routing, projection, inventory, daily, and processed-event data are preserved. The migration adds empty v4 daily attribution maps and zeroed tool histograms, then records only the triggering and later turns into the new fields. It does **not** backfill historical intent routing, skill routing, tool errors, or latency data.

Consequently, a report over any window beginning before `attribution.startedAt` has insufficient historical attribution. The start date itself can contain pre-v4 turns before the exact start instant, so compare only post-boundary observations. Invalid files remain untouched and fail open.

It also records agent-scoped resolved skill inventory observations on accepted stats events:

- each agent has an independent observation-turn counter and visible-skill map;
- each visible skill records source, hashed precedence-winner identity, raw-content SHA-256, first/last observation time and turn, observed turns, same-turn usage, and same-turn recommendation counts;
- a source, winner, content, or visibility-continuity change starts a new observation epoch for that skill;
- missing skills retain their last epoch as historical state but do not gain observation turns;
- inventory resolution uses the invoking tracked agent's current roots, source precedence, and disabled bundled-skill policy; unresolved policy or inventory errors skip only the observation update;
- fingerprints are internal statistics fields and are not exposed through skill tool results.

These observations feed the optional `skill-placement` Review trigger after an accepted stats event. Selection uses only the persisted tracked agent's currently visible resolved inventory. Existing top-level `needsReview` skill aggregates have priority; otherwise a continuous epoch becomes eligible after 20 observed turns only when recommendation and usage counts are both zero. At most one candidate is selected per turn, and completed or in-memory pending epoch keys are excluded. The selector does not modify skill files and does not synthesize historical zero observations.

Skill recommendation and usage names are canonicalized with trimmed lowercase identity for aggregate joins, while inventory observations retain the resolved display name. When valid existing stats contain mixed-case keys for the same skill, the load boundary merges their raw counters and daily counts into one canonical key before recomputing derived fields.

Complexity buckets count only turns with known complexity, so `low + medium + high` can be lower than an intent's total turns. Skill-usage readers continue to read the existing top-level skill aggregates independently of inventory observations.
