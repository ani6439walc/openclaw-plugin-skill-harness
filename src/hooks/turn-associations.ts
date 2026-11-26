import { randomUUID } from "node:crypto";

export interface TurnAssociation {
  readonly finalized?: true;
  sessionId: string;
  sessionKey?: string;
  turnKey: string;
}

export const SESSION_KEY_PRIORITY = {
  none: 0,
  persisted: 1,
  sdk: 2,
  host: 3,
} as const;

export interface SessionKeyVersion {
  sessionKeyPriority?: (typeof SESSION_KEY_PRIORITY)[keyof typeof SESSION_KEY_PRIORITY];
  sessionKeySeq?: number;
}

interface AssociationEntry extends SessionKeyVersion {
  association?: TurnAssociation;
  state:
    "reserved" | "pending" | "active" | "superseded" | "terminal" | "ambiguous";
  touchedAt: number;
  token?: string;
  ownerToken?: object;
  sessionId?: string;
  sessionKey?: string;
  inFlight?: boolean;
  anonymous?: boolean;
  nativeFence?: boolean;
  nativeBudget?: boolean;
  pinnedAnonymousRun?: boolean;
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

export function canUpdateSessionKey(
  current: SessionKeyVersion,
  incoming: SessionKeyVersion,
): boolean {
  const currentPriority =
    current.sessionKeyPriority ?? SESSION_KEY_PRIORITY.none;
  const incomingPriority =
    incoming.sessionKeyPriority ?? SESSION_KEY_PRIORITY.none;
  return (
    incomingPriority > currentPriority ||
    (incomingPriority === currentPriority &&
      (incoming.sessionKeySeq ?? 0) >= (current.sessionKeySeq ?? 0))
  );
}

const persistedSessionKey: SessionKeyVersion = {
  sessionKeyPriority: SESSION_KEY_PRIORITY.persisted,
};

export class TurnAssociationRegistry {
  private readonly entries = new Map<string, AssociationEntry>();
  private readonly maxEntries: number;
  private readonly maxNativeEntries: number;
  private nativeEntries = 0;
  private allowUnknownRunFallback = true;
  private readonly idleTtlMs: number;
  private readonly now: () => number;

  constructor(
    options: {
      maxEntries?: number;
      maxNativeEntries?: number;
      idleTtlMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.maxEntries = options.maxEntries ?? 1024;
    this.maxNativeEntries = options.maxNativeEntries ?? 16_384;
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  get unknownRunFallbackEnabled(): boolean {
    return this.allowUnknownRunFallback;
  }

  claimNativeRun(
    runId: string | undefined,
    ownerToken: object,
    sessionId?: string,
    sessionKey?: string,
    expectedAssociation?: TurnAssociation,
    keyVersion: SessionKeyVersion = persistedSessionKey,
  ): "claimed" | "same-owner" | "blocked" {
    const key = normalizeTurnAssociationKey(runId);
    if (!key) return "blocked";
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.nativeFence && existing.ownerToken === ownerToken) {
        if (existing.state === "pending")
          this.updateSessionKey(existing, sessionKey, keyVersion);
        return existing.state === "ambiguous" ? "blocked" : "same-owner";
      }
      if (
        existing.pinnedAnonymousRun &&
        !existing.nativeFence &&
        (existing.state === "active" || existing.state === "terminal") &&
        expectedAssociation &&
        sameTurnAssociation(existing.association, expectedAssociation)
      ) {
        existing.nativeFence = true;
        existing.ownerToken = ownerToken;
        existing.sessionId = expectedAssociation.sessionId;
        existing.inFlight = existing.state === "active";
        this.updateSessionKey(
          existing,
          existing.association?.sessionKey,
          persistedSessionKey,
        );
        this.updateSessionKey(existing, sessionKey, keyVersion);
        existing.touchedAt = this.now();
        return "same-owner";
      }
      const previousSessionId = existing.nativeFence
        ? existing.sessionId
        : existing.association?.sessionId;
      existing.sessionId =
        previousSessionId && previousSessionId === sessionId
          ? previousSessionId
          : undefined;
      existing.nativeFence = true;
      existing.state = "ambiguous";
      existing.inFlight = false;
      existing.touchedAt = this.now();
      delete existing.association;
      delete existing.token;
      delete existing.ownerToken;
      if (this.nativeEntries >= this.maxNativeEntries) {
        this.allowUnknownRunFallback = false;
      }
      return "blocked";
    }
    if (this.nativeEntries >= this.maxNativeEntries) {
      this.allowUnknownRunFallback = false;
      return "blocked";
    }
    const entry: AssociationEntry = {
      state: "pending",
      ownerToken,
      sessionId,
      inFlight: true,
      nativeFence: true,
      nativeBudget: true,
      touchedAt: this.now(),
    };
    this.updateSessionKey(entry, sessionKey, keyVersion);
    this.entries.set(key, entry);
    this.nativeEntries += 1;
    return "claimed";
  }

