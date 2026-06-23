---
triggers:
  - "The user wants two or more remembered subjects to be compared without merging them into a single recall path."
  - "User is asking about differences, similarities, trade-offs, or contrasts between two or more remembered subjects, periods, trips, approaches, or records"
examples:
  - "Which of these two approaches is better?"
  - "What's the difference between last month's and this month's data?"
  - "How does the Japan trip compare to the Chiayi trip?"
domain: "memory"
---

## Guidelines

- Treat the latest user message as the primary retrieval target.
- Use recent conversation only to disambiguate what the latest message refers to.
- Retrieve each subject separately before comparing them.
- Keep the comparison neutral and based on recorded evidence.
- Do not assume missing details for one side.

## Skills & Tools

- Read a large Markdown memory note by section:
  skill: treemd
- List tags or inspect linked memory notes after relevant files are found:
  skill: obsidian
- Search recorded memory for subject A:
  memory_search({ query: "<subject_A_trigram_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })
- Search recorded memory for subject B:
  memory_search({ query: "<subject_B_trigram_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })
- Read the most relevant memory note when more detail is needed:
  memory_get({ path: "<memory_file>" })

## Response Strategy

- Reformulate the user's comparison into clear subject A and subject B targets when references are ambiguous.
- Distill separate high-value keywords for each subject before searching.
- Search memory for each subject independently instead of using a merged comparison query.
- Align the most relevant comparable details.
- Highlight similarities, differences, and obvious data gaps.
- If one side is weakly supported, say so clearly.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
extract     search A      search B      align         output
subjects                                dimensions
```

### Step 1 — Extract Comparison Subjects

- Identify **Subject A** and **Subject B** (or more) from the user's question.
- ❌ "Compare Japan and Chiayi" → ✅ A = `Japan business trip travel`, B = `Chiayi trip`
- If subjects are vague ("that one" vs "this one"), resolve the specific referent from conversation context.
- If unable to identify two subjects, fall back to general memory lookup.

### Step 2 — Dual HyDE + Independent Search for Subject A

**Dual HyDE mode** (SOP boundary condition 6 — Comparison / Contrast):

- Generate a separate 50-word hypothetical answer for **Subject A** only (do not mix with B).
- Extract 2–3 semantically diverse search queries from the hypothetical answer.

```javascript
memory_search({
  query: "<subject_A_trigram_keywords>",
  corpus: "memory",
  maxResults: 5,
  minScore: 0.1,
});
```

- Read the full content of the 1–2 highest-scoring hits for A.
- If A returns 0 hits, record "Subject A data insufficient."
- **Adequacy gate**: if A has < 2 files and no high-confidence hit, report `DUAL_TOPIC_MISSING` and ask the user to confirm the subject.

### Step 3 — Dual HyDE + Independent Search for Subject B

**Dual HyDE mode**:

- Generate a separate 50-word hypothetical answer for **Subject B** only (do not mix with A).
- Extract 2–3 semantically diverse search queries from the hypothetical answer.

```javascript
memory_search({
  query: "<subject_B_trigram_keywords>",
  corpus: "memory",
  maxResults: 5,
  minScore: 0.1,
});
```

- Read the full content of the 1–2 highest-scoring hits for B.
- If B returns 0 hits, record "Subject B data insufficient."
- **Adequacy gate**: if only 1 subject is detected (the other side is completely blank), report `DUAL_TOPIC_MISSING` and ask for clarification.

### Step 4 — Contrast Axis Alignment + Comparison Dimensions

- Extract **common dimensions** from A and B's records for comparison:
  - **Time**: dates, duration, season
  - **Location**: cities, attractions, transportation
  - **Activities**: what was done, what was eaten, where stayed
  - **Emotions**: happiness level, stress, memorable moments
  - **Cost**: budget, actual spending (if recorded)
- If a dimension only has data on one side, mark "only A/B has records."

**Dual-origin BFS merge** (optional, when both sides have sufficient entry nodes):

- Run structural expansion from both A and B's hub nodes (obsidian backlinks/links).
- Mark intersection nodes (appearing in both A and B) as "shared context."
- Non-intersection nodes marked as "unique to A/B."

### Step 5 — Output Comparison Results

- Present comparison results in bullet-point format, one bullet per dimension.
- If one side has significantly less data, clearly state "B has fewer records, comparison may be incomplete."
- **Do not fabricate missing details** to "fill in" comparison tables. Leave blanks rather than invent.
- Avoid table format (Discord style guide) — use bullet points instead.
