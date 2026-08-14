# Closing Mode

When enough information is collected, stop asking discovery questions and switch into closing mode.

## Output order

1. **Boundary summary** — what this intent handles, what it doesn't, which neighboring intents it's closest to
2. **Recommended filename-derived id and filename**
3. **Collision warning** — if the proposed intent still overlaps an existing one
4. **Final draft intent file**

## Safety checks

- If the proposed design is still too broad or collides badly, do not force a final draft yet. Say what decision is still unresolved and ask the smallest next question.
- Use the routing-only frontmatter format in `references/format.md`: required `guidance`, optional direct `skills[]`, and no Markdown body.
- Keep commands, tool workflows, and durable lessons in referenced skills; do not add them to the intent definition.
- Do not draft or change runtime experience entries: session-local curation owns those skill-scoped records.

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
4. Write to the active OpenClaw-resolved runtime intent catalog on approval (normally `~/.openclaw/plugins/skill-harness/intents/` with the default local state directory)
5. Run simple format checks: complete frontmatter shape, one `guidance` sentence, concrete triggers/examples, direct `skills[]` shape, no intent body, and no metadata cross-references to other intent ids.