  bindNativeRun(
    runId: string | undefined,
    ownerToken: object,
    association: TurnAssociation,
    keyVersion: SessionKeyVersion = persistedSessionKey,
  ): "bound" | "ambiguous" | "stale" {
    const key = normalizeTurnAssociationKey(runId);
    if (!key) return "stale";
    const entry = this.entries.get(key);
    if (!entry?.nativeFence) return "stale";
    if (entry.state === "ambiguous") return "ambiguous";
    if (entry.ownerToken !== ownerToken || entry.state === "terminal") {
      return "stale";
    }
    if (
      entry.state === "active" &&
      !sameTurnAssociation(entry.association, association)
    ) {
      entry.sessionId =
        entry.sessionId === association.sessionId ? entry.sessionId : undefined;
      entry.state = "ambiguous";
      entry.inFlight = false;
      delete entry.association;
      delete entry.ownerToken;
      return "ambiguous";
    }
    if (entry.state !== "pending" && entry.state !== "active") return "stale";
    entry.state = "active";
    entry.sessionId = association.sessionId;
    this.updateSessionKey(entry, association.sessionKey, keyVersion);
    entry.association = { ...association, sessionKey: entry.sessionKey };
    entry.touchedAt = this.now();
    return "bound";
  }

  updatePendingNativeRunSessionKey(
    runId: string | undefined,
    ownerToken: object,
    sessionKey: string | undefined,
    keyVersion: SessionKeyVersion,
  ): void {
    const key = normalizeTurnAssociationKey(runId);
    const entry = key ? this.entries.get(key) : undefined;
    if (entry?.state === "pending" && entry.ownerToken === ownerToken)
      this.updateSessionKey(entry, sessionKey, keyVersion);
  }

  private updateSessionKey(
    entry: AssociationEntry,
    key: string | undefined,
    version: SessionKeyVersion,
  ): void {
    const sessionKey = normalizeTurnAssociationKey(key);
    if (
      !sessionKey ||
      (entry.sessionKey && !canUpdateSessionKey(entry, version))
    )
      return;
    entry.sessionKey = sessionKey;
    entry.sessionKeyPriority = version.sessionKeyPriority;
    entry.sessionKeySeq = version.sessionKeySeq;
    if (entry.association) entry.association.sessionKey = sessionKey;
  }

