# Intent Review

Intent Review is an optional post-turn reviewer for runtime intent definitions. It is disabled by default.

## Trigger signals

When enabled, Review can investigate completed turns with signals such as:

- tool-heavy work that may justify a reusable skill candidate
- repeated tool failures that reveal a process gap
- successful patterns worth preserving
- weak or missing intent classification
- explicit user corrections
- bounded entity-context learning signals
- one currently visible skill whose adoption needs review, or whose continuous inventory epoch has reached 20 turns with zero recommendations and zero usage

## Decision model

A trigger starts an investigation; it is not evidence by itself. The reviewer evaluates trigger-specific evidence, durability, scope, and existing intent coverage. It prefers the smallest valid change or a recorded no-finding result.

Validated changes may create, refine, split, or merge runtime `intents/*.md`; autonomous standalone deletion is not an operation. Before applying a targeted change, the host derives a canonical operation when the declared target lifecycle is uniquely classifiable: existing-file edits are `refine`, only new files are `create`, new plus modified files are `split`, and deleted plus modified files are `merge`. It then validates the staged catalog and canonical operation/file lifecycle together. A lifecycle containing both new and deleted targets is not reclassified automatically; standalone deletion remains unsupported. It records the applied canonical operation in `review.json`.

`skill-placement` is narrower than the general workflow. The host selects at most one candidate from the persisted tracked agent's current resolved inventory, reserves its epoch before any asynchronous snapshot work, and supplies the complete intent catalog including each intent's `skills[]`. The reviewer may only refine one existing intent so that its valid YAML frontmatter references the selected skill and, when needed, its plain-text body guidance explains the placement. Multiple positive placement findings, multiple targets, intent creation, and skill mutation are rejected by the host.

The snapshot phase must resolve the selected skill again for the same tracked agent. If that current resolution no longer returns the candidate, the host does not enqueue the placement portion and releases the in-memory reservation so a later accepted turn can retry. Any ordinary Review triggers from the same turn continue through a rebuilt ordinary snapshot without placement data.

Low-adoption candidates with an existing top-level `needsReview` signal have priority. Otherwise, eligibility requires at least 20 observations in the same continuous inventory epoch with both recommendation and usage counts at zero. Skill names use a canonical trimmed-lowercase identity for stats joins and host frontmatter validation, while the resolved display name remains available to the reviewer. An intent that already references the canonical skill may receive a guidance-only refinement without adding a differently cased duplicate.

The reviewer does not write source files, bundled skills, OpenClaw config, memory files, or arbitrary filesystem paths.

## Completeness and provenance

The staged workspace copy is authoritative for current intent content. The queued review snapshot remains historical evidence for the turn and routing decision.

Every requested trigger requires a valid positive or no-finding decision. Omitted or schema-invalid decisions are recorded as `schema-rejected` with sanitized `missing-trigger-decision` counts.

## Placement completion and retry

Only `applied` and `nofinding` complete a skill inventory epoch. The intent-only processed event and completed epoch are written atomically to schema-v6 `review.json`; keyword-triggered audits are retained separately in `historicalKeywordAudits`. Reviewer errors, parse or schema rejection, validation failure, queue failure, and review-log write failure clear the in-memory reservation without completing the epoch, so a later accepted turn can retry. An unreadable or incompatible review log disables placement selection while preserving ordinary Review triggers.

Schema v6 is current-only: schema-v5 and older logs, legacy string events, legacy outcomes, aliases, and unknown fields are rejected rather than migrated. Delete or archive an incompatible runtime `review.json` before enabling this version.
