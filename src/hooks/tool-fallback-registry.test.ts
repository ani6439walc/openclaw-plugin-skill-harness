import { describe, expect, it } from "vitest";
import { ToolFallbackRegistry } from "./tool-fallback-registry.js";

const turnA = { sessionId: "session-a", turnKey: "turn-a" };
const turnB = { sessionId: "session-b", turnKey: "turn-b" };

function fallback(name: string) {
  return {
    toolCallId: name,
    name: "read",
    params: { path: `/${name}` },
    result: name,
    success: true,
  };
}

describe("ToolFallbackRegistry", () => {
  it("pins live entries at capacity and prunes terminal entries after the idle TTL", () => {
    let now = 0;
    const registry = new ToolFallbackRegistry({
      maxEntries: 2,
      idleTtlMs: 100,
      now: () => now,
    });

    expect(
      registry.stage(" call-a ", {
        association: turnA,
        fallback: fallback("call-a"),
      }),
    ).toBe("staged");
    expect(
      registry.stage("call-b", {
        association: turnB,
        fallback: fallback("call-b"),
      }),
    ).toBe("staged");
    expect(
      registry.stage("call-c", {
        association: { sessionId: "session-c", turnKey: "turn-c" },
        fallback: fallback("call-c"),
      }),
    ).toBe("full");

    registry.markAssociationTerminal(turnA);
    now = 101;
    expect(
      registry.stage("call-c", {
        association: { sessionId: "session-c", turnKey: "turn-c" },
        fallback: fallback("call-c"),
      }),
    ).toBe("staged");
    expect(registry.get("call-a")).toBeUndefined();
    expect(registry.get("call-b")?.association).toEqual(turnB);
  });

  it("marks a normalized tool call id ambiguous when two live turns claim it", () => {
    const registry = new ToolFallbackRegistry();

    expect(
      registry.stage(" shared-call ", {
        association: turnA,
        fallback: fallback("first"),
      }),
    ).toBe("staged");
    expect(
      registry.stage("shared-call", {
        association: turnB,
        fallback: fallback("second"),
      }),
    ).toBe("ambiguous");

    expect(registry.get("shared-call")).toBeUndefined();
    expect(registry.listForAssociation(turnA)).toEqual([]);
    expect(registry.listForAssociation(turnB)).toEqual([]);
  });

  it("evicts the oldest terminal fallback at capacity before its idle TTL", () => {
    let now = 0;
    const registry = new ToolFallbackRegistry({
      maxEntries: 2,
      idleTtlMs: 1_000,
      now: () => now,
    });
    registry.stage("call-a", {
      association: turnA,
      fallback: fallback("call-a"),
    });
    registry.markAssociationTerminal(turnA);
    now = 1;
    registry.stage("call-b", {
      association: turnB,
      fallback: fallback("call-b"),
    });

    expect(
      registry.stage("call-c", {
        association: { sessionId: "session-c", turnKey: "turn-c" },
        fallback: fallback("call-c"),
      }),
    ).toBe("staged");
    expect(registry.get("call-a")).toBeUndefined();
    expect(registry.get("call-b")).toBeDefined();
  });

  it("removes every staged or ambiguous entry owned by an ended session", () => {
    const registry = new ToolFallbackRegistry();
    registry.stage("call-a", {
      association: turnA,
      fallback: fallback("call-a"),
    });
    registry.stage("shared", {
      association: turnA,
      fallback: fallback("first"),
    });
    registry.stage("shared", {
      association: turnB,
      fallback: fallback("second"),
    });

    registry.removeSession("session-a");

    expect(registry.get("call-a")).toBeUndefined();
    expect(
      registry.stage("shared", {
        association: turnB,
        fallback: fallback("replacement"),
      }),
    ).toBe("staged");
  });
});
