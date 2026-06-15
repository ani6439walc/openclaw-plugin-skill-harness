# Duplication Analysis Report: intention-hint-plugin

## 1. Atomic JSON Write Pattern (HIGH PRIORITY)

### The canonical implementation: `evolution-backlog.ts` (lines 122-139)
```typescript
export function writeBacklogAtomic(backlogPath, backlog) {
  const parsed = EvolutionBacklogSchema.parse(backlog);
  const sessionsDir = path.dirname(backlogPath);
  const tempPath = `${backlogPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(parsed, null, 2));
    fs.renameSync(tempPath, backlogPath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}
```

### Duplicate in: `stats-aggregator.ts` private `write()` (lines 429-447)
```typescript
private write(statsPath: string, stats: Stats): boolean {
  const sessionsDir = path.dirname(statsPath);
  const tempPath = `${statsPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(stats, null, 2));
    fs.renameSync(tempPath, statsPath);
    return true;
  } catch (err) {
    logger.warn("failed to write stats file", { error: err, path: statsPath });
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    return false;
  }
}
```

**Verdict:** Identical atomic-write logic. `stats-aggregator.ts` should use `writeBacklogAtomic` (renamed to a generic `writeJsonAtomic`) from `evolution-backlog.ts`, or both should delegate to a shared `writeJsonAtomic(path, data)` utility.

### Related: `backlog-writer.ts` private `write()` (lines 110-121)
This wraps `writeBacklogAtomic` with try/catch + logger — the error-handling wrapper pattern is also duplicated with `stats-aggregator.ts`.

---

## 2. JSON Read + Parse Pattern

### `evolution-backlog.ts` (line 118-120):
```typescript
export function readBacklog(backlogPath: string): EvolutionBacklog {
  return parseBacklog(JSON.parse(fs.readFileSync(backlogPath, "utf-8")));
}
```

### `stats-aggregator.ts` (lines 278-279):
```typescript
stats = JSON.parse(fs.readFileSync(statsPath, "utf-8")) as Stats;
if (stats.schemaVersion !== 1 || !stats.summary || ...) {
  throw new Error("unsupported or invalid stats schema");
}
```

### `session-tracker.ts` (lines 167-168):
```typescript
const content = fs.readFileSync(filePath, "utf-8");
const sessionData: SessionData = JSON.parse(content);
```

**Verdict:** `readJSON(path) → parse → validate` is repeated. A shared `readJsonFile<T>(path)` helper would consolidate this.

---

## 3. pluginRoot Resolution + Default Instance (HIGH PRIORITY)

**Identical boilerplate in 4 files:**

| File | Lines | Default export |
|------|-------|----------------|
| `session-tracker.ts` | 398-401 | `defaultTracker` |
| `stats-aggregator.ts` | 450-452 | `defaultStatsAggregator` |
| `backlog-writer.ts` | 124-126 | `defaultBacklogWriter` |
| `intent-loader.ts` | 165-169 | `defaultCatalog` |

Each has:
```typescript
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(currentDir, "..", "..");
export const defaultX = X.create(pluginRoot);
```

**Verdict:** Extract to a single `src/paths.ts` (or `src/plugin-root.ts`) exporting `pluginRoot`, then each file just imports it.

---

## 4. mkdirSync("sessions", { recursive: true })

Used in 3 files to ensure the sessions directory exists:
- `evolution-backlog.ts` line 130
- `stats-aggregator.ts` line 433
- `session-tracker.ts` line 314

**Verdict:** Could be a shared `ensureSessionsDir(pluginRoot)` helper, or absorbed into a generic `writeJsonAtomic` that takes a `pluginRoot` + filename.

---

## 5. Error Handling + Logger Pattern

All three "writer" classes wrap file operations in identical try/catch + logger.warn + return-false:

**stats-aggregator.ts** (lines 420-426):
```typescript
} catch (err) {
  logger.warn("failed to update stats file", { error: err, path: statsPath });
  return false;
}
```

**backlog-writer.ts** (lines 101-107):
```typescript
} catch (err) {
  logger.warn("failed to update evolution backlog", { error: err, path: backlogPath });
  return false;
}
```

**session-tracker.ts** has 4 instances of this same pattern (lines 170, 345, 380, 387).

**Verdict:** A small helper like `tryOrLog(fn, label, ctx)` or just letting the atomic write propagate errors would reduce this.

---

## 6. Logger Import (LOW PRIORITY — shared module, not real duplication)

6 files import `logger` from `../api.js`:
- `session-tracker.ts`, `stats-aggregator.ts`, `backlog-writer.ts`, `conversation-extract.ts`, `review-queue.ts`, `intent-loader.ts`

This is not problematic duplication since it's a single shared export. No action needed.

---

## 7. fs/path/fileURLToPath Imports (LOW PRIORITY)

Nearly every file imports the same trio:
```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
```
Present in: `evolution-backlog.ts`, `session-tracker.ts`, `stats-aggregator.ts`, `backlog-writer.ts`, `backlog-cli.ts`, `intent-loader.ts`. Standard Node imports — not worth abstracting.

---

## Summary: Priority Refactoring Targets

| # | Pattern | Files affected | Recommendation |
|---|---------|---------------|----------------|
| 1 | Atomic JSON write | evolution-backlog.ts, stats-aggregator.ts | Extract `writeJsonAtomic(path, data)` to shared util |
| 2 | pluginRoot resolution | session-tracker.ts, stats-aggregator.ts, backlog-writer.ts, intent-loader.ts | Single `src/plugin-root.ts` module |
| 3 | try/catch + logger.warn + return false | stats-aggregator.ts, backlog-writer.ts, session-tracker.ts | Shared `safeWrite` wrapper or let errors propagate |
| 4 | mkdirSync sessions dir | evolution-backlog.ts, stats-aggregator.ts, session-tracker.ts | Absorb into `writeJsonAtomic` or `ensureSessionsDir` |
| 5 | JSON read + parse | evolution-backlog.ts, stats-aggregator.ts, session-tracker.ts | Shared `readJsonFile(path)` utility |
