# Agent Guide — Intention Hint Plugin

An OpenClaw plugin that pre-scans user intent before replies and injects routing hints via `before_prompt_build` hook.

## Commands

```bash
pnpm run typecheck        # Type check without emitting
pnpm run test:unit        # Run tests
pnpm run test             # Type check + tests
pnpm run format           # Format with prettier
pnpm run backlog -- <cmd> # Run evolution backlog CLI
```

## Project Structure

```
src/
├── plugin.ts              # Plugin entry, registers hooks
├── hooks.ts               # Event handlers (prompt building, tracking, cleanup)
├── subagent.ts            # Intent classification sub-agent
├── intent-loader.ts       # Loads intent .md files from intentsDir
├── file-utils.ts          # Shared filesystem helpers (atomic I/O, path resolution)
├── constants.ts           # Default config values, fallback intent, prompt constants
├── session-tracker.ts     # Session persistence (sessions/<id>.json)
├── stats-aggregator.ts    # Runtime usage stats (sessions/stats.json)
├── trigger-checker.ts     # Detects 6 Self-Evolution triggers
├── review-subagent.ts     # Builds review prompts, runs tool-free review
├── review-queue.ts        # Serializes background evolution reviews
├── backlog-writer.ts      # Merges findings into sessions/evolution.json
├── evolution-backlog.ts   # Schema validation, atomic mutations
├── backlog-cli.ts         # CLI for backlog management
├── intent-validation.ts   # Validates intent markdown structure
├── conversation-extract.ts # Truncates conversation history
├── prompt.ts              # Builds classification prompt, parses JSON
├── session.ts             # Session eligibility guards
├── config.ts              # Zod schema validation
├── types.ts               # Core type definitions
└── evolution-types.ts     # Evolution-specific types

intents/                   # Intent definitions (YAML frontmatter .md files)
skills/                    # Plugin skills
dist/                      # Compiled output
```

> 架構圖、模組職責、Hook 流程、配置說明詳見 [README.md](./README.md)

## Code Style & Patterns

### Atomic File I/O

**所有 JSON 寫入都必須使用 `file-utils.ts`：**

```typescript
import { writeJsonAtomic, safeWriteJson, readJsonFile, fileExists } from './file-utils.js';

// 原子寫入（temp file + rename）
writeJsonAtomic(path, data);

// 帶錯誤日誌的寫入（fire-and-forget）
safeWriteJson(path, data, 'Failed to write session data');

// 讀取 JSON
const data = readJsonFile<MyType>(path);

// 檢查檔案存在
if (fileExists(path)) { ... }
```

**禁止直接使用 `fs.readFileSync` + `JSON.parse` 或 `fs.writeFileSync` + `JSON.stringify`**

### Module Structure

每個模組遵循以下模式：

1. **匯出 class + default singleton**
   ```typescript
   export class SessionTracker { ... }
   export const defaultTracker = SessionTracker.create(pluginRoot);
   ```

2. **Class 接受 `pluginRoot: string` 作為建構參數**

3. **使用 `.js` 副檔名進行 ESM import**
   ```typescript
   import { logger } from '../api.js';
   import { fileUtils } from './file-utils.js';
   ```

### Error Handling

- 使用 `logger.warn()` 記錄非致命錯誤
- 錯誤處理模式：**fail-open**（記錄錯誤但不阻斷主流程）
- Stats 和 Evolution 寫入失敗時記錄日誌但不影響使用者體驗

### TypeScript Conventions

- **Strict mode** 啟用
- 偏好 `interface` 定義物件結構
- 使用 `type` 定義 union 和複雜型別
- Import 型別使用 `import type { ... }`
- 避免使用 `any`，必要時用 `unknown` + type guard

### Testing

- 測試檔案與原始碼共置：`module.ts` → `module.test.ts`
- 使用 Vitest
- Mock 外部依賴（OpenClaw API、filesystem）
- **提交前必須跑 `pnpm run test`，所有測試必須通過**

```bash
pnpm run test              # 全部測試
pnpm run test:unit         # 只跑單元測試
pnpm run test -- --watch   # Watch 模式
```

## Protected Files

這些檔案**不會**被 session cleanup 或 retention 刪除：
- `sessions/stats.json` — 聚合統計
- `sessions/evolution.json` — Self-Evolution backlog

## Adding a New Intent

1. 建立 `intents/<intent-id>.md`，包含 YAML frontmatter：
   ```markdown
   ---
   id: my-intent
   name: My Intent
   description: What this intent detects
   examples:
     - "example user message 1"
     - "example user message 2"
   ---
   
   # Intent Instructions
   
   How to handle this intent...
   ```

2. 重啟 plugin — `intent-loader` 會自動載入
3. 大部分 intents 不需要修改程式碼

## Upgrading OpenClaw Dependency

升級 OpenClaw 版本時（例如 2026.6.5 → 2026.6.6）：

### 1. 更新 package.json 版本號

替換所有 `2026.6.5` 為 `2026.6.6`：

- `version` — Plugin 版本
- `openclaw.compat.pluginApi` — 最低相容 plugin API 版本（帶 `>=` 前綴）
- `openclaw.compat.minGatewayVersion` — 最低 gateway 版本
- `openclaw.build.openclawVersion` — Build target OpenClaw 版本
- `openclaw.build.pluginSdkVersion` — Plugin SDK 版本
- `peerDependencies.openclaw` — Peer dependency 版本

### 2. 清除並重新安裝依賴

```bash
rm -rf node_modules dist
pnpm i
```

### 3. 移除 pnpm-workspace.yaml 的舊版本限制

如果有 `minimumReleaseAgeExclude` 指向舊版本，刪除該行：

```yaml
# 刪除類似這行：
minimumReleaseAgeExclude:
  - openclaw@2026.6.5
```

### 4. 提交並推送

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "chore: bump openclaw to 2026.6.6"
git push origin main
```

### 5. 發布到 ClawhHub

```bash
clawhub package publish . --family code-plugin
```
