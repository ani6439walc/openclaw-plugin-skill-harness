---
domain: "memory"
triggers:
  - "The user wants past records or prior information without a specific recent, comparative, emotional, or timeline focus."
  - "User is asking about past events, records, preferences, habits, or prior discussions without a clearly recent, comparative, emotional, or timeline-oriented focus"
examples:
  - "Did we talk about that idea before?"
  - "What do I usually order at that restaurant?"
  - "Help me find the settings notes about Talos"
  - "What travel plans did I mention before?"
fastpath:
  keywords:
    - "I mentioned before"
    - "do you remember"
skills:
  - treemd
  - obsidian
---

## Guidelines

- Treat the latest user message as the primary retrieval target.
- Use recent conversation only to disambiguate what the latest message refers to.
- Search recorded memory instead of guessing.
- Use this intent for broad past recall without a narrow time window.
- If memory is weak or missing, say so clearly.

## Response Strategy

- Reformulate the user's request into a self-contained memory target when references are ambiguous.
- Distill a few high-value keywords before searching.
- Use a permissive retrieval threshold for preferences, habits, routines, or personal facts.
- Return the most relevant recorded memory first.
- Treat recent, emotional, timeline, or comparison questions as separate intents.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
extract     semantic      validate      deep-read    synthesize
keywords    search        results       + expand
```

### Step 1 — Extract High-Signal Search Terms

- Preserve the user's language and extract 3–5 high-signal nouns, entities, or canonical identifiers. Do not translate names merely to fit a keyword format.
- For languages without consistent word boundaries, separate distinct entities, nouns, or concepts with spaces.
- ❌ `Query settings for Talos` → ✅ `Talos config settings`
- ❌ `What travel plans did I mention before?` → ✅ `travel plans itinerary`
- Extract entity names from `[[MEMORY.md]]` entries (people, projects, places): `Talos`, `GCP PCA`, `Chiayi`.
- If the query mentions a specific tool or project, use its canonical name (e.g., `Kubernetes` not `k8s cluster mgmt`).

### Step 2 — Semantic Search + HyDE Query Expansion

**Basic mode** (single query sufficient):

```javascript
memory_search({
  query: "<high_signal_terms>",
  corpus: "memory",
  maxResults: 5,
  minScore: 0.1,
});
```

**HyDE mode** (when basic mode returns insufficient hits):

1. Generate a 50–100 word "hypothetical answer" (need not be correct, just cover potentially relevant entities/events/emotions).
2. Extract 3–5 semantically diverse search queries from the hypothetical answer:
   - Direct semantic translation
   - Geographic/temporal narrowing (add location, date keywords)
   - Emotional/evaluative angle (use adjectives with emotional coloring)
3. Execute `memory_search` independently for each query axis.

**Search termination conditions** (stop when any is met):

1. **Score threshold**: at least 1 hit with `score ≥ 0.45`.
2. **Consecutive zero hits**: 3 query variants return 0 hits.
3. **Saturation**: 10+ unique results accumulated, new queries yield no new documents.

- **Prefer semantic search** over `rg` for natural language memory content.
- If semantic search returns 0 hits, fall back to `rg -i "<keyword1>|<keyword2>" memory/*.md` for text matching.

### Step 3 — Validate Results + Adequacy Gate

**Adequacy checks**:

- **Sparse data** (< 2 files, no `score ≥ 0.45` hit) → report "insufficient memory", ask user for time period or context.
- **Very recent event** (today's raw diary exists but dreaming index not built) → `read` the daily `memory/YYYY-MM-DD.md` directly, skip vector search.
- **Exact location query** (URL / Jira ticket / specific ID) → trigger `rg` in `darling/` for the pattern.
- **Data scarcity** (search results only match definition pages or templates) → report `INSUFFICIENT_DATA`, do not speculate.

**Standard validation**:

- Check `memory_search` returned `score` and `snippet` to confirm relevance to the user's question.
- If top result `score < 0.3`, broaden keywords (add synonyms) and search once more.
- If still no hits, clearly tell the user "no relevant records found in memory" — never guess.

### Step 4 — Deep Read + Structural Expansion

- Use `memory_get` to read the full content of the 1–2 highest-scoring hits.
- If the hit is `MEMORY.md`, use `memory_get({ path: "MEMORY.md", from: <line>, lines: <N> })` to read the relevant section.
- If the hit is `memory/YYYY-MM-DD.md`, read the full daily file for complete context.

**Structural expansion** (when a single file is insufficient):

- Use `obsidian backlinks file="<filename>"` to find which files link to this one.
- Use `obsidian links file="<filename>"` to find which files this one links to.
- If Obsidian is not running, activate **semantic fallback**: search cross-date files for co-occurring entity keywords from the entry node.
- Traversal depth limit: **2 hops** (no Depth 3), max 15 unique related files.

### Step 5 — Synthesize Response

- Synthesize the read content into a natural language reply, with source citations (e.g., `Source: memory/2026-04-08.md#L42`).
- If information spans multiple files, merge and label each segment with its source date.
- **Never fabricate details** not present in memory. If a gap exists, explicitly say "Ani has no record of this part."

## Experience

- Use `treemd` skill when a large Markdown memory note needs section-level navigation before deep reading.
- Use `obsidian` skill after relevant notes are found to inspect tags, outgoing links, backlinks, and related memory structure.
- Use semantic memory search as the primary retrieval path for recorded memory, with language-preserving high-signal terms and a permissive threshold for personal facts, habits, and preferences.
- Use direct memory reads to inspect the highest-value memory hit before synthesizing an answer.
- Use lightweight tag extraction only as a supporting analysis step when sentiment, topic density, or tag context matters.
