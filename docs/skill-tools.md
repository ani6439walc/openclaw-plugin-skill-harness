# Skill Tools

Skill Harness registers four OpenClaw tools.

| Tool           | Behavior                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `skill_list`   | Broad inventory fallback when the task is broad, terminology is uncertain, or focused search is insufficient.                      |
| `skill_search` | Focused deterministic discovery when injected candidates do not fit. Results are candidates, not a substitute for reading a skill. |
| `skill_view`   | Reads a visible skill or allowed support file. Read the complete skill before following its workflow.                              |
| `skill_manage` | Authorized write-capable skill maintenance through the main agent's resolved catalog. Prefer focused patches and verify mutations. |

## Visibility

`skill_list`, `skill_search`, and `skill_view` use the invoking agent's resolved skill roots, the same resolution used for prompt hints. Intent metadata used to derive domains and search matches is also filtered for the invoking agent.

The tools deliberately do not apply OpenClaw's `agents.defaults.skills` or `agents.list[].skills` allowlists while indexing those roots. The result is an unfiltered inventory from the invoking agent's workspace roots, subject to source precedence and disabled bundled-skill entries. Do not add allowlist filtering without an explicit product decision, migration, documentation, and tests.

## Search and cache behavior

`skill_list` omits `usage_stats` and `related_skills` by default. Pass `show_stats: true` or `show_related: true` to include them. `skill_view` always includes visible related skills.

`skill_search` requires at least one non-empty `query`, `source`, `domains`, or `keywords` criterion. It defaults to 20 results and caps `limit` at 100. Search is case-insensitive, uses Unicode normalization, treats `domains` as a case-insensitive OR filter, and returns match evidence by default. Pass `show_matches: false` for compact output.

The index cache follows `skills.load` watcher settings. When `watch: true` and `watchDebounceMs` is a valid non-negative number, that value becomes the cache TTL; otherwise the default TTL is 60 seconds. This is cache polling, not a filesystem watcher. Changes become visible on the next list, search, or view after the selected TTL.
