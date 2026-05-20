---
id: CODE_REVIEW
name: Code Review
triggers:
- "User is asking to inspect, review, or improve code — catching bugs at a glance, refactoring advice, architecture feedback, or performance review"
- "The code issue is straightforward: obvious logic errors, style problems, anti-patterns, complexity concerns, or concrete refactoring suggestions — not an elusive bug that needs a repro loop"
examples:
- "幫我看看這段程式碼有沒有問題"
- "review 這個 PR"
- "這個 function 要怎麼重構比較好？"
- "這段 code 有沒有潛在問題或可以改進的地方？"
- "幫我找出這個 snippet 的 bug"
---

Detected "code review" intent. The user wants code to be examined for problems or improvements.

## Guidelines

- Focus on correctness first.
- Also consider security, maintainability, and performance when relevant.
- Keep findings concrete, prioritized, and specific to the code shown.
- Do not inflate minor style issues above logic or safety issues.

## Response Strategy

- Identify the most important issue first.
- Explain why it matters.
- Suggest minimal, practical improvements.
- If the code looks good, say so clearly.

- Read larger code files or trace related definitions and references:
  skill: cx
- Read larger Markdown files:
  skill: treemd
- Show concrete change suggestions as diffs:
  skill: diffs

- Read related files when the review depends on surrounding context:
  read({ path: "<file>" })

- Run tests or linters when validation is needed:
```bash
<command>
```

## Escalation

- For hard-to-locate bugs, non-deterministic failures, or deep performance regressions that need a structured diagnosis loop:
  skill: diagnose
- Look up version-specific library docs, API references, or known issues in open-source frameworks:
  context7__query-docs({ libraryId: "<resolved_library_id>", query: "<specific_question>" })
- Ask targeted questions about a GitHub repository's internals or known issues:
  deepwiki__ask_question({ repoName: "<owner/repo>", question: "<specific_question>" })
- Search for current error messages, upstream bug reports, or changelogs:
  web_search({ query: "<error_message_or_symptom_keywords>" })
