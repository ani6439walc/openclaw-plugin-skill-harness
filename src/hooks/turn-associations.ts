import { randomUUID } from "node:crypto";

export interface TurnAssociation {
  sessionId: string;
  sessionKey?: string;
  turnKey: string;
}

interface AssociationEntry {
  association?: TurnAssociation;
  state: "reserved" | "active" | "terminal" | "ambiguous";
  touchedAt: number;
  token?: string;
}

type ReservationResult =
  | { status: "reserved"; token: string }
  | { status: "existing"; association: TurnAssociation }
  | { status: "full" }
  | { status: "invalid" }
  | { status: "ambiguous" };

export function normalizeTurnAssociationKey(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function sameTurnAssociation(
  left: TurnAssociation | undefined,
  right: TurnAssociation,
): boolean {
  return left?.sessionId === right.sessionId && left.turnKey === right.turnKey;
}

export class TurnAssociationRegistry {
  private readonly entries = new Map<string, AssociationEntry>();
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
    this.maxEntries = options.maxEntries ?? 1024;
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  reserve(runId: string | undefined): ReservationResult {
    const key = normalizeTurnAssociationKey(runId);
    if (!key) return { status: "invalid" };
    const now = this.now();
    this.prune(now);
    const existing = this.entries.get(key);
    if (existing?.state === "active") {
      existing.touchedAt = now;
      return existing.association
        ? { status: "existing", association: { ...existing.association } }
        : { status: "ambiguous" };
    }
    if (existing?.state === "terminal") {
      existing.state = "ambiguous";
      existing.touchedAt = now;
      delete existing.association;
      delete existing.token;
      return { status: "ambiguous" };
    }
    if (existing?.state === "reserved") return { status: "ambiguous" };
    if (existing?.state === "ambiguous") return { status: "ambiguous" };
    if (this.entries.size >= this.maxEntries && !this.evictOldestEligible()) {
      return { status: "full" };
    }

    const token = randomUUID();
    this.entries.set(key, {
      state: "reserved",
      touchedAt: now,
      token,
    });
    return { status: "reserved", token };
  }

  reserveAnonymous(): Extract<
    ReservationResult,
    { status: "reserved" | "full" }
  > {
    const now = this.now();
    this.prune(now);
    if (this.entries.size >= this.maxEntries && !this.evictOldestEligible()) {
      return { status: "full" };
    }
    const token = randomUUID();
    this.entries.set(`anonymous:${token}`, {
      state: "reserved",
      touchedAt: now,
      token,
    });
    return { status: "reserved", token };
  }

  bind(
    token: string,
    runId: string | undefined,
    association: TurnAssociation,
  ): "bound" | "ambiguous" | "stale" {
    const key = normalizeTurnAssociationKey(runId);
    if (!key) return "stale";
    const entry = this.entries.get(key);
    if (!entry || entry.state !== "reserved" || entry.token !== token) {
      return this.bindExisting(key, association);
    }
    entry.state = "active";
    entry.association = { ...association };
    entry.touchedAt = this.now();
    delete entry.token;
    return "bound";
  }

  bindAnonymous(
    token: string,
    association: TurnAssociation,
  ): "bound" | "stale" {
    const key = `anonymous:${token}`;
    const entry = this.entries.get(key);
    if (!entry || entry.state !== "reserved" || entry.token !== token) {
      return "stale";
    }
    const duplicate = [...this.entries.entries()].find(
      ([candidateKey, candidate]) =>
        candidateKey !== key &&
        (candidate.state === "active" || candidate.state === "terminal") &&
        sameTurnAssociation(candidate.association, association),
    );
    if (duplicate) {
      duplicate[1].touchedAt = this.now();
      this.entries.delete(key);
      return "bound";
    }
    entry.state = "active";
    entry.association = { ...association };
    entry.touchedAt = this.now();
    delete entry.token;
    return "bound";
  }

  bindExisting(
    runId: string | undefined,
    association: TurnAssociation,
  ): "bound" | "ambiguous" | "stale" {
    const key = normalizeTurnAssociationKey(runId);
    if (!key) return "stale";
    const entry = this.entries.get(key);
    if (!entry) return "stale";
    if (sameTurnAssociation(entry.association, association)) {
      entry.touchedAt = this.now();
      return "bound";
    }
    entry.state = "ambiguous";
    entry.touchedAt = this.now();
    delete entry.association;
    delete entry.token;
    return "ambiguous";
  }

  release(token: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.state === "reserved" && entry.token === token) {
        this.entries.delete(key);
        return;
      }
    }
  }

  resolve(runId: string | undefined): TurnAssociation | undefined {
    const key = normalizeTurnAssociationKey(runId);
    if (!key) return;
    const entry = this.entries.get(key);
    if (entry?.state !== "active" || !entry.association) return;
    entry.touchedAt = this.now();
    return { ...entry.association };
  }

  resolveAnonymousSession(
    sessionIdentity: string | undefined,
  ): TurnAssociation | undefined {
    const normalizedSessionIdentity = sessionIdentity?.trim();
    if (!normalizedSessionIdentity) return;
    const distinct = new Map<string, TurnAssociation>();
    for (const [key, entry] of this.entries) {
      if (!key.startsWith("anonymous:")) continue;
      const association = entry.association;
      if (
        entry.state !== "active" ||
        !association ||
        (association.sessionId !== normalizedSessionIdentity &&
          association.sessionKey !== normalizedSessionIdentity)
      ) {
        continue;
      }
      distinct.set(
        `${association.sessionId}\u0000${association.turnKey}`,
        association,
      );
    }
    if (distinct.size !== 1) return;
    const association = [...distinct.values()][0];
    for (const entry of this.entries.values()) {
      if (sameTurnAssociation(entry.association, association)) {
        entry.touchedAt = this.now();
      }
    }
    return { ...association };
  }

  resolveSession(
    sessionIdentity: string | undefined,
  ): TurnAssociation | undefined {
    const normalizedSessionIdentity = sessionIdentity?.trim();
    if (!normalizedSessionIdentity) return;
    const distinct = new Map<string, TurnAssociation>();
    for (const entry of this.entries.values()) {
      const association = entry.association;
      if (
        entry.state !== "active" ||
        !association ||
        (association.sessionId !== normalizedSessionIdentity &&
          association.sessionKey !== normalizedSessionIdentity)
      ) {
        continue;
      }
      distinct.set(
        `${association.sessionId}\u0000${association.turnKey}`,
        association,
      );
    }
    if (distinct.size !== 1) return;
    const association = [...distinct.values()][0];
    for (const entry of this.entries.values()) {
      if (sameTurnAssociation(entry.association, association)) {
        entry.touchedAt = this.now();
      }
    }
    return { ...association };
  }

  markTerminal(runId: string | undefined, association: TurnAssociation): void {
    const key = normalizeTurnAssociationKey(runId);
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry || !sameTurnAssociation(entry.association, association)) return;
    entry.state = "terminal";
    entry.touchedAt = this.now();
  }

  markAssociationTerminal(association: TurnAssociation): void {
    for (const entry of this.entries.values()) {
      if (sameTurnAssociation(entry.association, association)) {
        entry.state = "terminal";
        entry.touchedAt = this.now();
      }
    }
  }

  removeSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.association?.sessionId === sessionId) this.entries.delete(key);
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
