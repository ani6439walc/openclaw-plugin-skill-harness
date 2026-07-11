export const SKILL_HARNESS_SYSTEM_CONTEXT = `## Skills (mandatory)

Before acting, actively check whether a reusable skill can improve correctness, safety, or execution quality. Skills contain specialized workflows, exact commands, project conventions, pitfalls, and verification procedures that are more reliable than improvising from general knowledge.

If an injected skill candidate matches or is even partially relevant to the current request, load it with \`skill_view\` before proceeding and follow the relevant instructions. Do not skip a relevant skill merely because the task appears familiar or could be handled with general-purpose tools.

Use only the Skill Harness tools exposed in the current turn. Do not call or depend on a tool that is absent from the active tool set. When a workflow supplies a narrower tool allowlist, a stricter tool-call budget, or more specific discovery instructions, follow that narrower workflow.

### Skill Harness tools

- \`skill_search\`: When available, search visible skills using concise task concepts, domains, or keywords. Search results are discovery candidates, not substitutes for reading a skill.
- \`skill_view\`: When available, load a selected skill's complete \`SKILL.md\` or an allowed linked support file before following its workflow.
- \`skill_list\`: When available, browse the visible skill inventory only when the task is broad, terminology is uncertain, or focused search is insufficient. Avoid enumerating the full inventory unnecessarily.
- \`skill_manage\`: When available and authorized, create, patch, edit, delete, or manage support files for skills. Prefer targeted patches for small corrections and verify write results.

### Using Skill Harness context

Skill Harness may inject \`domain_skill_candidates\` and an \`Instruction Hint\` for the current turn.

- Treat injected candidates as discovery leads, not proof that every listed skill applies.
- Treat the \`Instruction Hint\` as advisory. Follow it only when it matches the latest request, current conversation, and verified repository or tool evidence.
- The latest request and higher-priority instructions override stale, mismatched, or overly broad hints.
- If an injected candidate matches and \`skill_view\` is available, load it before following it.
- If the candidates or hint do not match the current intent, do not force them. When \`skill_search\` is available, search with 1-3 concise task concepts, inspect the strongest results, then load the best match with \`skill_view\` when available.
- Use \`skill_list\` only when focused search cannot identify a suitable candidate.
- Start with the strongest matching skill. Load additional skills only when distinct parts of the task genuinely require them.
- If no relevant skill can be identified with the tools available in the current turn, proceed without one rather than inventing a match.

If a loaded skill contains stale, incomplete, or incorrect instructions, use \`skill_manage\` only when it is available and the task authorizes changing that skill.`;
