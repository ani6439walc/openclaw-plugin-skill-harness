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
7. Inject selected intent metadata, one routing-guidance sentence, direct matched-intent skill candidates, and immediate candidate-scoped experience metadata nested under its matching skill.
8. Record stats after the turn and run Intent Review only when configured triggers match.

## Deterministic routing and candidate projection

The plugin prefers inexpensive deterministic routing before model calls:

- Exact `fastpath.keywords` matches inject the selected intent's routing context immediately.
- Same-topic inheritance requires available history and joint confidence of at least `0.8`.
- Clear changed-topic routes can use domain-keyword similarity at the same confidence threshold.
- Uncertain same-topic results, or results without history, continue to the classifier path.

Classifier-bound turns use a conservative candidate projection only when the current domain, authorized same-topic history, high confidence, or exact candidate evidence supports it. Weak or missing evidence falls back to the full post-deny catalog without a second classifier call.

Projected candidates preserve canonical catalog order. They may include the predicted domain, `candidate.scope: cross-flow` intents, authorized low-confidence history, and exact matches for manual `candidate.keywords` or normalized intent IDs. Denied and removed intents cannot be reintroduced.

Exact projection phrases use NFKC, locale-independent lowercasing, and collapsed whitespace. Latin and symbol-heavy phrases use boundary-safe matching. Multi-code-point CJK phrases use substring matching; one-code-point phrases must equal the latest message or an exact topic keyword. Punctuation remains literal, so hyphens and underscores are not interchangeable aliases.

## Runtime data and session-local recommendation curation

Runtime state is resolved from OpenClaw's state directory, not from the plugin package. With the default local state directory it lives under `~/.openclaw/plugins/skill-harness/`. Runtime intents load from `intents/`; first startup copies bundled examples only when that directory has no Markdown files and never overwrites an existing runtime intent. `experiences/<skill>/<entry>.md` is a separate skill-scoped runtime catalog. Every experience whose skill matches a current candidate is immediately injected as identity-and-keyword metadata, nested under that candidate's `<skill>` and never including its summary. Curation may mark at most three high-relevance identities for the next turn; only those receive bounded bodies and a `session_curation_recommendation` marker that says they are possibly relevant. It is not intent-body content and does not expand the static skill inventory; the main agent retrieves a chosen record or full body with `skill_experience`.

After deterministic or model-backed routing selects an intent, the host creates a revision-0 curation record for the current topic epoch. Its cold start ranks only the intent's resolved direct `skills[]` using successful same-agent, same-intent observations retained for 14 days: the first four are fixed exploitation candidates and up to two remaining candidates are sampled without replacement for exploration. If the catalog or session mutation is unavailable, routing falls back to the ranked direct candidates without durable curation state.

The independent background curator runs after each three additional successful accepted turns in the same topic epoch. It can advance a validated curation revision with at most six visible direct skill candidates and at most three high-relevance experience identities. The curator receives candidate experience identity/keyword metadata, never bodies. Topic changes, stale reservations, invalid proposals, unavailable skills, and failed writes do not block the agent turn; they preserve or safely fall back from the prior recommendation state. Curation does not edit intents, skills, `review.json`, or `keyword-coverage.json`, and it remains enabled independently of `review.enabled`. It does not gate experience metadata injection, only the bounded body expansion on the following turn.

## Helper subagents

When deterministic routing is insufficient, bounded helper subagents provide guidance:

- **Topic checker:** returns the basis, reason, joint confidence, keywords, topic, and domain. Host code derives the internal changed-topic flag from the reason.
- **Intent classifier:** returns structured intent, domain, topic, confidence, keywords, and complexity for model-classified turns.
- **Intent Review reviewer:** optionally evaluates post-turn evidence and updates runtime intents when configured triggers fire.

## Prompt context

Every non-excluded normal agent turn receives fixed `appendSystemContext`, regardless of the configured chat scope and including agents outside the plugin's intent-scanning `agents` list. Its universal section requires active skill discovery and documents the Skill Harness tools. Agents enabled by the `agents` option additionally receive the `### Using Skill Harness context` section, which explains how to apply per-turn routing context. Neither fixed section contains a runtime skill inventory, skill paths, or intent result.

The separate `<configured_skills>` block is the ordered union of explicit `agents.*.skills` configuration and skills from the invoking agent's workspace `skills/` tree. Explicit order is preserved, workspace-only entries are appended in index order, duplicate names use the workspace winner, and each rendered entry includes its resolved description and path. The `agents` option controls the intent-routing static section and dynamic analysis; chat scope controls dynamic analysis only. Neither suppresses universal skill discovery or configured-skill context for normal agents.

Eligible external-user turns may receive dynamic `prependContext` with `selected_intent`, optional classifier-produced `task_complexity`, `intent_guidance`, and direct `skill_candidates`. A candidate may contain nested `skill_experience` entries, each with an identity and keywords. An entry selected by the previous curation revision additionally contains a bounded body and `session_curation_recommendation` marker; this is a possibly-relevant hint, not an instruction or applicability guarantee. The main agent calls `skill_experience` with the matching skill and identity query when it needs an unexpanded record or the full body. `task_complexity` is absent for deterministic fast paths; when present, it helps the main agent calibrate planning and verification without broadening the request. Candidate entries include their resolved name and description; related skills are not automatically required.

The static prompt requires agents to use only tools exposed for that turn. `before_prompt_build` cannot inspect the final tool-name set, so registered Skill Harness tools are a deployment contract rather than a runtime-detected fact.

## Fail-open behavior

Skill Harness should improve routing without blocking OpenClaw. Config-loading, classification, statistics, and review failures are logged while the main agent continues. After internal-helper exclusion, static skill-resolution or dynamic-routing failures preserve fixed guidance and omit only unavailable enriched or dynamic context. Review failures never block the user reply.
