import {
  fileExists,
  keywordCoverageLogPath,
  readJsonFile,
  safeWriteJson,
  withFileLock,
} from "../file-utils.js";
import {
  hashKeywordEventId,
  createKeywordCoverageLog,
  parseKeywordCoverageLog,
  pruneKeywordCoverageLog,
  type KeywordCoverageLog,
} from "./keyword-coverage-log.js";
import {
  normalizeKeywordList,
  type TriggerKeywordTarget,
  type ReviewTriggerKeywords,
} from "./trigger-keywords.js";

export type KeywordWriteResult =
  "applied" | "already-applied" | "retryable-failure";
const STALE_RESERVATION_MS = 24 * 60 * 60 * 1000;

export interface KeywordMutation {
  target: TriggerKeywordTarget;
  add: string[];
  remove: string[];
}

export interface KeywordEventInput {
  eventId: string;
  policy: "ordinary" | "coverage";
  targets: readonly TriggerKeywordTarget[];
  mutations: readonly KeywordMutation[];
  nowMs?: number;
  outcome?: "applied" | "nofinding";
}

export interface CoverageEpochReservation {
  epochKey: string;
  targets: readonly TriggerKeywordTarget[];
  acceptedTurn: number;
  nowMs?: number;
}

export interface CoverageEpochCompletion {
  epochKey: string;
  outcome: "applied" | "nofinding";
  nowMs?: number;
  nextCursors?: Partial<Record<TriggerKeywordTarget, number>>;
}

export interface KeywordCoverageRuntimeState {
  triggerKeywords: ReviewTriggerKeywords;
  targets: Partial<
    Record<
      TriggerKeywordTarget,
      { cursor: number; lastCompletedAcceptedTurn: number }
    >
  >;
}

export class KeywordCoverageWriter {
  constructor(private readonly dataRoot: string) {}

  readKeywords(): ReviewTriggerKeywords | undefined {
    return this.readRuntimeState()?.triggerKeywords;
  }

  readRuntimeState(): KeywordCoverageRuntimeState | undefined {
    const logPath = keywordCoverageLogPath(this.dataRoot);
    try {
      const log = fileExists(logPath)
        ? parseKeywordCoverageLog(readJsonFile<unknown>(logPath))
        : createKeywordCoverageLog(new Date().toISOString());
      const targets: KeywordCoverageRuntimeState["targets"] = {};
      for (const target of [
        "successful-pattern",
        "behavior-fix",
        "entity-context",
      ] as const) {
        const state = log.targets[target];
        targets[target] = {
          cursor: parseCursor(state?.cursor),
          lastCompletedAcceptedTurn: state?.lastCompletedAcceptedTurn ?? 0,
        };
      }
      return {
        triggerKeywords: log.triggerKeywords,
        targets,
      };
    } catch {
      return undefined;
    }
  }

  async recordKeywordEvent(
    input: KeywordEventInput,
  ): Promise<KeywordWriteResult> {
    if (!hasValidMutationLimits(input) || !hasValidMutationTargets(input)) {
      return "retryable-failure";
    }

    const logPath = keywordCoverageLogPath(this.dataRoot);
    const result = await withFileLock(logPath, async () => {
      const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
      let log;
      try {
        log = fileExists(logPath)
          ? parseKeywordCoverageLog(readJsonFile<unknown>(logPath))
          : createKeywordCoverageLog(nowIso);
      } catch {
        return "retryable-failure" as const;
      }
      const pruned = pruneKeywordCoverageLog(log, input.nowMs ?? Date.now());

      const eventHash = hashKeywordEventId(input.eventId);
      if (
        Object.prototype.hasOwnProperty.call(
          log.processedKeywordEvents,
          eventHash,
        )
      ) {
        return persistPrunedLog(logPath, log, pruned)
          ? ("already-applied" as const)
          : ("retryable-failure" as const);
      }

      for (const mutation of input.mutations) {
        const property = keywordProperty(mutation.target);
        const remove = normalizeKeywordList(mutation.remove, []);
        const removed = new Set(
          remove.map((keyword) => keyword.toLocaleLowerCase()),
        );
        const current = log.triggerKeywords[property].filter(
          (keyword) => !removed.has(keyword.toLocaleLowerCase()),
        );
        const additions = normalizeKeywordList(mutation.add, []).filter(
          (keyword) => !removed.has(keyword.toLocaleLowerCase()),
        );
        log.triggerKeywords[property] = normalizeKeywordList(
          [...current, ...additions],
          [],
        );
      }

      log.processedKeywordEvents[eventHash] = {
        processedAt: nowIso,
        targets: [...input.targets],
        outcome:
          input.outcome ??
          (input.mutations.length > 0 ? "applied" : "nofinding"),
        mutations: input.mutations.map((mutation) => ({
          target: mutation.target,
          add: normalizeKeywordList(mutation.add, []),
          remove: normalizeKeywordList(mutation.remove, []),
        })),
      };
      log.updatedAt = nowIso;
      return safeWriteJson(
        logPath,
        log,
        "failed to write keyword coverage state",
      )
        ? ("applied" as const)
        : ("retryable-failure" as const);
    });
    return result ?? "retryable-failure";
  }

