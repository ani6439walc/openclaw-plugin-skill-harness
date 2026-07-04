# Evolution Workflow

Process exactly one pending finding from `~/.openclaw/plugins/intention-hint/evolution.json`.
Enter this mode only when the user explicitly asks to process the evolution backlog.

## Safety Rules

- Treat current runtime `~/.openclaw/plugins/intention-hint/intents/*.md` and the loaded catalog as the source of truth.
  `suggestedChange` is evidence and advice, not a patch to apply blindly.
- Follow `references/format.md` and the relevant design/inventory references for intent
  boundaries, collision checks, and workflow quality.
- Do not edit `~/.openclaw/plugins/intention-hint/evolution.json` directly. Use
  `pnpm run evolution-backlog -- ...` for every backlog read or mutation.
- `entity-context` trigger keyword findings are proposal-only like other
  `trigger-keywords` items. The trigger is intentionally narrow: learning
  keywords such as `看看`, `看一下`, or `看下` must pair with `TOOLS.md`,
  `MEMORY.md`, or a path containing `memory`; source allowlists are not learned
  from backlog suggestions.
- Never create a git commit or push.
- Process one item only. Leave blocked or ambiguous items `pending`.
- Mark duplicate, superseded, unsafe, or clearly rejected findings `dismissed`
  after grounding them against current Intent Markdown, so they do not stay at
  the front of the pending queue forever.
- For `split`, `merge`, or any deletion, first show the affected intents and
  planned file operations, then obtain explicit user confirmation.

## Select And Ground

1. From the plugin root, run
   `pnpm run evolution-backlog -- show --id <item-id>` when the user supplied
   an ID; otherwise run `pnpm run evolution-backlog -- show`. The default
   selects highest `frequency`, then oldest `createdAt`.
   Use `pnpm run evolution-backlog -- review-health --days 7` for read-only
   runtime review-health audits; it summarizes recent `processedEvents` by
   outcome (`wrote-items`, `nofinding`, `schema-rejected`, `parse-failed`,
   `subagent-error`, or `unknown`) without mutating the backlog.
2. Re-read the selected item immediately before processing. It must still be
   `pending`.
3. If `targetKind` is `trigger-keywords`, do not edit Intent Markdown and do not
   mark it processed in this workflow. First-version trigger keyword learning is
   proposal-only: inspect the evidence, dismiss clearly unsafe/duplicate
   suggestions, or leave the item pending for a future apply workflow. For
   `targetTrigger: entity-context`, reject suggestions that try to expand the
   source allowlist beyond `TOOLS.md`, `MEMORY.md`, or paths containing
   `memory`.
4. Inspect its target Intent Markdown, the compact intent catalog, and relevant
   intention-hint Skill references.
5. For a legacy item with `operation: unknown` or no targets, infer metadata
   only when the existing intents and finding make it unambiguous. Persist it
   with:

   ```bash
   pnpm run evolution-backlog -- set-target --id <item-id> --operation <operation> --target-intent <intent-id>
   ```

   Repeat `--target-intent` for multiple targets, then re-run `show` and use
   the new `updatedAt`. If inference is not clear, stop without modifying files.

## Body-boundary Mismatch Decision

Before editing, compare the filename-derived intent id, frontmatter triggers,
examples, domain, fastpath metadata, and body guidance:

- If filename id and metadata are correct but the body drifted away from the declared
  boundary, treat the finding as `refine` and fix the body, triggers, or
  examples to match the existing intent boundary.
- If the body consistently describes a better boundary than the current
  filename id or metadata, do not silently rewrite the body to fit stale
  routing metadata. Propose a rename or metadata update with the recommended
  filename, domain, fastpath fields, and any affected references, then obtain
  explicit user confirmation before changing filenames.
- If the body mixes multiple responsibilities or has become an oversized intent,
  propose `split` with the new intent boundaries, affected files, and migration
  plan, then obtain explicit user confirmation before creating/moving/deleting
  intent files.
- If the mismatch is caused by a duplicate or superseded finding, dismiss the
  finding instead of reshaping a healthy intent.

## Apply Transactionally

1. Decide whether the finding is already satisfied by current Intent Markdown.
   If so, skip edits and continue to validation.
2. Run the Body-boundary Mismatch Decision before changing any body section,
   routing metadata, or filename. Rename and split plans require explicit user
   confirmation; do not execute them as an automatic `refine`.
3. If the finding is a duplicate of an existing intent, is superseded by a safer
   current intent, or would introduce unsafe/conflicting behavior, do not edit
   files. Mark it dismissed using the latest selected `updatedAt`:

   ```bash
   pnpm run evolution-backlog -- mark-dismissed --id <item-id> --expected-updated-at <timestamp>
   ```

   Report the dismissal reason and stop processing this item.

4. Before any edit, create
   `/tmp/intention-hint-process-backlog/<item-id>-<timestamp>/` and back up
   every file that may be modified or deleted. Record every file that does not
   yet exist so it can be removed during rollback.
5. Apply only the grounded Intent Markdown changes:
   - `create`: create the declared target intent.
   - `refine`: update the declared target intent without broadening unrelated
     behavior.
   - `rename`: execute only after confirmation, then update filename-derived id
     and stale references together.
   - `split` or `merge`: execute only after the required confirmation.
6. Validate the resulting files:

   ```bash
   pnpm run evolution-backlog -- validate-intents --id <target-intent-id>
   pnpm run test
   pnpm run build
   ```

   Repeat `--id` for every resulting target intent.

7. When all checks pass, mark the item processed using the `updatedAt` from the
   latest `show` or `set-target` result:

   ```bash
   pnpm run evolution-backlog -- mark-processed --id <item-id> --expected-updated-at <timestamp>
   ```

8. If an edit, validation, or status update fails, restore only the files in
   this transaction from the backup, remove files recorded as newly created,
   and leave the item `pending`.

## Report

Report the item ID, operation, affected files, validation results, whether it
was processed or dismissed, whether a rollback occurred, and the remaining
pending count from:

```bash
pnpm run evolution-backlog -- list --json
```