  reserve(runId: string | undefined): ReservationResult {
    const key = normalizeTurnAssociationKey(runId);
    if (!key) return { status: "invalid" };
    const now = this.now();
    this.prune(now);
    const existing = this.entries.get(key);
    if (existing?.nativeFence) return { status: "ambiguous" };
    if (existing?.state === "active") {
      existing.touchedAt = now;
      return existing.association
        ? { status: "existing", association: { ...existing.association } }
        : { status: "ambiguous" };
    }
    if (existing?.state === "terminal") {
      if (existing.pinnedAnonymousRun) return { status: "ambiguous" };
      existing.state = "ambiguous";
      existing.touchedAt = now;
      delete existing.association;
      delete existing.token;
      return { status: "ambiguous" };
    }
    if (existing?.state === "reserved") return { status: "ambiguous" };
    if (existing?.state === "ambiguous") return { status: "ambiguous" };
    if (
      this.entries.size - this.nativeEntries >= this.maxEntries &&
      !this.evictOldestEligible()
    ) {
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
    if (
      this.entries.size - this.nativeEntries >= this.maxEntries &&
      !this.evictOldestEligible()
    ) {
      return { status: "full" };
    }
    const token = randomUUID();
    this.entries.set(`anonymous:${token}`, {
      anonymous: true,
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
    if (entry?.nativeFence) return "ambiguous";
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
    if (
      !entry?.anonymous ||
      entry.state !== "reserved" ||
      entry.token !== token
    ) {
      return "stale";
    }
    const duplicate = [...this.entries.entries()].find(
      ([candidateKey, candidate]) =>
        candidateKey !== key &&
        !candidate.nativeFence &&
        (candidate.state === "active" ||
          candidate.state === "superseded" ||
          candidate.state === "terminal") &&
        sameTurnAssociation(candidate.association, association),
    );
    if (duplicate) {
      duplicate[1].touchedAt = this.now();
      this.entries.delete(key);
      return "bound";
    }
    const now = this.now();
    if (!association.finalized) {
      for (const candidate of this.entries.values()) {
        if (
          candidate.anonymous &&
          !candidate.nativeFence &&
          candidate.state === "active" &&
          candidate.association?.sessionId === association.sessionId &&
          candidate.association.turnKey !== association.turnKey
        ) {
          candidate.state = "superseded";
          candidate.touchedAt = now;
        }
      }
    }
    entry.state = "active";
    entry.association = { ...association };
    entry.touchedAt = now;
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
    if (entry.nativeFence) return "ambiguous";
    if (sameTurnAssociation(entry.association, association)) {
      entry.touchedAt = this.now();
      return "bound";
    }
    if (entry.pinnedAnonymousRun) return "ambiguous";
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

  hasRun(runId: string | undefined): boolean {
    const key = normalizeTurnAssociationKey(runId);
    return key !== undefined && this.entries.has(key);
  }

  resolve(runId: string | undefined): TurnAssociation | undefined {
    const key = normalizeTurnAssociationKey(runId);
    if (!key) return;
    const entry = this.entries.get(key);
    if (entry?.state !== "active" || !entry.association) return;
    entry.touchedAt = this.now();
    return { ...entry.association };
  }

  pinAnonymousRun(runId: string, association: TurnAssociation): boolean {
    const key = normalizeTurnAssociationKey(runId);
    if (!key || this.entries.has(key) || !this.allowUnknownRunFallback)
      return false;
    const now = this.now();
    this.prune(now);
    if (
      this.entries.size - this.nativeEntries >= this.maxEntries &&
      !this.evictOldestEligible()
    )
      return false;
    this.entries.set(key, {
      association: { ...association },
      state: "active",
      touchedAt: now,
      // A delayed event must never become an unknown alias within this session.
      pinnedAnonymousRun: true,
    });
    return true;
  }

  hasActiveSession(sessionIdentity: string | undefined): boolean {
    const normalized = normalizeTurnAssociationKey(sessionIdentity);
    if (!normalized) return false;
    for (const entry of this.entries.values()) {
      if (
        (entry.state === "active" &&
          (entry.association?.sessionId === normalized ||
            entry.association?.sessionKey === normalized)) ||
        (entry.inFlight === true &&
          (entry.sessionId === normalized ||
            entry.sessionKey === normalized ||
            entry.association?.sessionId === normalized ||
            entry.association?.sessionKey === normalized))
      )
        return true;
    }
    return false;
  }

  resolveAnonymousSession(
    sessionIdentity: string | undefined,
  ): TurnAssociation | undefined {
    const normalizedSessionIdentity = sessionIdentity?.trim();
    if (!normalizedSessionIdentity) return;
    const distinct = new Map<string, TurnAssociation>();
    for (const entry of this.entries.values()) {
      if (!entry.anonymous || entry.nativeFence) continue;
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
      if (
        entry.state !== "terminal" &&
        entry.association?.sessionId === association.sessionId &&
        !sameTurnAssociation(entry.association, association)
      )
        return;
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
    entry.inFlight = false;
    entry.touchedAt = this.now();
  }

  markRunSettled(
    runId: string | undefined,
    expected?: { sessionId?: string; sessionKey?: string },
  ): void {
    const key = normalizeTurnAssociationKey(runId);
    const entry = key ? this.entries.get(key) : undefined;
    if (!entry || entry.state !== "pending") return;
    const sessionId = normalizeTurnAssociationKey(expected?.sessionId);
    const sessionKey = normalizeTurnAssociationKey(expected?.sessionKey);
    const recordedId = entry.sessionId ?? entry.association?.sessionId;
    const recordedKey = entry.sessionKey ?? entry.association?.sessionKey;
    if (
      (sessionId && recordedId && recordedId !== sessionId) ||
      (sessionKey && recordedKey && recordedKey !== sessionKey) ||
      !(
        (sessionId && recordedId === sessionId) ||
        (sessionKey && recordedKey === sessionKey)
      )
    )
      return;
    entry.inFlight = false;
    entry.state = "terminal";
    entry.touchedAt = this.now();
  }

  markAssociationTerminal(association: TurnAssociation): void {
    for (const entry of this.entries.values()) {
      if (sameTurnAssociation(entry.association, association)) {
        entry.state = "terminal";
        entry.inFlight = false;
        entry.touchedAt = this.now();
      }
    }
  }

  removeSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (
        (entry.nativeFence ? entry.sessionId : entry.association?.sessionId) ===
        sessionId
      ) {
        if (entry.nativeBudget) this.nativeEntries -= 1;
        this.entries.delete(key);
      }
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (
        !entry.nativeFence &&
        !entry.pinnedAnonymousRun &&
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
      if (entry.nativeFence || entry.pinnedAnonymousRun) continue;
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
