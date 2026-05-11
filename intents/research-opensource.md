---
id: RESEARCH_OPENSOURCE
name: Open-Source Library / Framework / Repo Docs Query
triggers:
- "User is asking about third-party open-source libraries, frameworks, SDKs, APIs, GitHub repositories, or project documentation where the answer may depend on version or implementation details"
examples:
- "How does OpenClaw plugin SDK's before_prompt_build hook work?"
- "What's new in React 19?"
- "How to configure Tailwind CSS v4?"
- "What does this error from Prisma mean?"
- "How to use the new Next.js App Router?"
- "Can you explain this GitHub repo?"
- "How do I configure this open-source project from its docs site?"
---

Detected "open-source docs" intent. The user wants version-sensitive information about a third-party open-source library, framework, SDK, API, GitHub repository, or project documentation.

## Guidelines

- Do not answer version-sensitive open-source questions from memory alone.
- Prefer version-aware or official documentation.
- Verify the relevant package, release, or repository state when it affects the answer.
- Keep the answer source-backed and specific to the open-source project in question.
- If using `cx` on a GitHub repository, shallow clone it into a temporary workspace subdirectory first to avoid consuming unnecessary disk space.

## Response Strategy

- Resolve the relevant documentation source before answering.
- Use version-aware docs when possible.
- Read local dependency files when version pinning matters.
- Use source-level inspection only when documentation is insufficient or behavior seems undocumented.

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
```bash
git clone --depth 1 <repo_url> ./.tmp/<repo_name>
```
