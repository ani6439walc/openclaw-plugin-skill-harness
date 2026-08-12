# Architecture

## Lifecycle

Skill Harness runs from OpenClaw lifecycle hooks. Eligible dynamic routing emits a `plugin:skill-harness` parent lifecycle:

- `pipeline:started` is emitted before an exact fast path or model-backed phase begins.
- `pipeline:completed` is emitted only after no further phase can run and carries producer-measured `durationMs`.
- `pipeline:failed` carries the same duration contract for unexpected exceptions.

Consumers should use the parent lifecycle for pipeline status and timing rather than treating an individual phase completion as the end of routing.

## Routing stages

1. Resolve the canonical agent and session identity.
2. Exclude Skill Harness helper, generic subagent, Intent Review, dreaming, and active-memory sessions from all prompt injection.
3. Append fixed skill-discovery guidance and the enriched configured-skills union for every remaining agent turn.
4. Apply the configured agent list, chat scope, user-turn, and interactive-session gates only to dynamic intent routing.
5. Load live config and runtime intents for eligible external-user turns.
6. Try deterministic evidence before helper models.
7. Inject focused candidate skills and an optional instruction hint.
8. Record stats after the turn and run Intent Review only when configured triggers match.

## Deterministic routing and candidate projection

The plugin prefers inexpensive deterministic routing before model calls:

- Exact `fastpath.keywords` matches inject a short hint immediately.
- Same-topic inheritance requires available history and joint confidence of at least `0.8`.
- Clear changed-topic routes can use domain-keyword similarity at the same confidence threshold.
- Uncertain same-topic results, or results without history, continue to the classifier path.

Classifier-bound turns use a conservative candidate projection only when the current domain, authorized same-topic history, high confidence, or exact candidate evidence supports it. Weak or missing evidence falls back to the full post-deny catalog without a second classifier call.

Projected candidates preserve canonical catalog order. They may include the predicted domain, `candidate.scope: cross-flow` intents, authorized low-confidence history, and exact matches for manual `candidate.keywords` or normalized intent IDs. Denied and removed intents cannot be reintroduced.

Exact projection phrases use NFKC, locale-independent lowercasing, and collapsed whitespace. Latin and symbol-heavy phrases use boundary-safe matching. Multi-code-point CJK phrases use substring matching; one-code-point phrases must equal the latest message or an exact topic keyword. Punctuation remains literal, so hyphens and underscores are not interchangeable aliases.

## Helper subagents

When deterministic routing is insufficient, bounded helper subagents provide guidance:

- **Topic checker:** returns the basis, reason, joint confidence, keywords, topic, and domain. Host code derives the internal changed-topic flag from the reason.
- **Intent classifier:** returns structured intent, domain, topic, confidence, keywords, and complexity for model-classified turns.
- **Instruction writer:** runs only when resolved confidence is at least `0.8`. It may either read one existing candidate or perform one focused `skill_search` followed by one `skill_view` of the strongest result. The host validates the tool order, results, viewed name, and returned candidates before adding verified skills to the candidate list.
- **Intent Review reviewer:** optionally evaluates post-turn evidence and updates runtime intents when configured triggers fire.

When complexity is known, the instruction writer receives its matching execution-depth calibration. When it is absent, the writer receives neither complexity metadata nor an `execution_mode` block. These calibrations do not define main-agent planning, delegation, or scheduling policy.

## Prompt context

Every non-excluded normal agent turn receives fixed `appendSystemContext`, regardless of the configured chat scope and including agents outside the plugin's intent-scanning `agents` list. Its universal section requires active skill discovery and documents the four Skill Harness tools. Agents enabled by the `agents` option additionally receive the `### Using Skill Harness context` section, which explains how to apply per-turn candidates and hints. Neither fixed section contains a runtime skill inventory, skill paths, intent result, or generated hint.

The separate `<configured_skills>` block is the ordered union of explicit `agents.*.skills` configuration and skills from the invoking agent's workspace `skills/` tree. Explicit order is preserved, workspace-only entries are appended in index order, duplicate names use the workspace winner, and each rendered entry includes its resolved description and path. The `agents` option controls the intent-routing static section and dynamic analysis; chat scope controls dynamic analysis only. Neither suppresses universal skill discovery or configured-skill context for normal agents.

Eligible external-user turns may receive dynamic `prependContext` with `<domain_skill_candidates>` and an optional `## Instruction Hint`. Candidate entries include their resolved path and directly visible related skills. Related skills are optional, not automatically required.

The static prompt requires agents to use only tools exposed for that turn. `before_prompt_build` cannot inspect the final tool-name set, so registered Skill Harness tools are a deployment contract rather than a runtime-detected fact.

## Fail-open behavior

Skill Harness should improve routing without blocking OpenClaw. Config-loading, classification, statistics, and review failures are logged while the main agent continues. After internal-helper exclusion, static skill-resolution or dynamic-routing failures preserve fixed guidance and omit only unavailable enriched or dynamic context. Review failures never block the user reply.
