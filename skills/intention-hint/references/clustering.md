# Clustering — Intent Grouping

Goal: Group all capabilities by usage intent, not by directory name.

## Actions

1. Cluster capabilities into intent families based on **what the user is trying to achieve** (e.g., "review code quality", "debug a system", "design architecture", "look up past memories").

2. Map each capability to **exactly one cluster** — no duplicates.

3. Compare against existing intents in `intents/`:
   - **Covered**: existing intent already handles this cluster.
   - **Gaps**: no existing intent for this cluster → recommend new intent ID.
   - **Overlaps**: one cluster maps to multiple existing intents → recommend merge or split.

4. Produce a cluster map: cluster name, capabilities, existing intent match (or "new"), recommended intent ID for gaps.

## Output

- Cluster map + gap analysis + recommended new intent list.

## Validation

- Every skill/tool belongs to exactly one cluster.
- No capability is orphaned.
- Proceed to interview with the cluster map for user calibration.
