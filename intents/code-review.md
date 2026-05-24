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
- If the code looks good, say so clearly.

## Skills & Tools

- Conduct multi-axis code review (correctness, readability, architecture, security, performance):
  skill: code-review-and-quality

- Simplify code without changing behavior:
  skill: code-simplification

- Find deepening opportunities and refactoring targets:
  skill: improve-codebase-architecture

- Apply adversarial review before merging risky changes:
  skill: doubt-driven-development

- Write tests first to prove behavior before fixing:
  skill: test-driven-development

- Language-specific review guidelines:
  skill: go
  skill: javascript
  skill: typescript
  skill: python
  skill: rust

- Read larger code files or trace related definitions and references:
  skill: cx

- Read larger Markdown files:
  skill: treemd

- Show concrete change suggestions as diffs:
  skill: diffs

- Read related files when review depends on surrounding context:
  read({ path: "<file>" })

- Run tests or linters when validation is needed:
  exec({ command: "<test_or_lint_command>" })

- Search for hard-to-locate bugs or deep performance regressions needing structured diagnosis:
  skill: diagnose

- Look up version-specific library docs, API references, or known issues:
  context7__query-docs({ libraryId: "<resolved_library_id>", query: "<specific_question>" })

- Ask targeted questions about a GitHub repository's internals or known issues:
  deepwiki__ask_question({ repoName: "<owner/repo>", question: "<specific_question>" })

- Search for current error messages, upstream bug reports, or changelogs:
  web_search({ query: "<error_message_or_symptom_keywords>" })

## Response Strategy

- Identify the most important issue first.
- Explain why it matters.
- Suggest minimal, practical improvements.
- If the code looks good, say so clearly.
- For hard-to-locate bugs, escalate to structured diagnosis (diagn skill).

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
read       review      escalate     suggest      verify
code       findings    (if needed)  changes      (optional)
```

### Step 1 — Read Code in Context
- Read the code snippet or file shown by the user.
- If the review depends on surrounding context, read related files.
- For larger codebases, use `treemd` or `cx` to trace definitions and references.

### Step 2 — Review Findings
- Run multi-axis review: correctness, readability, architecture, security, performance.
- Prioritize logic and safety issues over style concerns.
- Use language-specific skills for idiomatic guidance.

### Step 3 — Escalate (If Needed)
- For elusive bugs, non-deterministic failures, or deep regressions: escalate to `diagnose` skill.
- Look up version-specific docs or known issues when the bug may be upstream.
- Search web for error messages or upstream bug reports.

### Step 4 — Suggest Improvements
- Propose minimal, practical changes.
- Show diffs for suggested modifications.
- Avoid scope creep — focus on what the user asked about.

### Step 5 — Verify (Optional)
- Run tests or linters to validate suggested changes.
- For risky changes, apply adversarial review before merging.
