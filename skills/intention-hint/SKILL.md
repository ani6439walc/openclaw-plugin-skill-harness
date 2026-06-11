---
name: intention-hint
description: "Manage the intention-hint plugin's intent system. Use when designing or refining intent definitions, auditing the catalog, or explicitly processing a Self-Evolution backlog finding."
---

Manage intent definitions and Self-Evolution findings for the intention-hint
plugin.
Three modes — pick based on user request scope.

## Mode: single

User wants to create, rename, split, merge, or refine **one** intent.

Read order:

1. `references/interview.md`
2. `references/format-rules.md`
3. `references/closing.md`

Then follow the 5-step workflow: classify → interview → ground → draft → deliver.

## Mode: audit

User wants to bootstrap or re-audit the entire intent system (first install or after many new skills/tools).

Read order:

1. `references/discovery.md`
2. `references/clustering.md`
3. `references/interview.md`
4. `references/format-rules.md`
5. `references/closing.md`

Then follow: discovery → clustering → interview → generate → review.

## Mode: backlog

Use only when the user explicitly asks to process an Intent Self-Evolution
backlog finding. Process exactly one pending finding per invocation.

Read order:

1. `references/process-backlog.md`
2. `references/format-rules.md`
3. Other single/audit references only when the selected finding requires them

Then follow the transactional workflow in `references/process-backlog.md`.
Never enter this mode merely because `sessions/evolution.json` contains pending
items.

## First-time setup (assets)

When bootstrapping from scratch, copy example intent templates from `assets/` as starting points:

- `assets/chat.md` / `assets/typo.md` — minimal behavior-only intents (no tools)
- `assets/memory-lookup.md` / `assets/memory-compare.md` / `assets/memory-timeline.md` — memory retrieval SOPs
- `assets/summarization.md` / `assets/research-general.md` — multi-source routing patterns

These are English example templates. Adapt to the project's language and intent scope.

## Decision style

- Recommend defaults confidently; keep cognitive load low.
- Favor simple, maintainable intent boundaries over clever taxonomy.

## Failure modes (如果 X 失敗 → Y)

| 觸發條件 | 一線修復 | 仍失敗兜底 |
|----------|----------|------------|
| **Interview 卡住**：使用者不回覆或回覆模糊 | 重述問題，給出推薦選項（"A 或 B？"） | 記錄為 `incomplete`，建議稍後繼續 |
| **Discovery 掃描失敗**：skills 目錄不存在或為空 | 檢查路徑，提示使用者確認 skills 位置 | 手動輸入 capabilities 清單，標記 `manual_input` |
| **Clustering 發現 orphan capabilities** | 標記為 `unclustered`，建議建立新 intent | 保留 orphan 清單，下次 audit 再處理 |
| **Closing collision warning**：新 intent 與現有重疊 | 建議 split 或 merge，展示 collision 細節 | 強制建立但標記 `experimental`，下次 review 時檢查 |
| **format-rules.md 驗證失敗** | 讀取錯誤訊息，修正格式後重試 | 展示完整 format-rules.md 讓使用者手動檢查 |
| **Backlog finding 已被處理** | 跳過，標記 `already_processed` | 檢查 sessions/evolution.json 狀態 |

## Anti-patterns (不要做的事)

| # | 反模式 | 為什麼不要做 | 替代做法 |
|---|--------|-------------|---------|
| 1 | **一次問多個問題** | 使用者會困惑，回覆品質下降 | interview.md 明確規定一次只問一個 |
| 2 | **在 intent body 裡 cross-reference 其他 intents** | classification sub-agent 只看到 triggers/examples，會造成循環依賴 | 用 triggers 和 examples 表達邊界，不提其他 intent 的 id/name |
| 3 | **跳過 format-rules.md 直接寫 intent** | 格式不一致會導致 plugin 解析失敗 | 每次寫 intent 前必須讀 format-rules.md |
| 4 | **在沒有 discovery/clustering 的情況下做 audit** | 會漏掉 capabilities，產生 orphan intents | audit mode 必須按順序：discovery → clustering → interview |
| 5 | **backlog mode 一次處理多個 findings** | 會混淆上下文，難以追蹤哪個 finding 被處理了 | 每次 invocation 只處理一個 pending finding |
| 6 | **跳過 validation 直接 commit** | 可能引入格式錯誤或 collision | closing.md 有 safety checks，必須執行 |
| 7 | **為已存在的 intent 建立新的** | 會造成重複和 collision | interview 階段先檢查現有 intents |
| 8 | **用模糊的 description 當 trigger** | classification 無法準確匹配 | triggers 必須是具體的短語或關鍵字 |
