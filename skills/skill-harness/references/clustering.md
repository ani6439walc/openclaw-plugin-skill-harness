# Clustering — Intent Grouping

Goal: Group all capabilities by usage intent, not by directory name.

## Actions

1. Cluster capabilities into intent families based on **what the user is trying to achieve** (e.g., "review code quality", "debug a system", "design architecture", "look up past memories").

2. Map each capability to **exactly one cluster** — no duplicates.

3. Compare against existing runtime intents in `~/.openclaw/plugins/skill-harness/intents/`:
   - **Covered**: existing intent already handles this cluster.
   - **Gaps**: no existing intent for this cluster → recommend new intent ID.
   - **Overlaps**: one cluster maps to multiple existing intents → recommend merge or split.

4. Produce a cluster map: cluster name, capabilities, existing intent match (or "new"), recommended intent ID for gaps.

## Domain-Intent Consistency Criteria

Use these criteria when reviewing a catalog, designing a new intent, refining an existing intent, or validating a split/merge/extraction result:

1. Every intent in a domain should match the meaning of that domain name.
2. Intents inside the same domain should be semantically similar because they serve the same broad user-goal family.
3. Intents in different domains should have clearly different user goals, routing boundaries, or execution workflows.
4. Domain names should be semantically distinct from each other and should not overlap as near-synonyms.

If any criterion fails, mark the cluster as `overlap` or `unclear` and recommend the smallest rename, move, split, or merge that restores a single clear user-goal boundary.

## Domain Naming Conventions

Use these rules when naming a new domain, reviewing existing domains, or recommending domain renames:

1. Use `kebab-case`.
2. Name domains after broad user-goal families, not tools, implementation details, file locations, or data sources.
3. Prefer stable nouns or noun phrases, such as `software`, `version-control`, `web-interaction`, or `knowledge-base`.
4. For one-word domains, prefer nouns over gerunds. Use one-word gerunds only when the gerund is already the conventional name of a domain or activity category, such as `gaming`.
5. Avoid abbreviations unless the abbreviation is the user-facing product or platform name.
6. A domain should normally contain or plausibly grow into at least two semantically related intents. Singleton domains are acceptable only when the boundary is stable, specific, and likely to expand.
7. Use product or platform names only when the user's goal is managing that product or platform itself, such as `openclaw-platform`.
8. Avoid near-synonym domains. If two domain names can both complete the same sentence, "The user wants to ___", merge or rename them.
9. Check each candidate with the sentence test: "Users in this domain are trying to ___." If intents in the domain require unrelated verbs or goals to complete the sentence, split or rename the domain.

If a current domain violates these conventions, recommend the smallest migration: rename the domain, move the outlier intents, or merge overlapping domains.

## Output

Cluster map table:

```
| Cluster Name | Capabilities | Existing Intent | Recommended ID |
|--------------|--------------|-----------------|----------------|
| Memory Retrieval | memory_search, wiki_search, memory_get | memory-lookup | (existing) |
| Code Review | git diff, skill-vetter | (none) | code-review |
```

Gap analysis:

- **Covered**: clusters that map to existing intents
- **Gaps**: clusters with no existing intent → recommend new intent ID
- **Overlaps**: one cluster maps to multiple existing intents → recommend merge or split

## Validation

- Every skill/tool belongs to exactly one cluster.
- No capability is orphaned.
- Domain-intent consistency criteria all pass, or failures are reported as `overlap` / `unclear` with a recommended correction.
- Domain names follow the naming conventions above, or violations are reported with the smallest safe migration.
- Proceed to interview with the cluster map for user calibration.
