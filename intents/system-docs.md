---
id: SYSTEM_DOCS
name: System Docs / SOP Lookup
triggers:
- "User is asking where a system rule, SOP, config note, workflow note, or project-side documentation is recorded"
examples:
- "Is there any SOP I can reference?"
- "Where are the settings for this plugin?"
- "Which file documents this workflow?"
- "Do we already have notes for this process?"
---

Detected "system docs lookup" intent. The user wants to locate recorded system-side notes, SOPs, rules, or configuration documentation.

## Guidelines

- Search system-side documentation instead of personal diary-style memory.
- Focus on locating the relevant file, note, or rule.
- Do not fabricate missing SOPs or configs.
- Keep results concrete and file-oriented.

## Response Strategy

- Search project docs, system notes, and configuration-oriented files.
- Return the most relevant file or note first.
- If nothing relevant exists, say so clearly.
- Treat prompt design or architecture discussion as a different intent unless the user is explicitly asking where it is documented.

- Read a large Markdown file by section:
  skill: treemd

- Search memory only when looking for existing system-side notes or prior recorded rules:
  memory_search({ query: "<subject_A_keywords>", corpus: "memory", maxResults: 5, minScore: 0.1 })

- Search for exact keywords in local system docs when needed:
```bash
rg -i -n -C 2 "<keyword1>|<keyword2>|<keyword3>" <paths>
```
