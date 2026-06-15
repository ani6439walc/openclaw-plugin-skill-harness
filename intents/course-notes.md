---
id: COURSE_NOTES
name: Course Notes & Learning Workflow (課程筆記與學習工作流)
enabled: true
triggers:
  - "User wants to take structured notes from a video course, online class, lecture, or learning platform by extracting subtitles, transcripts, or course materials"
  - "User wants to supplement course content with official documentation, tutorials, references, or external research and synthesize them into study notes"
  - "User asks to follow an existing course-note template, project-specific learning format, or recurring study workflow"
  - "User mentions course notes, study notes, lecture notes, transcript extraction, 字幕整理, 課程筆記, 學習筆記, or 陪讀"
examples:
  - "幫我打開 Udemy 課程字幕，整理成筆記並補充官方文件"
  - "繼續記錄 Section 4 Lecture 12，按照之前的格式寫到課程筆記"
  - "把這堂課的 transcript 整理成 study notes，順便查官方 docs 補充"
  - "每次記錄一堂課後，把流程寫進 Ani 的陪讀小筆記"
---

Detected "course notes" intent. The user wants an end-to-end study workflow that extracts course content, researches supporting references, and writes structured learning notes.

## Guidelines

- Ground every note in verified course material, transcript text, screenshots, user-provided source content, or fetched documentation. Do not invent lecture content.
- Preserve the existing project template, heading structure, tone, and progress tracker before adding new lecture notes.
- For authenticated course platforms or subtitle extraction, use browser automation or delegation with explicit section/lecture navigation targets.
- Use official documentation first for supplementary research when the course names a technology, API, database, or framework.
- Process one lecture or a small explicit batch at a time unless the user asks for a larger range.
- If extraction or documentation access fails, report the exact blocker and do not fill gaps with guesses.
- When the user asks to record the workflow itself, update the designated study-process note only after the lecture note is successfully written and verified.

## Skills & Tools

- Extract subtitles, transcripts, screenshots, or course-page content through browser interaction:
  skill: browser-automation

- Research official documentation or source-backed supplementary material:
  skill: research-opensource

- Write and maintain structured productivity-vault learning notes:
  skill: productivity

- Edit Obsidian Markdown while preserving heading structure and wikilinks:
  skill: obsidian-markdown

- Survey large course-note files before editing:
  skill: treemd

- Fetch public documentation pages when no browser interaction is needed:
  web_fetch({ url: "<official_doc_url>" })

- Search for official documentation when the canonical URL is unknown:
  web_search({ query: "<topic> official documentation" })

- Read the current project note or template before modifying it:
  read({ path: "<course_note_path>" })

- Apply precise note updates after reading the latest file content:
  edit({ path: "<course_note_path>", edits: [{ oldText: "<exact_section>", newText: "<updated_section>" }] })

## Response Strategy

- Identify the course, section, lecture, target note file, expected template, and supplementary research sources.
- Extract or retrieve the course source content before drafting notes.
- Research only the topics actually covered by the lecture, prioritizing official docs.
- Write notes into the existing structure with clear source links and concise explanations.
- Verify the changed note, update any progress tracker, and report completed lecture(s), changed files, references used, and blockers.

## Concrete Workflow

### Step 1 — Verify Scope and Template
- Confirm the lecture/section identifier, target file, and expected note format from the user request or existing project note.
- Read the target note and inspect its headings before editing.

### Step 2 — Extract Course Content
- Use browser automation for authenticated course pages or subtitle panels.
- Include explicit navigation instructions such as course section, lecture number, title, and sidebar target.
- Verify the extracted content belongs to the requested lecture before summarizing.

### Step 3 — Research Supplementary Sources
- Identify key technologies, commands, APIs, or concepts from the transcript.
- Fetch official docs or authoritative references for those topics.
- Keep URLs verified and relevant to the lecture content.

### Step 4 — Synthesize Notes
- Convert transcript and references into the established template.
- Keep course facts, instructor claims, and external documentation clearly grounded.
- Avoid adding unsupported activities, examples, or conclusions.

### Step 5 — Persist and Verify
- Update the target note with precise edits.
- Re-read the changed section, check formatting, and update progress/status fields when present.
- If requested, record the repeatable workflow in the designated study-process section after the note update succeeds.
