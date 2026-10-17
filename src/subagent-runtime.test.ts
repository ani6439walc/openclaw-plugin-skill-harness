import { describe, expect, it } from "vitest";
import {
  extractEmbeddedRunError,
  formatEmbeddedError,
  createBackgroundRunner,
  isGatewayDrainingError,
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

describe("createBackgroundRunner", () => {
  it("returns values and propagates failures without a managed lifecycle", async () => {
    const run = createBackgroundRunner(undefined);
    expect(run(() => 42)).toBe(42);
    await expect(
      run(async () => {
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");
  });

  it("delegates the entire promise to the captured lifecycle with its receiver", async () => {
    const lifecycle = {
      value: 42,
      runInBackgroundContext<T>(run: () => T): T {
        expect(this.value).toBe(42);
        return run();
      },
    };
    const run = createBackgroundRunner(lifecycle);
    const work = Promise.resolve(42);
    expect(run(() => work)).toBe(work);
    await expect(work).resolves.toBe(42);
  });
});

describe("isGatewayDrainingError", () => {
  it("recognizes the public host admission error without reading process state", () => {
    const error = new Error("Gateway is restarting. Please try again shortly.");
    error.name = "GatewayDrainingError";
    expect(isGatewayDrainingError(error)).toBe(true);
    expect(isGatewayDrainingError(new Error("other error"))).toBe(false);
  });
});
