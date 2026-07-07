# Evolution Workflow

Evolution no longer creates or processes pending items. Background review applies safe runtime intent edits directly and records a compact audit trail in `~/.openclaw/plugins/skill-harness/evolution.json`.

## Runtime Contract

- Runtime editable intents live in `~/.openclaw/plugins/skill-harness/intents/*.md`.
- The review subagent runs through the serialized `ReviewQueue` with bounded `read`/`write`/`apply_patch` tools rooted at an isolated temporary workspace copied from the runtime intents directory.
- The subagent may edit only runtime intent Markdown files in that directory.
- The subagent must not edit bundled/package intents, skills, config, source code, `evolution.json`, `stats.json`, or any path outside runtime intents.
- Trigger keyword updates are returned as JSON findings only; the host records them into `evolution.json`.
- The host validates changed or targeted intents after the review run. Invalid intent edits are rolled back to the pre-review snapshot and recorded as `validation-failed`.

## evolution.json

`evolution.json` is now an audit log plus runtime trigger keyword store:

- `schemaVersion: 4`
- `triggerKeywords` stores runtime phrases for `successfulPattern`, `behaviorFix`, and `entityContext` triggers.
- `processedEvents` is the only event ledger. Each key is an event ID; each value stores `processedAt`, optional `source`, requested `triggers`, `changeCount`, `outcome`, optional `changedIntentIds`, optional applied `changes`, and bounded diagnostics.
- There is no `items` array and no pending/processed/dismissed item lifecycle.
- Legacy v1-v3 files are migrated by preserving `processedEvents`/`triggerKeywords` and dropping stale `items`.

Outcomes are:

- `applied` — the review applied runtime intent edits and/or trigger keyword updates.
- `nofinding` — the review intentionally found no reusable change.
- `schema-rejected` — requested positive findings were malformed.
- `parse-failed` — the reviewer output could not be parsed as JSON.
- `subagent-error` — all review model attempts failed.
- `validation-failed` — intent edits failed validation and were rolled back.
- `unknown` — migrated legacy/unknown state.

`nofinding` events may include bounded `noFindingReasonCounts`: `routine-tool-use`, `outside-intent-scope`, `insufficient-evidence`, `wrong-trigger`, `already-covered`, or `privacy-sensitive`.

`schema-rejected` events may include bounded `schemaRejectionReasonCounts`: `missing-required-field`, `missing-target`, `invalid-operation`, `invalid-trigger-keyword-target`, `invalid-field-type`, `too-long-field`, `invalid-shape`, or `unknown`.

Diagnostics must never persist raw snapshots, user text, evidence strings, raw model replies, secrets, or Zod dumps.

## Manual Intent Evolution

Use this workflow only when the user explicitly asks to edit runtime intents manually.

1. Treat current runtime intent Markdown and the loaded catalog as source of truth.
2. Read `references/format.md` and any relevant design/inventory references.
3. For rename, split, merge, deletion, or broad boundary changes, show the planned file operations and get explicit confirmation before editing.
4. Apply the smallest grounded runtime intent Markdown change.
5. Validate with focused tests, at minimum:

   ```bash
   pnpm test src/intent-validation.test.ts
   pnpm run test
   pnpm run build
   ```

6. Report affected files, validation results, and whether any staged edits were applied.

## Safety Rules

- Never enter this workflow merely because `evolution.json` has processed events.
- Never create a git commit or push unless the user explicitly asks.
- Do not manually edit `evolution.json` for normal intent evolution. Runtime review owns event records; manual edits should change intent Markdown and rely on tests/build for validation.
- Preserve entity-context privacy boundaries: learning phrases such as `看看`, `看一下`, or `看下` must pair with explicit `TOOLS.md`, `MEMORY.md`, or a path containing `memory`; never copy raw private memory into intent Markdown.
