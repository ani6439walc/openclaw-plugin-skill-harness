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

## Decision model

A trigger starts an investigation; it is not evidence by itself. The reviewer evaluates trigger-specific evidence, durability, scope, and existing intent coverage. It prefers the smallest valid change or a recorded no-finding result.

Validated changes may create, refine, split, or merge runtime `intents/*.md`. Before applying a targeted change, the reviewer validates the staged catalog. It records the outcome in `review.json`.

The reviewer does not write source files, bundled skills, OpenClaw config, memory files, or arbitrary filesystem paths.

## Completeness and provenance

The staged workspace copy is authoritative for current intent content. The queued review snapshot remains historical evidence for the turn and routing decision.

Every requested trigger requires a valid positive or no-finding decision. Omitted or schema-invalid decisions are recorded as `schema-rejected` with sanitized `missing-trigger-decision` counts.
