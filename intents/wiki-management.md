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
- "wiki 有沒有需要整理或修補的頁面？"
---

Detected "wiki management" intent. The user wants to search, read, create, update, or maintain pages in the memory wiki vault.

## Core Principles

- **Sources are evidence, not truth**: Treat raw sources, memory artifacts, and daily notes as evidence. Do not let wiki pages become the only source of truth for new claims.
- **Page identity stability**: Keep page identity stable. Favor updating existing entities and concepts over spawning duplicates with slightly different names.
- **Managed markers**: Keep generated sections inside managed markers. Do not overwrite human note blocks.
- **No manual file moves**: Never manually `mv` wiki files between directories. Always use the proper CLI workflow (`ingest` → `compile` → `lint`).

## Standard Maintenance Loop

When creating, moving, or reorganizing wiki content, **always** follow this sequence:

```bash
openclaw wiki ingest <path>          # Ingest file into sources/
openclaw wiki compile                # Compile vault, update indexes
openclaw wiki lint                   # Surface contradictions, gaps, questions
```

- In **bridge mode**: run `openclaw wiki bridge import` before relying on search results if you need the latest public memory artifacts.
- In **unsafe-local mode**: use `openclaw wiki unsafe-local import` only when the user explicitly opted into private local path access.

## Obsidian Compatibility

- Confirm vault mode and Obsidian CLI availability via `openclaw wiki status` before shelling out.
- Use `openclaw wiki obsidian status` to probe the CLI before depending on it. Do not assume Obsidian is installed, running, or configured.
- Prefer dedicated helpers: `openclaw wiki obsidian search`, `openclaw wiki obsidian open`, `openclaw wiki obsidian command`, `openclaw wiki obsidian daily`.
- Use `[[Wikilinks]]` for internal vault connections, standard Markdown `[text](url)` for external URLs only.
- Preserve Obsidian-friendly wikilinks when creating or refreshing indexes.
- Use valid Obsidian frontmatter: `title`, `tags`, `aliases`, `cssclasses`.
- Use callouts (`> [!type]`), embeds (`![[note]]`), and comments (`%%hidden%%`) where appropriate.
- Avoid destructive renames unless you also have a link-repair plan.

## Tool Routing

### Query & Discovery
- **First pass (shared memory + wiki)**: `memory_search({ query: "...", corpus: "all" })` — one recall pass across durable memory plus compiled wiki.
- **Wiki-only discovery**: `wiki_search({ query: "...", corpus: "wiki" })` — wiki-specific ranking and provenance.
- **Read exact content**: `wiki_get({ lookup: "<page_path_or_id>" })` — always inspect before editing or citing.

### Mutation
- **Narrow synthesis/metadata**: `wiki_apply({ op: "create_synthesis", ... })` — for targeted updates when a tool-level mutation is enough.
- **New pages from files**: `openclaw wiki ingest <path>` — places content in `sources/` with proper naming.
- **Full vault compile**: `openclaw wiki compile` — regenerates indexes and compiled pages.
- **Health check**: `openclaw wiki lint` — surfaces contradictions, provenance gaps, open questions. Review reports under `reports/`.

### Status & Context
- **Vault state**: `wiki_status()` — vault mode, path, page counts, Obsidian CLI availability.
- **Large page surgery**: Use `treemd` skill to survey structure before reading or editing large files.

## Response Strategy

| User Goal | Action |
|---|---|
| Find pages | `memory_search` (corpus=all) → `wiki_search` → `wiki_get` |
| Create new content | `openclaw wiki ingest <path>` → `openclaw wiki compile` → `openclaw wiki lint` |
| Update existing page | `wiki_get` → edit within managed markers → `openclaw wiki lint` |
| Audit vault health | `wiki_lint` → review `reports/` |
| Check vault state | `wiki_status` |
| Obsidian operations | `openclaw wiki obsidian status` → dedicated helpers |
