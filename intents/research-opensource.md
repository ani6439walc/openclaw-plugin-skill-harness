---
id: RESEARCH_OPENSOURCE
name: Open-Source Library / Framework / Repo Docs Query
triggers:
  - "User is asking about third-party open-source libraries, frameworks, SDKs, APIs, GitHub repositories, or project documentation where the answer may depend on version or implementation details"
examples:
  - "OpenClaw 的 plugin SDK 怎麼用？"
  - "React 19 有什麼新功能？"
  - "這個 GitHub repo 在做什麼？"
---

Detected "open-source docs" intent. The user wants version-sensitive information about a third-party open-source library, framework, SDK, API, GitHub repository, or project documentation.

## Guidelines

- Do not answer version-sensitive open-source questions from memory alone.
- Prefer version-aware or official documentation.
- Verify the relevant package, release, or repository state when it affects the answer.
- Keep the answer source-backed and specific to the open-source project in question.
- If using `cx` on a GitHub repository, shallow clone it into a temporary workspace subdirectory first to avoid consuming unnecessary disk space.

## Skills & Tools

- Read a code or package source tree by symbols when implementation details matter:
  skill: cx

- Read a large Markdown documentation file by section:
  skill: treemd

- Read a long documentation page with less clutter:
  skill: defuddle

- Resolve a library name to a Context7 id before querying docs:
  context7__resolve-library-id({ libraryName: "<library>", query: "<question>" })

- Query version-sensitive library documentation:
  context7__query-docs({ libraryId: "<context7_library_id>", query: "<question>" })

- Read a dependency or lock file when version pinning is needed:
  read({ path: "<dependency_or_lock_file>" })

- Read an official documentation page directly when a strong source is known:
  web_fetch({ url: "<authoritative_url>" })

- Shallow clone a GitHub repository into a temporary workspace subdirectory before source inspection:
  exec({ command: "git clone --depth 1 <repo_url> ./.tmp/<repo_name>" })

## Response Strategy

- Resolve the relevant documentation source before answering.
- Use version-aware docs (Context7) when possible.
- Read local dependency files when version pinning matters.
- Use source-level inspection (cx) only when documentation is insufficient or behavior seems undocumented.
- Shallow clone repos into `.tmp/` before source inspection.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
identify   resolve     read docs    source       synthesize
library    docs                        inspect
```

### Step 1 — Identify Library & Version
- Determine the library/framework name from the user's question.
- Check if a specific version is mentioned.
- Read local dependency/lock files if version pinning is needed.

### Step 2 — Resolve Documentation Source
- Call `context7__resolve-library-id` to get the Context7-compatible library ID.
- If no Context7 match, fall back to official docs or repo inspection.

### Step 3 — Read Documentation
- Query version-sensitive docs via `context7__query-docs`.
- For large docs: use `treemd` to survey structure first.
- For long pages: use `defuddle` for cleaner extraction.
- Read official documentation URLs directly when known.

### Step 4 — Source Inspection (Fallback)
- When documentation is insufficient, shallow clone the repo: `git clone --depth 1 <repo_url> ./.tmp/<repo_name>`.
- Use `cx` to inspect code symbols, definitions, and references.

### Step 5 — Synthesize Answer
- Provide a source-backed answer specific to the open-source project.
- Include version context when the answer varies by release.
- Cite documentation URLs or source file paths.
