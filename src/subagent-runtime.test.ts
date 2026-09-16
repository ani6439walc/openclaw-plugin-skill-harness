import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import {
  extractEmbeddedRunError,
  formatEmbeddedError,
  isGatewayDraining,
  runDetachedFromWorkScope,
} from "./subagent-runtime.js";

describe("formatEmbeddedError", () => {
  it("formats plain-object errors", () => {
    expect(formatEmbeddedError({ kind: "timeout", message: "expired" })).toBe(
      "timeout: expired",
    );
  });

  it("formats Error instances", () => {
    expect(formatEmbeddedError(new Error("timeout"))).toBe("timeout");
  });

  it.each([[], null, 42])("ignores unsupported error value %#", (error) => {
    expect(formatEmbeddedError(error)).toBeUndefined();
  });

  it("trims string errors", () => {
    expect(formatEmbeddedError("  timeout  ")).toBe("timeout");
  });
});

describe("extractEmbeddedRunError", () => {
  it("reads error payloads only from plain records", () => {
    expect(
      extractEmbeddedRunError({
        payloads: [{ isError: true, text: "  request failed  " }],
      }),
    ).toBe("request failed");
    expect(extractEmbeddedRunError({ payloads: [new Error("failure")] })).toBe(
      undefined,
    );
  });

  it("preserves an Error instance supplied through metadata", () => {
    expect(
      extractEmbeddedRunError({ meta: { error: new Error("timeout") } }),
    ).toBe("timeout");
  });
});

describe("runDetachedFromWorkScope", () => {
  const scopeKey = Symbol.for("openclaw.asyncWorkScope");

  it("executes the callback and returns its value when no scope exists", async () => {
    const original = (globalThis as Record<symbol, unknown>)[scopeKey];
    delete (globalThis as Record<symbol, unknown>)[scopeKey];
    try {
      const result = await runDetachedFromWorkScope(async () => 42);
      expect(result).toBe(42);
    } finally {
      if (original !== undefined) {
        (globalThis as Record<symbol, unknown>)[scopeKey] = original;
      }
    }
  });

  it("exits the openclaw.asyncWorkScope so callback executes with undefined store", async () => {
    const original = (globalThis as Record<symbol, unknown>)[scopeKey];
    const storage = new AsyncLocalStorage<{ phase: string }>();
    (globalThis as Record<symbol, unknown>)[scopeKey] = storage;

    try {
      await storage.run({ phase: "closed" }, async () => {
        expect(storage.getStore()).toEqual({ phase: "closed" });

        const insideStore = await runDetachedFromWorkScope(async () => {
          return storage.getStore();
        });

        expect(insideStore).toBeUndefined();
        expect(storage.getStore()).toEqual({ phase: "closed" });
      });
    } finally {
      if (original !== undefined) {
        (globalThis as Record<symbol, unknown>)[scopeKey] = original;
      } else {
        delete (globalThis as Record<symbol, unknown>)[scopeKey];
      }
    }
  });

  it("propagates errors thrown inside the detached callback", async () => {
    await expect(
      runDetachedFromWorkScope(async () => {
        throw new Error("inner error");
      }),
    ).rejects.toThrow("inner error");
  });
});

describe("isGatewayDraining", () => {
  const admissionKey = Symbol.for("openclaw.gatewayWorkAdmissionState");

  it("returns false when state symbol is absent or not draining", () => {
    const original = (globalThis as Record<symbol, unknown>)[admissionKey];
    delete (globalThis as Record<symbol, unknown>)[admissionKey];
    try {
      expect(isGatewayDraining()).toBe(false);

      (globalThis as Record<symbol, unknown>)[admissionKey] = {
        restartDraining: false,
      };
      expect(isGatewayDraining()).toBe(false);
    } finally {
      if (original !== undefined) {
        (globalThis as Record<symbol, unknown>)[admissionKey] = original;
      } else {
        delete (globalThis as Record<symbol, unknown>)[admissionKey];
      }
    }
  });

  it("returns true when restartDraining is true", () => {
    const original = (globalThis as Record<symbol, unknown>)[admissionKey];
    try {
      (globalThis as Record<symbol, unknown>)[admissionKey] = {
        restartDraining: true,
      };
      expect(isGatewayDraining()).toBe(true);
    } finally {
      if (original !== undefined) {
        (globalThis as Record<symbol, unknown>)[admissionKey] = original;
      } else {
        delete (globalThis as Record<symbol, unknown>)[admissionKey];
      }
    }
  });
});
