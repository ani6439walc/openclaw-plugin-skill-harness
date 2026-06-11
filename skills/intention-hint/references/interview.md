# Interview Rules

Interview the user one question at a time. Never batch questions.

## Opening decision tree

At the start, classify the request into one path:
1. create a brand-new intent
2. rename an existing intent
3. split an overloaded intent
4. merge two overlapping intents
5. refine an existing intent

If ambiguous, ask a single routing question first — explain why it matters, recommend the most likely path, then proceed.

## Interview goals

Confirm these fields in order:
1. intent purpose and boundary
2. best name and `id`
3. filename
4. `triggers`
5. `examples`
6. body scope
7. skills and tools worth hinting
8. collision check with existing intents

## Rules

- Ask only one question at a time. Wait for reply before proceeding.
- If the answer can be grounded by reading `README.md` or existing `intents/*.md`, do that instead of asking a vague question.
- Prefer narrowing scope over making a broad catch-all intent.
- If the user is describing an existing intent, say so directly.
- If two intents are colliding, recommend the smallest clean split.
- Do not write the final intent file until the boundary is clear.
- **No cross-references in body**: the markdown body must never mention other intents by name or id. All scope boundaries must be expressed through triggers and examples alone.

## User-specified flow override

If the user explicitly specifies a custom step order:
1. Follow the user's flow, overriding default steps.
2. If incomplete, supplement with calibration questions after completing their steps.
3. If it conflicts with intent rules, warn but comply.
4. Record the preference for future reuse.
