# Closing Mode

When enough information is collected, stop asking discovery questions and switch into closing mode.

## Output order

1. **Boundary summary** — what this intent handles, what it doesn't, which neighboring intents it's closest to
2. **Recommended `id`, `name`, and filename**
3. **Collision warning** — if the proposed intent still overlaps an existing one
4. **Final draft intent file**

## Safety checks

- If the proposed design is still too broad or collides badly, do not force a final draft yet. Say what decision is still unresolved and ask the smallest next question.
- Use the README's required skill/tool format (see `references/format.md`).
- Do not invent ad-hoc labels or freeform tool prose when a concrete call shape is more appropriate.

## Collision warning format

When a collision is detected, present:

```
⚠️ Collision detected:
- Proposed intent: <new-intent-id>
- Overlaps with: <existing-intent-id>
- Overlap reason: <shared triggers or examples>
- Recommendation: split (narrow scope) / merge (combine into existing) / rename (different boundary)
```

Ask user to confirm resolution before proceeding to final draft.

## Delivery

1. Write to a staging location first (e.g., `/tmp/intent-drafts/`)
2. Show diff preview to user
3. Confirm no conflicts
4. Write to `~/.openclaw/plugins/intention-hint/intents/` on approval
