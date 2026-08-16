import { describe, expect, it } from "vitest";
import { TurnAssociationRegistry } from "./turn-associations.js";

describe("TurnAssociationRegistry", () => {
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
