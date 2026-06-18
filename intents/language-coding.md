---
id: LANGUAGE_CODING
name: Language-Specific Coding (語言程式設計)
enabled: true
triggers:
  - "User is asking for language-specific coding guidance, best practices, idiomatic patterns, or common pitfalls for Go, JavaScript, TypeScript, Python, Rust, or other programming languages"
  - "User mentions language keywords: goroutine, async/await, ownership, borrow checker, PEP 8, type narrowing, generics, concurrency patterns"
  - "User wants to write idiomatic code in a specific language avoiding common traps and anti-patterns"
examples:
  - "幫我寫一個 Go 的 goroutine 要避免什麼陷阱？"
  - "Python 的 async pattern 要怎麼用比較好？"
  - "Rust 的 ownership 跟 lifetime 怎麼搞懂？"
  - "TypeScript 的 narrowing 跟 discriminated union"
  - "JavaScript 的 async/await 要注意什麼？"
---

Detected "language-specific coding" intent. The user wants language-specific coding guidance, best practices, or help avoiding common pitfalls.

## Guidelines

- Prefer language-specific skills over general coding advice when available.
- Keep examples idiomatic to the target language's conventions.
- Mention common pitfalls specific to the language (e.g., goroutine leaks in Go, ownership confusion in Rust).
- Use the appropriate skill based on the language mentioned.
- Reference official documentation or authoritative sources when needed.

## Skills & Tools

- Write reliable Go code avoiding goroutine leaks and interface traps:
  skill: go

- Write robust JavaScript with async patterns and type coercion handling:
  skill: javascript

- Write strict, type-safe TypeScript with narrowing and generics:
  skill: typescript

- Follow modern Python practices with PEP 8 and uv dependency management:
  skill: python

- Write idiomatic Rust avoiding ownership and borrow checker pitfalls:
  skill: rust

- Operate Linux systems avoiding permission traps and silent failures:
  skill: linux

- Avoid common Kubernetes mistakes with resources, probes, selectors, RBAC:
  skill: kubernetes

- Configure Nginx for reverse proxy, SSL termination, and performance:
  skill: nginx

- Handle Terraform state, for_each, lifecycle, and dependency ordering:
  skill: dev-lifecycle
  skill: terraform

- Look up version-specific library docs or API references:
  context7\_\_query-docs({ libraryId: "<resolved_library_id>", query: "<specific_question>" })

- Search for current language-specific best practices or updates:
  web_search({ query: "<language> <topic> best practices 2024" })

## Response Strategy

- Identify the target language from the user's request.
- Load the corresponding language skill for best practices.
- Provide idiomatic examples and warn about common traps.
- Reference official documentation or authoritative sources when needed.
