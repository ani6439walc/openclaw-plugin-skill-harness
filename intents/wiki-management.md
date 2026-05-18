---
id: WIKI_MANAGEMENT
name: Wiki Management & Query
triggers:
- "User is asking to search, read, create, update, or maintain wiki pages in the memory wiki vault (wiki/)"
- "User wants to check wiki status, lint wiki for contradictions, or manage wiki content structure"
- "User is asking about wiki entities, concepts, syntheses, or reports — the wiki as a knowledge base, not workspace docs"
- "User wants to ingest a file into wiki sources or reorganize wiki pages"
- "User mentions wiki vault maintenance, compile, or Obsidian compatibility"
examples:
- "搜尋 wiki 裡有沒有關於 Kubernetes 的記錄"
- "幫我建立一個新的 wiki 頁面記錄這個專案"
- "檢查 wiki 有沒有矛盾或問題"
- "把這份筆記整理到 wiki 裡"
- "wiki 裡有哪些實體頁面？"
- "wiki 的整體狀態怎麼樣？"
- "幫我更新這個實體的資訊"
- "幫我把這個檔案 ingest 到 wiki sources"
---

Detected "wiki management" intent. The user wants to search, read, create, update, or maintain pages in the memory wiki vault.

## Guidelines

- Do not manually `mv` wiki files between directories. Always use `openclaw wiki ingest` → `openclaw wiki compile` → `openclaw wiki lint`.
- Treat raw sources, memory artifacts, and daily notes as evidence. Do not let wiki pages become the only source of truth for new claims.
- Keep page identity stable. Favor updating existing entities and concepts over spawning duplicates.
- Keep generated sections inside managed markers (`<!-- openclaw:wiki:... -->`). Do not overwrite human note blocks.
- Use `[[Wikilinks]]` for internal vault connections, `[text](url)` for external URLs only.
- Avoid destructive renames unless you also have a link-repair plan.

## Response Strategy

- Check vault mode, path, page counts, and Obsidian CLI availability:
  wiki_status()

- One-pass recall across durable memory + compiled wiki:
  memory_search({ query: "<keywords>", corpus: "all", maxResults: 10 })

- Search wiki pages with wiki-specific ranking and provenance:
  wiki_search({ query: "<keywords>", corpus: "wiki", maxResults: 10 })

- Inspect exact wiki page content before editing or citing:
  wiki_get({ lookup: "<page_path_or_id>" })

- Create or update wiki synthesis / metadata:
  wiki_apply({ op: "create_synthesis", title: "<title>", body: "<content>", sourceIds: ["<source_id>"] })

- Lint wiki vault for contradictions, provenance gaps, open questions:
  wiki_lint()

- Ingest a local file into `sources/` (never manually move files):
  skill: exec (run `openclaw wiki ingest <path>`)

- Compile vault and refresh indexes:
  skill: exec (run `openclaw wiki compile`)

- Lint via CLI and review reports:
  skill: exec (run `openclaw wiki lint`)

- Probe Obsidian CLI status and helpers:
  skill: exec (run `openclaw wiki obsidian status`)

- Navigate a large wiki page by heading tree before editing:
  skill: treemd

- Inspect code or plugin implementation details within wiki context:
  skill: cx

- Search web for authoritative references to cite in wiki pages:
  web_search({ query: "<topic keywords>" })

- Fetch and extract content from an authoritative URL for wiki sourcing:
  web_fetch({ url: "<authoritative_url>" })
