---
id: WIKI_MANAGEMENT
name: Wiki Management & Query
triggers:
- "User is asking to search, read, create, update, or maintain wiki pages in the memory wiki vault (wiki/) — including status checks, linting, structural maintenance, and Obsidian compatibility"
- "User wants to query wiki entities, concepts, syntheses, or reports, or ingest/reorganize wiki sources"
examples:
- "搜尋 wiki 裡有沒有關於 Kubernetes 的記錄"
- "幫我建立一個新的 wiki 頁面記錄這個專案"
- "檢查 wiki 有沒有矛盾或問題"
- "wiki 的整體狀態怎麼樣？"
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

- Ingest a local file into `sources/`, compile vault, lint for issues (never manually move files):
  skill: wiki-maintainer

- Probe Obsidian CLI status and use Obsidian helpers (`status`, `search`, `open`, `daily`):
  skill: obsidian-vault-maintainer

- Navigate a large wiki page by heading tree before editing:
  skill: treemd

- Inspect code or plugin implementation details within wiki context:
  skill: cx

- Search web for authoritative references to cite in wiki pages:
  web_search({ query: "<topic keywords>" })

- Fetch and extract content from an authoritative URL for wiki sourcing:
  web_fetch({ url: "<authoritative_url>" })
