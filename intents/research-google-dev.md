---
id: RESEARCH_GOOGLE_DEV
name: Google Developer Products Query
triggers:
  - "User is asking about Google developer products, APIs, SDKs, or documentation such as Google Cloud, Firebase, Android, Chrome, TensorFlow, Go, Gemini, or web.dev"
examples:
  - "怎麼建立 Cloud Storage bucket？"
  - "Firebase Realtime Database 跟 Firestore 差在哪？"
  - "Android 要怎麼用 JWT 做認證？"
  - "Chrome extension 最佳實踐有哪些？"
  - "解釋 TensorFlow Lite 的量化"
  - "GCP PCA 考試要準備什麼？"
---

Detected "Google developer products" intent. The user wants authoritative information about Google developer products, APIs, SDKs, or documentation.

## Guidelines

- Do not answer Google developer product questions from memory alone.
- Prefer the Google developer knowledge corpus before general web lookup.
- Keep the answer source-backed and specific to the Google product in question.
- Use official documentation as fallback when the primary corpus is insufficient.

## Skills & Tools

- Query the primary Google developer corpus first:
  google_developer_knowledge\_\_answer_query({ query: "<question>" })

- Search Google developer docs when the first-pass answer is unavailable or insufficient:
  google_developer_knowledge\_\_search_documents({ query: "<question>" })

- Fetch full Google developer documents when search results need expansion:
  google_developer_knowledge\_\_get_documents({ names: ["<document_name>"] })

- Read an official Google documentation page directly when a strong source is known:
  web_fetch({ url: "<authoritative_url>" })

## Response Strategy

- Query the Google developer corpus first with `answer_query`.
- Fall back to `search_documents` when direct answering is unavailable or incomplete.
- Fetch full documents when search results need more detail.
- Mention source links for factual or technical claims.
- Use official documentation as fallback when the corpus is insufficient.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4
query      search      fetch        cite
corpus     docs        full docs    & deliver
```

### Step 1 — Query Primary Corpus

- Call `google_developer_knowledge__answer_query` with the user's question.
- If a grounded answer is returned, proceed to delivery.

### Step 2 — Search Documents (Fallback)

- If the first-pass answer is unavailable or insufficient, call `google_developer_knowledge__search_documents`.
- Review returned document chunks for relevance.

### Step 3 — Fetch Full Documents

- When search results are not detailed enough, use `google_developer_knowledge__get_documents` with document names from the search.
- Alternatively, `web_fetch` the official documentation URL directly.

### Step 4 — Cite & Deliver

- Synthesize a source-backed answer specific to the Google product.
- Include source links for factual and technical claims.
