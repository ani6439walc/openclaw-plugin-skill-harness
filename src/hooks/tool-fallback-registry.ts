import type { ToolResultFallback } from "../session/index.js";
import type { SkillRecord } from "../session/tracker.js";
import type { TurnAssociation } from "./turn-associations.js";

export interface StagedToolFallback {
  association: TurnAssociation;
  fallback: ToolResultFallback;
  skillUsed?: SkillRecord;
}

interface FallbackEntry {
  payload?: StagedToolFallback;
  ownerSessionIds: Set<string>;
  state: "active" | "terminal" | "ambiguous";
  touchedAt: number;
}

export type StageToolFallbackResult =
  "staged" | "ambiguous" | "full" | "invalid";

function normalizeKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function sameAssociation(
  left: TurnAssociation | undefined,
  right: TurnAssociation,
): boolean {
  return left?.sessionId === right.sessionId && left.turnKey === right.turnKey;
}

export class ToolFallbackRegistry {
  private readonly entries = new Map<string, FallbackEntry>();
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;

  constructor(
    options: {
      maxEntries?: number;
      idleTtlMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.maxEntries = options.maxEntries ?? 256;
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  stage(
    toolCallId: string | undefined,
    payload: StagedToolFallback,
  ): StageToolFallbackResult {
    const key = normalizeKey(toolCallId);
    if (!key) return "invalid";
    const now = this.now();
    this.prune(now);
    const existing = this.entries.get(key);

    if (existing) {
      existing.touchedAt = now;
      existing.ownerSessionIds.add(payload.association.sessionId);
      if (
        existing.state !== "ambiguous" &&
        sameAssociation(existing.payload?.association, payload.association)
      ) {
        existing.payload = {
          ...payload,
          association: { ...payload.association },
        };
        return "staged";
      }
      existing.state = "ambiguous";
      delete existing.payload;
      return "ambiguous";
    }

    if (this.entries.size >= this.maxEntries && !this.evictOldestEligible()) {
      return "full";
    }
    this.entries.set(key, {
      payload: {
        ...payload,
        association: { ...payload.association },
      },
      ownerSessionIds: new Set([payload.association.sessionId]),
      state: "active",
      touchedAt: now,
    });
    return "staged";
  }

  get(toolCallId: string | undefined): StagedToolFallback | undefined {
    const key = normalizeKey(toolCallId);
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry?.payload || entry.state === "ambiguous") return;
    entry.touchedAt = this.now();
    return {
      ...entry.payload,
      association: { ...entry.payload.association },
    };
  }

  listForAssociation(
    association: TurnAssociation,
  ): Array<[string, StagedToolFallback]> {
    const matches: Array<[string, StagedToolFallback]> = [];
    for (const [key, entry] of this.entries) {
      if (
        entry.state === "ambiguous" ||
        !entry.payload ||
        !sameAssociation(entry.payload.association, association)
      ) {
        continue;
      }
      entry.touchedAt = this.now();
      matches.push([
        key,
        {
          ...entry.payload,
          association: { ...entry.payload.association },
        },
      ]);
    }
    return matches;
  }

  delete(toolCallId: string | undefined): void {
    const key = normalizeKey(toolCallId);
    if (key) this.entries.delete(key);
  }

  markAssociationTerminal(association: TurnAssociation): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (sameAssociation(entry.payload?.association, association)) {
        entry.state = "terminal";
        entry.touchedAt = now;
      }
    }
  }

  removeSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.ownerSessionIds.has(sessionId)) this.entries.delete(key);
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (
        (entry.state === "terminal" || entry.state === "ambiguous") &&
        now - entry.touchedAt > this.idleTtlMs
      ) {
        this.entries.delete(key);
      }
    }
  }

  private evictOldestEligible(): boolean {
    let oldest: { key: string; touchedAt: number } | undefined;
    for (const [key, entry] of this.entries) {
      if (entry.state !== "terminal" && entry.state !== "ambiguous") continue;
      if (!oldest || entry.touchedAt < oldest.touchedAt) {
        oldest = { key, touchedAt: entry.touchedAt };
      }
    }
    if (!oldest) return false;
    this.entries.delete(oldest.key);
    return true;
  }
}