  async reserveCoverageEpoch(
    input: CoverageEpochReservation,
  ): Promise<KeywordWriteResult> {
    if (!isOpaqueEpochKey(input.epochKey)) return "retryable-failure";
    const logPath = keywordCoverageLogPath(this.dataRoot);
    const result = await withFileLock(logPath, async () => {
      const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
      let log;
      try {
        log = fileExists(logPath)
          ? parseKeywordCoverageLog(readJsonFile<unknown>(logPath))
          : createKeywordCoverageLog(nowIso);
      } catch {
        return "retryable-failure" as const;
      }
      const pruned = pruneKeywordCoverageLog(log, input.nowMs ?? Date.now());
      const existing = log.coverageEpochs[input.epochKey];
      if (existing) {
        const ageMs =
          (input.nowMs ?? Date.now()) - Date.parse(existing.reservedAt);
        if (existing.outcome || ageMs < STALE_RESERVATION_MS) {
          return persistPrunedLog(logPath, log, pruned)
            ? ("already-applied" as const)
            : ("retryable-failure" as const);
        }
      }
      log.coverageEpochs[input.epochKey] = {
        reservedAt: nowIso,
        targets: [...input.targets],
        acceptedTurn: input.acceptedTurn,
      };
      log.updatedAt = nowIso;
      return safeWriteJson(
        logPath,
        log,
        "failed to reserve keyword coverage epoch",
      )
        ? ("applied" as const)
        : ("retryable-failure" as const);
    });
    return result ?? "retryable-failure";
  }

  async releaseCoverageEpoch(
    input: Pick<CoverageEpochReservation, "epochKey" | "nowMs">,
  ): Promise<KeywordWriteResult> {
    if (!isOpaqueEpochKey(input.epochKey)) return "retryable-failure";
    const logPath = keywordCoverageLogPath(this.dataRoot);
    const result = await withFileLock(logPath, async () => {
      try {
        if (!fileExists(logPath)) return "already-applied" as const;
        const log = parseKeywordCoverageLog(readJsonFile<unknown>(logPath));
        const pruned = pruneKeywordCoverageLog(log, input.nowMs ?? Date.now());
        if (
          !Object.prototype.hasOwnProperty.call(
            log.coverageEpochs,
            input.epochKey,
          )
        ) {
          return persistPrunedLog(logPath, log, pruned)
            ? ("already-applied" as const)
            : ("retryable-failure" as const);
        }
        if (log.coverageEpochs[input.epochKey].outcome) {
          return persistPrunedLog(logPath, log, pruned)
            ? ("already-applied" as const)
            : ("retryable-failure" as const);
        }
        delete log.coverageEpochs[input.epochKey];
        log.updatedAt = new Date(input.nowMs ?? Date.now()).toISOString();
        return safeWriteJson(
          logPath,
          log,
          "failed to release keyword coverage epoch",
        )
          ? ("applied" as const)
          : ("retryable-failure" as const);
      } catch {
        return "retryable-failure" as const;
      }
    });
    return result ?? "retryable-failure";
  }

