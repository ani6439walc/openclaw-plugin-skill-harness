# Clustering — Intent Grouping

Goal: Group all capabilities by usage intent, not by directory name.

This workflow can identify overlap and complexity, but it does not apply split, merge, or delete operations. Record the evidence and let Intent Review's reviewer subagent own those lifecycle decisions.

## Actions

1. Cluster capabilities into intent families based on **what the user is trying to achieve** (e.g., "review code quality", "debug a system", "design architecture", "look up past memories").

2. Map each capability to **exactly one cluster** — no duplicates.

3. Compare against existing runtime intents in the active OpenClaw-resolved catalog (normally `~/.openclaw/plugins/skill-harness/intents/` with the default local state directory):
   - **Covered**: existing intent already handles this cluster.
   - **Gaps**: no existing intent for this cluster → recommend new intent ID.
   - **Overlaps**: one cluster maps to multiple existing intents → recommend merge or split.

4. Produce a cluster map: cluster name, capabilities, existing intent match (or "new"), recommended intent ID for gaps.

## Cluster Consistency Criteria

Use these criteria when reviewing a catalog, designing a new intent, refining an existing intent, or validating a reviewer-owned boundary result:

1. Every intent in a cluster should match the meaning of that cluster name.
2. Intents inside the same cluster should be semantically similar because they serve the same broad user-goal family.
3. Intents in different clusters should have clearly different user goals, routing boundaries, or execution workflows.
4. Cluster names should be semantically distinct from each other and should not overlap as near-synonyms.

If any criterion fails, mark the cluster as `overlap` or `unclear` and recommend the smallest rename, move, split, or merge that restores a single clear user-goal boundary.

## Cluster Naming Conventions

Use these rules when naming a new cluster, reviewing existing clusters, or recommending cluster renames:

1. Use clear, descriptive names for broad user-goal families, not tools, implementation details, file locations, or data sources.
2. Prefer stable noun phrases, such as `Software Development`, `Version Control`, `Web Interaction`, or `Knowledge Base`.
3. Avoid near-synonym clusters. If two cluster names can both complete the same sentence, "The user wants to ___", merge or rename them.
4. Check each candidate with the sentence test: "Users in this cluster are trying to ___." If intents in the cluster require unrelated verbs or goals to complete the sentence, split or rename the cluster.

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
- Cluster consistency criteria all pass, or failures are reported as `overlap` / `unclear` with a recommended correction.
- Cluster names follow the naming conventions above.
- Proceed to interview with the cluster map for user calibration.
