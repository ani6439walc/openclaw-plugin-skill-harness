import { describe, expect, it } from "vitest";
import { TurnAssociationRegistry } from "./turn-associations.js";

describe("TurnAssociationRegistry", () => {
  describe("native correlation fences", () => {
    it("keeps a pending normalized alias known until its owner binds it", () => {
      const registry = new TurnAssociationRegistry();
      const owner = {};
      const association = { sessionId: "session-a", turnKey: "turn-a" };
      expect(registry.claimNativeRun(undefined, owner)).toBe("blocked");
      expect(registry.claimNativeRun(" ", owner)).toBe("blocked");
      expect(registry.hasRun(" ")).toBe(false);
      expect(registry.claimNativeRun(" run-a ", owner, "session-a")).toBe(
        "claimed",
      );
      expect(registry.hasRun("run-a")).toBe(true);
      expect(registry.resolve("run-a")).toBeUndefined();
      expect(registry.claimNativeRun("run-a", owner, "session-a")).toBe(
        "same-owner",
      );
      expect(registry.bindNativeRun("run-a", {}, association)).toBe("stale");
      expect(registry.resolve("run-a")).toBeUndefined();
      expect(registry.bindNativeRun("run-a", owner, association)).toBe("bound");
      expect(registry.bindNativeRun("run-a", owner, association)).toBe("bound");
      expect(registry.resolve("run-a")).toEqual(association);
      expect(registry.unknownRunFallbackEnabled).toBe(true);
    });

    it("binds multiple aliases owned by one request without retiring older active turns", () => {
      const registry = new TurnAssociationRegistry();
      const firstOwner = {};
      const first = { sessionId: "session-a", turnKey: "turn-a" };
      for (const runId of ["run-a", "run-a-rebuild"]) {
        expect(registry.claimNativeRun(runId, firstOwner, "session-a")).toBe(
          "claimed",
        );
        expect(registry.bindNativeRun(runId, firstOwner, first)).toBe("bound");
      }
      const secondOwner = {};
      const second = { sessionId: "session-a", turnKey: "turn-b" };
      registry.claimNativeRun("run-b", secondOwner, "session-a");
      registry.bindNativeRun("run-b", secondOwner, second);
      expect(registry.resolve("run-a")).toEqual(first);
      expect(registry.resolve("run-a-rebuild")).toEqual(first);
      registry.markAssociationTerminal(first);
      expect(registry.resolve("run-a")).toBeUndefined();
      expect(registry.resolve("run-a-rebuild")).toBeUndefined();
      expect(registry.resolve("run-b")).toEqual(second);
      expect(registry.claimNativeRun("run-a", firstOwner, "session-a")).toBe(
        "same-owner",
      );
      expect(registry.bindNativeRun("run-a", firstOwner, first)).toBe("stale");
      expect(registry.hasRun("run-a")).toBe(true);
    });

    it("makes different-owner collisions ambiguous before either preparation binds", () => {
      const registry = new TurnAssociationRegistry();
      const owner = {};
      const association = { sessionId: "session-a", turnKey: "turn-a" };
      registry.claimNativeRun("run-a", owner, "session-a");
      expect(registry.claimNativeRun("run-a", {}, "session-a")).toBe("blocked");
      expect(registry.bindNativeRun("run-a", owner, association)).toBe(
        "ambiguous",
      );
      expect(registry.claimNativeRun("run-a", owner, "session-a")).toBe(
        "blocked",
      );
      expect(registry.hasRun("run-a")).toBe(true);
      expect(registry.resolve("run-a")).toBeUndefined();
    });

    it("never lets legacy reserve or bind adopt pending or active native aliases", () => {
      const registry = new TurnAssociationRegistry();
      const owner = {};
      const association = { sessionId: "session-a", turnKey: "turn-a" };
      registry.claimNativeRun("run-a", owner, "session-a");
      expect(registry.reserve("run-a")).toEqual({ status: "ambiguous" });
      expect(registry.bind("foreign", "run-a", association)).toBe("ambiguous");
      expect(registry.bindExisting("run-a", association)).toBe("ambiguous");
      expect(registry.resolve("run-a")).toBeUndefined();

      registry.claimNativeRun("run-b", owner, "session-a");
      registry.bindNativeRun("run-b", owner, association);
      expect(registry.reserve("run-b")).toEqual({ status: "ambiguous" });
      expect(registry.bindExisting("run-b", association)).toBe("ambiguous");
    });

    it("retains pending, terminal and ambiguous native fences through TTL and legacy eviction", () => {
      let now = 0;
      const registry = new TurnAssociationRegistry({
        maxEntries: 1,
        idleTtlMs: 10,
        now: () => now,
      });
      const owner = {};
      registry.claimNativeRun("pending", owner, "session-a");
      registry.claimNativeRun("terminal", owner, "session-a");
      const association = { sessionId: "session-a", turnKey: "turn-a" };
      registry.bindNativeRun("terminal", owner, association);
      registry.markAssociationTerminal(association);
      registry.claimNativeRun("ambiguous", owner, "session-a");
      registry.claimNativeRun("ambiguous", {}, "session-a");
      const legacy = registry.reserve("legacy");
      if (legacy.status !== "reserved") throw new Error("expected reservation");
      registry.bind(legacy.token, "legacy", association);
      registry.markTerminal("legacy", association);
      expect(registry.reserve("replacement").status).toBe("reserved");
      now = 100;
      registry.reserve("trigger-prune");
      for (const runId of ["pending", "terminal", "ambiguous"]) {
        expect(registry.hasRun(runId)).toBe(true);
        expect(registry.resolve(runId)).toBeUndefined();
      }
    });

    it("cleans same-session fences but preserves cross-session collision fences", () => {
      const registry = new TurnAssociationRegistry();
      const owner = {};
      registry.claimNativeRun("pending", owner, "session-a");
      registry.claimNativeRun("same-session", owner, "session-a");
      registry.claimNativeRun("same-session", {}, "session-a");
      registry.claimNativeRun("cross-session", owner, "session-a");
      registry.claimNativeRun("cross-session", {}, "session-b");
      registry.removeSession("session-a");
      expect(registry.hasRun("pending")).toBe(false);
      expect(registry.hasRun("same-session")).toBe(false);
      expect(registry.hasRun("cross-session")).toBe(true);
      registry.removeSession("session-b");
      expect(registry.hasRun("cross-session")).toBe(true);
    });

    it("latches unknown-run fallback off at native capacity while keeping legacy capacity independent", () => {
      const registry = new TurnAssociationRegistry({
        maxEntries: 1,
        maxNativeEntries: 1,
      });
      const owner = {};
      expect(registry.claimNativeRun("native", owner, "session-a")).toBe(
        "claimed",
      );
      expect(registry.claimNativeRun("overflow", {}, "session-b")).toBe(
        "blocked",
      );
      expect(registry.hasRun("overflow")).toBe(false);
      expect(registry.hasRun("native")).toBe(true);
      expect(registry.unknownRunFallbackEnabled).toBe(false);
      expect(registry.reserveAnonymous().status).toBe("reserved");
      registry.removeSession("session-a");
      expect(registry.claimNativeRun("new-native", {}, "session-b")).toBe(
        "claimed",
      );
      expect(registry.unknownRunFallbackEnabled).toBe(false);
    });

    it("keeps converted legacy fences in their original budget even at native capacity", () => {
      const registry = new TurnAssociationRegistry({
        maxEntries: 1,
        maxNativeEntries: 1,
      });
      const legacy = registry.reserve("run-a");
      if (legacy.status !== "reserved") throw new Error("expected reservation");
      registry.bind(legacy.token, "run-a", {
        sessionId: "session-a",
        turnKey: "turn-a",
      });
      expect(registry.claimNativeRun("native", {}, "session-native")).toBe(
        "claimed",
      );
      expect(registry.claimNativeRun("run-a", {}, "session-a")).toBe("blocked");
      expect(registry.resolve("run-a")).toBeUndefined();
      expect(registry.hasRun("run-a")).toBe(true);
      expect(registry.unknownRunFallbackEnabled).toBe(false);
      expect(registry.reserve("legacy-next").status).toBe("full");
      registry.removeSession("session-a");
      expect(registry.hasRun("run-a")).toBe(false);
      expect(registry.reserve("legacy-next").status).toBe("reserved");
      expect(registry.claimNativeRun("native-next", {}, "session-b")).toBe(
        "blocked",
      );
      registry.removeSession("session-native");
      expect(registry.claimNativeRun("native-next", {}, "session-b")).toBe(
        "claimed",
      );
      expect(registry.unknownRunFallbackEnabled).toBe(false);
    });
  });

  it("reserves capacity before binding and releases failed preparation", () => {
    const registry = new TurnAssociationRegistry({ maxEntries: 1 });
    const first = registry.reserve("run-a");
    expect(first.status).toBe("reserved");
    expect(registry.reserve("run-b")).toEqual({ status: "full" });
    if (first.status !== "reserved") throw new Error("expected reservation");
    registry.release(first.token);
    expect(registry.reserve("run-b").status).toBe("reserved");
  });

  it("returns an existing identical binding and marks conflicting reuse ambiguous", () => {
    const registry = new TurnAssociationRegistry();
    const reserved = registry.reserve("run-a");
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    expect(
      registry.bind(reserved.token, "run-a", {
        sessionId: "session-a",
        turnKey: "turn-a",
      }),
    ).toBe("bound");
    expect(registry.resolve("run-a")).toEqual({
      sessionId: "session-a",
      turnKey: "turn-a",
    });
    expect(registry.reserve("run-a")).toEqual({
      status: "existing",
      association: { sessionId: "session-a", turnKey: "turn-a" },
    });

    expect(
      registry.bindExisting("run-a", {
        sessionId: "session-b",
        turnKey: "turn-b",
      }),
    ).toBe("ambiguous");
    expect(registry.resolve("run-a")).toBeUndefined();
  });

  it("marks terminal run IDs ambiguous before they can be reused", () => {
    const registry = new TurnAssociationRegistry();
    const reservation = registry.reserve("run-a");
    if (reservation.status !== "reserved")
      throw new Error("expected reservation");
    const association = { sessionId: "session-a", turnKey: "turn-a" };
    registry.bind(reservation.token, "run-a", association);
    registry.markTerminal("run-a", association);

    expect(registry.reserve("run-a")).toEqual({ status: "ambiguous" });
    expect(registry.resolve("run-a")).toBeUndefined();
  });

  it("pins active entries while pruning terminal and ambiguous entries after idle TTL", () => {
    let now = 0;
    const registry = new TurnAssociationRegistry({
      maxEntries: 2,
      idleTtlMs: 100,
      now: () => now,
    });
    const active = registry.reserve("active");
    const terminal = registry.reserve("terminal");
    if (active.status !== "reserved" || terminal.status !== "reserved") {
      throw new Error("expected reservations");
    }
    registry.bind(active.token, "active", {
      sessionId: "session-a",
      turnKey: "turn-a",
    });
    registry.bind(terminal.token, "terminal", {
      sessionId: "session-t",
      turnKey: "turn-t",
    });
    registry.markTerminal("terminal", {
      sessionId: "session-t",
      turnKey: "turn-t",
    });

    now = 101;
    expect(registry.reserve("new").status).toBe("reserved");
    expect(registry.resolve("active")).toEqual({
      sessionId: "session-a",
      turnKey: "turn-a",
    });
    expect(registry.resolve("terminal")).toBeUndefined();
  });

  it("refuses overflow when all entries remain active", () => {
    const registry = new TurnAssociationRegistry({ maxEntries: 2 });
    for (const key of ["a", "b"]) {
      const reservation = registry.reserve(key);
      if (reservation.status !== "reserved")
        throw new Error("expected reservation");
      registry.bind(reservation.token, key, {
        sessionId: `session-${key}`,
        turnKey: `turn-${key}`,
      });
    }
    expect(registry.reserve("c")).toEqual({ status: "full" });
  });

  it("evicts the oldest terminal entry at capacity before its idle TTL", () => {
    let now = 0;
    const registry = new TurnAssociationRegistry({
      maxEntries: 2,
      idleTtlMs: 1_000,
      now: () => now,
    });
    const first = registry.reserve("run-a");
    if (first.status !== "reserved") throw new Error("expected reservation");
    const associationA = { sessionId: "session-a", turnKey: "turn-a" };
    registry.bind(first.token, "run-a", associationA);
    registry.markTerminal("run-a", associationA);
    now = 1;
    const second = registry.reserve("run-b");
    if (second.status !== "reserved") throw new Error("expected reservation");
    registry.bind(second.token, "run-b", {
      sessionId: "session-b",
      turnKey: "turn-b",
    });

    expect(registry.reserve("run-c").status).toBe("reserved");
    expect(registry.resolveSession("session-a")).toBeUndefined();
    expect(registry.resolve("run-b")).toMatchObject({ turnKey: "turn-b" });
  });

  it("normalizes keys by trimming and rejects empty keys", () => {
    const registry = new TurnAssociationRegistry();
    expect(registry.reserve("   ")).toEqual({ status: "invalid" });
    const reservation = registry.reserve(" run-a ");
    if (reservation.status !== "reserved")
      throw new Error("expected reservation");
    registry.bind(reservation.token, "run-a", {
      sessionId: "session-a",
      turnKey: "turn-a",
    });
    expect(registry.resolve(" run-a ")).toEqual({
      sessionId: "session-a",
      turnKey: "turn-a",
    });
  });

  it("resolves anonymous turns by session only while attribution is unique", () => {
    const registry = new TurnAssociationRegistry();
    const first = registry.reserveAnonymous();
    expect(first.status).toBe("reserved");
    if (first.status !== "reserved") throw new Error("expected reservation");
    expect(
      registry.bindAnonymous(first.token, {
        sessionId: "session-a",
        turnKey: "turn-a",
      }),
    ).toBe("bound");
    expect(registry.resolveSession("session-a")).toEqual({
      sessionId: "session-a",
      turnKey: "turn-a",
    });

    const second = registry.reserveAnonymous();
    if (second.status !== "reserved") throw new Error("expected reservation");
    registry.bindAnonymous(second.token, {
      sessionId: "session-a",
      turnKey: "turn-b",
    });
    expect(registry.resolveSession("session-a")).toBeUndefined();
  });

  it("resolves a unique live turn by canonical session key", () => {
    const registry = new TurnAssociationRegistry();
    const reservation = registry.reserve("run-a");
    if (reservation.status !== "reserved")
      throw new Error("expected reservation");
    registry.bind(reservation.token, "run-a", {
      sessionId: "session-a",
      sessionKey: "agent:main:direct:123",
      turnKey: "turn-a",
    });

    expect(registry.resolveSession("agent:main:direct:123")).toEqual({
      sessionId: "session-a",
      sessionKey: "agent:main:direct:123",
      turnKey: "turn-a",
    });
  });

  it("deduplicates anonymous prompt retries and removes every session association", () => {
    const registry = new TurnAssociationRegistry();
    for (let index = 0; index < 2; index += 1) {
      const reservation = registry.reserveAnonymous();
      if (reservation.status !== "reserved")
        throw new Error("expected reservation");
      expect(
        registry.bindAnonymous(reservation.token, {
          sessionId: "session-a",
          turnKey: "turn-a",
        }),
      ).toBe("bound");
    }
    expect(registry.resolveSession("session-a")).toEqual({
      sessionId: "session-a",
      turnKey: "turn-a",
    });
    registry.removeSession("session-a");
    expect(registry.resolveSession("session-a")).toBeUndefined();
  });

  it("resolves consecutive turns in the same session without interference from terminal entries", () => {
    const registry = new TurnAssociationRegistry();
    const firstReservation = registry.reserveAnonymous();
    if (firstReservation.status !== "reserved")
      throw new Error("expected reservation");
    const turnA = { sessionId: "session-a", turnKey: "turn-1" };
    expect(registry.bindAnonymous(firstReservation.token, turnA)).toBe("bound");
    expect(registry.resolveSession("session-a")).toEqual(turnA);

    registry.markAssociationTerminal(turnA);
    expect(registry.resolveSession("session-a")).toBeUndefined();

    const secondReservation = registry.reserveAnonymous();
    if (secondReservation.status !== "reserved")
      throw new Error("expected reservation");
    const turnB = { sessionId: "session-a", turnKey: "turn-2" };
    expect(registry.bindAnonymous(secondReservation.token, turnB)).toBe(
      "bound",
    );
    expect(registry.resolveSession("session-a")).toEqual(turnB);
  });
});
