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

## Response Strategy

- Query the Google developer corpus first.
- Fall back to document search when direct answering is unavailable or incomplete.
- Read official docs directly only when more detail is needed.
- Mention source links for factual or technical claims.

- Query the primary Google developer corpus first:
  google-developer-knowledge__answer_query({ query: "<question>" })

- Search Google developer docs when the first-pass answer is unavailable or insufficient:
  google-developer-knowledge__search_documents({ query: "<question>" })

- Fetch full Google developer documents when search results need expansion:
  google-developer-knowledge__get_documents({ names: ["<document_name>"] })

- Read an official Google documentation page directly when a strong source is known:
  web_fetch({ url: "<authoritative_url>" })