  async completeCoverageEpoch(
    input: CoverageEpochCompletion,
  ): Promise<KeywordWriteResult> {
    if (!isOpaqueEpochKey(input.epochKey)) return "retryable-failure";
    const logPath = keywordCoverageLogPath(this.dataRoot);
    const result = await withFileLock(logPath, async () => {
      try {
        if (!fileExists(logPath)) return "retryable-failure" as const;
        const log = parseKeywordCoverageLog(readJsonFile<unknown>(logPath));
        const pruned = pruneKeywordCoverageLog(log, input.nowMs ?? Date.now());
        const epoch = log.coverageEpochs[input.epochKey];
        if (!epoch) {
          return persistPrunedLog(logPath, log, pruned)
            ? ("retryable-failure" as const)
            : ("retryable-failure" as const);
        }
        if (epoch.outcome) {
          return persistPrunedLog(logPath, log, pruned)
            ? ("already-applied" as const)
            : ("retryable-failure" as const);
        }

        epoch.outcome = input.outcome;
        epoch.completedAt = new Date(input.nowMs ?? Date.now()).toISOString();
        for (const target of epoch.targets) {
          const state = log.targets[target] ?? {};
          state.lastCompletedAcceptedTurn = Math.max(
            state.lastCompletedAcceptedTurn ?? 0,
            epoch.acceptedTurn,
          );
          const nextCursor = input.nextCursors?.[target];
          if (typeof nextCursor === "number" && Number.isFinite(nextCursor)) {
            state.cursor = String(Math.max(0, Math.floor(nextCursor)));
          }
          log.targets[target] = state;
        }
        log.updatedAt = new Date(input.nowMs ?? Date.now()).toISOString();
        return safeWriteJson(
          logPath,
          log,
          "failed to complete keyword coverage epoch",
        )
          ? ("applied" as const)
          : ("retryable-failure" as const);
      } catch {
        return "retryable-failure" as const;
      }
    });
    return result ?? "retryable-failure";
  }
}

function hasValidMutationLimits(input: KeywordEventInput): boolean {
  const limits =
    input.policy === "coverage"
      ? { maxAdditionsPerTarget: 1, maxRemovalsPerTarget: 1 }
      : { maxAdditionsPerTarget: 3, maxRemovalsPerTarget: 3 };
  const mutationsByTarget = new Map<
    TriggerKeywordTarget,
    { additions: number; removals: number }
  >();
  for (const mutation of input.mutations) {
    const current = mutationsByTarget.get(mutation.target) ?? {
      additions: 0,
      removals: 0,
    };
    current.additions += normalizeKeywordList(mutation.add, []).length;
    current.removals += normalizeKeywordList(mutation.remove, []).length;
    mutationsByTarget.set(mutation.target, current);
  }
  return [...mutationsByTarget.values()].every(
    ({ additions, removals }) =>
      additions <= limits.maxAdditionsPerTarget &&
      removals <= limits.maxRemovalsPerTarget,
  );
}

function hasMutationConflict(input: KeywordEventInput): boolean {
  const additionsByTarget = new Map<TriggerKeywordTarget, Set<string>>();
  const removalsByTarget = new Map<TriggerKeywordTarget, Set<string>>();
  for (const mutation of input.mutations) {
    const additions = additionsByTarget.get(mutation.target) ?? new Set();
    const removals = removalsByTarget.get(mutation.target) ?? new Set();
    normalizeKeywordList(mutation.add, []).forEach((keyword) =>
      additions.add(keyword.toLocaleLowerCase()),
    );
    normalizeKeywordList(mutation.remove, []).forEach((keyword) =>
      removals.add(keyword.toLocaleLowerCase()),
    );
    additionsByTarget.set(mutation.target, additions);
    removalsByTarget.set(mutation.target, removals);
  }
  return [...additionsByTarget].some(([target, additions]) =>
    [...(removalsByTarget.get(target) ?? [])].some((keyword) =>
      additions.has(keyword),
    ),
  );
}

function hasValidMutationTargets(input: KeywordEventInput): boolean {
  const targets = new Set(input.targets);
  return (
    input.mutations.every((mutation) => targets.has(mutation.target)) &&
    !hasMutationConflict(input)
  );
}

function isOpaqueEpochKey(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function persistPrunedLog(
  logPath: string,
  log: KeywordCoverageLog,
  pruned: boolean,
): boolean {
  return (
    !pruned ||
    safeWriteJson(
      logPath,
      log,
      "failed to persist pruned keyword coverage state",
    )
  );
}

function keywordProperty(
  target: TriggerKeywordTarget,
): keyof ReviewTriggerKeywords {
  switch (target) {
    case "successful-pattern":
      return "successfulPattern";
    case "behavior-fix":
      return "behaviorFix";
    case "entity-context":
      return "entityContext";
  }
}

function parseCursor(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
