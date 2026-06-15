---
id: WIKI_MANAGEMENT
name: Wiki Management & Query
triggers:
  - "User is asking to search, read, create, update, or maintain wiki pages in the memory wiki vault (wiki/) — including status checks, linting, structural maintenance, and Obsidian compatibility"
  - "User wants to query wiki entities, concepts, syntheses, or reports, or ingest/reorganize wiki sources"
  - "User wants to search, read, or explore raw or external wiki-like directories, including subagent workspaces such as llm-wiki, that are not part of the managed Obsidian vault"
examples:
  - "搜尋 wiki 裡有沒有關於 Kubernetes 的記錄"
  - "幫我建立一個新的 wiki 頁面記錄這個專案"
  - "檢查 wiki 有沒有矛盾或問題"
  - "wiki 的整體狀態怎麼樣？"
  - "幫我把這個檔案 ingest 到 wiki sources"
  - "去找找 llm-wiki 下整理的文章"
  - "看看 subagent 的 wiki 目錄裡有什麼類別"
---

Detected "wiki management" intent. The user wants to search, read, create, update, or maintain pages in the memory wiki vault.

## Guidelines

- Do not manually `mv` wiki files between directories. Always use `openclaw wiki ingest` → `openclaw wiki compile` → `openclaw wiki lint`.
- Treat raw sources, memory artifacts, and daily notes as evidence. Do not let wiki pages become the only source of truth for new claims.
- Keep page identity stable. Favor updating existing entities and concepts over spawning duplicates.
- Keep generated sections inside managed markers (`<!-- openclaw:wiki:... -->`). Do not overwrite human note blocks.
- Use `[[Wikilinks]]` for internal vault connections, `[text](url)` for external URLs only.
- Avoid destructive renames unless you also have a link-repair plan.
- Distinguish the managed memory wiki vault (`wiki/`) from raw/external wiki directories such as subagent `llm-wiki` workspaces; for raw directories, use filesystem inspection instead of managed vault tools.
- When archiving, ingesting, or reorganizing source files into the managed wiki, ALWAYS use the wiki-maintainer ingest → compile → lint pipeline so original source content is preserved before deletion.
- If source files were already deleted, check git history and restore them before running the ingest pipeline.

## Skills & Tools

- Check vault mode, path, page counts, and Obsidian CLI availability:
  wiki_status()

- One-pass recall across durable memory + compiled wiki:
  memory_search({ query: "<keywords>", corpus: "all", maxResults: 10 })

- Search wiki pages with wiki-specific ranking and provenance:
  wiki_search({ query: "<keywords>", corpus: "wiki", maxResults: 10 })

- Inspect exact wiki page content before editing or citing:
  wiki_get({ lookup: "<page_path_or_id>" })

- Retrieve wiki page content with the exact accepted shape only; do not pass unsupported fields such as `limit` or `format`:
  wiki_get({ lookup: "<page_path_or_id>" })

- Create or update wiki synthesis / metadata:
  wiki_apply({ op: "create_synthesis", title: "<title>", body: "<content>", sourceIds: ["<source_id>"] })

- Lint wiki vault for contradictions, provenance gaps, open questions:
  wiki_lint()

- Ingest a local file into `sources/`, compile vault, lint for issues (never manually move files):
  skill: wiki-maintainer

- Preserve original source files through the wiki-maintainer pipeline before deleting source folders:
  skill: wiki-maintainer

- Probe Obsidian CLI status and use Obsidian helpers (`status`, `search`, `open`, `daily`):
  skill: obsidian-vault-maintainer

- Navigate a large wiki page by heading tree before editing:
  skill: treemd

- Inspect code or plugin implementation details within wiki context:
  skill: cx

- Search web for authoritative references to cite in wiki pages:
  web_search({ query: "<topic_keywords>" })

- Fetch and extract content from an authoritative URL for wiki sourcing:
  web_fetch({ url: "<authoritative_url>" })

- Explore raw wiki directory structures and read source files directly:
  exec({ command: "find <raw_wiki_path> -maxdepth 3 -type f | sort" })
  read({ path: "<file_path>" })

- Analyze local repository structure and implementation files as source material for wiki documentation:
  exec({ command: "tree <repo_path> -L 3" })
  exec({ command: "find <repo_path> -type f | sort | head -100" })
  read({ path: "<file_path>" })

## Response Strategy

- Check vault status first to understand the current wiki state.
- For queries: search wiki pages with `wiki_search`, then `wiki_get` the exact content.
- For creation: ingest sources, compile, then lint for issues.
- For maintenance: lint the vault, resolve contradictions, and fix structural issues.
- Never manually move wiki files — always use the ingest → compile → lint pipeline.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5 → Step 6
check      search      gather       read         edit/create  lint
status     wiki        sources      content      or ingest    & compile
```

### Step 1 — Check Vault Status
- Call `wiki_status()` to understand vault mode, path, page counts, and Obsidian CLI availability.
- Confirm the vault is accessible before any operation.

### Step 2 — Search Wiki
- For managed vault queries: use `wiki_search` with relevant keywords.
- For broader context: use `memory_search` with corpus "all" to span memory + wiki.
- For raw or external wiki-like directories, first inspect the directory tree with `find`/`rg` and identify the relevant source, summary, concept, or index files directly.

### Step 3 — Gather Source Material
- For wiki pages based on codebases or local projects, explore repository structure with `tree`, `find`, or `rg` before writing.
- Read key configuration, README, manifest, deployment, or implementation files needed to support the requested documentation.
- Capture file organization patterns, important directories, and concrete implementation details; do not invent undocumented behavior.

### Step 4 — Read Content
- Use `wiki_get` to inspect managed vault page content before editing or citing.
- Use `read` for raw directory files after confirming the requested path or repository.
- For large pages: use `treemd` to navigate by heading tree first when available.

### Step 5 — Edit, Create, or Ingest
- For edits: use `wiki_apply` to create synthesis or update metadata.
- For new pages: ingest the source file via `wiki-maintainer` skill.
- Never manually move files between directories.

### Step 6 — Lint & Compile
- Run `wiki_lint()` to check for contradictions, provenance gaps, and open questions.
- Compile the vault with `obsidian-vault-maintainer` if needed.
- Fix any issues found during linting.

### Step 7 — Reinforce Synthesis Evidence

- Scan for synthesis pages missing evidence or `sourceIds` using wiki tools or narrow filesystem inspection.
- Retrieve each affected page with `wiki_get({ lookup: "<page_path_or_id>" })` only.
- Add evidence with `wiki_apply`, including appropriate `sourceIds` or claim evidence references rather than freehand provenance.
- Run `wiki_lint` after updates to confirm structural integrity and provenance health.
