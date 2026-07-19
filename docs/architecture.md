# Architecture

## Lifecycle

Skill Harness runs from OpenClaw lifecycle hooks. Eligible dynamic routing emits a `plugin:skill-harness` parent lifecycle:

- `pipeline:started` is emitted before an exact fast path or model-backed phase begins.
- `pipeline:completed` is emitted only after no further phase can run and carries producer-measured `durationMs`.
- `pipeline:failed` carries the same duration contract for unexpected exceptions.

Consumers should use the parent lifecycle for pipeline status and timing rather than treating an individual phase completion as the end of routing.

## Routing stages

1. Check agent and chat authorization.
2. Append fixed skill-discovery guidance for authorized main-agent turns.
3. Skip dynamic classification for internal, inter-session, generic subagent, Intent Review, dreaming, active-memory, or non-user-trigger turns.
4. Load live config and runtime intents for eligible external-user turns.
5. Try deterministic evidence before helper models.
6. Inject focused candidate skills and an optional instruction hint.
7. Record stats after the turn and run Intent Review only when configured triggers match.

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

The fixed `appendSystemContext` requires active skill discovery and documents the four Skill Harness tools. It contains no runtime skill inventory, skill paths, intent result, or generated hint.

Eligible external-user turns may receive dynamic `prependContext` with `<domain_skill_candidates>` and an optional `## Instruction Hint`. Candidate entries include their resolved path and directly visible related skills. Related skills are optional, not automatically required.

The static prompt requires agents to use only tools exposed for that turn. `before_prompt_build` cannot inspect the final tool-name set, so registered Skill Harness tools are a deployment contract rather than a runtime-detected fact.

## Fail-open behavior

Skill Harness should improve routing without blocking OpenClaw. Config-loading, classification, statistics, and review failures are logged while the main agent continues. After static authorization succeeds, a dynamic-routing failure preserves fixed guidance and omits only the failed dynamic hint. Review failures never block the user reply.
